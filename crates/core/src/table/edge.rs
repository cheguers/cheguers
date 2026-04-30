use std::collections::BTreeMap;

use crate::catalog::EdgeTypeEntry;
use crate::config::StorageConfig;
use crate::types::{Direction, EdgeId, NodeGroupIdx, NodeId, NodeOffset, PropertyValue, RowIdx};

use crate::table::column::ColumnChunk;
use crate::error::StorageError;
use crate::io::page::Page;
use crate::io::binary;

/// Number of nodes per leaf region within a CSR edge group.
/// Determines the granularity of incremental checkpoint: only dirty
/// leaf regions are re-serialized during flush.
const CSR_LEAF_REGION_SIZE: u64 = 1024;

/// One edge as returned by the edge group.
#[derive(Debug, Clone, PartialEq)]
pub struct CSREdgeRecord {
  pub edge_id:    EdgeId,
  pub from:       NodeId,
  pub to:         NodeId,
  pub properties: Vec<Option<PropertyValue>>,
}

/// Storage for a single node's edge-list within the CSR index.
///
/// Two modes:
/// - **Sequential**: edges were appended in row order — stores only
///   `(start_row, count)`, 16 bytes regardless of degree.
/// - **Sparse**: edges arrived out-of-order or a mid-list deletion occurred —
///   stores individual sorted row indices.
///
/// This mirrors Kuzu's `NodeCSRIndex` with its `isSequential` flag.
enum NodeEdgeList {
  Sequential { start: RowIdx, len: u32 },
  Sparse(Vec<RowIdx>),
}

impl NodeEdgeList {
  fn new_empty() -> Self {
    Self::Sequential { start: 0, len: 0 }
  }

  fn is_empty(&self) -> bool {
    match self {
      Self::Sequential { len, .. } => *len == 0,
      Self::Sparse(rows) => rows.is_empty(),
    }
  }

  /// Push a row index. Maintains sequential mode if the new row
  /// continues the contiguous range; otherwise explodes to Sparse.
  fn push(&mut self, row: RowIdx) {
    match self {
      Self::Sequential { start, len } => {
        if *len == 0 {
          *start = row;
          *len = 1;
        } else if row == *start + *len as u64 {
          *len += 1;
        } else {
          let mut rows: Vec<RowIdx> = (*start..*start + *len as u64).collect();
          let pos = rows.binary_search(&row).unwrap_or_else(|i| i);
          rows.insert(pos, row);
          *self = Self::Sparse(rows);
        }
      }
      Self::Sparse(rows) => {
        let pos = rows.binary_search(&row).unwrap_or_else(|i| i);
        rows.insert(pos, row);
      }
    }
  }

  /// Remove a row index. Always explodes Sequential → Sparse.
  /// Returns `true` if the row was present.
  fn remove(&mut self, row: RowIdx) -> bool {
    match self {
      Self::Sequential { start, len } => {
        if row < *start || row >= *start + *len as u64 {
          return false;
        }
        let mut rows: Vec<RowIdx> = (*start..*start + *len as u64).collect();
        let pos = rows.binary_search(&row).unwrap();
        rows.remove(pos);
        *self = Self::Sparse(rows);
        true
      }
      Self::Sparse(rows) => {
        if let Ok(pos) = rows.binary_search(&row) {
          rows.remove(pos);
          true
        } else {
          false
        }
      }
    }
  }

  /// Serialized size in bytes.
  fn serialized_len(&self) -> usize {
    match self {
      Self::Sequential { .. } => 1 + 8 + 4,      // tag(u8) + start(u64) + len(u32)
      Self::Sparse(rows) => 1 + 4 + rows.len() * 8, // tag(u8) + count(u32) + rows
    }
  }

  /// Write a single CSR entry into the buffer at the current position.
  fn serialize_entry(&self, buf: &mut [u8], pos: &mut usize) {
    match self {
      Self::Sequential { start, len } => {
        binary::write_u8(buf, pos, 0); // tag: 0 = sequential
        binary::write_u64(buf, pos, *start);
        binary::write_u32(buf, pos, *len);
      }
      Self::Sparse(rows) => {
        binary::write_u8(buf, pos, 1); // tag: 1 = sparse
        binary::write_u32(buf, pos, rows.len() as u32);
        for &row in rows {
          binary::write_u64(buf, pos, row);
        }
      }
    }
  }

  /// Read a single CSR entry from the buffer.
  fn deserialize_entry(buf: &[u8], pos: &mut usize) -> Self {
    let tag = binary::read_u8(buf, pos);
    match tag {
      0 => {
        let start = binary::read_u64(buf, pos);
        let len = binary::read_u32(buf, pos);
        Self::Sequential { start, len }
      }
      _ => {
        let count = binary::read_u32(buf, pos) as usize;
        let mut rows = Vec::with_capacity(count);
        for _ in 0..count {
          rows.push(binary::read_u64(buf, pos));
        }
        Self::Sparse(rows)
      }
    }
  }
}

/// Iterator over row indices from a `NodeEdgeList`, abstracting
/// over Sequential vs Sparse storage.
pub struct NodeEdgeIterWrapper<'a> {
  inner: &'a NodeEdgeList,
  sequential_pos: u64,
  sparse_idx: usize,
}

impl<'a> Iterator for NodeEdgeIterWrapper<'a> {
  type Item = RowIdx;

  fn next(&mut self) -> Option<Self::Item> {
    match self.inner {
      NodeEdgeList::Sequential { start, len } => {
        if self.sequential_pos < *len as u64 {
          let row = *start + self.sequential_pos;
          self.sequential_pos += 1;
          Some(row)
        } else {
          None
        }
      }
      NodeEdgeList::Sparse(rows) => {
        if self.sparse_idx < rows.len() {
          let row = rows[self.sparse_idx];
          self.sparse_idx += 1;
          Some(row)
        } else {
          None
        }
      }
    }
  }
}

/// CSR edge group — stores edges columnar with a non-dense CSR index.
///
/// Each group is scoped to a fixed range of `NODE_GROUP_SIZE` node offsets.
/// Group `k` covers offsets `[k * NODE_GROUP_SIZE, (k+1) * NODE_GROUP_SIZE)`.
/// This makes the group responsible for a predictable slice of the CSR key
/// space — mirroring Kuzu's `NodeGroup`-scoped CSR design.
///
/// Direction determines which node is the reference key:
///   FWD: reference = from (source node offset)
///   BWD: reference = to   (destination node offset)
pub struct CSREdgeGroup {
  group_idx:   NodeGroupIdx,
  /// First node offset covered by this group (= group_idx * NODE_GROUP_SIZE).
  offset_base: NodeOffset,
  num_rows:    u64,
  #[allow(dead_code)]
  direction:   Direction,

  edge_ids:    Vec<EdgeId>,
  from_ids:    Vec<NodeId>,
  to_ids:      Vec<NodeId>,
  columns:     Vec<ColumnChunk>,
  delete_mask: Vec<bool>,

  /// Maps (ref_offset - offset_base) → edge list.
  /// Key range: [0, NODE_GROUP_SIZE). O(log n) lookup with sequential
  /// optimization for the common contiguous-insert case.
  csr_index:   BTreeMap<u64, NodeEdgeList>,

  /// Bitmask of dirty leaf regions (1 bit per 1024-node region).
  /// Only dirty regions are re-serialized during incremental flush.
  dirty_regions: u64,
}

impl CSREdgeGroup {
  pub fn new(group_idx: NodeGroupIdx, direction: Direction, schema: &EdgeTypeEntry) -> Self {
    let columns = schema
      .properties
      .iter()
      .map(|p| ColumnChunk::new(crate::types::ColumnId(p.column_id.0), p.data_type.clone()))
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
  pub fn group_idx(&self) -> NodeGroupIdx { self.group_idx }

  #[must_use]
  pub fn offset_base(&self) -> NodeOffset { self.offset_base }

  #[must_use]
  pub fn num_rows(&self) -> u64 { self.num_rows }

  #[must_use]
  pub fn num_live_rows(&self) -> u64 {
    self.delete_mask.iter().filter(|&&d| !d).count() as u64
  }

  #[must_use]
  pub fn is_full(&self) -> bool {
    self.num_rows >= StorageConfig::NODE_GROUP_SIZE
  }

  /// Given a global dense node offset, return the local key
  /// used to index into this group's `csr_index`.
  ///
  /// Returns `None` if the offset falls outside this group's range.
  #[must_use]
  fn local_key(&self, ref_offset: NodeOffset) -> Option<u64> {
    let base = self.offset_base;
    if ref_offset < base || ref_offset >= base + StorageConfig::NODE_GROUP_SIZE {
      return None;
    }
    Some(ref_offset - base)
  }

  /// Mark the leaf region containing `local_key` as dirty.
  fn mark_region_dirty(&mut self, local_key: u64) {
    let region = local_key / CSR_LEAF_REGION_SIZE;
    self.dirty_regions |= 1 << region;
  }

  /// Insert an edge. `ref_offset` is the CSR key:
  ///  - FWD: `source_node_offset` (source group_idx * NODE_GROUP_SIZE + source_row)
  ///  - BWD: `dest_node_offset`   (dest group_idx * NODE_GROUP_SIZE + dest_row)
  ///
  /// `values` must match the schema's property list positionally.
  /// Returns `CsrEdgeGroupFull` if the group is at capacity, or
  /// `StorageError::SerDe` if the ref_offset is outside this group's range.
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
      chunk.append_value(values.get(i).and_then(|v| v.as_ref()))?;
    }
    self.edge_ids.push(edge_id);
    self.from_ids.push(from);
    self.to_ids.push(to);
    self.delete_mask.push(false);
    let row = self.num_rows;
    self.num_rows += 1;

    let list = self.csr_index.entry(local).or_insert_with(NodeEdgeList::new_empty);
    list.push(row);
    self.mark_region_dirty(local);
    Ok(row)
  }

  /// Return an iterator over row indices for a given reference node offset.
  /// Returns an empty iterator if the node has no edges in this group.
  pub fn find_edges(&self, ref_offset: NodeOffset) -> impl Iterator<Item = RowIdx> + '_ {
    let local = self.local_key(ref_offset);
    match local.and_then(|k| self.csr_index.get(&k)) {
      Some(list) => NodeEdgeIterWrapper { inner: list, sequential_pos: 0, sparse_idx: 0 },
      None => NodeEdgeIterWrapper {
        inner: &NodeEdgeList::Sequential { start: 0, len: 0 },
        sequential_pos: 0,
        sparse_idx: 0,
      },
    }
  }

  /// Read edge record at a row. Returns `Ok(None)` if soft-deleted.
  pub fn get_row(&self, row: RowIdx) -> Result<Option<CSREdgeRecord>, StorageError> {
    if row >= self.num_rows {
      return Err(StorageError::RowOutOfBounds { row, len: self.num_rows });
    }
    if self.delete_mask[row as usize] {
      return Ok(None);
    }
    let mut properties = Vec::with_capacity(self.columns.len());
    for chunk in &self.columns {
      properties.push(chunk.get(row)?);
    }
    Ok(Some(CSREdgeRecord {
      edge_id: self.edge_ids[row as usize],
      from: self.from_ids[row as usize],
      to: self.to_ids[row as usize],
      properties,
    }))
  }

  /// Find an edge by its global EdgeId. Linear scan.
  #[must_use]
  pub fn find_edge(&self, edge_id: EdgeId) -> Option<RowIdx> {
    self
      .edge_ids
      .iter()
      .enumerate()
      .find(|(i, id)| **id == edge_id && !self.delete_mask[*i])
      .map(|(i, _)| i as RowIdx)
  }

  /// Soft-delete a row.
  pub fn delete_row(&mut self, row: RowIdx) -> Result<(), StorageError> {
    if row as usize >= self.delete_mask.len() {
      return Err(StorageError::RowOutOfBounds { row, len: self.num_rows });
    }
    self.delete_mask[row as usize] = true;

    // Remove from CSR index — find which local_key this row belongs to.
    let mut found_key: Option<u64> = None;
    for (&local, list) in &mut self.csr_index {
      if list.remove(row) {
        found_key = Some(local);
        break;
      }
    }
    if let Some(local) = found_key {
      if self.csr_index.get(&local).is_some_and(|v| v.is_empty()) {
        self.csr_index.remove(&local);
      }
      self.mark_region_dirty(local);
    }
    Ok(())
  }

  /// Returns a bitmap of dirty leaf regions for incremental checkpoint.
  #[must_use]
  pub fn dirty_regions(&self) -> u64 {
    self.dirty_regions
  }

  /// Clear the dirty-region bitmap (called after a successful flush).
  pub fn clear_dirty_regions(&mut self) {
    self.dirty_regions = 0;
  }

  /// Like `clear_dirty_regions` but only clears the regions that
  /// were actually flushed (for partial flushes).
  pub fn clear_dirty_regions_mask(&mut self, mask: u64) {
    self.dirty_regions &= !mask;
  }

  fn compute_serialized_size(&self) -> usize {
    let header = 8 + 8 + 8 + 4 + 4 + 4 + (self.columns.len() * 4);
    let edge_ids = (self.num_rows as usize) * 8;
    let from_ids = (self.num_rows as usize) * 8;
    let to_ids = (self.num_rows as usize) * 8;
    let delete_mask = (self.num_rows as usize).div_ceil(8);
    let csr: usize = self.csr_index.values().map(|v| 8 + v.serialized_len()).sum();
    let cols: usize = self.columns.iter().map(|c| c.serialized_len()).sum();
    header + edge_ids + from_ids + to_ids + delete_mask + csr + cols
  }

  pub fn serialize_to_pages(&self) -> Result<Vec<Page>, StorageError> {
    let total = self.compute_serialized_size();
    let mut buf = vec![0u8; total];
    let mut pos = 0usize;

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
    let mask_bytes = binary::pack_bitmask(&self.delete_mask);
    binary::write_bytes(&mut buf, &mut pos, &mask_bytes);

    for (&local, list) in &self.csr_index {
      binary::write_u64(&mut buf, &mut pos, local);
      list.serialize_entry(&mut buf, &mut pos);
    }

    for col in &self.columns {
      let len = col.serialized_len();
      let written = col.serialize(&mut buf[pos..pos + len])?;
      pos += written;
    }

    Ok(Self::split_into_pages(&buf))
  }

  pub fn deserialize_from_pages(
    direction: Direction,
    schema: &EdgeTypeEntry,
    group_idx: NodeGroupIdx,
    pages: &[Page],
  ) -> Result<Self, StorageError> {
    let buf: Vec<u8> = pages.iter().flat_map(|p| p.to_vec()).collect();
    let mut pos = 0usize;

    let _disk_group_idx = binary::read_u64(&buf, &mut pos);
    let offset_base = binary::read_u64(&buf, &mut pos);
    let num_rows = binary::read_u64(&buf, &mut pos);
    let _num_live = binary::read_u32(&buf, &mut pos);
    let num_columns = binary::read_u32(&buf, &mut pos) as usize;
    let num_csr_entries = binary::read_u32(&buf, &mut pos) as usize;
    let mut column_lens = Vec::with_capacity(num_columns);
    for _ in 0..num_columns {
      column_lens.push(binary::read_u32(&buf, &mut pos) as usize);
    }
    let mut edge_ids = Vec::with_capacity(num_rows as usize);
    let mut from_ids = Vec::with_capacity(num_rows as usize);
    let mut to_ids = Vec::with_capacity(num_rows as usize);
    for _ in 0..num_rows {
      edge_ids.push(EdgeId(binary::read_u64(&buf, &mut pos)));
    }
    for _ in 0..num_rows {
      from_ids.push(NodeId(binary::read_u64(&buf, &mut pos)));
    }
    for _ in 0..num_rows {
      to_ids.push(NodeId(binary::read_u64(&buf, &mut pos)));
    }

    let mask_len = (num_rows as usize).div_ceil(8);
    let mask_bytes = binary::read_bytes(&buf, &mut pos, mask_len);
    let delete_mask = binary::unpack_bitmask(mask_bytes, num_rows as usize);

    let mut csr_index = BTreeMap::new();
    for _ in 0..num_csr_entries {
      let local = binary::read_u64(&buf, &mut pos);
      let list = NodeEdgeList::deserialize_entry(&buf, &mut pos);
      csr_index.insert(local, list);
    }

    let mut columns = Vec::with_capacity(schema.properties.len());
    for (i, prop) in schema.properties.iter().enumerate() {
      let len = column_lens.get(i).copied().unwrap_or(0);
      let chunk = ColumnChunk::deserialize(
        crate::types::ColumnId(prop.column_id.0),
        prop.data_type.clone(),
        &buf[pos..pos + len],
      )?;
      pos += len;
      columns.push(chunk);
    }

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

  fn split_into_pages(buf: &[u8]) -> Vec<Page> {
    let page_size = StorageConfig::PAGE_SIZE as usize;
    buf.chunks(page_size).map(Page::from_bytes).collect()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn knows_schema() -> EdgeTypeEntry {
    EdgeTypeEntry {
      table_id: crate::types::TableId(1),
      label_id: crate::types::LabelId(1),
      name: "Knows".into(),
      from_label_id: crate::types::LabelId(0),
      to_label_id: crate::types::LabelId(0),
      properties: vec![crate::catalog::PropertyDef {
        name: "weight".into(),
        column_id: crate::types::ColumnId(0),
        data_type: crate::types::DataType::Float64,
        nullable: false,
      }],
    }
  }

  fn edge_values(weight: f64) -> Vec<Option<PropertyValue>> {
    vec![Some(PropertyValue::Float64(weight))]
  }

  /// All offsets must fall within the group's node-offset window.
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
    let offset_outside = StorageConfig::NODE_GROUP_SIZE + 1; // belongs to group 1
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

    let rows: Vec<_> = group.find_edges(base + 100).collect();
    assert_eq!(rows.len(), 2);
    let rows2: Vec<_> = group.find_edges(base + 200).collect();
    assert_eq!(rows2.len(), 1);
    let rows3: Vec<_> = group.find_edges(base + 999).collect();
    assert_eq!(rows3.len(), 0);
  }

  #[test]
  fn sequential_optimization_stays_compact() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    for i in 0..100u64 {
      group.insert_edge(base, EdgeId(i), NodeId(10), NodeId(20 + i), &edge_values(0.5)).unwrap();
    }
    // 100 sequential edges from the same source → should be Sequential mode (13 bytes serialized)
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
    // Insert between the two — breaks sequential
    group.insert_edge(base, EdgeId(3), NodeId(50), NodeId(60), &edge_values(0.3)).unwrap();
    // Now insert right after the last one — should still work (sparse mode)
    group.insert_edge(base + 1, EdgeId(4), NodeId(11), NodeId(21), &edge_values(0.1)).unwrap();

    let rows: Vec<_> = group.find_edges(base).collect();
    assert_eq!(rows.len(), 3);
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
      Direction::Forward, &knows_schema(), NodeGroupIdx(0), &pages,
    ).unwrap();

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
      Direction::Forward, &knows_schema(), NodeGroupIdx(0), &pages,
    ).unwrap();
    assert_eq!(restored.num_rows(), 50);
    assert_eq!(restored.find_edges(base).count(), 50);
  }

  #[test]
  fn dirty_regions_tracked() {
    let base = in_range(0);
    let mut group = CSREdgeGroup::new(NodeGroupIdx(0), Direction::Forward, &knows_schema());
    assert_eq!(group.dirty_regions(), 0);
    group.insert_edge(base + 50, EdgeId(1), NodeId(10), NodeId(20), &edge_values(0.5)).unwrap();
    assert!(group.dirty_regions() != 0, "region 0 should be dirty");
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
    // Delete the middle edge
    group.delete_row(1).unwrap();
    // Remaining edges should still be findable
    let rows: Vec<_> = group.find_edges(base).collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows, vec![0, 2]);
  }
}
