use crate::types::{ColumnId, EdgeId, LabelId, NodeId, PropertyValue};

/// The v0 command model.
///
/// All mutations enter the system through these commands.
/// The commit log is a sequence of checksummed commands. Replay is deterministic.
/// This follows the TigerBeetle principle: the log owns commit semantics.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
  /// Create a node with the given label and properties.
  CreateNode {
    node_id:    NodeId,
    label_id:   LabelId,
    properties: Vec<PropertyValue>,
  },

  /// Create an edge between two nodes.
  CreateEdge {
    edge_id:    EdgeId,
    type_id:    LabelId,
    from:       NodeId,
    to:         NodeId,
    properties: Vec<PropertyValue>,
  },

  /// Insert or update a vector attached to a node.
  /// ANN is derived from committed vectors — vectors are stored in base graph store.
  UpsertVector {
    node_id:   NodeId,
    /// Column ID of the vector property within the node label schema.
    column_id: ColumnId,
    vector:    Vec<f32>,
  },

  /// Soft-delete a node. Does not remove edges immediately in v0.
  DeleteNode { node_id: NodeId },

  /// Delete an edge by its ID.
  DeleteEdge { edge_id: EdgeId },
}

/// A log entry wraps a command with metadata for the commit log.
#[derive(Debug, Clone, PartialEq)]
pub struct LogEntry {
  /// Monotonically increasing log sequence number.
  pub lsn:      u64,
  /// Checksum of the serialized command bytes.
  /// Corrupt entries are rejected at replay time.
  pub checksum: u32,
  pub command:  Command,
}
