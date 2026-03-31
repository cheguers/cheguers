use std::collections::HashMap;

use crate::types::{EdgeId, LabelId, NodeId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeRef {
  pub edge_id: EdgeId,
  pub type_id: LabelId,
  pub neighbor: NodeId,
}

pub struct AdjacencyIndex {
  forward: HashMap<NodeId, Vec<EdgeRef>>,
  backward: HashMap<NodeId, Vec<EdgeRef>>,
}

impl AdjacencyIndex {
  pub fn new() -> Self {
    Self {
      forward: HashMap::new(),
      backward: HashMap::new(),
    }
  }

  pub fn add_edge(&mut self, edge_id: EdgeId, type_id: LabelId, from: NodeId, to: NodeId) {
    self
      .forward
      .entry(from)
      .or_insert_with(Vec::new)
      .push(EdgeRef {
        edge_id,
        type_id,
        neighbor: to,
      });

    self
      .backward
      .entry(to)
      .or_insert_with(Vec::new)
      .push(EdgeRef {
        edge_id,
        type_id,
        neighbor: from,
      });
  }

  pub fn remove_edge(&mut self, edge_id: EdgeId, from: NodeId, to: NodeId) {
    if let Some(refs) = self.forward.get_mut(&from) {
      refs.retain(|r| r.edge_id != edge_id);
    }
    if let Some(refs) = self.backward.get_mut(&to) {
      refs.retain(|r| r.edge_id != edge_id);
    }
  }

  pub fn get_forward(&self, node: NodeId) -> &[EdgeRef] {
    self.forward.get(&node).map(|v| v.as_slice()).unwrap_or(&[])
  }

  pub fn get_backward(&self, node: NodeId) -> &[EdgeRef] {
    self.backward.get(&node).map(|v| v.as_slice()).unwrap_or(&[])
  }
}

impl Default for AdjacencyIndex {
  fn default() -> Self {
    Self::new()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn add_and_get_forward() {
    let mut index = AdjacencyIndex::new();
    let edge_id = EdgeId(1);
    let type_id = LabelId(1);
    let from = NodeId(10);
    let to = NodeId(20);

    index.add_edge(edge_id, type_id, from, to);

    let refs = index.get_forward(from);
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].edge_id, edge_id);
    assert_eq!(refs[0].type_id, type_id);
    assert_eq!(refs[0].neighbor, to);
  }

  #[test]
  fn add_and_get_backward() {
    let mut index = AdjacencyIndex::new();
    let edge_id = EdgeId(1);
    let type_id = LabelId(1);
    let from = NodeId(10);
    let to = NodeId(20);

    index.add_edge(edge_id, type_id, from, to);

    let refs = index.get_backward(to);
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].edge_id, edge_id);
    assert_eq!(refs[0].type_id, type_id);
    assert_eq!(refs[0].neighbor, from);
  }

  #[test]
  fn remove_edge() {
    let mut index = AdjacencyIndex::new();
    let edge_id = EdgeId(1);
    let from = NodeId(10);
    let to = NodeId(20);

    index.add_edge(edge_id, LabelId(1), from, to);
    assert_eq!(index.get_forward(from).len(), 1);
    assert_eq!(index.get_backward(to).len(), 1);

    index.remove_edge(edge_id, from, to);
    assert_eq!(index.get_forward(from).len(), 0);
    assert_eq!(index.get_backward(to).len(), 0);
  }

  #[test]
  fn remove_nonexistent_is_silent() {
    let mut index = AdjacencyIndex::new();
    // Should not panic
    index.remove_edge(EdgeId(999), NodeId(10), NodeId(20));
  }

  #[test]
  fn get_empty_node_returns_empty_slice() {
    let index = AdjacencyIndex::new();
    assert_eq!(index.get_forward(NodeId(999)), &[]);
    assert_eq!(index.get_backward(NodeId(999)), &[]);
  }

  #[test]
  fn multiple_edges_same_node() {
    let mut index = AdjacencyIndex::new();

    index.add_edge(EdgeId(1), LabelId(1), NodeId(10), NodeId(20));
    index.add_edge(EdgeId(2), LabelId(1), NodeId(10), NodeId(30));

    let refs = index.get_forward(NodeId(10));
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0].neighbor, NodeId(20));
    assert_eq!(refs[1].neighbor, NodeId(30));
  }
}
