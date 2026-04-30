use crate::config::StorageConfig;
use crate::types::{ColumnId, DataType, PropertyValue, RowIdx};

use crate::error::StorageError;
use crate::io::binary;

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

  /// How many bytes needed to serialize this column.
  #[must_use]
  pub fn serialized_len(&self) -> usize {
    let base = 4 + self.null_mask.len().div_ceil(8); // num_rows + null_mask
    let num = self.num_rows as usize;
    base + match &self.data {
      ColumnData::Bool(_) => num,
      ColumnData::Int64(_) => num * 8,
      ColumnData::Float64(_) => num * 8,
      ColumnData::String(v) => {
        let offsets_size = (num + 1) * 4;
        let data_size: usize = v.iter().map(|s| s.as_ref().map(|s| s.len()).unwrap_or(0)).sum();
        offsets_size + data_size
      }
      ColumnData::Bytes(v) => {
        let offsets_size = (num + 1) * 4;
        let data_size: usize = v.iter().map(|b| b.as_ref().map(|b| b.len()).unwrap_or(0)).sum();
        offsets_size + data_size
      }
    }
  }

  /// Serialize this column into a byte buffer. Returns bytes written.
  /// Format: [num_rows: u32] [null_mask: bit-packed] [data...]
  pub fn serialize(&self, buf: &mut [u8]) -> Result<usize, StorageError> {
    let mut pos = 0usize;
    binary::write_u32(buf, &mut pos, self.num_rows as u32);

    let null_bytes = binary::pack_bitmask(&self.null_mask);
    binary::write_bytes(buf, &mut pos, &null_bytes);

    match &self.data {
      ColumnData::Bool(v) => {
        for &b in v {
          binary::write_u8(buf, &mut pos, u8::from(b));
        }
      }
      ColumnData::Int64(v) => {
        for &n in v {
          binary::write_i64(buf, &mut pos, n);
        }
      }
      ColumnData::Float64(v) => {
        for &x in v {
          binary::write_f64(buf, &mut pos, x);
        }
      }
      ColumnData::String(v) => self.serialize_var_width(buf, &mut pos, v, |s| s.as_bytes()),
      ColumnData::Bytes(v) => self.serialize_var_width(buf, &mut pos, v, |b| b.as_slice()),
    }

    Ok(pos)
  }

  /// Deserialize from a byte buffer.
  pub fn deserialize(column_id: ColumnId, data_type: DataType, buf: &[u8]) -> Result<Self, StorageError> {
    if buf.len() < 4 {
      return Err(StorageError::SerDe("buffer too short for num_rows".into()));
    }
    let mut pos = 0usize;
    let num_rows = binary::read_u32(buf, &mut pos) as u64;

    let null_bytes_len = (num_rows as usize).div_ceil(8);
    let null_bytes = binary::read_bytes(buf, &mut pos, null_bytes_len);
    let null_mask = binary::unpack_bitmask(null_bytes, num_rows as usize);

    let data = match &data_type {
      DataType::Bool => {
        let mut v = Vec::with_capacity(num_rows as usize);
        for _ in 0..num_rows {
          v.push(binary::read_u8(buf, &mut pos) != 0);
        }
        ColumnData::Bool(v)
      }
      DataType::Int64 => {
        let mut v = Vec::with_capacity(num_rows as usize);
        for _ in 0..num_rows {
          v.push(binary::read_i64(buf, &mut pos));
        }
        ColumnData::Int64(v)
      }
      DataType::Float64 => {
        let mut v = Vec::with_capacity(num_rows as usize);
        for _ in 0..num_rows {
          v.push(binary::read_f64(buf, &mut pos));
        }
        ColumnData::Float64(v)
      }
      DataType::String => {
        let v = Self::deserialize_var_width_str(buf, &mut pos, num_rows)?;
        ColumnData::String(v)
      }
      DataType::Bytes | DataType::Vector { .. } => {
        let v = Self::deserialize_var_width_bytes(buf, &mut pos, num_rows)?;
        ColumnData::Bytes(v)
      }
    };

    Ok(Self { column_id, data_type, data, null_mask, num_rows })
  }

  fn serialize_var_width<T>(
    &self,
    buf: &mut [u8],
    pos: &mut usize,
    values: &[Option<T>],
    to_bytes: impl Fn(&T) -> &[u8],
  ) {
    let num = values.len();
    let offsets_start = *pos;

    // Write placeholder u32 offsets — filled in below.
    for _ in 0..num + 1 {
      binary::write_u32(buf, pos, 0);
    }

    let data_start = *pos;
    for (i, val) in values.iter().enumerate() {
      let off = (*pos - data_start) as u32;
      let off_pos = offsets_start + i * 4;
      buf[off_pos..off_pos + 4].copy_from_slice(&off.to_le_bytes());

      if let Some(v) = val {
        binary::write_bytes(buf, pos, to_bytes(v));
      }
    }
    // Sentinel offset
    let sentinel = (*pos - data_start) as u32;
    let sentinel_pos = offsets_start + num * 4;
    buf[sentinel_pos..sentinel_pos + 4].copy_from_slice(&sentinel.to_le_bytes());
  }

  fn deserialize_var_width_str(buf: &[u8], pos: &mut usize, num_rows: u64) -> Result<Vec<Option<String>>, StorageError> {
    let offsets = Self::read_offset_array(buf, pos, num_rows)?;
    let data_start = *pos;
    let mut values = Vec::with_capacity(num_rows as usize);
    for i in 0..num_rows as usize {
      let start = offsets[i] as usize;
      let end = offsets[i + 1] as usize;
      if start == end {
        values.push(Some(String::new()));
      } else {
        let bytes = &buf[data_start + start..data_start + end];
        let s = String::from_utf8(bytes.to_vec())
          .map_err(|e| StorageError::SerDe(format!("invalid UTF-8: {e}")))?;
        values.push(Some(s));
      }
    }
    *pos = data_start + offsets[num_rows as usize] as usize;
    Ok(values)
  }

  fn deserialize_var_width_bytes(buf: &[u8], pos: &mut usize, num_rows: u64) -> Result<Vec<Option<Vec<u8>>>, StorageError> {
    let offsets = Self::read_offset_array(buf, pos, num_rows)?;
    let data_start = *pos;
    let mut values = Vec::with_capacity(num_rows as usize);
    for i in 0..num_rows as usize {
      let start = offsets[i] as usize;
      let end = offsets[i + 1] as usize;
      if start == end {
        values.push(Some(Vec::new()));
      } else {
        values.push(Some(buf[data_start + start..data_start + end].to_vec()));
      }
    }
    *pos = data_start + offsets[num_rows as usize] as usize;
    Ok(values)
  }

  fn read_offset_array(buf: &[u8], pos: &mut usize, num_rows: u64) -> Result<Vec<u32>, StorageError> {
    let count = (num_rows + 1) as usize;
    let mut offsets = Vec::with_capacity(count);
    for _ in 0..count {
      offsets.push(binary::read_u32(buf, pos));
    }
    Ok(offsets)
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

  #[test]
  fn serde_int64_roundtrip() {
    let mut chunk = int64_chunk();
    for i in 0i64..10 {
      chunk.append_value(Some(&PropertyValue::Int64(i))).unwrap();
    }
    chunk.append_value(None).unwrap();
    chunk.append_value(Some(&PropertyValue::Int64(99))).unwrap();

    let len = chunk.serialized_len();
    let mut buf = vec![0u8; len];
    let written = chunk.serialize(&mut buf).unwrap();
    assert_eq!(written, len);

    let restored = ColumnChunk::deserialize(ColumnId(0), DataType::Int64, &buf).unwrap();
    assert_eq!(restored.len(), 12);
    assert_eq!(restored.get(0).unwrap(), Some(PropertyValue::Int64(0)));
    assert_eq!(restored.get(9).unwrap(), Some(PropertyValue::Int64(9)));
    assert_eq!(restored.get(10).unwrap(), None);
    assert_eq!(restored.get(11).unwrap(), Some(PropertyValue::Int64(99)));
  }

  #[test]
  fn serde_bool_roundtrip() {
    let mut chunk = ColumnChunk::new(ColumnId(0), DataType::Bool);
    chunk.append_value(Some(&PropertyValue::Bool(true))).unwrap();
    chunk.append_value(Some(&PropertyValue::Bool(false))).unwrap();
    chunk.append_value(None).unwrap();

    let len = chunk.serialized_len();
    let mut buf = vec![0u8; len];
    chunk.serialize(&mut buf).unwrap();

    let restored = ColumnChunk::deserialize(ColumnId(0), DataType::Bool, &buf).unwrap();
    assert_eq!(restored.get(0).unwrap(), Some(PropertyValue::Bool(true)));
    assert_eq!(restored.get(1).unwrap(), Some(PropertyValue::Bool(false)));
    assert_eq!(restored.get(2).unwrap(), None);
  }

  #[test]
  fn serde_float64_roundtrip() {
    let mut chunk = ColumnChunk::new(ColumnId(0), DataType::Float64);
    chunk.append_value(Some(&PropertyValue::Float64(1.5))).unwrap();
    chunk.append_value(Some(&PropertyValue::Float64(-2.0))).unwrap();

    let len = chunk.serialized_len();
    let mut buf = vec![0u8; len];
    chunk.serialize(&mut buf).unwrap();

    let restored = ColumnChunk::deserialize(ColumnId(0), DataType::Float64, &buf).unwrap();
    assert_eq!(restored.get(0).unwrap(), Some(PropertyValue::Float64(1.5)));
    assert_eq!(restored.get(1).unwrap(), Some(PropertyValue::Float64(-2.0)));
  }

  #[test]
  fn serde_string_roundtrip() {
    let mut chunk = ColumnChunk::new(ColumnId(0), DataType::String);
    chunk.append_value(Some(&PropertyValue::String("hello".into()))).unwrap();
    chunk.append_value(Some(&PropertyValue::String("".into()))).unwrap();
    chunk.append_value(None).unwrap();

    let len = chunk.serialized_len();
    let mut buf = vec![0u8; len];
    chunk.serialize(&mut buf).unwrap();

    let restored = ColumnChunk::deserialize(ColumnId(0), DataType::String, &buf).unwrap();
    assert_eq!(restored.get(0).unwrap(), Some(PropertyValue::String("hello".into())));
    assert_eq!(restored.get(1).unwrap(), Some(PropertyValue::String("".into())));
    assert_eq!(restored.get(2).unwrap(), None);
  }

  #[test]
  fn serde_bytes_roundtrip() {
    let mut chunk = ColumnChunk::new(ColumnId(0), DataType::Bytes);
    chunk.append_value(Some(&PropertyValue::Bytes(vec![1, 2, 3]))).unwrap();
    chunk.append_value(Some(&PropertyValue::Bytes(vec![]))).unwrap();
    chunk.append_value(None).unwrap();

    let len = chunk.serialized_len();
    let mut buf = vec![0u8; len];
    chunk.serialize(&mut buf).unwrap();

    let restored = ColumnChunk::deserialize(ColumnId(0), DataType::Bytes, &buf).unwrap();
    assert_eq!(restored.get(0).unwrap(), Some(PropertyValue::Bytes(vec![1, 2, 3])));
    assert_eq!(restored.get(1).unwrap(), Some(PropertyValue::Bytes(vec![])));
    assert_eq!(restored.get(2).unwrap(), None);
  }

  #[test]
  fn serde_empty_chunk() {
    let chunk = ColumnChunk::new(ColumnId(0), DataType::Int64);
    let len = chunk.serialized_len();
    let mut buf = vec![0u8; len];
    chunk.serialize(&mut buf).unwrap();
    let restored = ColumnChunk::deserialize(ColumnId(0), DataType::Int64, &buf).unwrap();
    assert_eq!(restored.len(), 0);
  }
}
