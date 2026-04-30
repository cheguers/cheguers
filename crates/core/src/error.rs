use std::fmt;

use crate::types::{DataType, EdgeId, LabelId, NodeId, RowIdx};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
  ColumnTypeMismatch { expected: DataType, got: DataType },
  NodeGroupFull,
  EdgeGroupFull,
  RowOutOfBounds { row: RowIdx, len: u64 },
  LabelNotFound { label_id: LabelId },
  NodeNotFound { node_id: NodeId },
  EdgeNotFound { edge_id: EdgeId },
  SerDe(String),
  Io(String),
  CorruptHeader,
  CsrEdgeGroupFull,
}

impl fmt::Display for StorageError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::ColumnTypeMismatch { expected, got } => {
        write!(f, "column type mismatch: expected {expected}, got {got}")
      }
      Self::NodeGroupFull => f.write_str("node group is full"),
      Self::EdgeGroupFull => f.write_str("edge group is full"),
      Self::RowOutOfBounds { row, len } => write!(f, "row {row} is out of bounds (len={len})"),
      Self::LabelNotFound { label_id } => write!(f, "label {label_id} not found"),
      Self::NodeNotFound { node_id } => write!(f, "node {node_id} not found"),
      Self::EdgeNotFound { edge_id } => write!(f, "edge {edge_id} not found"),
      Self::SerDe(msg) => write!(f, "serialization error: {msg}"),
      Self::Io(msg) => write!(f, "I/O error: {msg}"),
      Self::CorruptHeader => f.write_str("corrupt database header"),
      Self::CsrEdgeGroupFull => f.write_str("CSR edge group is full"),
    }
  }
}

impl std::error::Error for StorageError {}
