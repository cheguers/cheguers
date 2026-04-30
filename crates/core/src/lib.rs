pub mod adjacency;
pub mod catalog;
pub mod command;
pub mod config;
pub mod error;
pub mod io;
pub mod state;
pub mod table;
pub mod types;

#[cfg(test)]
pub mod testing;

pub use state::database::StorageManager;
pub use state::edge_store::EdgeStore;
pub use state::edge_table::EdgeTable;
pub use table::edge::CSREdgeRecord;
pub use io::page::Page;
pub use error::StorageError;

pub fn init() {}
