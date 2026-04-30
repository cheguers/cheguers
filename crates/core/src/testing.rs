//! Shared test fixtures for storage layer tests.

use crate::catalog::{Catalog, NodeLabelEntry, PropertyDef};
use crate::command::Command;
use crate::types::{ColumnId, DataType, LabelId, NodeId, PropertyValue, TableId};

pub fn person_schema() -> NodeLabelEntry {
  NodeLabelEntry {
    table_id:     TableId(0),
    label_id:     LabelId(0),
    name:         "Person".into(),
    pk_column_id: ColumnId(0),
    properties:   vec![
      PropertyDef {
        name:      "name".into(),
        column_id: ColumnId(0),
        data_type: DataType::String,
        nullable:  false,
      },
      PropertyDef {
        name:      "age".into(),
        column_id: ColumnId(1),
        data_type: DataType::Int64,
        nullable:  true,
      },
    ],
  }
}

pub fn person_values(name: &str, age: i64) -> Vec<Option<PropertyValue>> {
  vec![Some(PropertyValue::String(name.into())), Some(PropertyValue::Int64(age))]
}

pub fn catalog_with_person() -> Catalog {
  Catalog { node_labels: vec![person_schema()], edge_types: vec![] }
}

pub fn create_person(id: u64, name: &str, age: i64) -> Command {
  Command::CreateNode {
    node_id:    NodeId(id),
    label_id:   LabelId(0),
    properties: vec![PropertyValue::String(name.into()), PropertyValue::Int64(age)],
  }
}
