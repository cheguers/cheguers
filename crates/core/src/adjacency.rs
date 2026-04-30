use crate::types::{EdgeId, LabelId, NodeId};

/// A reference to an edge from a node's adjacency list.
/// Used as the return type for CSR-based neighbor lookups.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeRef {
  pub edge_id: EdgeId,
  pub type_id: LabelId,
  pub neighbor: NodeId,
}
