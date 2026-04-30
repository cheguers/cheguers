use std::collections::{BTreeMap, HashSet};

use crate::catalog::EdgeTypeEntry;
use crate::config::StorageConfig;
use crate::table::edge::{CSREdgeGroup, CSREdgeRecord};
use crate::error::StorageError;
use crate::types::{Direction, EdgeId, LabelId, NodeGroupIdx, NodeId, NodeOffset, PageRange, PropertyValue, TableId};

use crate::io::file::FileManager;

/// Metadata mapping a CSR edge group to its on-disk page range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CSREdgeGroupPageInfo {
  pub group_idx:  NodeGroupIdx,
  pub direction:  Direction,
  pub page_range: PageRange,
}

/// Manages all CSR edge groups for a single edge type.
///
/// Groups are organised by **node-offset range**: group index `k` covers
/// node offsets `[k*NODE_GROUP_SIZE, (k+1)*NODE_GROUP_SIZE)`.
/// Multiple groups per range are created when one fills beyond
/// `NODE_GROUP_SIZE` edges.
pub struct EdgeTable {
  table_id: TableId,
  type_id:  LabelId,
  schema:   EdgeTypeEntry,

  /// Forward groups, keyed by node-offset range index.
  fwd_ranges: BTreeMap<NodeGroupIdx, Vec<CSREdgeGroup>>,
  /// Backward groups, same layout.
  bwd_ranges: BTreeMap<NodeGroupIdx, Vec<CSREdgeGroup>>,

  dirty_groups: HashSet<(NodeGroupIdx, Direction)>,
  page_infos:   Vec<CSREdgeGroupPageInfo>,
}

impl EdgeTable {
  pub fn new(schema: EdgeTypeEntry) -> Self {
    Self {
      table_id: schema.table_id,
      type_id: schema.label_id,
      schema,
      fwd_ranges: BTreeMap::new(),
      bwd_ranges: BTreeMap::new(),
      dirty_groups: HashSet::new(),
      page_infos: Vec::new(),
    }
  }

  pub fn table_id(&self) -> TableId { self.table_id }
  pub fn type_id(&self) -> LabelId { self.type_id }

  /// Compute the node-offset range index for a given offset.
  fn range_idx(offset: NodeOffset) -> NodeGroupIdx {
    NodeGroupIdx(offset / StorageConfig::NODE_GROUP_SIZE)
  }

  /// Find an existing non-full group for the given range, or create one.
  fn find_or_create_group<'a>(
    ranges: &'a mut BTreeMap<NodeGroupIdx, Vec<CSREdgeGroup>>,
    range_idx: NodeGroupIdx,
    direction: Direction,
    schema: &EdgeTypeEntry,
  ) -> (&'a mut CSREdgeGroup, NodeGroupIdx) {
    let new_idx = NodeGroupIdx(
      ranges.values().map(|v| v.len()).sum::<usize>() as u64
    );
    let groups = ranges.entry(range_idx).or_default();
    let needs_new = groups.last().map(|g| g.is_full()).unwrap_or(true);
    if needs_new {
      groups.push(CSREdgeGroup::new(new_idx, direction, schema));
    }
    let last = groups.last_mut().unwrap();
    let idx = last.group_idx();
    (last, idx)
  }

  /// Insert an edge. `from_offset` and `to_offset` are dense node offsets
  /// (group_idx * NODE_GROUP_SIZE + row) used as CSR keys.
  /// The caller (EdgeStore) is responsible for computing these from NodeTable.
  pub fn insert_edge(
    &mut self,
    edge_id: EdgeId,
    from: NodeId,
    to: NodeId,
    from_offset: NodeOffset,
    to_offset: NodeOffset,
    properties: &[Option<PropertyValue>],
  ) -> Result<(), StorageError> {
    let fwd_range = Self::range_idx(from_offset);
    let bwd_range = Self::range_idx(to_offset);

    let (fwd_group, fwd_idx) = Self::find_or_create_group(
      &mut self.fwd_ranges, fwd_range, Direction::Forward, &self.schema,
    );
    let (bwd_group, bwd_idx) = Self::find_or_create_group(
      &mut self.bwd_ranges, bwd_range, Direction::Backward, &self.schema,
    );

    fwd_group.insert_edge(from_offset, edge_id, from, to, properties)?;
    bwd_group.insert_edge(to_offset, edge_id, from, to, properties)?;

    self.dirty_groups.insert((fwd_idx, Direction::Forward));
    self.dirty_groups.insert((bwd_idx, Direction::Backward));
    Ok(())
  }

  pub fn get_edge(&self, edge_id: EdgeId) -> Result<Option<CSREdgeRecord>, StorageError> {
    for groups in self.fwd_ranges.values() {
      for group in groups {
        if let Some(row) = group.find_edge(edge_id) {
          return group.get_row(row);
        }
      }
    }
    Ok(None)
  }

  pub fn delete_edge(&mut self, edge_id: EdgeId) -> Result<(), StorageError> {
    let mut found = false;
    for groups in self.fwd_ranges.values_mut() {
      for group in groups.iter_mut() {
        if let Some(row) = group.find_edge(edge_id) {
          let gid = group.group_idx();
          group.delete_row(row)?;
          self.dirty_groups.insert((gid, Direction::Forward));
          found = true;
          break;
        }
      }
      if found { break; }
    }
    for groups in self.bwd_ranges.values_mut() {
      for group in groups.iter_mut() {
        if let Some(row) = group.find_edge(edge_id) {
          let gid = group.group_idx();
          group.delete_row(row)?;
          self.dirty_groups.insert((gid, Direction::Backward));
          found = true;
          break;
        }
      }
      if found { break; }
    }
    if !found {
      return Err(StorageError::EdgeNotFound { edge_id });
    }
    Ok(())
  }

  /// CSR-based neighbor lookup. Appends all EdgeRefs for a node in the given direction.
  pub fn neighbors_into(&self, node_offset: NodeOffset, dir: Direction, out: &mut Vec<crate::adjacency::EdgeRef>) {
    let range = Self::range_idx(node_offset);
    let ranges = match dir {
      Direction::Forward => &self.fwd_ranges,
      Direction::Backward => &self.bwd_ranges,
    };
    let type_id = self.type_id;
    if let Some(groups) = ranges.get(&range) {
      for group in groups {
        for row in group.find_edges(node_offset) {
          if let Ok(Some(record)) = group.get_row(row) {
            let neighbor = match dir {
              Direction::Forward => record.to,
              Direction::Backward => record.from,
            };
            out.push(crate::adjacency::EdgeRef {
              edge_id: record.edge_id,
              type_id,
              neighbor,
            });
          }
        }
      }
    }
  }

  pub fn num_groups(&self) -> usize {
    self.fwd_ranges.values().map(|v| v.len()).sum()
  }

  pub fn num_edges(&self) -> u64 {
    self.fwd_ranges.values()
      .flat_map(|v| v.iter())
      .map(|g| g.num_live_rows())
      .sum()
  }

  pub fn iter(&self) -> CSREdgeScanIter<'_> {
    let all_groups: Vec<&CSREdgeGroup> = self.fwd_ranges.values().flat_map(|v| v.iter()).collect();
    CSREdgeScanIter { groups: all_groups, group_idx: 0, row_idx: 0 }
  }

  pub fn page_infos(&self) -> &[CSREdgeGroupPageInfo] { &self.page_infos }

  pub fn flush(&mut self, fm: &mut FileManager) -> Result<(), StorageError> {
    let dirty: Vec<_> = self.dirty_groups.iter().copied().collect();
    for (ng_idx, dir) in dirty {
      let ranges = match dir {
        Direction::Forward => &mut self.fwd_ranges,
        Direction::Backward => &mut self.bwd_ranges,
      };
      let group = Self::find_group_by_idx_mut(ranges, ng_idx)
        .ok_or_else(|| StorageError::SerDe(format!("group {ng_idx} not found during flush")))?;
      let pages = group.serialize_to_pages()?;
      group.clear_dirty_regions();
      let num = pages.len() as u64;
      let start = fm.allocate_pages(num)?;
      fm.write_page_range(start, &pages)?;
      self.upsert_page_info(ng_idx, dir, PageRange { start_page: start, num_pages: num as u32 });
      self.dirty_groups.remove(&(ng_idx, dir));
    }
    fm.sync()
  }

  /// Find a specific group by its global group index. Returns mutable reference.
  fn find_group_by_idx_mut(
    ranges: &mut BTreeMap<NodeGroupIdx, Vec<CSREdgeGroup>>,
    idx: NodeGroupIdx,
  ) -> Option<&mut CSREdgeGroup> {
    for groups in ranges.values_mut() {
      for g in groups.iter_mut() {
        if g.group_idx() == idx {
          return Some(g);
        }
      }
    }
    None
  }

  pub fn load(
    schema: EdgeTypeEntry,
    page_infos: Vec<CSREdgeGroupPageInfo>,
    fm: &mut FileManager,
  ) -> Result<Self, StorageError> {
    let mut fwd_ranges: BTreeMap<NodeGroupIdx, Vec<CSREdgeGroup>> = BTreeMap::new();
    let mut bwd_ranges: BTreeMap<NodeGroupIdx, Vec<CSREdgeGroup>> = BTreeMap::new();
    for info in &page_infos {
      let pages = fm.read_page_range(info.page_range.start_page, info.page_range.num_pages)?;
      let group = CSREdgeGroup::deserialize_from_pages(info.direction, &schema, info.group_idx, &pages)?;
      // Determine range from the group's offset_base (stored in serialized form).
      // We need to peek at offset_base — add a method or compute from saved data.
      // For now, reconstruct the range from the group_idx stored in the group.
      let range_idx = NodeGroupIdx(group.offset_base() / StorageConfig::NODE_GROUP_SIZE);
      let target = match info.direction {
        Direction::Forward => &mut fwd_ranges,
        Direction::Backward => &mut bwd_ranges,
      };
      target.entry(range_idx).or_default().push(group);
    }
    Ok(Self {
      table_id: schema.table_id,
      type_id: schema.label_id,
      schema,
      fwd_ranges,
      bwd_ranges,
      dirty_groups: HashSet::new(),
      page_infos,
    })
  }

  fn upsert_page_info(&mut self, group_idx: NodeGroupIdx, direction: Direction, range: PageRange) {
    for info in &mut self.page_infos {
      if info.group_idx == group_idx && info.direction == direction {
        info.page_range = range;
        return;
      }
    }
    self.page_infos.push(CSREdgeGroupPageInfo { group_idx, direction, page_range: range });
  }
}

pub struct CSREdgeScanIter<'a> {
  groups:    Vec<&'a CSREdgeGroup>,
  group_idx: usize,
  row_idx:   u64,
}

impl<'a> Iterator for CSREdgeScanIter<'a> {
  type Item = CSREdgeRecord;

  fn next(&mut self) -> Option<Self::Item> {
    while self.group_idx < self.groups.len() {
      let group = self.groups[self.group_idx];
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
      table_id: TableId(1),
      label_id: LabelId(1),
      name: "Knows".to_string(),
      from_label_id: LabelId(0),
      to_label_id: LabelId(0),
      properties: vec![crate::catalog::PropertyDef {
        name: "weight".to_string(),
        column_id: crate::types::ColumnId(0),
        data_type: crate::types::DataType::Float64,
        nullable: false,
      }],
    }
  }

  fn ev(weight: f64) -> Vec<Option<PropertyValue>> {
    vec![Some(PropertyValue::Float64(weight))]
  }

  #[test]
  fn single_insert_and_get() {
    let mut table = EdgeTable::new(knows_schema());
    table.insert_edge(EdgeId(1), NodeId(10), NodeId(20), 100, 200, &ev(0.95)).unwrap();
    let record = table.get_edge(EdgeId(1)).unwrap().unwrap();
    assert_eq!(record.edge_id, EdgeId(1));
  }

  #[test]
  fn neighbors_csr() {
    let mut table = EdgeTable::new(knows_schema());
    table.insert_edge(EdgeId(1), NodeId(10), NodeId(20), 100, 200, &ev(0.5)).unwrap();
    table.insert_edge(EdgeId(2), NodeId(10), NodeId(30), 100, 300, &ev(0.7)).unwrap();

    let mut fwd = Vec::new();
    table.neighbors_into(100, Direction::Forward, &mut fwd);
    assert_eq!(fwd.len(), 2);
    assert!(fwd.iter().any(|r| r.neighbor == NodeId(20)));
    assert!(fwd.iter().any(|r| r.neighbor == NodeId(30)));

    let mut bwd = Vec::new();
    table.neighbors_into(300, Direction::Backward, &mut bwd);
    assert_eq!(bwd.len(), 1);
    assert_eq!(bwd[0].neighbor, NodeId(10));
  }

  #[test]
  fn delete_edge() {
    let mut table = EdgeTable::new(knows_schema());
    table.insert_edge(EdgeId(1), NodeId(10), NodeId(20), 100, 200, &ev(0.5)).unwrap();
    assert_eq!(table.num_edges(), 1);
    table.delete_edge(EdgeId(1)).unwrap();
    assert_eq!(table.num_edges(), 0);
    assert!(table.get_edge(EdgeId(1)).unwrap().is_none());
  }

  #[test]
  fn delete_missing_edge_returns_error() {
    let mut table = EdgeTable::new(knows_schema());
    assert!(matches!(table.delete_edge(EdgeId(999)), Err(StorageError::EdgeNotFound { .. })));
  }

  #[test]
  fn scan_iterator_skips_deleted() {
    let mut table = EdgeTable::new(knows_schema());
    for i in 0..5 {
      table.insert_edge(EdgeId(i), NodeId(10), NodeId(20 + i), 100, 200 + i, &ev(0.5)).unwrap();
    }
    table.delete_edge(EdgeId(1)).unwrap();
    table.delete_edge(EdgeId(3)).unwrap();

    let collected: Vec<_> = table.iter().map(|r| r.edge_id).collect();
    assert_eq!(collected, vec![EdgeId(0), EdgeId(2), EdgeId(4)]);
  }

  #[test]
  fn scan_empty_table() {
    let table = EdgeTable::new(knows_schema());
    assert_eq!(table.iter().count(), 0);
  }

  #[test]
  fn multi_group_overflow() {
    let mut table = EdgeTable::new(knows_schema());
    // Insert edges all routed to the same node-offset range (group 0).
    // After NODE_GROUP_SIZE insertions, a second group for range 0 should be created.
    let total = crate::config::StorageConfig::NODE_GROUP_SIZE + 100;
    for i in 0..total {
      table.insert_edge(EdgeId(i), NodeId(10), NodeId(20), i, 200 + i, &ev(0.5)).unwrap();
    }
    assert!(table.num_groups() > 1);
    assert_eq!(table.num_edges(), total);
  }
}
