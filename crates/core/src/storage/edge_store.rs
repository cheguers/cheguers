use std::collections::HashMap;

use crate::catalog::Catalog;
use crate::command::Command;
use crate::storage::{AdjacencyIndex, EdgeRef, EdgeRecord, EdgeTable, StorageError};
use crate::types::{Direction, EdgeId, LabelId, PropertyValue};

pub struct EdgeStore {
  tables: HashMap<LabelId, EdgeTable>,
  adjacency: AdjacencyIndex,
  catalog: Catalog,
}

impl EdgeStore {
  pub fn new(catalog: Catalog) -> Self {
    let mut tables = HashMap::new();
    for edge_type in &catalog.edge_types {
      tables.insert(edge_type.label_id, EdgeTable::new(edge_type.clone()));
    }

    Self {
      tables,
      adjacency: AdjacencyIndex::new(),
      catalog,
    }
  }

  pub fn apply_command(&mut self, cmd: &Command) -> Result<(), StorageError> {
    match cmd {
      Command::CreateEdge {
        edge_id,
        type_id,
        from,
        to,
        properties,
      } => {
        let schema = self
          .catalog
          .get_edge_type(*type_id)
          .ok_or(StorageError::LabelNotFound { label_id: *type_id })?;
        let aligned = align_properties(schema, properties);
        let table = self
          .tables
          .get_mut(type_id)
          .ok_or(StorageError::LabelNotFound { label_id: *type_id })?;
        table.insert_edge(*edge_id, *from, *to, &aligned)?;
        self.adjacency.add_edge(*edge_id, *type_id, *from, *to);
        Ok(())
      }
      Command::DeleteEdge { edge_id } => {
        for table in self.tables.values_mut() {
          if let Ok(Some(record)) = table.get_edge(*edge_id) {
            let from = record.from;
            let to = record.to;
            table.delete_edge(*edge_id)?;
            self.adjacency.remove_edge(*edge_id, from, to);
            return Ok(());
          }
        }
        Err(StorageError::EdgeNotFound { edge_id: *edge_id })
      }
      Command::CreateNode { .. } | Command::UpsertVector { .. } | Command::DeleteNode { .. } => {
        Ok(())
      }
    }
  }

  pub fn get_edge(&self, edge_id: EdgeId, type_id: LabelId) -> Option<EdgeRecord> {
    self
      .tables
      .get(&type_id)
      .and_then(|t| t.get_edge(edge_id).ok().flatten())
  }

  pub fn scan_type(&self, type_id: LabelId) -> impl Iterator<Item = EdgeRecord> + '_ {
    self
      .tables
      .get(&type_id)
      .map(|t| t.iter())
      .into_iter()
      .flatten()
  }

  pub fn num_edges(&self, type_id: LabelId) -> u64 {
    self.tables.get(&type_id).map(|t| t.num_edges()).unwrap_or(0)
  }

  pub fn neighbors(&self, node: crate::types::NodeId, dir: Direction) -> &[EdgeRef] {
    match dir {
      Direction::Forward => self.adjacency.get_forward(node),
      Direction::Backward => self.adjacency.get_backward(node),
    }
  }
}

fn align_properties(schema: &crate::catalog::EdgeTypeEntry, values: &[PropertyValue]) -> Vec<Option<PropertyValue>> {
  schema
    .properties
    .iter()
    .enumerate()
    .map(|(i, _)| values.get(i).cloned())
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn catalog_with_knows() -> Catalog {
    let mut catalog = Catalog::default();
    catalog.edge_types.push(crate::catalog::EdgeTypeEntry {
      table_id: crate::types::TableId(1),
      label_id: crate::types::LabelId(1),
      name: "Knows".to_string(),
      from_label_id: crate::types::LabelId(0),
      to_label_id: crate::types::LabelId(0),
      properties: vec![crate::catalog::PropertyDef {
        name: "weight".to_string(),
        column_id: crate::types::ColumnId(0),
        data_type: crate::types::DataType::Float64,
        nullable: false,
      }],
    });
    catalog
  }

  fn edge_values() -> Vec<PropertyValue> {
    vec![PropertyValue::Float64(0.95)]
  }

  #[test]
  fn create_and_read_edge() {
    let mut store = EdgeStore::new(catalog_with_knows());
    let edge_id = EdgeId(1);
    let type_id = crate::types::LabelId(1);

    let cmd = Command::CreateEdge {
      edge_id,
      type_id,
      from: crate::types::NodeId(10),
      to: crate::types::NodeId(20),
      properties: edge_values(),
    };
    store.apply_command(&cmd).expect("apply");

    let record = store.get_edge(edge_id, type_id).expect("get");
    assert_eq!(record.edge_id, edge_id);
  }

  #[test]
  fn delete_edge_via_command() {
    let mut store = EdgeStore::new(catalog_with_knows());
    let edge_id = EdgeId(1);
    let type_id = crate::types::LabelId(1);

    store
      .apply_command(&Command::CreateEdge {
        edge_id,
        type_id,
        from: crate::types::NodeId(10),
        to: crate::types::NodeId(20),
        properties: edge_values(),
      })
      .expect("create");

    assert_eq!(store.num_edges(type_id), 1);

    store
      .apply_command(&Command::DeleteEdge { edge_id })
      .expect("delete");

    assert_eq!(store.num_edges(type_id), 0);
    assert!(store.get_edge(edge_id, type_id).is_none());
  }

  #[test]
  fn delete_missing_edge_returns_error() {
    let mut store = EdgeStore::new(catalog_with_knows());
    let err = store
      .apply_command(&Command::DeleteEdge {
        edge_id: EdgeId(999),
      })
      .expect_err("should error");
    assert_eq!(
      err,
      StorageError::EdgeNotFound {
        edge_id: EdgeId(999)
      }
    );
  }

  #[test]
  fn unknown_type_returns_error() {
    let mut store = EdgeStore::new(catalog_with_knows());
    let err = store
      .apply_command(&Command::CreateEdge {
        edge_id: EdgeId(1),
        type_id: crate::types::LabelId(999),
        from: crate::types::NodeId(10),
        to: crate::types::NodeId(20),
        properties: edge_values(),
      })
      .expect_err("should error");
    assert_eq!(
      err,
      StorageError::LabelNotFound {
        label_id: crate::types::LabelId(999)
      }
    );
  }

  #[test]
  fn adjacency_updated_on_create() {
    let mut store = EdgeStore::new(catalog_with_knows());
    let from = crate::types::NodeId(10);
    let to = crate::types::NodeId(20);

    store
      .apply_command(&Command::CreateEdge {
        edge_id: EdgeId(1),
        type_id: crate::types::LabelId(1),
        from,
        to,
        properties: edge_values(),
      })
      .expect("apply");

    let forward = store.neighbors(from, Direction::Forward);
    assert_eq!(forward.len(), 1);
    assert_eq!(forward[0].neighbor, to);
  }

  #[test]
  fn adjacency_updated_on_delete() {
    let mut store = EdgeStore::new(catalog_with_knows());
    let from = crate::types::NodeId(10);
    let to = crate::types::NodeId(20);

    store
      .apply_command(&Command::CreateEdge {
        edge_id: EdgeId(1),
        type_id: crate::types::LabelId(1),
        from,
        to,
        properties: edge_values(),
      })
      .expect("create");

    store
      .apply_command(&Command::DeleteEdge {
        edge_id: EdgeId(1),
      })
      .expect("delete");

    assert_eq!(store.neighbors(from, Direction::Forward).len(), 0);
  }

  #[test]
  fn replay_sequence() {
    let mut store = EdgeStore::new(catalog_with_knows());
    let type_id = crate::types::LabelId(1);

    for i in 0..10 {
      store
        .apply_command(&Command::CreateEdge {
          edge_id: EdgeId(i),
          type_id,
          from: crate::types::NodeId(100),
          to: crate::types::NodeId(200 + i),
          properties: edge_values(),
        })
        .expect("create");
    }

    for i in 0..10 {
      if i % 2 == 0 {
        store
          .apply_command(&Command::DeleteEdge {
            edge_id: EdgeId(i),
          })
          .expect("delete");
      }
    }

    let remaining: Vec<_> = store
      .scan_type(type_id)
      .map(|r| r.edge_id)
      .collect();
    assert_eq!(remaining, vec![EdgeId(1), EdgeId(3), EdgeId(5), EdgeId(7), EdgeId(9)]);
  }

  #[test]
  fn node_command_is_ignored() {
    let mut store = EdgeStore::new(catalog_with_knows());

    store
      .apply_command(&Command::CreateNode {
        node_id: crate::types::NodeId(1),
        label_id: crate::types::LabelId(0),
        properties: vec![],
      })
      .expect("should silently ok");

    store
      .apply_command(&Command::DeleteNode {
        node_id: crate::types::NodeId(1),
      })
      .expect("should silently ok");

    store
      .apply_command(&Command::UpsertVector {
        node_id: crate::types::NodeId(1),
        column_id: crate::types::ColumnId(0),
        vector: vec![],
      })
      .expect("should silently ok");
  }

  #[test]
  fn scan_unknown_type_returns_empty_iter() {
    let store = EdgeStore::new(catalog_with_knows());
    assert_eq!(store.scan_type(crate::types::LabelId(999)).count(), 0);
  }
}
