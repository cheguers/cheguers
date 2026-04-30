use crate::catalog::NodeLabelEntry;
use crate::config::StorageConfig;
use crate::types::{NodeGroupIdx, NodeId, PropertyValue, RowIdx};

use crate::table::column::ColumnChunk;
use crate::error::StorageError;
use crate::io::page::Page;
use crate::io::binary;

/// A node group holds up to NODE_GROUP_SIZE rows for a single node label.
/// Columns are stored columnar — one ColumnChunk per property in the schema.
/// `node_ids` is a dense array enabling ID→row lookup (linear scan, v0).
/// `delete_mask` supports soft-deletes without compaction.
pub struct NodeGroup {
  group_idx:   NodeGroupIdx,
  num_rows:    u64,
  columns:     Vec<ColumnChunk>,
  node_ids:    Vec<NodeId>,
  delete_mask: Vec<bool>,
}

impl NodeGroup {
  pub fn new(group_idx: NodeGroupIdx, schema: &NodeLabelEntry) -> Self {
    let columns = schema
      .properties
      .iter()
      .map(|p| ColumnChunk::new(p.column_id, p.data_type.clone()))
      .collect();
    Self { group_idx, num_rows: 0, columns, node_ids: Vec::new(), delete_mask: Vec::new() }
  }

  #[must_use]
  pub fn group_idx(&self) -> NodeGroupIdx {
    self.group_idx
  }

  #[must_use]
  pub fn num_rows(&self) -> u64 {
    self.num_rows
  }

  #[must_use]
  pub fn num_live_rows(&self) -> u64 {
    self.delete_mask.iter().filter(|&&d| !d).count() as u64
  }

  #[must_use]
  pub fn is_full(&self) -> bool {
    self.columns.first().map(|c| c.is_full()).unwrap_or(false)
      || self.num_rows >= StorageConfig::NODE_GROUP_SIZE
  }

  /// Insert a row. `values` must be aligned to the schema's property list (positional).
  /// Returns the RowIdx within this group.
  pub fn insert_row(
    &mut self,
    node_id: NodeId,
    values: &[Option<PropertyValue>],
  ) -> Result<RowIdx, StorageError> {
    if self.is_full() {
      return Err(StorageError::NodeGroupFull);
    }
    for (i, chunk) in self.columns.iter_mut().enumerate() {
      chunk.append_value(values.get(i).and_then(|v| v.as_ref()))?;
    }
    self.node_ids.push(node_id);
    self.delete_mask.push(false);
    let row = self.num_rows;
    self.num_rows += 1;
    Ok(row)
  }

  /// Read all column values for a row. Returns `Ok(None)` if the row is soft-deleted.
  pub fn get_row(&self, row: RowIdx) -> Result<Option<Vec<Option<PropertyValue>>>, StorageError> {
    if row >= self.num_rows {
      return Err(StorageError::RowOutOfBounds { row, len: self.num_rows });
    }
    if self.delete_mask[row as usize] {
      return Ok(None);
    }
    let values = self
      .columns
      .iter()
      .map(|c| c.get(row))
      .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(values))
  }

  /// Linear scan for a NodeId within this group. Returns the RowIdx if found and not deleted.
  #[must_use]
  pub fn find_node(&self, node_id: NodeId) -> Option<RowIdx> {
    self.node_ids.iter().enumerate().find_map(|(i, &id)| {
      if id == node_id && !self.delete_mask[i] {
        Some(i as RowIdx)
      } else {
        None
      }
    })
  }

  /// Returns the NodeId stored at `row`, or `RowOutOfBounds` if the index is invalid.
  pub fn node_id_at(&self, row: RowIdx) -> Result<NodeId, StorageError> {
    self
      .node_ids
      .get(row as usize)
      .copied()
      .ok_or(StorageError::RowOutOfBounds { row, len: self.num_rows })
  }

  /// Soft-delete a row. Returns `RowOutOfBounds` if the row index is invalid.
  pub fn delete_row(&mut self, row: RowIdx) -> Result<(), StorageError> {
    if row as usize >= self.delete_mask.len() {
      return Err(StorageError::RowOutOfBounds { row, len: self.num_rows });
    }
    self.delete_mask[row as usize] = true;
    Ok(())
  }

  fn compute_serialized_size(&self) -> usize {
    let header = 8 + 8 + 4 + 4 + (self.columns.len() * 4);
    let node_ids = (self.num_rows as usize) * 8;
    let delete_mask = (self.num_rows as usize).div_ceil(8);
    let cols: usize = self.columns.iter().map(|c| c.serialized_len()).sum();
    header + node_ids + delete_mask + cols
  }

  pub fn serialize_to_pages(&self) -> Result<Vec<Page>, StorageError> {
    let total = self.compute_serialized_size();
    let mut buf = vec![0u8; total];
    let mut pos = 0usize;

    binary::write_u64(&mut buf, &mut pos, self.group_idx.0);
    binary::write_u64(&mut buf, &mut pos, self.num_rows);
    binary::write_u32(&mut buf, &mut pos, self.num_live_rows() as u32);
    binary::write_u32(&mut buf, &mut pos, self.columns.len() as u32);
    for col in &self.columns {
      binary::write_u32(&mut buf, &mut pos, col.serialized_len() as u32);
    }
    for &id in &self.node_ids {
      binary::write_u64(&mut buf, &mut pos, id.0);
    }

    let mask_bytes = binary::pack_bitmask(&self.delete_mask);
    binary::write_bytes(&mut buf, &mut pos, &mask_bytes);

    for col in &self.columns {
      let len = col.serialized_len();
      let written = col.serialize(&mut buf[pos..pos + len])?;
      pos += written;
    }

    Ok(Self::split_into_pages(&buf))
  }

  pub fn deserialize_from_pages(
    schema: &NodeLabelEntry,
    group_idx: NodeGroupIdx,
    pages: &[Page],
  ) -> Result<Self, StorageError> {
    let buf: Vec<u8> = pages.iter().flat_map(|p| p.to_vec()).collect();
    let mut pos = 0usize;

    let _disk_group_idx = binary::read_u64(&buf, &mut pos);
    let num_rows = binary::read_u64(&buf, &mut pos);
    let _num_live = binary::read_u32(&buf, &mut pos);
    let num_columns = binary::read_u32(&buf, &mut pos) as usize;
    let mut column_lens = Vec::with_capacity(num_columns);
    for _ in 0..num_columns {
      column_lens.push(binary::read_u32(&buf, &mut pos) as usize);
    }
    let mut node_ids = Vec::with_capacity(num_rows as usize);
    for _ in 0..num_rows {
      node_ids.push(NodeId(binary::read_u64(&buf, &mut pos)));
    }

    let mask_len = (num_rows as usize).div_ceil(8);
    let mask_bytes = binary::read_bytes(&buf, &mut pos, mask_len);
    let delete_mask = binary::unpack_bitmask(mask_bytes, num_rows as usize);

    let mut columns = Vec::with_capacity(schema.properties.len());
    for (i, prop) in schema.properties.iter().enumerate() {
      let len = column_lens.get(i).copied().unwrap_or(0);
      let chunk = ColumnChunk::deserialize(prop.column_id, prop.data_type.clone(), &buf[pos..pos + len])?;
      pos += len;
      columns.push(chunk);
    }

    Ok(Self { group_idx, num_rows, columns, node_ids, delete_mask })
  }

  fn split_into_pages(buf: &[u8]) -> Vec<Page> {
    let page_size = StorageConfig::PAGE_SIZE as usize;
    buf.chunks(page_size).map(Page::from_bytes).collect()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::catalog::{NodeLabelEntry, PropertyDef};
  use crate::types::DataType;
  use crate::types::{ColumnId, LabelId, TableId};

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

  fn person_values(name: &str, age: i64) -> Vec<Option<PropertyValue>> {
    vec![Some(PropertyValue::String(name.into())), Some(PropertyValue::Int64(age))]
  }

  #[test]
  fn insert_and_read_back() {
    let schema = person_schema();
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);

    let row = group.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();
    assert_eq!(row, 0);

    let values = group.get_row(0).unwrap().unwrap();
    assert_eq!(values[0], Some(PropertyValue::String("Alice".into())));
    assert_eq!(values[1], Some(PropertyValue::Int64(30)));
  }

  #[test]
  fn find_node() {
    let schema = person_schema();
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);
    group.insert_row(NodeId(10), &person_values("Bob", 25)).unwrap();
    group.insert_row(NodeId(20), &person_values("Carol", 40)).unwrap();

    assert_eq!(group.find_node(NodeId(10)), Some(0));
    assert_eq!(group.find_node(NodeId(20)), Some(1));
    assert_eq!(group.find_node(NodeId(99)), None);
  }

  #[test]
  fn delete_hides_row() {
    let schema = person_schema();
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);
    group.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();
    group.insert_row(NodeId(2), &person_values("Bob", 25)).unwrap();

    assert_eq!(group.num_live_rows(), 2);
    group.delete_row(0).unwrap();
    assert_eq!(group.num_live_rows(), 1);

    assert_eq!(group.get_row(0).unwrap(), None);
    assert_eq!(group.find_node(NodeId(1)), None);
    assert!(group.get_row(1).unwrap().is_some());
  }

  #[test]
  fn delete_out_of_bounds_returns_error() {
    let schema = person_schema();
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);
    assert!(matches!(
      group.delete_row(0),
      Err(StorageError::RowOutOfBounds { .. })
    ));
  }

  #[test]
  fn full_group_rejects_insert() {
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
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);
    for i in 0..StorageConfig::NODE_GROUP_SIZE {
      group
        .insert_row(NodeId(i), &[Some(PropertyValue::Bool(true))])
        .unwrap();
    }
    assert!(group.is_full());
    let result = group.insert_row(NodeId(u64::MAX), &[Some(PropertyValue::Bool(false))]);
    assert!(matches!(result, Err(StorageError::NodeGroupFull)));
  }

  #[test]
  fn serde_roundtrip() {
    let schema = person_schema();
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);
    group.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();
    group.insert_row(NodeId(2), &person_values("Bob", 25)).unwrap();
    group.insert_row(NodeId(3), &person_values("Carol", 40)).unwrap();

    let pages = group.serialize_to_pages().unwrap();
    let restored = NodeGroup::deserialize_from_pages(&schema, NodeGroupIdx(0), &pages).unwrap();

    assert_eq!(restored.num_rows(), 3);
    assert_eq!(restored.num_live_rows(), 3);
    assert_eq!(restored.find_node(NodeId(1)), Some(0));
    assert_eq!(restored.find_node(NodeId(3)), Some(2));

    let row0 = restored.get_row(0).unwrap().unwrap();
    assert_eq!(row0[0], Some(PropertyValue::String("Alice".into())));
    assert_eq!(row0[1], Some(PropertyValue::Int64(30)));
  }

  #[test]
  fn serde_with_deletes() {
    let schema = person_schema();
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);
    group.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();
    group.insert_row(NodeId(2), &person_values("Bob", 25)).unwrap();
    group.delete_row(0).unwrap();

    let pages = group.serialize_to_pages().unwrap();
    let restored = NodeGroup::deserialize_from_pages(&schema, NodeGroupIdx(0), &pages).unwrap();

    assert_eq!(restored.num_rows(), 2);
    assert_eq!(restored.num_live_rows(), 1);
    assert_eq!(restored.get_row(0).unwrap(), None); // deleted
    assert!(restored.get_row(1).unwrap().is_some());
    assert_eq!(restored.find_node(NodeId(1)), None);
  }

  #[test]
  fn serde_empty_group() {
    let schema = person_schema();
    let group = NodeGroup::new(NodeGroupIdx(5), &schema);
    let pages = group.serialize_to_pages().unwrap();
    assert!(!pages.is_empty());
    let restored = NodeGroup::deserialize_from_pages(&schema, NodeGroupIdx(5), &pages).unwrap();
    assert_eq!(restored.num_rows(), 0);
  }
}
