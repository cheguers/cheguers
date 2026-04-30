use std::collections::BTreeMap;

use crate::catalog::EdgeTypeEntry;
use crate::config::StorageConfig;
use crate::error::StorageError;
use crate::io::binary;
use crate::io::page::Page;
use crate::table::column::ColumnChunk;
use crate::types::{Direction, EdgeId, NodeGroupIdx, NodeId, NodeOffset, PropertyValue, RowIdx};

/// Determines the granularity of incremental checkpoint: only dirty
/// leaf regions are re-serialized during flush.
const CSR_LEAF_REGION_SIZE: u64 = 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct CSREdgeRecord {
  pub edge_id:    EdgeId,
  pub from:       NodeId,
  pub to:         NodeId,
  pub properties: Vec<Option<PropertyValue>>,
}

/// Sequential mode stores `(start, len)` (16 B regardless of degree); the
/// list explodes to `Sparse` on out-of-order insert or mid-list delete.
/// Mirrors Kuzu's `NodeCSRIndex` `isSequential` flag.
enum NodeEdgeList {
  Sequential { start: RowIdx, len: u32 },
  Sparse(Vec<RowIdx>),
}

impl NodeEdgeList {
  const fn empty() -> Self {
    Self::Sequential { start: 0, len: 0 }
  }

  fn is_empty(&self) -> bool {
    match self {
      Self::Sequential { len, .. } => *len == 0,
      Self::Sparse(rows) => rows.is_empty(),
    }
  }

  /// Maintains sequential mode if the new row continues the contiguous range;
  /// otherwise explodes to Sparse.
  fn push(&mut self, row: RowIdx) {
    match self {
      Self::Sequential { start, len } if *len == 0 => {
        *start = row;
        *len = 1;
      }
      Self::Sequential { start, len } if row == *start + *len as u64 => {
        *len += 1;
      }
      Self::Sequential { start, len } => {
        let mut rows: Vec<RowIdx> = (*start..*start + *len as u64).collect();
        let pos = rows.binary_search(&row).unwrap_or_else(|i| i);
        rows.insert(pos, row);
        *self = Self::Sparse(rows);
      }
      Self::Sparse(rows) => {
        let pos = rows.binary_search(&row).unwrap_or_else(|i| i);
        rows.insert(pos, row);
      }
    }
  }

  /// Always explodes Sequential → Sparse. Returns `true` if the row was present.
  fn remove(&mut self, row: RowIdx) -> bool {
    match self {
      Self::Sequential { start, len } => {
        if row < *start || row >= *start + *len as u64 {
          return false;
        }
        let mut rows: Vec<RowIdx> = (*start..*start + *len as u64).collect();
        rows.retain(|&r| r != row);
        *self = Self::Sparse(rows);
        true
      }
      Self::Sparse(rows) => match rows.binary_search(&row) {
        Ok(pos) => {
          rows.remove(pos);
          true
        }
        Err(_) => false,
      },
    }
  }

  fn serialized_len(&self) -> usize {
    match self {
      Self::Sequential { .. } => 1 + 8 + 4,
      Self::Sparse(rows) => 1 + 4 + rows.len() * 8,
    }
  }

  fn serialize_entry(&self, buf: &mut [u8], pos: &mut usize) {
    match self {
      Self::Sequential { start, len } => {
        binary::write_u8(buf, pos, 0);
        binary::write_u64(buf, pos, *start);
        binary::write_u32(buf, pos, *len);
      }
      Self::Sparse(rows) => {
        binary::write_u8(buf, pos, 1);
        binary::write_u32(buf, pos, rows.len() as u32);
        for &row in rows {
          binary::write_u64(buf, pos, row);
        }
      }
    }
  }

  fn deserialize_entry(buf: &[u8], pos: &mut usize) -> Self {
    match binary::read_u8(buf, pos) {
      0 => Self::Sequential {
        start: binary::read_u64(buf, pos),
        len:   binary::read_u32(buf, pos),
      },
      _ => {
        let count = binary::read_u32(buf, pos) as usize;
        Self::Sparse((0..count).map(|_| binary::read_u64(buf, pos)).collect())
      }
    }
  }
}

/// Iterator over row indices stored by a `NodeEdgeList`.
pub enum NodeEdgeIter<'a> {
  Sequential { current: u64, end: u64 },
  Sparse(std::slice::Iter<'a, RowIdx>),
  Empty,
}

impl<'a> Iterator for NodeEdgeIter<'a> {
  type Item = RowIdx;

  fn next(&mut self) -> Option<Self::Item> {
    match self {
      Self::Sequential { current, end } => {
        if current < end {
          let row = *current;
          *current += 1;
          Some(row)
        } else {
          None
        }
      }
      Self::Sparse(iter) => iter.next().copied(),
      Self::Empty => None,
    }
  }
}

impl<'a> NodeEdgeIter<'a> {
  fn from_list(list: &'a NodeEdgeList) -> Self {
    match list {
      NodeEdgeList::Sequential { start, len } => Self::Sequential {
        current: *start,
        end:     *start + *len as u64,
      },
      NodeEdgeList::Sparse(rows) => Self::Sparse(rows.iter()),
    }
  }
}

/// Each group is scoped to a fixed range of `NODE_GROUP_SIZE` node offsets:
/// group `k` covers `[k * NODE_GROUP_SIZE, (k+1) * NODE_GROUP_SIZE)`.
/// This makes the group responsible for a predictable slice of the CSR key
/// space — mirrors Kuzu's `NodeGroup`-scoped CSR design.
///
/// Direction determines which node is the reference key:
///   FWD: reference = from (source node offset)
///   BWD: reference = to   (destination node offset)
pub struct CSREdgeGroup {
  group_idx:   NodeGroupIdx,
  /// First node offset covered by this group (= `group_idx * NODE_GROUP_SIZE`).
  offset_base: NodeOffset,
  num_rows:    u64,
  #[allow(dead_code)]
  direction:   Direction,

  edge_ids:    Vec<EdgeId>,
  from_ids:    Vec<NodeId>,
  to_ids:      Vec<NodeId>,
  columns:     Vec<ColumnChunk>,
  delete_mask: Vec<bool>,

  /// Maps `(ref_offset - offset_base)` → edge list. Key range `[0, NODE_GROUP_SIZE)`.
  /// O(log n) lookup with sequential optimization for contiguous-insert cases.
  csr_index: BTreeMap<u64, NodeEdgeList>,

  /// Bitmask of dirty leaf regions (1 bit per `CSR_LEAF_REGION_SIZE`-node region);
  /// only dirty regions are re-serialized during incremental flush.
  dirty_regions: u64,
}

impl CSREdgeGroup {
  pub fn new(group_idx: NodeGroupIdx, direction: Direction, schema: &EdgeTypeEntry) -> Self {
    let columns = schema
      .properties
      .iter()
      .map(|p| ColumnChunk::new(p.column_id, p.data_type.clone()))
      .collect();
    Self {
      group_idx,
      offset_base: group_idx.0 * StorageConfig::NODE_GROUP_SIZE,
      num_rows: 0,
      direction,
      edge_ids: Vec::new(),
      from_ids: Vec::new(),
      to_ids: Vec::new(),
      columns,
      delete_mask: Vec::new(),
      csr_index: BTreeMap::new(),
      dirty_regions: 0,
    }
  }

  #[must_use]
  pub fn group_idx(&self) -> NodeGroupIdx {
    self.group_idx
  }

  #[must_use]
  pub fn offset_base(&self) -> NodeOffset {
    self.offset_base
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
    self.num_rows >= StorageConfig::NODE_GROUP_SIZE
  }

  /// Returns `None` if `ref_offset` falls outside this group's range.
  fn local_key(&self, ref_offset: NodeOffset) -> Option<u64> {
    let end = self.offset_base + StorageConfig::NODE_GROUP_SIZE;
    (ref_offset >= self.offset_base && ref_offset < end).then(|| ref_offset - self.offset_base)
  }

  fn mark_region_dirty(&mut self, local_key: u64) {
    self.dirty_regions |= 1 << (local_key / CSR_LEAF_REGION_SIZE);
  }

  /// `ref_offset` is the CSR key:
  ///  - FWD: `source_node_offset` (`source_group_idx * NODE_GROUP_SIZE + source_row`)
  ///  - BWD: `dest_node_offset`
  ///
  /// `values` must match the schema's property list positionally.
  pub fn insert_edge(
    &mut self,
    ref_offset: NodeOffset,
    edge_id: EdgeId,
    from: NodeId,
    to: NodeId,
    values: &[Option<PropertyValue>],
  ) -> Result<RowIdx, StorageError> {
    if self.is_full() {
      return Err(StorageError::CsrEdgeGroupFull);
    }
    let local = self.local_key(ref_offset).ok_or_else(|| {
      StorageError::SerDe(format!(
        "offset {ref_offset} outside group {} range [{}, {})",
        self.group_idx.0,
        self.offset_base,
        self.offset_base + StorageConfig::NODE_GROUP_SIZE,
      ))
    })?;

    for (i, chunk) in self.columns.iter_mut().enumerate() {
      chunk.append_value(values.get(i).and_then(Option::as_ref))?;
    }
    self.edge_ids.push(edge_id);
    self.from_ids.push(from);
    self.to_ids.push(to);
    self.delete_mask.push(false);
    let row = self.num_rows;
    self.num_rows += 1;

    self.csr_index.entry(local).or_insert_with(NodeEdgeList::empty).push(row);
    self.mark_region_dirty(local);
    Ok(row)
  }

  /// Returns an empty iterator if the node has no edges in this group.
  pub fn find_edges(&self, ref_offset: NodeOffset) -> NodeEdgeIter<'_> {
    self
      .local_key(ref_offset)
      .and_then(|k| self.csr_index.get(&k))
      .map_or(NodeEdgeIter::Empty, NodeEdgeIter::from_list)
  }

  /// Returns `Ok(None)` if soft-deleted.
  pub fn get_row(&self, row: RowIdx) -> Result<Option<CSREdgeRecord>, StorageError> {
    if row >= self.num_rows {
      return Err(StorageError::RowOutOfBounds { row, len: self.num_rows });
    }
    if self.delete_mask[row as usize] {
      return Ok(None);
    }
    let properties = self
      .columns
      .iter()
      .map(|c| c.get(row))
      .collect::<Result<Vec<_>, _>>()?;
    let i = row as usize;
    Ok(Some(CSREdgeRecord {
      edge_id:    self.edge_ids[i],
      from:       self.from_ids[i],
      to:         self.to_ids[i],
      properties,
    }))
  }

  #[must_use]
  pub fn find_edge(&self, edge_id: EdgeId) -> Option<RowIdx> {
    self
      .edge_ids
      .iter()
      .zip(&self.delete_mask)
      .position(|(&id, &deleted)| id == edge_id && !deleted)
      .map(|i| i as RowIdx)
  }

  pub fn delete_row(&mut self, row: RowIdx) -> Result<(), StorageError> {
    let slot = self
      .delete_mask
      .get_mut(row as usize)
      .ok_or(StorageError::RowOutOfBounds { row, len: self.num_rows })?;
    *slot = true;

    let removed_key = self
      .csr_index
      .iter_mut()
      .find_map(|(&k, list)| list.remove(row).then_some(k));
    if let Some(key) = removed_key {
      if self.csr_index.get(&key).is_some_and(NodeEdgeList::is_empty) {
        self.csr_index.remove(&key);
      }
      self.mark_region_dirty(key);
    }
    Ok(())
  }

  #[must_use]
  pub fn dirty_regions(&self) -> u64 {
    self.dirty_regions
  }

  pub fn clear_dirty_regions(&mut self) {
    self.dirty_regions = 0;
  }

  /// Like `clear_dirty_regions` but only clears the regions that were actually flushed.
  pub fn clear_dirty_regions_mask(&mut self, mask: u64) {
    self.dirty_regions &= !mask;
  }

  fn compute_serialized_size(&self) -> usize {
    let header = 8 + 8 + 8 + 4 + 4 + 4 + self.columns.len() * 4;
    let id_arrays = self.num_rows as usize * 8 * 3;
    let delete_mask = (self.num_rows as usize).div_ceil(8);
    let csr: usize = self.csr_index.values().map(|v| 8 + v.serialized_len()).sum();
    let cols: usize = self.columns.iter().map(ColumnChunk::serialized_len).sum();
    header + id_arrays + delete_mask + csr + cols
  }

  pub fn serialize_to_pages(&self) -> Result<Vec<Page>, StorageError> {
    let mut buf = vec![0u8; self.compute_serialized_size()];
    let mut pos = 0;

    binary::write_u64(&mut buf, &mut pos, self.group_idx.0);
    binary::write_u64(&mut buf, &mut pos, self.offset_base);
    binary::write_u64(&mut buf, &mut pos, self.num_rows);
    binary::write_u32(&mut buf, &mut pos, self.num_live_rows() as u32);
    binary::write_u32(&mut buf, &mut pos, self.columns.len() as u32);
    binary::write_u32(&mut buf, &mut pos, self.csr_index.len() as u32);
    for col in &self.columns {
      binary::write_u32(&mut buf, &mut pos, col.serialized_len() as u32);
    }
    for &id in &self.edge_ids {
      binary::write_u64(&mut buf, &mut pos, id.0);
    }
    for &n in &self.from_ids {
      binary::write_u64(&mut buf, &mut pos, n.0);
    }
    for &n in &self.to_ids {
      binary::write_u64(&mut buf, &mut pos, n.0);
    }
    binary::write_bytes(&mut buf, &mut pos, &binary::pack_bitmask(&self.delete_mask));

    for (&local, list) in &self.csr_index {
      binary::write_u64(&mut buf, &mut pos, local);
      list.serialize_entry(&mut buf, &mut pos);
    }

    for col in &self.columns {
      let len = col.serialized_len();
      let written = col.serialize(&mut buf[pos..pos + len])?;
      pos += written;
    }

    Ok(split_into_pages(&buf))
  }

  pub fn deserialize_from_pages(
    direction: Direction,
    schema: &EdgeTypeEntry,
    group_idx: NodeGroupIdx,
    pages: &[Page],
  ) -> Result<Self, StorageError> {
    let buf: Vec<u8> = pages.iter().flat_map(Page::to_vec).collect();
    let mut pos = 0;

    let _disk_group_idx = binary::read_u64(&buf, &mut pos);
    let offset_base = binary::read_u64(&buf, &mut pos);
    let num_rows = binary::read_u64(&buf, &mut pos);
    let _num_live = binary::read_u32(&buf, &mut pos);
    let num_columns = binary::read_u32(&buf, &mut pos) as usize;
    let num_csr_entries = binary::read_u32(&buf, &mut pos) as usize;

    let column_lens: Vec<usize> = (0..num_columns)
      .map(|_| binary::read_u32(&buf, &mut pos) as usize)
      .collect();
    let edge_ids: Vec<EdgeId> = (0..num_rows).map(|_| EdgeId(binary::read_u64(&buf, &mut pos))).collect();
    let from_ids: Vec<NodeId> = (0..num_rows).map(|_| NodeId(binary::read_u64(&buf, &mut pos))).collect();
    let to_ids: Vec<NodeId> = (0..num_rows).map(|_| NodeId(binary::read_u64(&buf, &mut pos))).collect();

    let mask_bytes = binary::read_bytes(&buf, &mut pos, (num_rows as usize).div_ceil(8));
    let delete_mask = binary::unpack_bitmask(mask_bytes, num_rows as usize);

    let csr_index: BTreeMap<u64, NodeEdgeList> = (0..num_csr_entries)
      .map(|_| {
        let key = binary::read_u64(&buf, &mut pos);
        (key, NodeEdgeList::deserialize_entry(&buf, &mut pos))
      })
      .collect();

    let columns = schema
      .properties
      .iter()
      .enumerate()
      .map(|(i, prop)| {
        let len = column_lens.get(i).copied().unwrap_or(0);
        let chunk = ColumnChunk::deserialize(prop.column_id, prop.data_type.clone(), &buf[pos..pos + len])?;
        pos += len;
        Ok(chunk)
      })
      .collect::<Result<Vec<_>, StorageError>>()?;

    Ok(Self {
      group_idx,
      offset_base,
      num_rows,
      direction,
      edge_ids,
      from_ids,
      to_ids,
      columns,
      delete_mask,
      csr_index,
      dirty_regions: 0,
    })
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
  use crate::catalog::PropertyDef;
  use crate::types::{ColumnId, DataType, LabelId, TableId};

  fn knows_schema() -> EdgeTypeEntry {
    EdgeTypeEntry {
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
    }
  }

  fn edge_values(weight: f64) -> Vec<Option<PropertyValue>> {
    vec![Some(PropertyValue::Float64(weight))]
  }

  fn in_range(group_idx: u64) -> NodeOffset {
    group_idx * StorageConfig::NODE_GROUP_SIZE
  }

  #[test]
  fn insert_and_read_back() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    let row = group
      .insert_edge(base + 100, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.95))
      .unwrap();
    assert_eq!(row, 0);
    let record = group.get_row(0).unwrap().unwrap();
    assert_eq!(record.edge_id, EdgeId(1));
    assert_eq!(record.from, NodeId(10));
    assert_eq!(record.to, NodeId(20));
    assert_eq!(record.properties[0], Some(PropertyValue::Float64(0.95)));
  }

  #[test]
  fn insert_out_of_range_rejects() {
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    let offset_outside = StorageConfig::NODE_GROUP_SIZE + 1;
    let result = group.insert_edge(offset_outside, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.5));
    assert!(result.is_err());
  }

  #[test]
  fn find_edges_by_offset() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    group.insert_edge(base + 100, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.5)).unwrap();
    group.insert_edge(base + 100, EdgeId(2), NodeId(10), NodeId(30), &edge_values(0.7)).unwrap();
    group.insert_edge(base + 200, EdgeId(3), NodeId(50), NodeId(60), &edge_values(0.3)).unwrap();

    assert_eq!(group.find_edges(base + 100).count(), 2);
    assert_eq!(group.find_edges(base + 200).count(), 1);
    assert_eq!(group.find_edges(base + 999).count(), 0);
  }

  #[test]
  fn sequential_optimization_stays_compact() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    for i in 0..100u64 {
      group.insert_edge(base, EdgeId(i), NodeId(10), NodeId(20 + i), &edge_values(0.5)).unwrap();
    }
    let rows: Vec<_> = group.find_edges(base).collect();
    assert_eq!(rows.len(), 100);
    assert_eq!(rows[0], 0);
    assert_eq!(rows[99], 99);
  }

  #[test]
  fn out_of_order_explodes_to_sparse() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    group.insert_edge(base, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.5)).unwrap();
    group.insert_edge(base, EdgeId(2), NodeId(10), NodeId(30), &edge_values(0.7)).unwrap();
    group.insert_edge(base, EdgeId(3), NodeId(50), NodeId(60), &edge_values(0.3)).unwrap();
    group.insert_edge(base + 1, EdgeId(4), NodeId(11), NodeId(21), &edge_values(0.1)).unwrap();

    assert_eq!(group.find_edges(base).count(), 3);
  }

  #[test]
  fn delete_hides_row() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    group.insert_edge(base + 100, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.5)).unwrap();
    assert_eq!(group.num_live_rows(), 1);
    assert_eq!(group.find_edges(base + 100).count(), 1);

    group.delete_row(0).unwrap();
    assert_eq!(group.num_live_rows(), 0);
    assert_eq!(group.find_edges(base + 100).count(), 0);
    assert_eq!(group.get_row(0).unwrap(), None);
  }

  #[test]
  fn serde_roundtrip() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    group.insert_edge(base + 100, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.5)).unwrap();
    group.insert_edge(base + 100, EdgeId(2), NodeId(10), NodeId(30), &edge_values(0.7)).unwrap();
    group.insert_edge(base + 200, EdgeId(3), NodeId(50), NodeId(60), &edge_values(0.3)).unwrap();

    let pages = group.serialize_to_pages().unwrap();
    let restored = CSREdgeGroup::deserialize_from_pages(
      Direction::Forward,
      &knows_schema(),
      NodeGroupIdx(0),
      &pages,
    )
    .unwrap();

    assert_eq!(restored.num_rows(), 3);
    assert_eq!(restored.num_live_rows(), 3);
    assert_eq!(restored.find_edges(base + 100).count(), 2);
    assert_eq!(restored.find_edges(base + 200).count(), 1);

    let row0 = restored.get_row(0).unwrap().unwrap();
    assert_eq!(row0.edge_id, EdgeId(1));
    assert_eq!(row0.properties[0], Some(PropertyValue::Float64(0.5)));
  }

  #[test]
  fn serde_sequential_compactness() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    for i in 0..50u64 {
      group.insert_edge(base, EdgeId(i), NodeId(10), NodeId(20 + i), &edge_values(0.5)).unwrap();
    }
    let pages = group.serialize_to_pages().unwrap();
    let restored = CSREdgeGroup::deserialize_from_pages(
      Direction::Forward,
      &knows_schema(),
      NodeGroupIdx(0),
      &pages,
    )
    .unwrap();
    assert_eq!(restored.num_rows(), 50);
    assert_eq!(restored.find_edges(base).count(), 50);
  }

  #[test]
  fn dirty_regions_tracked() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    assert_eq!(group.dirty_regions(), 0);
    group.insert_edge(base + 50, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.5)).unwrap();
    assert_ne!(group.dirty_regions(), 0, "region 0 should be dirty");
    group.clear_dirty_regions();
    assert_eq!(group.dirty_regions(), 0);
  }

  #[test]
  fn delete_sequential_explodes_and_removes() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    group.insert_edge(base, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.5)).unwrap();
    group.insert_edge(base, EdgeId(2), NodeId(10), NodeId(30), &edge_values(0.7)).unwrap();
    group.insert_edge(base, EdgeId(3), NodeId(10), NodeId(40), &edge_values(0.9)).unwrap();
    group.delete_row(1).unwrap();
    let rows: Vec<_> = group.find_edges(base).collect();
    assert_eq!(rows, vec![0, 2]);
  }
}
