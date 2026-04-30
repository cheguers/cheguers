use crate::error::StorageError;
use crate::io::binary;
use crate::types::{ColumnId, DataType, LabelId, TableId};

/// Schema for a single property column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyDef {
  pub name:      String,
  pub column_id: ColumnId,
  pub data_type: DataType,
  pub nullable:  bool,
}

/// Fixed schema, single primary key, bounded property set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeLabelEntry {
  pub table_id:     TableId,
  pub label_id:     LabelId,
  pub name:         String,
  pub pk_column_id: ColumnId,
  pub properties:   Vec<PropertyDef>,
}

/// Fixed schema in v0: source label, destination label, type name, properties.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeTypeEntry {
  pub table_id:      TableId,
  pub label_id:      LabelId,
  pub name:          String,
  pub from_label_id: LabelId,
  pub to_label_id:   LabelId,
  pub properties:    Vec<PropertyDef>,
}

/// In v0 this is an in-memory structure rebuilt from the committed log on startup.
#[derive(Debug, Default, Clone)]
pub struct Catalog {
  pub node_labels: Vec<NodeLabelEntry>,
  pub edge_types:  Vec<EdgeTypeEntry>,
}

impl Catalog {
  #[must_use]
  pub fn get_node_label(&self, id: LabelId) -> Option<&NodeLabelEntry> {
    self.node_labels.iter().find(|e| e.label_id == id)
  }

  #[must_use]
  pub fn get_edge_type(&self, id: LabelId) -> Option<&EdgeTypeEntry> {
    self.edge_types.iter().find(|e| e.label_id == id)
  }

  #[must_use]
  pub fn serialized_len(&self) -> usize {
    let nodes: usize = self.node_labels.iter().map(Self::node_label_entry_len).sum();
    let edges: usize = self.edge_types.iter().map(Self::edge_type_entry_len).sum();
    4 + 4 + nodes + edges
  }

  pub fn serialize(&self, buf: &mut [u8]) -> Result<usize, StorageError> {
    let mut pos = 0;
    binary::write_u32(buf, &mut pos, self.node_labels.len() as u32);
    for entry in &self.node_labels {
      Self::write_node_label_entry(buf, &mut pos, entry);
    }
    binary::write_u32(buf, &mut pos, self.edge_types.len() as u32);
    for entry in &self.edge_types {
      Self::write_edge_type_entry(buf, &mut pos, entry);
    }
    Ok(pos)
  }

  pub fn deserialize(buf: &[u8]) -> Result<Self, StorageError> {
    let mut pos = 0;
    let num_node = binary::read_u32(buf, &mut pos) as usize;
    let node_labels = (0..num_node)
      .map(|_| Self::read_node_label_entry(buf, &mut pos))
      .collect::<Result<Vec<_>, _>>()?;
    let num_edge = binary::read_u32(buf, &mut pos) as usize;
    let edge_types = (0..num_edge)
      .map(|_| Self::read_edge_type_entry(buf, &mut pos))
      .collect::<Result<Vec<_>, _>>()?;
    Ok(Self { node_labels, edge_types })
  }

  fn property_def_len(p: &PropertyDef) -> usize {
    let vector_dim = matches!(p.data_type, DataType::Vector { .. }) as usize * 4;
    2 + p.name.len() + 4 + 1 + vector_dim + 1
  }

  fn node_label_entry_len(e: &NodeLabelEntry) -> usize {
    let props: usize = e.properties.iter().map(Self::property_def_len).sum();
    4 + 4 + 2 + e.name.len() + 4 + 4 + props
  }

  fn edge_type_entry_len(e: &EdgeTypeEntry) -> usize {
    let props: usize = e.properties.iter().map(Self::property_def_len).sum();
    4 + 4 + 2 + e.name.len() + 4 + 4 + 4 + props
  }

  fn write_node_label_entry(buf: &mut [u8], pos: &mut usize, e: &NodeLabelEntry) {
    binary::write_u32(buf, pos, e.table_id.0);
    binary::write_u32(buf, pos, e.label_id.0);
    Self::write_string(buf, pos, &e.name);
    binary::write_u32(buf, pos, e.pk_column_id.0);
    binary::write_u32(buf, pos, e.properties.len() as u32);
    for p in &e.properties {
      Self::write_property_def(buf, pos, p);
    }
  }

  fn read_node_label_entry(buf: &[u8], pos: &mut usize) -> Result<NodeLabelEntry, StorageError> {
    let table_id = TableId(binary::read_u32(buf, pos));
    let label_id = LabelId(binary::read_u32(buf, pos));
    let name = Self::read_string(buf, pos)?;
    let pk_column_id = ColumnId(binary::read_u32(buf, pos));
    let num_props = binary::read_u32(buf, pos) as usize;
    let properties = (0..num_props)
      .map(|_| Self::read_property_def(buf, pos))
      .collect::<Result<Vec<_>, _>>()?;
    Ok(NodeLabelEntry { table_id, label_id, name, pk_column_id, properties })
  }

  fn write_edge_type_entry(buf: &mut [u8], pos: &mut usize, e: &EdgeTypeEntry) {
    binary::write_u32(buf, pos, e.table_id.0);
    binary::write_u32(buf, pos, e.label_id.0);
    Self::write_string(buf, pos, &e.name);
    binary::write_u32(buf, pos, e.from_label_id.0);
    binary::write_u32(buf, pos, e.to_label_id.0);
    binary::write_u32(buf, pos, e.properties.len() as u32);
    for p in &e.properties {
      Self::write_property_def(buf, pos, p);
    }
  }

  fn read_edge_type_entry(buf: &[u8], pos: &mut usize) -> Result<EdgeTypeEntry, StorageError> {
    let table_id = TableId(binary::read_u32(buf, pos));
    let label_id = LabelId(binary::read_u32(buf, pos));
    let name = Self::read_string(buf, pos)?;
    let from_label_id = LabelId(binary::read_u32(buf, pos));
    let to_label_id = LabelId(binary::read_u32(buf, pos));
    let num_props = binary::read_u32(buf, pos) as usize;
    let properties = (0..num_props)
      .map(|_| Self::read_property_def(buf, pos))
      .collect::<Result<Vec<_>, _>>()?;
    Ok(EdgeTypeEntry { table_id, label_id, name, from_label_id, to_label_id, properties })
  }

  fn write_property_def(buf: &mut [u8], pos: &mut usize, p: &PropertyDef) {
    Self::write_string(buf, pos, &p.name);
    binary::write_u32(buf, pos, p.column_id.0);
    binary::write_u8(buf, pos, p.data_type.discriminant());
    if let DataType::Vector { dim } = p.data_type {
      binary::write_u32(buf, pos, dim);
    }
    binary::write_u8(buf, pos, u8::from(p.nullable));
  }

  fn read_property_def(buf: &[u8], pos: &mut usize) -> Result<PropertyDef, StorageError> {
    let name = Self::read_string(buf, pos)?;
    let column_id = ColumnId(binary::read_u32(buf, pos));
    let disc = binary::read_u8(buf, pos);
    let data_type = DataType::from_discriminant(disc)
      .ok_or_else(|| StorageError::SerDe(format!("unknown DataType discriminant: {disc}")))?;
    let data_type = match data_type {
      DataType::Vector { .. } => DataType::Vector { dim: binary::read_u32(buf, pos) },
      other => other,
    };
    let nullable = binary::read_u8(buf, pos) != 0;
    Ok(PropertyDef { name, column_id, data_type, nullable })
  }

  fn write_string(buf: &mut [u8], pos: &mut usize, s: &str) {
    let bytes = s.as_bytes();
    binary::write_u16(buf, pos, bytes.len() as u16);
    binary::write_bytes(buf, pos, bytes);
  }

  fn read_string(buf: &[u8], pos: &mut usize) -> Result<String, StorageError> {
    let len = binary::read_u16(buf, pos) as usize;
    let bytes = binary::read_bytes(buf, pos, len);
    String::from_utf8(bytes.to_vec())
      .map_err(|e| StorageError::SerDe(format!("invalid UTF-8 in catalog string: {e}")))
  }
}
