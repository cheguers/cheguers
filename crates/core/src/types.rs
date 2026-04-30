use std::fmt;

/// Logical IDs everywhere — no raw physical pointers across pages on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EdgeId(pub u64);

/// Used to distinguish node labels and edge types in the catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LabelId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ColumnId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TableId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PageIdx(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeGroupIdx(pub u64);

impl fmt::Display for NodeId {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}
impl fmt::Display for EdgeId {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}
impl fmt::Display for LabelId {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}
impl fmt::Display for ColumnId {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}
impl fmt::Display for TableId {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}
impl fmt::Display for PageIdx {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}
impl fmt::Display for NodeGroupIdx {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}

/// Row index within a node group.
pub type RowIdx = u64;

/// Dense offset within a node table: `group_idx * NODE_GROUP_SIZE + row`.
/// Used as the CSR key for edge adjacency lookups.
pub type NodeOffset = u64;

/// Offset within a structure (node offset, slot offset, etc.).
pub type Offset = u64;

/// Contiguous range of pages owned by a structure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageRange {
  pub start_page: PageIdx,
  pub num_pages:  u32,
}

/// The type of a property column.
/// Defined here (not in catalog) so `PropertyValue::data_type()` has no circular dep.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum DataType {
  Bool,
  Int64,
  Float64,
  String,
  Bytes,
  Vector { dim: u32 },
}

impl DataType {
  /// On-disk discriminant byte for this type.
  #[must_use]
  pub fn discriminant(&self) -> u8 {
    match self {
      Self::Bool => 0,
      Self::Int64 => 1,
      Self::Float64 => 2,
      Self::String => 3,
      Self::Bytes => 4,
      Self::Vector { .. } => 5,
    }
  }

  /// Reconstruct from an on-disk discriminant byte.
  /// Returns `None` if the discriminant is unknown.
  #[must_use]
  pub fn from_discriminant(d: u8) -> Option<Self> {
    match d {
      0 => Some(Self::Bool),
      1 => Some(Self::Int64),
      2 => Some(Self::Float64),
      3 => Some(Self::String),
      4 => Some(Self::Bytes),
      5 => Some(Self::Vector { dim: 0 }),
      _ => None,
    }
  }
}

impl fmt::Display for DataType {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Bool => write!(f, "Bool"),
      Self::Int64 => write!(f, "Int64"),
      Self::Float64 => write!(f, "Float64"),
      Self::String => write!(f, "String"),
      Self::Bytes => write!(f, "Bytes"),
      Self::Vector { dim } => write!(f, "Vector({dim})"),
    }
  }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PropertyValue {
  Bool(bool),
  Int64(i64),
  Float64(f64),
  String(String),
  Bytes(Vec<u8>),
}

impl PropertyValue {
  /// Returns the `DataType` corresponding to this value's variant.
  #[must_use]
  pub fn data_type(&self) -> DataType {
    match self {
      Self::Bool(_) => DataType::Bool,
      Self::Int64(_) => DataType::Int64,
      Self::Float64(_) => DataType::Float64,
      Self::String(_) => DataType::String,
      Self::Bytes(_) => DataType::Bytes,
    }
  }
}

impl fmt::Display for PropertyValue {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Bool(b) => write!(f, "{b}"),
      Self::Int64(n) => write!(f, "{n}"),
      Self::Float64(x) => write!(f, "{x}"),
      Self::String(s) => write!(f, "{s}"),
      Self::Bytes(b) => write!(f, "<{} bytes>", b.len()),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Direction {
  Forward,
  Backward,
}
