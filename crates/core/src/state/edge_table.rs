use std::collections::{BTreeMap, HashSet};

use crate::adjacency::EdgeRef;
use crate::catalog::EdgeTypeEntry;
use crate::config::StorageConfig;
use crate::error::StorageError;
use crate::io::file::FileManager;
use crate::table::edge::{CSREdgeGroup, CSREdgeRecord};
use crate::types::{Direction, EdgeId, LabelId, NodeGroupIdx, NodeId, NodeOffset, PageRange, PropertyValue, TableId};

/// Metadata mapping a CSR edge group to its on-disk page range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CSREdgeGroupPageInfo {
  pub group_idx:  NodeGroupIdx,
  pub direction:  Direction,
  pub page_range: PageRange,
}

type RangeMap = BTreeMap<NodeGroupIdx, Vec<CSREdgeGroup>>;

/// Groups are organised by **node-offset range**: group `k` covers offsets
/// `[k * NODE_GROUP_SIZE, (k+1) * NODE_GROUP_SIZE)`. Multiple groups per range
/// are created when one fills beyond `NODE_GROUP_SIZE` edges.
pub struct EdgeTable {
  table_id: TableId,
  type_id:  LabelId,
  schema:   EdgeTypeEntry,

  fwd_ranges: RangeMap,
  bwd_ranges: RangeMap,

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

  #[inline]
  pub fn table_id(&self) -> TableId {
    self.table_id
  }

  #[inline]
  pub fn type_id(&self) -> LabelId {
    self.type_id
  }

  fn range_idx(offset: NodeOffset) -> NodeGroupIdx {
    NodeGroupIdx(offset / StorageConfig::NODE_GROUP_SIZE)
  }

  fn find_or_create_group<'a>(
    ranges: &'a mut RangeMap,
    range_idx: NodeGroupIdx,
    direction: Direction,
    schema: &EdgeTypeEntry,
  ) -> &'a mut CSREdgeGroup {
    let groups = ranges.entry(range_idx).or_default();
    if groups.last().is_none_or(CSREdgeGroup::is_full) {
      groups.push(CSREdgeGroup::new(range_idx, direction, schema));
    }
    groups.last_mut().expect("just pushed if missing")
  }

  /// `from_offset` and `to_offset` are dense node offsets used as CSR keys;
  /// `EdgeStore` is responsible for computing them from `NodeTable`.
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

    let fwd_group = Self::find_or_create_group(
      &mut self.fwd_ranges,
      fwd_range,
      Direction::Forward,
      &self.schema,
    );
    let fwd_idx = fwd_group.group_idx();
    fwd_group.insert_edge(from_offset, edge_id, from, to, properties)?;

    let bwd_group = Self::find_or_create_group(
      &mut self.bwd_ranges,
      bwd_range,
      Direction::Backward,
      &self.schema,
    );
    let bwd_idx = bwd_group.group_idx();
    bwd_group.insert_edge(to_offset, edge_id, from, to, properties)?;

    self.dirty_groups.insert((fwd_idx, Direction::Forward));
    self.dirty_groups.insert((bwd_idx, Direction::Backward));
    Ok(())
  }

  pub fn get_edge(&self, edge_id: EdgeId) -> Result<Option<CSREdgeRecord>, StorageError> {
    self
      .fwd_ranges
      .values()
      .flat_map(|groups| groups.iter())
      .find_map(|g| g.find_edge(edge_id).map(|row| g.get_row(row)))
      .unwrap_or(Ok(None))
  }

  pub fn delete_edge(&mut self, edge_id: EdgeId) -> Result<(), StorageError> {
    let mut deleted = false;
    deleted |= Self::delete_edge_in(&mut self.fwd_ranges, edge_id, Direction::Forward, &mut self.dirty_groups)?;
    deleted |= Self::delete_edge_in(&mut self.bwd_ranges, edge_id, Direction::Backward, &mut self.dirty_groups)?;

    if deleted {
      Ok(())
    } else {
      Err(StorageError::EdgeNotFound { edge_id })
    }
  }

  fn delete_edge_in(
    ranges: &mut RangeMap,
    edge_id: EdgeId,
    direction: Direction,
    dirty: &mut HashSet<(NodeGroupIdx, Direction)>,
  ) -> Result<bool, StorageError> {
    for groups in ranges.values_mut() {
      for group in groups.iter_mut() {
        if let Some(row) = group.find_edge(edge_id) {
          let gid = group.group_idx();
          group.delete_row(row)?;
          dirty.insert((gid, direction));
          return Ok(true);
        }
      }
    }
    Ok(false)
  }

  pub fn neighbors_into(&self, node_offset: NodeOffset, dir: Direction, out: &mut Vec<EdgeRef>) {
    let ranges = match dir {
      Direction::Forward => &self.fwd_ranges,
      Direction::Backward => &self.bwd_ranges,
    };
    let Some(groups) = ranges.get(&Self::range_idx(node_offset)) else {
      return;
    };

    for group in groups {
      for row in group.find_edges(node_offset) {
        if let Ok(Some(record)) = group.get_row(row) {
          let neighbor = match dir {
            Direction::Forward => record.to,
            Direction::Backward => record.from,
          };
          out.push(EdgeRef { edge_id: record.edge_id, type_id: self.type_id, neighbor });
        }
      }
    }
  }

  pub fn num_groups(&self) -> usize {
    self.fwd_ranges.values().map(Vec::len).sum()
  }

  pub fn num_edges(&self) -> u64 {
    self
      .fwd_ranges
      .values()
      .flat_map(|v| v.iter())
      .map(CSREdgeGroup::num_live_rows)
      .sum()
  }

  pub fn iter(&self) -> impl Iterator<Item = CSREdgeRecord> + '_ {
    self
      .fwd_ranges
      .values()
      .flat_map(|groups| groups.iter())
      .flat_map(|group| {
        (0..group.num_rows()).filter_map(move |row| group.get_row(row).ok().flatten())
      })
  }

  pub fn page_infos(&self) -> &[CSREdgeGroupPageInfo] {
    &self.page_infos
  }

  pub fn flush(&mut self, fm: &mut FileManager) -> Result<(), StorageError> {
    let dirty: Vec<_> = self.dirty_groups.drain().collect();
    for (ng_idx, dir) in dirty {
      let ranges = match dir {
        Direction::Forward => &mut self.fwd_ranges,
        Direction::Backward => &mut self.bwd_ranges,
      };
      let group = Self::find_group_by_idx_mut(ranges, ng_idx)
        .ok_or_else(|| StorageError::SerDe(format!("group {ng_idx} not found during flush")))?;
      let pages = group.serialize_to_pages()?;
      group.clear_dirty_regions();
      let num_pages = pages.len() as u32;
      let start_page = fm.allocate_pages(pages.len() as u64)?;
      fm.write_page_range(start_page, &pages)?;
      self.upsert_page_info(ng_idx, dir, PageRange { start_page, num_pages });
    }
    fm.sync()
  }

  fn find_group_by_idx_mut(ranges: &mut RangeMap, idx: NodeGroupIdx) -> Option<&mut CSREdgeGroup> {
    ranges
      .values_mut()
      .flat_map(|g| g.iter_mut())
      .find(|g| g.group_idx() == idx)
  }

  pub fn load(
    schema: EdgeTypeEntry,
    page_infos: Vec<CSREdgeGroupPageInfo>,
    fm: &mut FileManager,
  ) -> Result<Self, StorageError> {
    let mut fwd_ranges = RangeMap::new();
    let mut bwd_ranges = RangeMap::new();

    for info in &page_infos {
      let pages = fm.read_page_range(info.page_range.start_page, info.page_range.num_pages)?;
      let group = CSREdgeGroup::deserialize_from_pages(info.direction, &schema, info.group_idx, &pages)?;
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
    if let Some(info) = self
      .page_infos
      .iter_mut()
      .find(|i| i.group_idx == group_idx && i.direction == direction)
    {
      info.page_range = range;
    } else {
      self.page_infos.push(CSREdgeGroupPageInfo { group_idx, direction, page_range: range });
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::catalog::PropertyDef;
  use crate::types::{ColumnId, DataType};

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
    let total = StorageConfig::NODE_GROUP_SIZE + 100;
    for i in 0..total {
      table.insert_edge(EdgeId(i), NodeId(10), NodeId(20), i, 200 + i, &ev(0.5)).unwrap();
    }
    assert!(table.num_groups() > 1);
    assert_eq!(table.num_edges(), total);
  }
}
