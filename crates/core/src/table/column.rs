use crate::config::StorageConfig;
use crate::error::StorageError;
use crate::io::binary;
use crate::types::{ColumnId, DataType, PropertyValue, RowIdx};

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

  #[must_use]
  pub fn serialized_len(&self) -> usize {
    let base = 4 + self.null_mask.len().div_ceil(8);
    let num = self.num_rows as usize;
    let payload = match &self.data {
      ColumnData::Bool(_) => num,
      ColumnData::Int64(_) | ColumnData::Float64(_) => num * 8,
      ColumnData::String(v) => {
        let data: usize = v.iter().flatten().map(String::len).sum();
        (num + 1) * 4 + data
      }
      ColumnData::Bytes(v) => {
        let data: usize = v.iter().flatten().map(Vec::len).sum();
        (num + 1) * 4 + data
      }
    };
    base + payload
  }

  /// Format: `[num_rows: u32] [null_mask: bit-packed] [data...]`
  pub fn serialize(&self, buf: &mut [u8]) -> Result<usize, StorageError> {
    let mut pos = 0;
    binary::write_u32(buf, &mut pos, self.num_rows as u32);
    binary::write_bytes(buf, &mut pos, &binary::pack_bitmask(&self.null_mask));

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
      ColumnData::String(v) => Self::serialize_var_width(buf, &mut pos, v, |s| s.as_bytes()),
      ColumnData::Bytes(v) => Self::serialize_var_width(buf, &mut pos, v, Vec::as_slice),
    }

    Ok(pos)
  }

  pub fn deserialize(
    column_id: ColumnId,
    data_type: DataType,
    buf: &[u8],
  ) -> Result<Self, StorageError> {
    if buf.len() < 4 {
      return Err(StorageError::SerDe("buffer too short for num_rows".into()));
    }
    let mut pos = 0;
    let num_rows = binary::read_u32(buf, &mut pos) as u64;
    let n = num_rows as usize;

    let mask_bytes = binary::read_bytes(buf, &mut pos, n.div_ceil(8));
    let null_mask = binary::unpack_bitmask(mask_bytes, n);

    let data = match &data_type {
      DataType::Bool => ColumnData::Bool(
        (0..n).map(|_| binary::read_u8(buf, &mut pos) != 0).collect(),
      ),
      DataType::Int64 => ColumnData::Int64(
        (0..n).map(|_| binary::read_i64(buf, &mut pos)).collect(),
      ),
      DataType::Float64 => ColumnData::Float64(
        (0..n).map(|_| binary::read_f64(buf, &mut pos)).collect(),
      ),
      DataType::String => ColumnData::String(Self::deserialize_var_width_str(buf, &mut pos, n)?),
      DataType::Bytes | DataType::Vector { .. } => {
        ColumnData::Bytes(Self::deserialize_var_width_bytes(buf, &mut pos, n)?)
      }
    };

    Ok(Self { column_id, data_type, data, null_mask, num_rows })
  }

  fn serialize_var_width<T>(
    buf: &mut [u8],
    pos: &mut usize,
    values: &[Option<T>],
    to_bytes: impl Fn(&T) -> &[u8],
  ) {
    let num = values.len();
    let offsets_start = *pos;
    *pos += (num + 1) * 4;
    let data_start = *pos;

    for (i, val) in values.iter().enumerate() {
      let off = (*pos - data_start) as u32;
      buf[offsets_start + i * 4..offsets_start + i * 4 + 4].copy_from_slice(&off.to_le_bytes());
      if let Some(v) = val {
        binary::write_bytes(buf, pos, to_bytes(v));
      }
    }
    let sentinel = (*pos - data_start) as u32;
    buf[offsets_start + num * 4..offsets_start + num * 4 + 4].copy_from_slice(&sentinel.to_le_bytes());
  }

  fn deserialize_var_width_str(
    buf: &[u8],
    pos: &mut usize,
    n: usize,
  ) -> Result<Vec<Option<String>>, StorageError> {
    let offsets = Self::read_offset_array(buf, pos, n);
    let data_start = *pos;
    let values = (0..n)
      .map(|i| {
        let bytes = &buf[data_start + offsets[i] as usize..data_start + offsets[i + 1] as usize];
        String::from_utf8(bytes.to_vec())
          .map(Some)
          .map_err(|e| StorageError::SerDe(format!("invalid UTF-8: {e}")))
      })
      .collect::<Result<Vec<_>, _>>()?;
    *pos = data_start + offsets[n] as usize;
    Ok(values)
  }

  fn deserialize_var_width_bytes(
    buf: &[u8],
    pos: &mut usize,
    n: usize,
  ) -> Result<Vec<Option<Vec<u8>>>, StorageError> {
    let offsets = Self::read_offset_array(buf, pos, n);
    let data_start = *pos;
    let values = (0..n)
      .map(|i| Some(buf[data_start + offsets[i] as usize..data_start + offsets[i + 1] as usize].to_vec()))
      .collect();
    *pos = data_start + offsets[n] as usize;
    Ok(values)
  }

  fn read_offset_array(buf: &[u8], pos: &mut usize, n: usize) -> Vec<u32> {
    (0..=n).map(|_| binary::read_u32(buf, pos)).collect()
  }

  fn type_check(&self, value: &PropertyValue) -> Result<(), StorageError> {
    let compatible = matches!(
      (&self.data_type, value.data_type()),
      (DataType::Vector { .. }, DataType::Bytes)
    ) || self.data_type == value.data_type();

    if compatible {
      Ok(())
    } else {
      Err(StorageError::ColumnTypeMismatch {
        expected: self.data_type.clone(),
        got:      value.data_type(),
      })
    }
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
      _ => unreachable!("type_check guarantees variant compatibility"),
    }
  }

  fn read_value(&self, row: RowIdx) -> PropertyValue {
    let i = row as usize;
    match &self.data {
      ColumnData::Bool(v) => PropertyValue::Bool(v[i]),
      ColumnData::Int64(v) => PropertyValue::Int64(v[i]),
      ColumnData::Float64(v) => PropertyValue::Float64(v[i]),
      ColumnData::String(v) => PropertyValue::String(
        v[i].clone().expect("non-null row contains a String"),
      ),
      ColumnData::Bytes(v) => PropertyValue::Bytes(
        v[i].clone().expect("non-null row contains Bytes"),
      ),
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
