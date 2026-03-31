use std::collections::HashMap;

use crate::catalog::{Catalog, NodeLabelEntry};
use crate::command::Command;
use crate::types::{LabelId, NodeId, PropertyValue};

use super::error::StorageError;
use super::node_table::{NodeRecord, NodeTable};

/// Top-level in-memory node storage. Maps each LabelId to its NodeTable.
/// `apply_command` is the single write entry point — mirrors the log-driven
/// state machine described in the design doc.
pub struct NodeStore {
  tables:  HashMap<LabelId, NodeTable>,
  catalog: Catalog,
}

impl NodeStore {
  /// Build a NodeStore pre-populated with one empty NodeTable per label in the catalog.
  pub fn new(catalog: Catalog) -> Self {
    let tables = catalog
      .node_labels
      .iter()
      .map(|entry| (entry.label_id, NodeTable::new(entry.clone())))
      .collect();
    Self { tables, catalog }
  }

  /// Apply a command from the log. Only `CreateNode` and `DeleteNode` are handled here.
  /// Other variants are silently ignored (edges, vectors are separate stores in later phases).
  pub fn apply_command(&mut self, cmd: &Command) -> Result<(), StorageError> {
    match cmd {
      Command::CreateNode { node_id, label_id, properties } => {
        let schema = self
          .catalog
          .get_node_label(*label_id)
          .ok_or(StorageError::LabelNotFound { label_id: *label_id })?;
        let aligned = align_properties(schema, properties);
        let table = self
          .tables
          .get_mut(label_id)
          .ok_or(StorageError::LabelNotFound { label_id: *label_id })?;
        table.insert_node(*node_id, &aligned)?;
      }
      Command::DeleteNode { node_id } => {
        // DeleteNode doesn't carry a label_id — scan all tables.
        // Only NodeNotFound is a "keep scanning" signal; all other errors propagate.
        let mut found = false;
        for table in self.tables.values_mut() {
          match table.delete_node(*node_id) {
            Ok(()) => {
              found = true;
              break;
            }
            Err(StorageError::NodeNotFound { .. }) => continue,
            Err(e) => return Err(e),
          }
        }
        if !found {
          return Err(StorageError::NodeNotFound { node_id: *node_id });
        }
      }
      // Edges, vectors, and edge deletions are out of scope for this store.
      Command::CreateEdge { .. } | Command::UpsertVector { .. } | Command::DeleteEdge { .. } => {}
    }
    Ok(())
  }

  #[must_use]
  pub fn get_node(
    &self,
    node_id: NodeId,
    label_id: LabelId,
  ) -> Option<Vec<Option<PropertyValue>>> {
    self.tables.get(&label_id)?.get_node(node_id).ok().flatten()
  }

  #[must_use]
  pub fn scan_label(&self, label_id: LabelId) -> impl Iterator<Item = NodeRecord> + '_ {
    // Return an empty iterator for unknown labels rather than wrapping in Option.
    self
      .tables
      .get(&label_id)
      .into_iter()
      .flat_map(|t| t.iter())
  }

  #[must_use]
  pub fn num_nodes(&self, label_id: LabelId) -> u64 {
    self.tables.get(&label_id).map(|t| t.num_nodes()).unwrap_or(0)
  }
}

/// Map a flat `&[PropertyValue]` from a command onto the schema's column list positionally.
/// Extra values beyond the schema are ignored.
/// Missing values (fewer values than columns) become `None`.
fn align_properties(schema: &NodeLabelEntry, values: &[PropertyValue]) -> Vec<Option<PropertyValue>> {
  schema.properties.iter().enumerate().map(|(i, _)| values.get(i).cloned()).collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::catalog::{Catalog, NodeLabelEntry, PropertyDef};
  use crate::types::DataType;
  use crate::types::{ColumnId, EdgeId, LabelId, NodeId, TableId};

  fn catalog_with_person() -> Catalog {
    Catalog {
      node_labels: vec![NodeLabelEntry {
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
      }],
      edge_types: vec![],
    }
  }

  fn create_person(id: u64, name: &str, age: i64) -> Command {
    Command::CreateNode {
      node_id:    NodeId(id),
      label_id:   LabelId(0),
      properties: vec![PropertyValue::String(name.into()), PropertyValue::Int64(age)],
    }
  }

  #[test]
  fn create_and_read_node() {
    let mut store = NodeStore::new(catalog_with_person());
    store.apply_command(&create_person(1, "Alice", 30)).unwrap();

    let props = store.get_node(NodeId(1), LabelId(0)).unwrap();
    assert_eq!(props[0], Some(PropertyValue::String("Alice".into())));
    assert_eq!(props[1], Some(PropertyValue::Int64(30)));
  }

  #[test]
  fn delete_node_via_command() {
    let mut store = NodeStore::new(catalog_with_person());
    store.apply_command(&create_person(1, "Alice", 30)).unwrap();
    assert_eq!(store.num_nodes(LabelId(0)), 1);

    store.apply_command(&Command::DeleteNode { node_id: NodeId(1) }).unwrap();
    assert_eq!(store.num_nodes(LabelId(0)), 0);
    assert!(store.get_node(NodeId(1), LabelId(0)).is_none());
  }

  #[test]
  fn delete_missing_node_returns_error() {
    let mut store = NodeStore::new(catalog_with_person());
    let result = store.apply_command(&Command::DeleteNode { node_id: NodeId(99) });
    assert!(matches!(result, Err(StorageError::NodeNotFound { node_id: NodeId(99) })));
  }

  #[test]
  fn unknown_label_returns_error() {
    let mut store = NodeStore::new(catalog_with_person());
    let cmd = Command::CreateNode {
      node_id:    NodeId(1),
      label_id:   LabelId(99),
      properties: vec![],
    };
    assert!(matches!(
      store.apply_command(&cmd),
      Err(StorageError::LabelNotFound { label_id: LabelId(99) })
    ));
  }

  #[test]
  fn replay_sequence() {
    let mut store = NodeStore::new(catalog_with_person());
    for i in 0..10u64 {
      store.apply_command(&create_person(i, "X", i as i64)).unwrap();
    }
    for i in (0..10u64).step_by(2) {
      store.apply_command(&Command::DeleteNode { node_id: NodeId(i) }).unwrap();
    }
    assert_eq!(store.num_nodes(LabelId(0)), 5);

    let ids: Vec<u64> = store.scan_label(LabelId(0)).map(|r| r.node_id.0).collect();
    assert_eq!(ids, vec![1, 3, 5, 7, 9]);
  }

  #[test]
  fn edge_command_is_ignored() {
    let mut store = NodeStore::new(catalog_with_person());
    let cmd = Command::CreateEdge {
      edge_id:    EdgeId(1),
      type_id:    LabelId(0),
      from:       NodeId(1),
      to:         NodeId(2),
      properties: vec![],
    };
    assert!(store.apply_command(&cmd).is_ok());
  }

  #[test]
  fn scan_unknown_label_returns_empty_iter() {
    let store = NodeStore::new(catalog_with_person());
    assert_eq!(store.scan_label(LabelId(99)).count(), 0);
  }
}
