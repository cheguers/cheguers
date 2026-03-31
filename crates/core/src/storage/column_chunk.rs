use crate::config::StorageConfig;
use crate::types::{ColumnId, DataType, PropertyValue, RowIdx};

use super::error::StorageError;

/// The underlying typed storage for a column chunk.
enum ColumnData {
  Bool(Vec<bool>),
  Int64(Vec<i64>),
  Float64(Vec<f64>),
  String(Vec<Option<String>>),
  Bytes(Vec<Option<Vec<u8>>>),
}

/// One typed column within a node group.
/// Stores up to NODE_GROUP_SIZE values, with a separate null mask.
pub struct ColumnChunk {
  column_id: ColumnId,
  data_type: DataType,
  data:      ColumnData,
  null_mask: Vec<bool>,
  num_rows:  u64,
}

impl ColumnChunk {
  #[must_use]
  pub fn new(column_id: ColumnId, data_type: DataType) -> Self {
    let data = match &data_type {
      DataType::Bool => ColumnData::Bool(Vec::new()),
      DataType::Int64 => ColumnData::Int64(Vec::new()),
      DataType::Float64 => ColumnData::Float64(Vec::new()),
      DataType::String => ColumnData::String(Vec::new()),
      DataType::Bytes | DataType::Vector { .. } => ColumnData::Bytes(Vec::new()),
    };
    Self { column_id, data_type, data, null_mask: Vec::new(), num_rows: 0 }
  }

  #[must_use]
  pub fn column_id(&self) -> ColumnId {
    self.column_id
  }

  #[must_use]
  pub fn data_type(&self) -> &DataType {
    &self.data_type
  }

  #[must_use]
  pub fn len(&self) -> u64 {
    self.num_rows
  }

  #[must_use]
  pub fn is_empty(&self) -> bool {
    self.num_rows == 0
  }

  #[must_use]
  pub fn is_full(&self) -> bool {
    self.num_rows >= StorageConfig::NODE_GROUP_SIZE
  }

  #[must_use]
  pub fn is_null(&self, row: RowIdx) -> bool {
    self.null_mask.get(row as usize).copied().unwrap_or(false)
  }

  /// Append a value (or null) to this column.
  /// Returns `StorageError::NodeGroupFull` if at capacity.
  /// Returns `StorageError::ColumnTypeMismatch` if the value type doesn't match.
  pub fn append_value(&mut self, value: Option<&PropertyValue>) -> Result<(), StorageError> {
    if self.is_full() {
      return Err(StorageError::NodeGroupFull);
    }
    match value {
      None => {
        self.null_mask.push(true);
        self.push_default();
      }
      Some(v) => {
        self.type_check(v)?;
        self.null_mask.push(false);
        self.push_value(v);
      }
    }
    self.num_rows += 1;
    Ok(())
  }

  /// Retrieve a value at the given row index. Returns `None` if null.
  #[must_use = "ignoring a value read is a bug"]
  pub fn get(&self, row: RowIdx) -> Result<Option<PropertyValue>, StorageError> {
    if row >= self.num_rows {
      return Err(StorageError::RowOutOfBounds { row, len: self.num_rows });
    }
    if self.null_mask[row as usize] {
      return Ok(None);
    }
    Ok(Some(self.read_value(row)))
  }

  fn type_check(&self, value: &PropertyValue) -> Result<(), StorageError> {
    // Vector columns accept Bytes values (raw-encoded float arrays).
    let compatible = matches!(
      (&self.data_type, value.data_type()),
      (DataType::Vector { .. }, DataType::Bytes)
    ) || self.data_type == value.data_type();

    if !compatible {
      return Err(StorageError::ColumnTypeMismatch {
        expected: self.data_type.clone(),
        got:      value.data_type(),
      });
    }
    Ok(())
  }

  fn push_default(&mut self) {
    match &mut self.data {
      ColumnData::Bool(v) => v.push(false),
      ColumnData::Int64(v) => v.push(0),
      ColumnData::Float64(v) => v.push(0.0),
      ColumnData::String(v) => v.push(None),
      ColumnData::Bytes(v) => v.push(None),
    }
  }

  fn push_value(&mut self, value: &PropertyValue) {
    match (&mut self.data, value) {
      (ColumnData::Bool(v), PropertyValue::Bool(b)) => v.push(*b),
      (ColumnData::Int64(v), PropertyValue::Int64(n)) => v.push(*n),
      (ColumnData::Float64(v), PropertyValue::Float64(x)) => v.push(*x),
      (ColumnData::String(v), PropertyValue::String(s)) => v.push(Some(s.clone())),
      (ColumnData::Bytes(v), PropertyValue::Bytes(b)) => v.push(Some(b.clone())),
      _ => unreachable!("type_check should have caught this"),
    }
  }

  fn read_value(&self, row: RowIdx) -> PropertyValue {
    let i = row as usize;
    match &self.data {
      ColumnData::Bool(v) => PropertyValue::Bool(v[i]),
      ColumnData::Int64(v) => PropertyValue::Int64(v[i]),
      ColumnData::Float64(v) => PropertyValue::Float64(v[i]),
      ColumnData::String(v) => {
        PropertyValue::String(v[i].clone().expect("non-null row had None in String data"))
      }
      ColumnData::Bytes(v) => {
        PropertyValue::Bytes(v[i].clone().expect("non-null row had None in Bytes data"))
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn int64_chunk() -> ColumnChunk {
    ColumnChunk::new(ColumnId(0), DataType::Int64)
  }

  #[test]
  fn append_and_read_back() {
    let mut chunk = int64_chunk();
    for i in 0i64..10 {
      chunk.append_value(Some(&PropertyValue::Int64(i))).unwrap();
    }
    assert_eq!(chunk.len(), 10);
    for i in 0u64..10 {
      assert_eq!(chunk.get(i).unwrap(), Some(PropertyValue::Int64(i as i64)));
    }
  }

  #[test]
  fn null_handling() {
    let mut chunk = int64_chunk();
    chunk.append_value(Some(&PropertyValue::Int64(42))).unwrap();
    chunk.append_value(None).unwrap();
    chunk.append_value(Some(&PropertyValue::Int64(99))).unwrap();

    assert!(!chunk.is_null(0));
    assert!(chunk.is_null(1));
    assert!(!chunk.is_null(2));

    assert_eq!(chunk.get(0).unwrap(), Some(PropertyValue::Int64(42)));
    assert_eq!(chunk.get(1).unwrap(), None);
    assert_eq!(chunk.get(2).unwrap(), Some(PropertyValue::Int64(99)));
  }

  #[test]
  fn type_mismatch_returns_error() {
    let mut chunk = int64_chunk();
    let result = chunk.append_value(Some(&PropertyValue::Bool(true)));
    assert!(matches!(result, Err(StorageError::ColumnTypeMismatch { .. })));
  }

  #[test]
  fn row_out_of_bounds_returns_error() {
    let chunk = int64_chunk();
    assert!(matches!(
      chunk.get(0),
      Err(StorageError::RowOutOfBounds { row: 0, len: 0 })
    ));
  }

  #[test]
  fn is_full_at_capacity() {
    let mut chunk = ColumnChunk::new(ColumnId(0), DataType::Bool);
    for _ in 0..StorageConfig::NODE_GROUP_SIZE {
      chunk.append_value(Some(&PropertyValue::Bool(true))).unwrap();
    }
    assert!(chunk.is_full());
    let result = chunk.append_value(Some(&PropertyValue::Bool(false)));
    assert!(matches!(result, Err(StorageError::NodeGroupFull)));
  }
}
