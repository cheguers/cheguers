use crate::config::StorageConfig;
use crate::error::StorageError;
use crate::io::binary;
use crate::table::column::ColumnChunk;
use crate::types::{ColumnId, DataType, NodeId, PropertyValue, RowIdx};

pub struct ChunkedNodeGroup {
  start_row_idx: RowIdx,
  num_rows:      u64,
  capacity:      u64,
  columns:       Vec<ColumnChunk>,
  node_ids:      Vec<NodeId>,
  delete_mask:   Vec<bool>,
}

impl ChunkedNodeGroup {
  pub fn new(start_row_idx: RowIdx, schema_columns: &[(ColumnId, DataType)]) -> Self {
    let columns = schema_columns
      .iter()
      .map(|(column_id, data_type)| ColumnChunk::new(*column_id, data_type.clone()))
      .collect();
    Self {
      start_row_idx,
      num_rows: 0,
      capacity: StorageConfig::CHUNKED_NODE_GROUP_CAPACITY,
      columns,
      node_ids: Vec::with_capacity(StorageConfig::CHUNKED_NODE_GROUP_CAPACITY as usize),
      delete_mask: Vec::with_capacity(StorageConfig::CHUNKED_NODE_GROUP_CAPACITY as usize),
    }
  }

  #[must_use]
  pub fn start_row_idx(&self) -> RowIdx { self.start_row_idx }

  #[must_use]
  pub fn num_rows(&self) -> u64 { self.num_rows }

  #[must_use]
  pub fn num_live_rows(&self) -> u64 {
    self.delete_mask.iter().filter(|&&d| !d).count() as u64
  }

  #[must_use]
  pub fn is_full(&self) -> bool { self.num_rows >= self.capacity }

  #[must_use]
  pub fn end_row_idx(&self) -> RowIdx { self.start_row_idx + self.num_rows }

  #[must_use]
  pub fn contains(&self, row_idx: RowIdx) -> bool {
    row_idx >= self.start_row_idx && (row_idx - self.start_row_idx) < self.num_rows
  }

  pub fn insert_row(
    &mut self,
    node_id: NodeId,
    values: &[Option<PropertyValue>],
  ) -> Result<RowIdx, StorageError> {
    if self.is_full() {
      return Err(StorageError::NodeGroupFull);
    }

    self
      .columns
      .iter()
      .zip(values.iter().map(Option::as_ref).chain(std::iter::repeat(None)))
      .try_for_each(|(col, val)| val.map_or(Ok(()), |v| col.type_check(v)))?;

    self
      .columns
      .iter_mut()
      .zip(values.iter().map(Option::as_ref).chain(std::iter::repeat(None)))
      .try_for_each(|(col, val)| col.append_value(val))?;

    self.node_ids.push(node_id);
    self.delete_mask.push(false);
    let local_row = self.num_rows;
    self.num_rows += 1;
    Ok(self.start_row_idx + local_row)
  }

  pub fn get_row_local(
    &self,
    local_row: RowIdx,
  ) -> Result<Option<Vec<Option<PropertyValue>>>, StorageError> {
    if local_row >= self.num_rows {
      return Err(StorageError::RowOutOfBounds { row: local_row, len: self.num_rows });
    }
    if self.delete_mask[local_row as usize] {
      return Ok(None);
    }
    self
      .columns
      .iter()
      .map(|c| c.get(local_row))
      .collect::<Result<Vec<_>, _>>()
      .map(Some)
  }

  #[must_use]
  pub fn find_node_local(&self, node_id: NodeId) -> Option<RowIdx> {
    self
      .node_ids
      .iter()
      .zip(&self.delete_mask)
      .position(|(&id, &deleted)| id == node_id && !deleted)
      .map(|i| i as RowIdx)
  }

  pub fn node_id_at_local(&self, local_row: RowIdx) -> Result<NodeId, StorageError> {
    self
      .node_ids
      .get(local_row as usize)
      .copied()
      .ok_or(StorageError::RowOutOfBounds { row: local_row, len: self.num_rows })
  }

  pub fn delete_row_local(&mut self, local_row: RowIdx) -> Result<(), StorageError> {
    let slot = self
      .delete_mask
      .get_mut(local_row as usize)
      .ok_or(StorageError::RowOutOfBounds { row: local_row, len: self.num_rows })?;
    *slot = true;
    Ok(())
  }

  pub fn serialized_len(&self) -> usize {
    let header = 8 + 8 + 4 + self.columns.len() * 4;
    let node_ids = self.num_rows as usize * 8;
    let delete_mask = (self.num_rows as usize).div_ceil(8);
    let cols: usize = self.columns.iter().map(ColumnChunk::serialized_len).sum();
    header + node_ids + delete_mask + cols
  }

  pub fn serialize(&self, buf: &mut [u8]) -> Result<usize, StorageError> {
    let mut pos = 0;

    binary::write_u64(buf, &mut pos, self.start_row_idx);
    binary::write_u64(buf, &mut pos, self.num_rows);
    binary::write_u32(buf, &mut pos, self.columns.len() as u32);
    for col in &self.columns {
      binary::write_u32(buf, &mut pos, col.serialized_len() as u32);
    }
    for &id in &self.node_ids {
      binary::write_u64(buf, &mut pos, id.0);
    }
    binary::write_bytes(buf, &mut pos, &binary::pack_bitmask(&self.delete_mask));

    for col in &self.columns {
      let len = col.serialized_len();
      let written = col.serialize(&mut buf[pos..pos + len])?;
      pos += written;
    }

    Ok(pos)
  }

  pub fn deserialize(
    schema_columns: &[(ColumnId, DataType)],
    buf: &[u8],
  ) -> Result<Self, StorageError> {
    let mut pos = 0;

    let start_row_idx = binary::read_u64(buf, &mut pos);
    let num_rows = binary::read_u64(buf, &mut pos);
    let num_columns = binary::read_u32(buf, &mut pos) as usize;

    let column_lens: Vec<usize> = (0..num_columns)
      .map(|_| binary::read_u32(buf, &mut pos) as usize)
      .collect();
    let node_ids: Vec<NodeId> = (0..num_rows)
      .map(|_| NodeId(binary::read_u64(buf, &mut pos)))
      .collect();

    let mask_bytes = binary::read_bytes(buf, &mut pos, (num_rows as usize).div_ceil(8));
    let delete_mask = binary::unpack_bitmask(mask_bytes, num_rows as usize);

    let columns = schema_columns
      .iter()
      .enumerate()
      .map(|(i, (column_id, data_type))| {
        let len = column_lens.get(i).copied().unwrap_or(0);
        let chunk = ColumnChunk::deserialize(*column_id, data_type.clone(), &buf[pos..pos + len])?;
        pos += len;
        Ok(chunk)
      })
      .collect::<Result<Vec<_>, StorageError>>()?;

    Ok(Self {
      start_row_idx,
      num_rows,
      capacity: StorageConfig::CHUNKED_NODE_GROUP_CAPACITY,
      columns,
      node_ids,
      delete_mask,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::ColumnId;

  fn columns_schema() -> Vec<(ColumnId, DataType)> {
    vec![
      (ColumnId(0), DataType::String),
      (ColumnId(1), DataType::Int64),
    ]
  }

  fn person_values(name: &str, age: i64) -> Vec<Option<PropertyValue>> {
    vec![Some(PropertyValue::String(name.into())), Some(PropertyValue::Int64(age))]
  }

  #[test]
  fn insert_and_read_back_local() {
    let schema = columns_schema();
    let mut chunk = ChunkedNodeGroup::new(0, &schema);

    let global = chunk.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();
    assert_eq!(global, 0);

    let row = chunk.get_row_local(0).unwrap().unwrap();
    assert_eq!(row[0], Some(PropertyValue::String("Alice".into())));
    assert_eq!(row[1], Some(PropertyValue::Int64(30)));
  }

  #[test]
  fn find_node_local() {
    let schema = columns_schema();
    let mut chunk = ChunkedNodeGroup::new(0, &schema);
    chunk.insert_row(NodeId(10), &person_values("Bob", 25)).unwrap();
    chunk.insert_row(NodeId(20), &person_values("Carol", 40)).unwrap();

    assert_eq!(chunk.find_node_local(NodeId(10)), Some(0));
    assert_eq!(chunk.find_node_local(NodeId(20)), Some(1));
    assert_eq!(chunk.find_node_local(NodeId(99)), None);
  }

  #[test]
  fn delete_hides_row() {
    let schema = columns_schema();
    let mut chunk = ChunkedNodeGroup::new(0, &schema);
    chunk.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();
    chunk.insert_row(NodeId(2), &person_values("Bob", 25)).unwrap();

    assert_eq!(chunk.num_live_rows(), 2);
    chunk.delete_row_local(0).unwrap();
    assert_eq!(chunk.num_live_rows(), 1);
    assert!(chunk.get_row_local(0).unwrap().is_none());
    assert!(chunk.get_row_local(1).unwrap().is_some());
  }

  #[test]
  fn contains_check() {
    let schema = columns_schema();
    let mut chunk = ChunkedNodeGroup::new(100, &schema);
    chunk.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();
    chunk.insert_row(NodeId(2), &person_values("Bob", 25)).unwrap();

    assert!(chunk.contains(100));
    assert!(chunk.contains(101));
    assert!(!chunk.contains(99));
    assert!(!chunk.contains(102));
  }

  #[test]
  fn end_row_idx() {
    let schema = columns_schema();
    let mut chunk = ChunkedNodeGroup::new(0, &schema);
    assert_eq!(chunk.end_row_idx(), 0);
    chunk.insert_row(NodeId(1), &person_values("X", 0)).unwrap();
    chunk.insert_row(NodeId(2), &person_values("Y", 0)).unwrap();
    assert_eq!(chunk.end_row_idx(), 2);
  }

  #[test]
  fn is_full_at_capacity() {
    let schema = vec![(ColumnId(0), DataType::Bool)];
    let mut chunk = ChunkedNodeGroup::new(0, &schema);
    for i in 0..StorageConfig::CHUNKED_NODE_GROUP_CAPACITY {
      chunk.insert_row(NodeId(i), &[Some(PropertyValue::Bool(true))]).unwrap();
    }
    assert!(chunk.is_full());
    let result = chunk.insert_row(NodeId(u64::MAX), &[Some(PropertyValue::Bool(false))]);
    assert!(matches!(result, Err(StorageError::NodeGroupFull)));
  }

  #[test]
  fn type_mismatch_does_not_corrupt_chunk() {
    let schema = columns_schema();
    let mut chunk = ChunkedNodeGroup::new(0, &schema);
    chunk.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();

    // Second column expects Int64 — pass a Bool to trigger a type error.
    let bad = vec![
      Some(PropertyValue::String("X".into())),
      Some(PropertyValue::Bool(true)),
    ];
    let result = chunk.insert_row(NodeId(2), &bad);
    assert!(matches!(result, Err(StorageError::ColumnTypeMismatch { .. })));

    // Chunk must still be consistent: only the first row exists, all columns aligned.
    assert_eq!(chunk.num_rows(), 1);
    assert_eq!(chunk.num_live_rows(), 1);
    let row = chunk.get_row_local(0).unwrap().unwrap();
    assert_eq!(row[0], Some(PropertyValue::String("Alice".into())));
    assert_eq!(row[1], Some(PropertyValue::Int64(30)));
  }

  #[test]
  fn serde_roundtrip() {
    let schema = columns_schema();
    let mut chunk = ChunkedNodeGroup::new(10, &schema);
    chunk.insert_row(NodeId(1), &person_values("Alice", 30)).unwrap();
    chunk.insert_row(NodeId(2), &person_values("Bob", 25)).unwrap();
    chunk.insert_row(NodeId(3), &person_values("Carol", 40)).unwrap();
    chunk.delete_row_local(1).unwrap();

    let len = chunk.serialized_len();
    let mut buf = vec![0u8; len];
    let written = chunk.serialize(&mut buf).unwrap();
    assert_eq!(written, len);

    let restored = ChunkedNodeGroup::deserialize(&schema, &buf).unwrap();
    assert_eq!(restored.start_row_idx(), 10);
    assert_eq!(restored.num_rows(), 3);
    assert_eq!(restored.num_live_rows(), 2);
    assert!(restored.get_row_local(0).unwrap().is_some());
    assert!(restored.get_row_local(1).unwrap().is_none());
    assert!(restored.get_row_local(2).unwrap().is_some());
  }
}
