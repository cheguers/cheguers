use crate::types::PageIdx;

/// Storage configuration constants.
/// Inspired by Kuzu's `StorageConfig` / `system_config.h`.
pub struct StorageConfig;

impl StorageConfig {
  /// Page size as a power of 2 (default: 4 KiB).
  pub const PAGE_SIZE_LOG2: u32 = 12;
  /// Fundamental I/O unit: 4096 bytes.
  pub const PAGE_SIZE: u64 = 1 << Self::PAGE_SIZE_LOG2;

  pub const NODE_GROUP_SIZE_LOG2: u32 = 16;
  /// 65 536 rows per node group.
  pub const NODE_GROUP_SIZE: u64 = 1 << Self::NODE_GROUP_SIZE_LOG2;

  /// Maximum number of properties per node/edge label in v0.
  /// Bounded property set, typed at schema definition time.
  pub const MAX_PROPERTIES_PER_LABEL: usize = 64;

  /// Page index reserved for the database header.
  pub const DB_HEADER_PAGE_IDX: PageIdx = PageIdx(0);

  /// Log segment size (number of pages per segment in the commit log).
  pub const LOG_SEGMENT_SIZE_LOG2: u32 = 8;
  /// 256 pages per log segment.
  pub const LOG_SEGMENT_SIZE: u64 = 1 << Self::LOG_SEGMENT_SIZE_LOG2;
}
