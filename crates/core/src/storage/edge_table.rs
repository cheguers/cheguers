use crate::catalog::EdgeTypeEntry;
use crate::storage::edge_group::{EdgeGroup, EdgeRecord};
use crate::storage::StorageError;
use crate::types::{EdgeId, LabelId, NodeGroupIdx, PropertyValue, RowIdx, TableId};

pub struct EdgeTable {
  table_id: TableId,
  type_id: LabelId,
  schema: EdgeTypeEntry,
  groups: Vec<EdgeGroup>,
}

impl EdgeTable {
  pub fn new(schema: EdgeTypeEntry) -> Self {
    Self {
      table_id: schema.table_id,
      type_id: schema.label_id,
      schema,
      groups: Vec::new(),
    }
  }

  pub fn table_id(&self) -> TableId {
    self.table_id
  }

  pub fn type_id(&self) -> LabelId {
    self.type_id
  }

  pub fn insert_edge(
    &mut self,
    edge_id: EdgeId,
    from: crate::types::NodeId,
    to: crate::types::NodeId,
    properties: &[Option<PropertyValue>],
  ) -> Result<(NodeGroupIdx, RowIdx), StorageError> {
    if self.groups.last().map(|g: &EdgeGroup| g.is_full()).unwrap_or(true) {
      let idx = NodeGroupIdx(self.groups.len() as u64);
      self.groups.push(EdgeGroup::new(idx, &self.schema));
    }
    let group_idx = self.groups.len() - 1;
    let row = self.groups[group_idx].insert_row(edge_id, from, to, properties)?;
    Ok((NodeGroupIdx(group_idx as u64), row))
  }

  pub fn get_edge(&self, edge_id: EdgeId) -> Result<Option<EdgeRecord>, StorageError> {
    for group in &self.groups {
      if let Some(row) = group.find_edge(edge_id) {
        return group.get_row(row);
      }
    }
    Ok(None)
  }

  pub fn delete_edge(&mut self, edge_id: EdgeId) -> Result<(), StorageError> {
    for group in self.groups.iter_mut() {
      if let Some(row) = group.find_edge(edge_id) {
        return group.delete_row(row);
      }
    }
    Err(StorageError::EdgeNotFound { edge_id })
  }

  pub fn num_groups(&self) -> usize {
    self.groups.len()
  }

  pub fn num_edges(&self) -> u64 {
    self.groups.iter().map(|g: &EdgeGroup| g.num_live_rows()).sum()
  }

  pub fn iter(&self) -> EdgeScanIter<'_> {
    EdgeScanIter {
      table: self,
      group_idx: 0,
      row_idx: 0,
    }
  }
}

pub struct EdgeScanIter<'a> {
  table: &'a EdgeTable,
  group_idx: usize,
  row_idx: u64,
}

impl<'a> Iterator for EdgeScanIter<'a> {
  type Item = EdgeRecord;

  fn next(&mut self) -> Option<Self::Item> {
    while self.group_idx < self.table.groups.len() {
      let group = &self.table.groups[self.group_idx];
      while self.row_idx < group.num_rows() {
        let row = self.row_idx;
        self.row_idx += 1;
        if let Ok(Some(record)) = group.get_row(row) {
          return Some(record);
        }
      }
      self.group_idx += 1;
      self.row_idx = 0;
    }
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn knows_schema() -> EdgeTypeEntry {
    EdgeTypeEntry {
      table_id: crate::types::TableId(1),
      label_id: crate::types::LabelId(1),
      name: "Knows".to_string(),
      from_label_id: crate::types::LabelId(0),
      to_label_id: crate::types::LabelId(0),
      properties: vec![crate::catalog::PropertyDef {
        name: "weight".to_string(),
        column_id: crate::types::ColumnId(0),
        data_type: crate::types::DataType::Float64,
        nullable: false,
      }],
    }
  }

  fn edge_values() -> Vec<Option<PropertyValue>> {
    vec![Some(PropertyValue::Float64(0.95))]
  }

  #[test]
  fn single_insert_and_get() {
    let mut table = EdgeTable::new(knows_schema());
    let edge_id = EdgeId(1);

    table
      .insert_edge(edge_id, crate::types::NodeId(10), crate::types::NodeId(20), &edge_values())
      .expect("insert");

    let record = table.get_edge(edge_id).expect("get").expect("found");
    assert_eq!(record.edge_id, edge_id);
  }

  #[test]
  fn delete_edge() {
    let mut table = EdgeTable::new(knows_schema());
    let edge_id = EdgeId(1);

    table
      .insert_edge(edge_id, crate::types::NodeId(10), crate::types::NodeId(20), &edge_values())
      .expect("insert");

    assert_eq!(table.num_edges(), 1);
    table.delete_edge(edge_id).expect("delete");
    assert_eq!(table.num_edges(), 0);

    let record = table.get_edge(edge_id).expect("get");
    assert_eq!(record, None);
  }

  #[test]
  fn delete_missing_edge_returns_error() {
    let mut table = EdgeTable::new(knows_schema());
    let err = table
      .delete_edge(EdgeId(999))
      .expect_err("should be not found");
    assert_eq!(
      err,
      StorageError::EdgeNotFound {
        edge_id: EdgeId(999)
      }
    );
  }

  #[test]
  fn multi_group_overflow() {
    let mut table = EdgeTable::new(knows_schema());

    for i in 0..crate::config::StorageConfig::NODE_GROUP_SIZE + 100 {
      table
        .insert_edge(
          EdgeId(i as u64),
          crate::types::NodeId(10),
          crate::types::NodeId(20),
          &edge_values(),
        )
        .expect("insert");
    }

    assert!(table.num_groups() > 1);
  }

  #[test]
  fn scan_iterator_skips_deleted() {
    let mut table = EdgeTable::new(knows_schema());

    for i in 0..5 {
      table
        .insert_edge(
          EdgeId(i),
          crate::types::NodeId(10),
          crate::types::NodeId(20),
          &edge_values(),
        )
        .expect("insert");
    }

    table.delete_edge(EdgeId(1)).expect("delete 1");
    table.delete_edge(EdgeId(3)).expect("delete 3");

    let collected: Vec<_> = table.iter().map(|r| r.edge_id).collect();
    assert_eq!(collected, vec![EdgeId(0), EdgeId(2), EdgeId(4)]);
  }

  #[test]
  fn scan_empty_table() {
    let table = EdgeTable::new(knows_schema());
    assert_eq!(table.iter().count(), 0);
  }
}
