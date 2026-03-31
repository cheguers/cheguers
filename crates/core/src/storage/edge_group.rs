use crate::catalog::EdgeTypeEntry;
use crate::config::StorageConfig;
use crate::storage::column_chunk::ColumnChunk;
use crate::storage::StorageError;
use crate::types::{EdgeId, NodeGroupIdx, NodeId, PropertyValue, RowIdx};

#[derive(Debug, Clone, PartialEq)]
pub struct EdgeRecord {
  pub edge_id: EdgeId,
  pub from: NodeId,
  pub to: NodeId,
  pub properties: Vec<Option<PropertyValue>>,
}

pub struct EdgeGroup {
  group_idx: NodeGroupIdx,
  num_rows: u64,
  edge_ids: Vec<EdgeId>,
  from_ids: Vec<NodeId>,
  to_ids: Vec<NodeId>,
  columns: Vec<ColumnChunk>,
  delete_mask: Vec<bool>,
}

impl EdgeGroup {
  pub fn new(group_idx: NodeGroupIdx, schema: &EdgeTypeEntry) -> Self {
    let columns = schema
      .properties
      .iter()
      .enumerate()
      .map(|(i, prop)| {
        ColumnChunk::new(
          crate::types::ColumnId(i as u32),
          prop.data_type.clone(),
        )
      })
      .collect();

    Self {
      group_idx,
      num_rows: 0,
      edge_ids: Vec::new(),
      from_ids: Vec::new(),
      to_ids: Vec::new(),
      columns,
      delete_mask: Vec::new(),
    }
  }

  pub fn group_idx(&self) -> NodeGroupIdx {
    self.group_idx
  }

  pub fn num_rows(&self) -> u64 {
    self.num_rows
  }

  pub fn num_live_rows(&self) -> u64 {
    self.delete_mask.iter().filter(|&&deleted| !deleted).count() as u64
  }

  pub fn is_full(&self) -> bool {
    self.num_rows >= StorageConfig::NODE_GROUP_SIZE
  }

  pub fn insert_row(
    &mut self,
    edge_id: EdgeId,
    from: NodeId,
    to: NodeId,
    values: &[Option<PropertyValue>],
  ) -> Result<RowIdx, StorageError> {
    if self.is_full() {
      return Err(StorageError::EdgeGroupFull);
    }

    for (i, chunk) in self.columns.iter_mut().enumerate() {
      let val = values.get(i).and_then(|opt_v| opt_v.as_ref());
      chunk.append_value(val)?;
    }

    self.edge_ids.push(edge_id);
    self.from_ids.push(from);
    self.to_ids.push(to);
    self.delete_mask.push(false);
    let row = self.num_rows;
    self.num_rows += 1;
    Ok(row)
  }

  pub fn get_row(&self, row: RowIdx) -> Result<Option<EdgeRecord>, StorageError> {
    if row >= self.num_rows {
      return Err(StorageError::RowOutOfBounds {
        row,
        len: self.num_rows,
      });
    }

    if self.delete_mask[row as usize] {
      return Ok(None);
    }

    let mut properties: Vec<Option<PropertyValue>> = Vec::new();
    for chunk in &self.columns {
      properties.push(chunk.get(row)?);
    }

    Ok(Some(EdgeRecord {
      edge_id: self.edge_ids[row as usize],
      from: self.from_ids[row as usize],
      to: self.to_ids[row as usize],
      properties,
    }))
  }

  pub fn find_edge(&self, edge_id: EdgeId) -> Option<RowIdx> {
    self
      .edge_ids
      .iter()
      .enumerate()
      .find(|(i, id)| **id == edge_id && !self.delete_mask[*i])
      .map(|(i, _)| i as u64)
  }

  pub fn edge_id_at(&self, row: RowIdx) -> Result<EdgeId, StorageError> {
    if row >= self.num_rows {
      return Err(StorageError::RowOutOfBounds {
        row,
        len: self.num_rows,
      });
    }
    Ok(self.edge_ids[row as usize])
  }

  pub fn delete_row(&mut self, row: RowIdx) -> Result<(), StorageError> {
    if row >= self.num_rows {
      return Err(StorageError::RowOutOfBounds {
        row,
        len: self.num_rows,
      });
    }
    self.delete_mask[row as usize] = true;
    Ok(())
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
  fn insert_and_read_back() {
    let mut group = EdgeGroup::new(NodeGroupIdx(0), &knows_schema());
    let edge_id = EdgeId(1);
    let from = NodeId(10);
    let to = NodeId(20);

    let row = group
      .insert_row(edge_id, from, to, &edge_values())
      .expect("insert");
    assert_eq!(row, 0);

    let record = group.get_row(row).expect("get_row").expect("not deleted");
    assert_eq!(record.edge_id, edge_id);
    assert_eq!(record.from, from);
    assert_eq!(record.to, to);
    assert_eq!(record.properties[0], Some(PropertyValue::Float64(0.95)));
  }

  #[test]
  fn find_edge() {
    let mut group = EdgeGroup::new(NodeGroupIdx(0), &knows_schema());
    let edge_id = EdgeId(1);

    group
      .insert_row(edge_id, NodeId(10), NodeId(20), &edge_values())
      .expect("insert");

    let row = group.find_edge(edge_id).expect("find");
    assert_eq!(row, 0);

    assert_eq!(group.find_edge(EdgeId(999)), None);
  }

  #[test]
  fn delete_hides_row() {
    let mut group = EdgeGroup::new(NodeGroupIdx(0), &knows_schema());
    let edge_id = EdgeId(1);

    let row = group
      .insert_row(edge_id, NodeId(10), NodeId(20), &edge_values())
      .expect("insert");

    assert_eq!(group.num_live_rows(), 1);
    group.delete_row(row).expect("delete");
    assert_eq!(group.num_live_rows(), 0);

    let record = group.get_row(row).expect("get_row");
    assert_eq!(record, None);

    let found = group.find_edge(edge_id);
    assert_eq!(found, None);
  }

  #[test]
  fn delete_out_of_bounds_returns_error() {
    let mut group = EdgeGroup::new(NodeGroupIdx(0), &knows_schema());
    let err = group.delete_row(0).expect_err("should error");
    assert_eq!(
      err,
      StorageError::RowOutOfBounds {
        row: 0,
        len: 0
      }
    );
  }

  #[test]
  fn full_group_rejects_insert() {
    let mut group = EdgeGroup::new(NodeGroupIdx(0), &knows_schema());

    for i in 0..StorageConfig::NODE_GROUP_SIZE {
      let edge_id = EdgeId(i as u64);
      group
        .insert_row(edge_id, NodeId(10), NodeId(20), &edge_values())
        .expect("insert");
    }

    assert!(group.is_full());
    let err = group
      .insert_row(
        EdgeId(StorageConfig::NODE_GROUP_SIZE as u64),
        NodeId(10),
        NodeId(20),
        &edge_values(),
      )
      .expect_err("should be full");
    assert_eq!(err, StorageError::EdgeGroupFull);
  }

  #[test]
  fn zero_property_schema() {
    let schema = EdgeTypeEntry {
      table_id: crate::types::TableId(1),
      label_id: crate::types::LabelId(1),
      name: "Links".to_string(),
      from_label_id: crate::types::LabelId(0),
      to_label_id: crate::types::LabelId(0),
      properties: vec![],
    };

    let mut group = EdgeGroup::new(NodeGroupIdx(0), &schema);
    let row = group
      .insert_row(EdgeId(1), NodeId(10), NodeId(20), &[])
      .expect("insert");

    let record = group.get_row(row).expect("get_row").expect("not deleted");
    assert_eq!(record.edge_id, EdgeId(1));
    assert_eq!(record.from, NodeId(10));
    assert_eq!(record.to, NodeId(20));
    assert!(record.properties.is_empty());
  }
}
