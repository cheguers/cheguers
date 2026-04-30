use std::fmt;

macro_rules! id_newtype {
  ($($name:ident($inner:ty)),* $(,)?) => {
    $(
      #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
      pub struct $name(pub $inner);

      impl fmt::Display for $name {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
          fmt::Display::fmt(&self.0, f)
        }
      }
    )*
  };
}

id_newtype! {
  NodeId(u64),
  EdgeId(u64),
  LabelId(u32),
  ColumnId(u32),
  TableId(u32),
  PageIdx(u64),
  NodeGroupIdx(u64),
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

  /// Returns `None` if the discriminant is unknown.
  #[must_use]
  pub fn from_discriminant(d: u8) -> Option<Self> {
    Some(match d {
      0 => Self::Bool,
      1 => Self::Int64,
      2 => Self::Float64,
      3 => Self::String,
      4 => Self::Bytes,
      5 => Self::Vector { dim: 0 },
      _ => return None,
    })
  }
}

impl fmt::Display for DataType {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Bool => f.write_str("Bool"),
      Self::Int64 => f.write_str("Int64"),
      Self::Float64 => f.write_str("Float64"),
      Self::String => f.write_str("String"),
      Self::Bytes => f.write_str("Bytes"),
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
      Self::Bool(b) => fmt::Display::fmt(b, f),
      Self::Int64(n) => fmt::Display::fmt(n, f),
      Self::Float64(x) => fmt::Display::fmt(x, f),
      Self::String(s) => f.write_str(s),
      Self::Bytes(b) => write!(f, "<{} bytes>", b.len()),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Direction {
  Forward,
  Backward,
}
