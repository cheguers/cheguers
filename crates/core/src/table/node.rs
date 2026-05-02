use crate::catalog::NodeLabelEntry;
use crate::config::StorageConfig;
use crate::error::StorageError;
use crate::io::binary;
use crate::io::page::Page;
use crate::table::chunked_node_group::ChunkedNodeGroup;
use crate::types::{ColumnId, DataType, NodeGroupIdx, NodeId, PropertyValue, RowIdx};

pub struct NodeGroup {
  group_idx:      NodeGroupIdx,
  chunked_groups: Vec<ChunkedNodeGroup>,
  column_schema:  Vec<(ColumnId, DataType)>,
}

impl NodeGroup {
  pub fn new(group_idx: NodeGroupIdx, schema: &NodeLabelEntry) -> Self {
    let column_schema: Vec<(ColumnId, DataType)> = schema
      .properties
      .iter()
      .map(|p| (p.column_id, p.data_type.clone()))
      .collect();
    Self { group_idx, chunked_groups: Vec::new(), column_schema }
  }

  #[must_use]
  pub fn group_idx(&self) -> NodeGroupIdx { self.group_idx }

  #[must_use]
  pub fn num_rows(&self) -> u64 {
    self
      .chunked_groups
      .last()
      .map_or(0, |c| c.start_row_idx() + c.num_rows())
  }

  #[must_use]
  pub fn num_live_rows(&self) -> u64 {
    self.chunked_groups.iter().map(ChunkedNodeGroup::num_live_rows).sum()
  }

  #[must_use]
  pub fn is_full(&self) -> bool {
    const MAX_CHUNKS: usize =
      (StorageConfig::NODE_GROUP_SIZE / StorageConfig::CHUNKED_NODE_GROUP_CAPACITY) as usize;
    self.chunked_groups.len() == MAX_CHUNKS
      && self.chunked_groups.last().is_some_and(ChunkedNodeGroup::is_full)
  }

  fn find_chunk(&self, row: RowIdx) -> Option<(usize, RowIdx)> {
    let idx = (row / StorageConfig::CHUNKED_NODE_GROUP_CAPACITY) as usize;
    let chunk = self.chunked_groups.get(idx)?;
    let local = row - chunk.start_row_idx();
    (local < chunk.num_rows()).then_some((idx, local))
  }

  fn ensure_active_chunk(&mut self) -> &mut ChunkedNodeGroup {
    let need_new = self
      .chunked_groups
      .last()
      .is_none_or(ChunkedNodeGroup::is_full);
    if need_new {
      let start_row = self
        .chunked_groups
        .last()
        .map_or(0, ChunkedNodeGroup::end_row_idx);
      self
        .chunked_groups
        .push(ChunkedNodeGroup::new(start_row, &self.column_schema));
    }
    self
      .chunked_groups
      .last_mut()
      .expect("ensure_active_chunk just guaranteed a chunk")
  }

  pub fn insert_row(
    &mut self,
    node_id: NodeId,
    values: &[Option<PropertyValue>],
  ) -> Result<RowIdx, StorageError> {
    if self.is_full() {
      return Err(StorageError::NodeGroupFull);
    }
    self.ensure_active_chunk().insert_row(node_id, values)
  }

  pub fn get_row(&self, row: RowIdx) -> Result<Option<Vec<Option<PropertyValue>>>, StorageError> {
    let (chunk_idx, local) = self
      .find_chunk(row)
      .ok_or_else(|| StorageError::RowOutOfBounds { row, len: self.num_rows() })?;
    self.chunked_groups[chunk_idx].get_row_local(local)
  }

  #[must_use]
  pub fn find_node(&self, node_id: NodeId) -> Option<RowIdx> {
    self.chunked_groups.iter().find_map(|chunk| {
      chunk
        .find_node_local(node_id)
        .map(|local| chunk.start_row_idx() + local)
    })
  }

  pub fn node_id_at(&self, row: RowIdx) -> Result<NodeId, StorageError> {
    let (chunk_idx, local) = self
      .find_chunk(row)
      .ok_or_else(|| StorageError::RowOutOfBounds { row, len: self.num_rows() })?;
    self.chunked_groups[chunk_idx].node_id_at_local(local)
  }

  pub fn delete_row(&mut self, row: RowIdx) -> Result<(), StorageError> {
    let (chunk_idx, local) = self
      .find_chunk(row)
      .ok_or_else(|| StorageError::RowOutOfBounds { row, len: self.num_rows() })?;
    self.chunked_groups[chunk_idx].delete_row_local(local)
  }

  fn compute_serialized_size(&self) -> usize {
    let header = 8 + 8 + 4 + 4 + self.chunked_groups.len() * 4;
    let chunks: usize = self.chunked_groups.iter().map(ChunkedNodeGroup::serialized_len).sum();
    header + chunks
  }

  pub fn serialize_to_pages(&self) -> Result<Vec<Page>, StorageError> {
    let total = self.compute_serialized_size();
    let mut buf = vec![0u8; total];
    let mut pos = 0;

    binary::write_u64(&mut buf, &mut pos, self.group_idx.0);
    binary::write_u64(&mut buf, &mut pos, self.num_rows());
    binary::write_u32(&mut buf, &mut pos, self.num_live_rows() as u32);
    binary::write_u32(&mut buf, &mut pos, self.chunked_groups.len() as u32);

    let chunk_offsets =
      self.chunked_groups.iter().scan(0u32, |acc, chunk| {
        let off = *acc;
        *acc += chunk.serialized_len() as u32;
        Some(off)
      });
    for off in chunk_offsets {
      binary::write_u32(&mut buf, &mut pos, off);
    }

    pos = self
      .chunked_groups
      .iter()
      .try_fold(pos, |p, chunk| chunk.serialize(&mut buf[p..]).map(|n| p + n))?;

    Ok(split_into_pages(&buf[..pos]))
  }

  pub fn deserialize_from_pages(
    schema: &NodeLabelEntry,
    group_idx: NodeGroupIdx,
    pages: &[Page],
  ) -> Result<Self, StorageError> {
    let column_schema: Vec<(ColumnId, DataType)> = schema
      .properties
      .iter()
      .map(|p| (p.column_id, p.data_type.clone()))
      .collect();
    let buf: Vec<u8> = pages.iter().flat_map(Page::to_vec).collect();
    let mut pos = 0;

    let _disk_group_idx = binary::read_u64(&buf, &mut pos);
    let _total_num_rows = binary::read_u64(&buf, &mut pos);
    let _total_num_live = binary::read_u32(&buf, &mut pos);
    let num_chunks = binary::read_u32(&buf, &mut pos) as usize;

    let offsets: Vec<usize> = (0..num_chunks)
      .map(|_| binary::read_u32(&buf, &mut pos) as usize)
      .collect();
    let data_start = pos;

    let starts = offsets.iter().map(|&o| data_start + o);
    let ends = offsets
      .iter()
      .skip(1)
      .map(|&o| data_start + o)
      .chain(std::iter::once(buf.len()));

    let chunked_groups = starts
      .zip(ends)
      .map(|(s, e)| {
        if s > e || e > buf.len() {
          return Err(StorageError::SerDe(format!(
            "chunk offsets out of range: start={s} end={e} buf_len={}",
            buf.len()
          )));
        }
        ChunkedNodeGroup::deserialize(&column_schema, &buf[s..e])
      })
      .collect::<Result<Vec<_>, StorageError>>()?;

    Ok(Self { group_idx, chunked_groups, column_schema })
  }
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
  use crate::catalog::{NodeLabelEntry, PropertyDef};
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
  fn overflow_into_second_chunk() {
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
    let cap = StorageConfig::CHUNKED_NODE_GROUP_CAPACITY;
    for i in 0..cap + 1 {
      group.insert_row(NodeId(i), &[Some(PropertyValue::Bool(true))]).unwrap();
    }
    assert_eq!(group.num_rows(), cap + 1);
    assert_eq!(group.chunked_groups.len(), 2);
    assert!(group.get_row(0).unwrap().is_some());
    assert!(group.get_row(cap - 1).unwrap().is_some());
    assert!(group.get_row(cap).unwrap().is_some());
  }

  #[test]
  fn find_node_across_chunks() {
    let schema = person_schema();
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);
    let cap = StorageConfig::CHUNKED_NODE_GROUP_CAPACITY;
    for i in 0..cap {
      group.insert_row(NodeId(i), &person_values("X", i as i64)).unwrap();
    }
    group.insert_row(NodeId(cap), &person_values("Target", 42)).unwrap();

    assert_eq!(group.find_node(NodeId(0)), Some(0));
    assert_eq!(group.find_node(NodeId(cap - 1)), Some(cap - 1));
    assert_eq!(group.find_node(NodeId(cap)), Some(cap));
  }

  #[test]
  fn delete_across_chunks() {
    let schema = person_schema();
    let mut group = NodeGroup::new(NodeGroupIdx(0), &schema);
    let cap = StorageConfig::CHUNKED_NODE_GROUP_CAPACITY;
    for i in 0..cap + 2 {
      group.insert_row(NodeId(i), &person_values("X", i as i64)).unwrap();
    }
    group.delete_row(cap - 1).unwrap();
    group.delete_row(cap).unwrap();

    assert!(group.get_row(cap - 1).unwrap().is_none());
    assert!(group.get_row(cap).unwrap().is_none());
    assert!(group.get_row(cap - 2).unwrap().is_some());
    assert!(group.get_row(cap + 1).unwrap().is_some());
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
    assert_eq!(restored.get_row(0).unwrap(), None);
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

  #[test]
  fn serde_multi_chunk_roundtrip() {
    let schema = NodeLabelEntry {
      table_id:     TableId(0),
      label_id:     LabelId(0),
      name:         "T".into(),
      pk_column_id: ColumnId(0),
      properties:   vec![PropertyDef {
        name:      "val".into(),
        column_id: ColumnId(0),
        data_type: DataType::Int64,
        nullable:  false,
      }],
    };
    let mut group = NodeGroup::new(NodeGroupIdx(7), &schema);
    let cap = StorageConfig::CHUNKED_NODE_GROUP_CAPACITY;
    for i in 0..cap + 5 {
      group.insert_row(NodeId(i), &[Some(PropertyValue::Int64(i as i64))]).unwrap();
    }
    group.delete_row(0).unwrap();
    group.delete_row(cap).unwrap();
    group.delete_row(cap + 1).unwrap();

    let pages = group.serialize_to_pages().unwrap();
    let restored = NodeGroup::deserialize_from_pages(&schema, NodeGroupIdx(7), &pages).unwrap();

    assert_eq!(restored.num_rows(), cap + 5);
    assert_eq!(restored.num_live_rows(), cap + 2);
    assert!(restored.get_row(0).unwrap().is_none());
    assert!(restored.get_row(1).unwrap().is_some());
    assert_eq!(restored.get_row(1).unwrap().unwrap()[0], Some(PropertyValue::Int64(1)));
    assert!(restored.get_row(cap).unwrap().is_none());
    assert!(restored.get_row(cap + 1).unwrap().is_none());
    assert!(restored.get_row(cap + 2).unwrap().is_some());
    assert_eq!(restored.get_row(cap + 2).unwrap().unwrap()[0], Some(PropertyValue::Int64((cap + 2) as i64)));
  }
}
