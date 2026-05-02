use std::collections::{HashMap, HashSet};

use crate::catalog::NodeLabelEntry;
use crate::config::StorageConfig;
use crate::error::StorageError;
use crate::io::file::FileManager;
use crate::table::node::NodeGroup;
use crate::types::{LabelId, NodeGroupIdx, NodeId, NodeOffset, PageRange, PropertyValue, RowIdx, TableId};

/// Metadata mapping a node group to its on-disk page range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeGroupPageInfo {
  pub group_idx:  NodeGroupIdx,
  pub page_range: PageRange,
}

/// Groups are append-only — when the current group fills, a new one is allocated.
pub struct NodeTable {
  table_id: TableId,
  label_id: LabelId,
  schema:   NodeLabelEntry,
  groups:   Vec<NodeGroup>,
  /// Dense offset = `group_idx * NODE_GROUP_SIZE + row_in_group` (CSR key).
  pub(crate) node_id_to_offset: HashMap<NodeId, NodeOffset>,
  page_infos:   Vec<NodeGroupPageInfo>,
  dirty_groups: HashSet<NodeGroupIdx>,
}

impl NodeTable {
  pub fn new(schema: NodeLabelEntry) -> Self {
    Self {
      table_id: schema.table_id,
      label_id: schema.label_id,
      schema,
      groups: Vec::new(),
      node_id_to_offset: HashMap::new(),
      page_infos: Vec::new(),
      dirty_groups: HashSet::new(),
    }
  }

  #[inline]
  pub fn table_id(&self) -> TableId {
    self.table_id
  }

  #[inline]
  pub fn label_id(&self) -> LabelId {
    self.label_id
  }

  pub fn insert_node(
    &mut self,
    node_id: NodeId,
    properties: &[Option<PropertyValue>],
  ) -> Result<(NodeGroupIdx, RowIdx), StorageError> {
    if self.groups.last().is_none_or(NodeGroup::is_full) {
      let idx = NodeGroupIdx(self.groups.len() as u64);
      self.groups.push(NodeGroup::new(idx, &self.schema));
    }
    let group = self.groups.last_mut().expect("just pushed if missing");
    let ng_idx = group.group_idx();
    let row = group.insert_row(node_id, properties)?;
    let offset = StorageConfig::NODE_GROUP_SIZE * ng_idx.0 + row;
    self.node_id_to_offset.insert(node_id, offset);
    self.dirty_groups.insert(ng_idx);
    Ok((ng_idx, row))
  }

  pub fn get_node(&self, node_id: NodeId) -> Result<Option<Vec<Option<PropertyValue>>>, StorageError> {
    let Some(&offset) = self.node_id_to_offset.get(&node_id) else {
      return Ok(None);
    };
    let (group_idx, row) = split_offset(offset);
    self.groups[group_idx].get_row(row)
  }

  pub fn delete_node(&mut self, node_id: NodeId) -> Result<(), StorageError> {
    let offset = self
      .node_id_to_offset
      .remove(&node_id)
      .ok_or(StorageError::NodeNotFound { node_id })?;
    let (group_idx, row) = split_offset(offset);
    let group = &mut self.groups[group_idx];
    self.dirty_groups.insert(group.group_idx());
    group.delete_row(row)
  }

  #[must_use]
  pub fn node_offset(&self, node_id: NodeId) -> Option<NodeOffset> {
    self.node_id_to_offset.get(&node_id).copied()
  }

  #[must_use]
  pub fn num_groups(&self) -> usize {
    self.groups.len()
  }

  #[must_use]
  pub fn num_nodes(&self) -> u64 {
    self.groups.iter().map(NodeGroup::num_live_rows).sum()
  }

  pub fn iter(&self) -> impl Iterator<Item = NodeRecord> + '_ {
    self.groups.iter().flat_map(|group| {
      (0..group.num_rows()).filter_map(move |row| {
        let properties = group.get_row(row).ok().flatten()?;
        let node_id = group
          .node_id_at(row)
          .expect("node_id_at must succeed for a row whose get_row returned Some");
        Some(NodeRecord { node_id, properties })
      })
    })
  }

  #[must_use]
  pub fn page_infos(&self) -> &[NodeGroupPageInfo] {
    &self.page_infos
  }

  pub fn flush(&mut self, fm: &mut FileManager) -> Result<(), StorageError> {
    let dirty: Vec<_> = self.dirty_groups.drain().collect();
    for ng_idx in dirty {
      let group = &self.groups[ng_idx.0 as usize];
      let pages = group.serialize_to_pages()?;
      let num_pages = pages.len() as u32;
      let start_page = fm.allocate_pages(pages.len() as u64)?;
      fm.write_page_range(start_page, &pages)?;
      self.upsert_page_info(ng_idx, PageRange { start_page, num_pages });
    }
    fm.sync()
  }

  pub fn load(
    schema: NodeLabelEntry,
    page_infos: Vec<NodeGroupPageInfo>,
    fm: &mut FileManager,
  ) -> Result<Self, StorageError> {
    let mut groups = Vec::with_capacity(page_infos.len());
    let mut node_id_to_offset = HashMap::new();

    for info in &page_infos {
      let pages = fm.read_page_range(info.page_range.start_page, info.page_range.num_pages)?;
      let group = NodeGroup::deserialize_from_pages(&schema, info.group_idx, &pages)?;
      for row in 0..group.num_rows() {
        if let Ok(Some(_)) = group.get_row(row)
          && let Ok(node_id) = group.node_id_at(row)
        {
          let offset = info.group_idx.0 * StorageConfig::NODE_GROUP_SIZE + row;
          node_id_to_offset.insert(node_id, offset);
        }
      }
      groups.push(group);
    }

    Ok(Self {
      table_id: schema.table_id,
      label_id: schema.label_id,
      schema,
      groups,
      node_id_to_offset,
      page_infos,
      dirty_groups: HashSet::new(),
    })
  }

  fn upsert_page_info(&mut self, group_idx: NodeGroupIdx, range: PageRange) {
    if let Some(info) = self.page_infos.iter_mut().find(|i| i.group_idx == group_idx) {
      info.page_range = range;
    } else {
      self.page_infos.push(NodeGroupPageInfo { group_idx, page_range: range });
    }
  }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeRecord {
  pub node_id:    NodeId,
  pub properties: Vec<Option<PropertyValue>>,
}

#[inline]
fn split_offset(offset: NodeOffset) -> (usize, RowIdx) {
  (
    (offset / StorageConfig::NODE_GROUP_SIZE) as usize,
    offset % StorageConfig::NODE_GROUP_SIZE,
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::catalog::PropertyDef;
  use crate::types::{ColumnId, DataType, LabelId, TableId};

  fn person_schema() -> NodeLabelEntry {
    NodeLabelEntry {
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
    }
  }

  fn pv(name: &str, age: i64) -> Vec<Option<PropertyValue>> {
    vec![Some(PropertyValue::String(name.into())), Some(PropertyValue::Int64(age))]
  }

  #[test]
  fn single_insert_and_get() {
    let mut table = NodeTable::new(person_schema());
    table.insert_node(NodeId(1), &pv("Alice", 30)).unwrap();
    let props = table.get_node(NodeId(1)).unwrap().unwrap();
    assert_eq!(props[0], Some(PropertyValue::String("Alice".into())));
    assert_eq!(props[1], Some(PropertyValue::Int64(30)));
  }

  #[test]
  fn delete_node() {
    let mut table = NodeTable::new(person_schema());
    table.insert_node(NodeId(1), &pv("Alice", 30)).unwrap();
    assert_eq!(table.num_nodes(), 1);
    table.delete_node(NodeId(1)).unwrap();
    assert_eq!(table.num_nodes(), 0);
    assert!(table.get_node(NodeId(1)).unwrap().is_none());
  }

  #[test]
  fn delete_missing_node_returns_error() {
    let mut table = NodeTable::new(person_schema());
    assert!(matches!(
      table.delete_node(NodeId(99)),
      Err(StorageError::NodeNotFound { node_id: NodeId(99) })
    ));
  }

  #[test]
  fn multi_group_overflow() {
    let schema = NodeLabelEntry {
      table_id:     TableId(0),
      label_id:     LabelId(0),
      name:         "T".into(),
      pk_column_id: ColumnId(0),
      properties:   vec![PropertyDef {
        name:      "flag".into(),
        column_id: ColumnId(0),
        data_type: DataType::Bool,
        nullable:  false,
      }],
    };
    let mut table = NodeTable::new(schema);
    let total = StorageConfig::NODE_GROUP_SIZE + 1;
    for i in 0..total {
      table.insert_node(NodeId(i), &[Some(PropertyValue::Bool(true))]).unwrap();
    }
    assert_eq!(table.num_groups(), 2);
    assert_eq!(table.num_nodes(), total);
  }

  #[test]
  fn scan_iterator_skips_deleted() {
    let mut table = NodeTable::new(person_schema());
    table.insert_node(NodeId(1), &pv("Alice", 30)).unwrap();
    table.insert_node(NodeId(2), &pv("Bob", 25)).unwrap();
    table.insert_node(NodeId(3), &pv("Carol", 40)).unwrap();
    table.delete_node(NodeId(2)).unwrap();

    let records: Vec<_> = table.iter().collect();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].node_id, NodeId(1));
    assert_eq!(records[1].node_id, NodeId(3));
  }

  #[test]
  fn scan_empty_table() {
    let table = NodeTable::new(person_schema());
    assert_eq!(table.iter().count(), 0);
  }
}
