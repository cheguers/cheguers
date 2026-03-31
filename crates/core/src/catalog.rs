use crate::types::{ColumnId, DataType, LabelId, TableId};

/// Schema for a single property column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyDef {
  pub name:      String,
  pub column_id: ColumnId,
  pub data_type: DataType,
  pub nullable:  bool,
}

/// Schema for a node label.
/// Fixed schema, single primary key, bounded property set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeLabelEntry {
  pub table_id:     TableId,
  pub label_id:     LabelId,
  pub name:         String,
  pub pk_column_id: ColumnId,
  pub properties:   Vec<PropertyDef>,
}

/// Schema for an edge type.
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

/// The catalog holds all schema metadata for the shard.
/// In v0 this is an in-memory structure rebuilt from the committed log on startup.
#[derive(Debug, Default)]
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
}
