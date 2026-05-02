use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::adjacency::EdgeRef;
use crate::catalog::Catalog;
use crate::command::Command;
use crate::config::StorageConfig;
use crate::error::StorageError;
use crate::io::binary;
use crate::io::file::FileManager;
use crate::io::header::DatabaseHeader;
use crate::io::page::Page;
use crate::table::edge::CSREdgeRecord;
use crate::types::{Direction, EdgeId, LabelId, NodeId, PageIdx, PageRange, PropertyValue};

use super::edge_store::EdgeStore;
use super::edge_table::CSREdgeGroupPageInfo;
use super::node_store::NodeStore;
use super::node_table::NodeGroupPageInfo;

const NODE_PI_ENTRY_SIZE: usize = 20;
const EDGE_PI_ENTRY_SIZE: usize = 21;

/// Owns the data file, catalog, and in-memory stores.
pub struct StorageManager {
  file_manager: FileManager,
  catalog:      Arc<Catalog>,
  node_store:   NodeStore,
  edge_store:   EdgeStore,
}

impl StorageManager {
  pub fn create(path: &Path, catalog: Catalog) -> Result<Self, StorageError> {
    let catalog = Arc::new(catalog);
    let mut fm = FileManager::create(path)?;

    let mut header = DatabaseHeader::new(generate_db_id());
    fm.write_page(PageIdx(0), &header.serialize())?;

    let cat_pages = serialize_catalog_block(&catalog, &[], &[])?;
    let cat_start = fm.allocate_pages(cat_pages.len() as u64)?;
    fm.write_page_range(cat_start, &cat_pages)?;

    header.set_catalog_page_range(PageRange {
      start_page: cat_start,
      num_pages:  cat_pages.len() as u32,
    });
    fm.write_page(PageIdx(0), &header.serialize())?;
    fm.sync()?;

    let node_store = NodeStore::new(Arc::clone(&catalog));
    let edge_store = EdgeStore::new(Arc::clone(&catalog));

    Ok(Self { file_manager: fm, catalog, node_store, edge_store })
  }

  pub fn open(path: &Path) -> Result<Self, StorageError> {
    let mut fm = FileManager::open(path)?;
    let header_page = fm.read_page(PageIdx(0))?;
    let header = DatabaseHeader::deserialize(&header_page)?;

    let cat_pages = fm.read_page_range(
      header.catalog_page_range.start_page,
      header.catalog_page_range.num_pages,
    )?;
    let cat_buf: Vec<u8> = cat_pages.iter().flat_map(Page::to_vec).collect();
    let catalog = Arc::new(Catalog::deserialize(&cat_buf)?);

    let cat_len = catalog.serialized_len();
    let (node_page_infos, edge_page_infos) = deserialize_table_metadata(&cat_buf[cat_len..])?;

    let node_store = NodeStore::load(Arc::clone(&catalog), &node_page_infos, &mut fm)?;
    let mut edge_store = EdgeStore::load(Arc::clone(&catalog), &edge_page_infos, &mut fm)?;
    edge_store.update_node_offsets(&node_store.node_offset_map());

    Ok(Self { file_manager: fm, catalog, node_store, edge_store })
  }

  pub fn apply_command(&mut self, cmd: &Command) -> Result<(), StorageError> {
    match cmd {
      Command::CreateEdge { .. } | Command::DeleteEdge { .. } => {
        self.edge_store.update_node_offsets(&self.node_store.node_offset_map());
        self.edge_store.apply_command(cmd)
      }
      _ => self.node_store.apply_command(cmd),
    }
  }

  pub fn get_node(&self, node_id: NodeId, label_id: LabelId) -> Option<Vec<Option<PropertyValue>>> {
    self.node_store.get_node(node_id, label_id)
  }

  pub fn get_edge(&self, edge_id: EdgeId, type_id: LabelId) -> Option<CSREdgeRecord> {
    self.edge_store.get_edge(edge_id, type_id)
  }

  pub fn neighbors(&self, node_id: NodeId, dir: Direction, out: &mut Vec<EdgeRef>) {
    if let Some(off) = self.node_store.node_offset(node_id) {
      self.edge_store.neighbors(off, dir, out);
    }
  }

  pub fn flush(&mut self) -> Result<(), StorageError> {
    self.node_store.flush_all(&mut self.file_manager)?;
    self.edge_store.flush_all(&mut self.file_manager)?;

    let node_pis = self.node_store.all_page_infos();
    let edge_pis = self.edge_store.all_page_infos();

    let cat_pages = serialize_catalog_block(&self.catalog, &node_pis, &edge_pis)?;
    let cat_start = self.file_manager.allocate_pages(cat_pages.len() as u64)?;
    self.file_manager.write_page_range(cat_start, &cat_pages)?;

    let header_page = self.file_manager.read_page(PageIdx(0))?;
    let mut header = DatabaseHeader::deserialize(&header_page)?;
    header.set_catalog_page_range(PageRange {
      start_page: cat_start,
      num_pages:  cat_pages.len() as u32,
    });
    self.file_manager.write_page(PageIdx(0), &header.serialize())?;
    self.file_manager.sync()
  }
}

fn generate_db_id() -> [u8; 16] {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos() as u64)
    .unwrap_or_default();
  let mut id = [0u8; 16];
  id[..8].copy_from_slice(&now.to_le_bytes());
  id
}

fn serialize_catalog_block(
  catalog: &Catalog,
  node_pis: &[NodeGroupPageInfo],
  edge_pis: &[CSREdgeGroupPageInfo],
) -> Result<Vec<Page>, StorageError> {
  let cat_len = catalog.serialized_len();
  let mut buf = vec![0u8; cat_len];
  catalog.serialize(&mut buf)?;
  write_table_metadata(&mut buf, node_pis, edge_pis);
  Ok(split_into_pages(&buf))
}

fn write_table_metadata(
  buf: &mut Vec<u8>,
  node_pis: &[NodeGroupPageInfo],
  edge_pis: &[CSREdgeGroupPageInfo],
) {
  let mut header = [0u8; 8];
  let mut pos = 0;
  binary::write_u32(&mut header, &mut pos, node_pis.len() as u32);
  binary::write_u32(&mut header, &mut pos, edge_pis.len() as u32);
  buf.extend_from_slice(&header);

  for pi in node_pis {
    let mut entry = [0u8; NODE_PI_ENTRY_SIZE];
    let mut pos = 0;
    binary::write_u64(&mut entry, &mut pos, pi.group_idx.0);
    binary::write_u64(&mut entry, &mut pos, pi.page_range.start_page.0);
    binary::write_u32(&mut entry, &mut pos, pi.page_range.num_pages);
    buf.extend_from_slice(&entry);
  }
  for pi in edge_pis {
    let mut entry = [0u8; EDGE_PI_ENTRY_SIZE];
    let mut pos = 0;
    binary::write_u64(&mut entry, &mut pos, pi.group_idx.0);
    binary::write_u8(&mut entry, &mut pos, direction_to_byte(pi.direction));
    binary::write_u64(&mut entry, &mut pos, pi.page_range.start_page.0);
    binary::write_u32(&mut entry, &mut pos, pi.page_range.num_pages);
    buf.extend_from_slice(&entry);
  }
}

fn deserialize_table_metadata(
  buf: &[u8],
) -> Result<(Vec<NodeGroupPageInfo>, Vec<CSREdgeGroupPageInfo>), StorageError> {
  if buf.len() < 8 {
    return Ok((Vec::new(), Vec::new()));
  }
  let mut pos = 0;
  let num_node = binary::read_u32(buf, &mut pos) as usize;
  let num_edge = binary::read_u32(buf, &mut pos) as usize;

  let node_pis = (0..num_node)
    .map(|_| {
      let group_idx = crate::types::NodeGroupIdx(binary::read_u64(buf, &mut pos));
      let start_page = PageIdx(binary::read_u64(buf, &mut pos));
      let num_pages = binary::read_u32(buf, &mut pos);
      NodeGroupPageInfo { group_idx, page_range: PageRange { start_page, num_pages } }
    })
    .collect();

  let edge_pis = (0..num_edge)
    .map(|_| {
      let group_idx = crate::types::NodeGroupIdx(binary::read_u64(buf, &mut pos));
      let direction = byte_to_direction(binary::read_u8(buf, &mut pos));
      let start_page = PageIdx(binary::read_u64(buf, &mut pos));
      let num_pages = binary::read_u32(buf, &mut pos);
      CSREdgeGroupPageInfo {
        group_idx,
        direction,
        page_range: PageRange { start_page, num_pages },
      }
    })
    .collect();

  Ok((node_pis, edge_pis))
}

#[inline]
fn direction_to_byte(dir: Direction) -> u8 {
  match dir {
    Direction::Forward => 0,
    Direction::Backward => 1,
  }
}

#[inline]
fn byte_to_direction(b: u8) -> Direction {
  if b == 0 { Direction::Forward } else { Direction::Backward }
}

fn split_into_pages(buf: &[u8]) -> Vec<Page> {
  buf
    .chunks(StorageConfig::PAGE_SIZE as usize)
    .map(Page::from_bytes)
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::catalog::{Catalog, EdgeTypeEntry, NodeLabelEntry, PropertyDef};
  use crate::command::Command;
  use crate::types::{ColumnId, DataType, EdgeId, LabelId, NodeId, PropertyValue, TableId};
  use std::sync::atomic::{AtomicU64, Ordering};

  static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

  fn test_path() -> std::path::PathBuf {
    let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("cheguers_test_{n}.cheguers"))
  }

  fn test_catalog() -> Catalog {
    Catalog {
      node_labels: vec![NodeLabelEntry {
        table_id:     TableId(0),
        label_id:     LabelId(0),
        name:         "Person".into(),
        pk_column_id: ColumnId(0),
        properties:   vec![
          PropertyDef {
            name:      "name".into(),
            column_id: ColumnId(0),
            data_type: DataType::String,
            nullable:  false,
          },
          PropertyDef {
            name:      "age".into(),
            column_id: ColumnId(1),
            data_type: DataType::Int64,
            nullable:  true,
          },
        ],
      }],
      edge_types:  vec![EdgeTypeEntry {
        table_id:      TableId(1),
        label_id:      LabelId(1),
        name:          "Knows".into(),
        from_label_id: LabelId(0),
        to_label_id:   LabelId(0),
        properties:    vec![PropertyDef {
          name:      "weight".into(),
          column_id: ColumnId(0),
          data_type: DataType::Float64,
          nullable:  false,
        }],
      }],
    }
  }

  #[test]
  fn create_flush_reopen_roundtrip() {
    let path = test_path();
    let catalog = test_catalog();

    let mut sm = StorageManager::create(&path, catalog.clone()).unwrap();

    sm.apply_command(&Command::CreateNode {
      node_id:    NodeId(1),
      label_id:   LabelId(0),
      properties: vec![PropertyValue::String("Alice".into()), PropertyValue::Int64(30)],
    })
    .unwrap();
    sm.apply_command(&Command::CreateNode {
      node_id:    NodeId(2),
      label_id:   LabelId(0),
      properties: vec![PropertyValue::String("Bob".into()), PropertyValue::Int64(25)],
    })
    .unwrap();

    sm.apply_command(&Command::CreateEdge {
      edge_id:    EdgeId(1),
      type_id:    LabelId(1),
      from:       NodeId(1),
      to:         NodeId(2),
      properties: vec![PropertyValue::Float64(0.95)],
    })
    .unwrap();

    let alice = sm.get_node(NodeId(1), LabelId(0)).unwrap();
    assert_eq!(alice[0], Some(PropertyValue::String("Alice".into())));

    sm.flush().unwrap();
    drop(sm);

    let sm2 = StorageManager::open(&path).unwrap();

    let alice2 = sm2.get_node(NodeId(1), LabelId(0)).unwrap();
    assert_eq!(alice2[0], Some(PropertyValue::String("Alice".into())));

    let bob2 = sm2.get_node(NodeId(2), LabelId(0)).unwrap();
    assert_eq!(bob2[0], Some(PropertyValue::String("Bob".into())));

    let edge = sm2.get_edge(EdgeId(1), LabelId(1)).unwrap();
    assert_eq!(edge.from, NodeId(1));
    assert_eq!(edge.to, NodeId(2));
    assert_eq!(edge.properties[0], Some(PropertyValue::Float64(0.95)));

    let mut fwd = Vec::new();
    sm2.neighbors(NodeId(1), Direction::Forward, &mut fwd);
    assert_eq!(fwd.len(), 1);
    assert_eq!(fwd[0].edge_id, EdgeId(1));
    assert_eq!(fwd[0].neighbor, NodeId(2));

    let mut bwd = Vec::new();
    sm2.neighbors(NodeId(2), Direction::Backward, &mut bwd);
    assert_eq!(bwd.len(), 1);
    assert_eq!(bwd[0].neighbor, NodeId(1));

    drop(sm2);
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn create_empty_database() {
    let path = test_path();
    let sm = StorageManager::create(&path, Catalog::default()).unwrap();
    drop(sm);
    let _ = StorageManager::open(&path).unwrap();
    let _ = std::fs::remove_file(&path);
  }
}
