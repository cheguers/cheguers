use std::collections::HashMap;
use std::sync::Arc;

use crate::adjacency::EdgeRef;
use crate::catalog::{Catalog, EdgeTypeEntry};
use crate::command::Command;
use crate::error::StorageError;
use crate::io::file::FileManager;
use crate::table::edge::CSREdgeRecord;
use crate::types::{Direction, EdgeId, LabelId, NodeId, NodeOffset, PropertyValue};

use super::edge_table::{CSREdgeGroupPageInfo, EdgeTable};

pub struct EdgeStore {
  tables:       HashMap<LabelId, EdgeTable>,
  /// Maps `NodeId` → dense node offset (`group_idx * NODE_GROUP_SIZE + row`).
  /// Populated by `StorageManager` from `NodeTable` before applying edge commands.
  node_offsets: HashMap<NodeId, NodeOffset>,
  catalog:      Arc<Catalog>,
}

impl EdgeStore {
  pub fn new(catalog: Arc<Catalog>) -> Self {
    let tables = catalog
      .edge_types
      .iter()
      .map(|edge_type| (edge_type.label_id, EdgeTable::new(edge_type.clone())))
      .collect();
    Self { tables, node_offsets: HashMap::new(), catalog }
  }

  pub fn update_node_offsets(&mut self, offsets: &HashMap<NodeId, NodeOffset>) {
    self.node_offsets.extend(offsets);
  }

  /// For `CreateEdge`, the from/to node offsets must have been registered
  /// via `update_node_offsets` before this call.
  pub fn apply_command(&mut self, cmd: &Command) -> Result<(), StorageError> {
    match cmd {
      Command::CreateEdge { edge_id, type_id, from, to, properties } => {
        let from_offset = self.lookup_offset(*from)?;
        let to_offset = self.lookup_offset(*to)?;

        let schema = self
          .catalog
          .get_edge_type(*type_id)
          .ok_or(StorageError::LabelNotFound { label_id: *type_id })?;
        let aligned = align_properties(schema, properties);
        let table = self
          .tables
          .get_mut(type_id)
          .ok_or(StorageError::LabelNotFound { label_id: *type_id })?;
        table.insert_edge(*edge_id, *from, *to, from_offset, to_offset, &aligned)
      }
      Command::DeleteEdge { edge_id } => {
        for table in self.tables.values_mut() {
          if table.get_edge(*edge_id)?.is_some() {
            return table.delete_edge(*edge_id);
          }
        }
        Err(StorageError::EdgeNotFound { edge_id: *edge_id })
      }
      Command::CreateNode { .. } | Command::UpsertVector { .. } | Command::DeleteNode { .. } => Ok(()),
    }
  }

  pub fn get_edge(&self, edge_id: EdgeId, type_id: LabelId) -> Option<CSREdgeRecord> {
    self.tables.get(&type_id).and_then(|t| t.get_edge(edge_id).ok().flatten())
  }

  pub fn scan_type(&self, type_id: LabelId) -> impl Iterator<Item = CSREdgeRecord> + '_ {
    self.tables.get(&type_id).into_iter().flat_map(EdgeTable::iter)
  }

  pub fn num_edges(&self, type_id: LabelId) -> u64 {
    self.tables.get(&type_id).map_or(0, EdgeTable::num_edges)
  }

  /// Appends `EdgeRef`s for `node_offset` (dense offset) in the given direction.
  pub fn neighbors(&self, node_offset: NodeOffset, dir: Direction, out: &mut Vec<EdgeRef>) {
    for table in self.tables.values() {
      table.neighbors_into(node_offset, dir, out);
    }
  }

  #[must_use]
  pub fn node_offsets(&self) -> &HashMap<NodeId, NodeOffset> {
    &self.node_offsets
  }

  pub fn flush_all(&mut self, fm: &mut FileManager) -> Result<(), StorageError> {
    self.tables.values_mut().try_for_each(|t| t.flush(fm))
  }

  #[must_use]
  pub fn all_page_infos(&self) -> Vec<CSREdgeGroupPageInfo> {
    self.tables.values().flat_map(|t| t.page_infos().to_vec()).collect()
  }

  pub fn load(
    catalog: Arc<Catalog>,
    page_infos: &[CSREdgeGroupPageInfo],
    fm: &mut FileManager,
  ) -> Result<Self, StorageError> {
    // TODO: include label_id in CSREdgeGroupPageInfo for correct per-label filtering.
    let tables = catalog
      .edge_types
      .iter()
      .map(|entry| {
        EdgeTable::load(entry.clone(), page_infos.to_vec(), fm).map(|t| (entry.label_id, t))
      })
      .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(Self { tables, node_offsets: HashMap::new(), catalog })
  }

  fn lookup_offset(&self, node_id: NodeId) -> Result<NodeOffset, StorageError> {
    self
      .node_offsets
      .get(&node_id)
      .copied()
      .ok_or(StorageError::NodeNotFound { node_id })
  }
}

fn align_properties(schema: &EdgeTypeEntry, values: &[PropertyValue]) -> Vec<Option<PropertyValue>> {
  schema
    .properties
    .iter()
    .enumerate()
    .map(|(i, _)| values.get(i).cloned())
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::catalog::PropertyDef;
  use crate::types::{ColumnId, DataType, TableId};

  fn catalog_with_knows() -> Catalog {
    Catalog {
      node_labels: vec![],
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

  fn edge_values() -> Vec<PropertyValue> {
    vec![PropertyValue::Float64(0.95)]
  }

  fn store_with_offsets(offsets: &[(u64, u64)]) -> EdgeStore {
    let mut store = EdgeStore::new(Arc::new(catalog_with_knows()));
    let map: HashMap<NodeId, NodeOffset> = offsets
      .iter()
      .map(|&(nid, off)| (NodeId(nid), off))
      .collect();
    store.update_node_offsets(&map);
    store
  }

  #[test]
  fn create_and_read_edge() {
    let mut store = store_with_offsets(&[(10, 100), (20, 200)]);
    let edge_id = EdgeId(1);
    let type_id = LabelId(1);

    store
      .apply_command(&Command::CreateEdge {
        edge_id,
        type_id,
        from: NodeId(10),
        to: NodeId(20),
        properties: edge_values(),
      })
      .expect("apply");

    let record = store.get_edge(edge_id, type_id).expect("get");
    assert_eq!(record.edge_id, edge_id);
  }

  #[test]
  fn delete_edge_via_command() {
    let mut store = store_with_offsets(&[(10, 100), (20, 200)]);
    let edge_id = EdgeId(1);
    let type_id = LabelId(1);

    store
      .apply_command(&Command::CreateEdge {
        edge_id,
        type_id,
        from: NodeId(10),
        to: NodeId(20),
        properties: edge_values(),
      })
      .expect("create");

    assert_eq!(store.num_edges(type_id), 1);

    store.apply_command(&Command::DeleteEdge { edge_id }).expect("delete");
    assert_eq!(store.num_edges(type_id), 0);
    assert!(store.get_edge(edge_id, type_id).is_none());
  }

  #[test]
  fn delete_missing_edge_returns_error() {
    let mut store = store_with_offsets(&[]);
    assert!(matches!(
      store.apply_command(&Command::DeleteEdge { edge_id: EdgeId(999) }),
      Err(StorageError::EdgeNotFound { .. })
    ));
  }

  #[test]
  fn unknown_type_returns_error() {
    let mut store = store_with_offsets(&[(10, 100), (20, 200)]);
    assert!(matches!(
      store.apply_command(&Command::CreateEdge {
        edge_id: EdgeId(1),
        type_id: LabelId(999),
        from: NodeId(10),
        to: NodeId(20),
        properties: edge_values(),
      }),
      Err(StorageError::LabelNotFound { .. })
    ));
  }

  #[test]
  fn adjacency_updated_on_create() {
    let mut store = store_with_offsets(&[(10, 100), (20, 200)]);
    store
      .apply_command(&Command::CreateEdge {
        edge_id: EdgeId(1),
        type_id: LabelId(1),
        from: NodeId(10),
        to: NodeId(20),
        properties: edge_values(),
      })
      .expect("apply");

    let mut forward = Vec::new();
    store.neighbors(100, Direction::Forward, &mut forward);
    assert_eq!(forward.len(), 1);
    assert_eq!(forward[0].neighbor, NodeId(20));
  }

  #[test]
  fn adjacency_updated_on_delete() {
    let mut store = store_with_offsets(&[(10, 100), (20, 200)]);
    store
      .apply_command(&Command::CreateEdge {
        edge_id: EdgeId(1),
        type_id: LabelId(1),
        from: NodeId(10),
        to: NodeId(20),
        properties: edge_values(),
      })
      .expect("create");

    store.apply_command(&Command::DeleteEdge { edge_id: EdgeId(1) }).expect("delete");
    let mut forward = Vec::new();
    store.neighbors(100, Direction::Forward, &mut forward);
    assert_eq!(forward.len(), 0);
  }

  #[test]
  fn replay_sequence() {
    let mut store = store_with_offsets(&[
      (100, 1000), (200, 2000), (201, 2001), (202, 2002), (203, 2003),
      (204, 2004), (205, 2005), (206, 2006), (207, 2007), (208, 2008),
      (209, 2009),
    ]);
    let type_id = LabelId(1);

    for i in 0..10 {
      store
        .apply_command(&Command::CreateEdge {
          edge_id: EdgeId(i),
          type_id,
          from: NodeId(100),
          to: NodeId(200 + i),
          properties: edge_values(),
        })
        .expect("create");
    }

    for i in (0..10).step_by(2) {
      store.apply_command(&Command::DeleteEdge { edge_id: EdgeId(i) }).expect("delete");
    }

    let remaining: Vec<_> = store.scan_type(type_id).map(|r| r.edge_id).collect();
    assert_eq!(remaining, vec![EdgeId(1), EdgeId(3), EdgeId(5), EdgeId(7), EdgeId(9)]);
  }

  #[test]
  fn node_command_is_ignored() {
    let mut store = store_with_offsets(&[]);
    assert!(store.apply_command(&Command::CreateNode {
      node_id: NodeId(1), label_id: LabelId(0), properties: vec![],
    }).is_ok());
    assert!(store.apply_command(&Command::DeleteNode { node_id: NodeId(1) }).is_ok());
    assert!(store.apply_command(&Command::UpsertVector {
      node_id: NodeId(1), column_id: ColumnId(0), vector: vec![],
    }).is_ok());
  }

  #[test]
  fn scan_unknown_type_returns_empty_iter() {
    let store = store_with_offsets(&[]);
    assert_eq!(store.scan_type(LabelId(999)).count(), 0);
  }

  #[test]
  fn create_edge_missing_offset_returns_error() {
    let mut store = EdgeStore::new(Arc::new(catalog_with_knows()));
    let result = store.apply_command(&Command::CreateEdge {
      edge_id: EdgeId(1),
      type_id: LabelId(1),
      from: NodeId(10),
      to: NodeId(20),
      properties: edge_values(),
    });
    assert!(matches!(result, Err(StorageError::NodeNotFound { node_id: NodeId(10) })));
  }
}
