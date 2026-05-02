use crate::types::{NodeGroupIdx, NodeOffset, PageIdx};

pub struct StorageConfig;

impl StorageConfig {
  pub const PAGE_SIZE_LOG2: u32 = 12;
  pub const PAGE_SIZE: u64 = 1 << Self::PAGE_SIZE_LOG2;

  pub const NODE_GROUP_SIZE_LOG2: u32 = 16;
  pub const NODE_GROUP_SIZE: u64 = 1 << Self::NODE_GROUP_SIZE_LOG2;

  pub const CHUNKED_NODE_GROUP_CAPACITY: u64 =
    if 2048 < Self::NODE_GROUP_SIZE { 2048 } else { Self::NODE_GROUP_SIZE };

  pub const MAX_PROPERTIES_PER_LABEL: usize = 64;

  pub const DB_HEADER_PAGE_IDX: PageIdx = PageIdx(0);

  pub const LOG_SEGMENT_SIZE_LOG2: u32 = 8;
  pub const LOG_SEGMENT_SIZE: u64 = 1 << Self::LOG_SEGMENT_SIZE_LOG2;

  pub const FILE_SUFFIX: &str = "cheguers";

  pub const STORAGE_VERSION: u32 = 1;
}

const _: () = assert!(
  StorageConfig::NODE_GROUP_SIZE.is_multiple_of(StorageConfig::CHUNKED_NODE_GROUP_CAPACITY),
  "NODE_GROUP_SIZE must be a whole multiple of CHUNKED_NODE_GROUP_CAPACITY",
);

#[inline]
pub fn get_start_offset_of_node_group(node_group_idx: NodeGroupIdx) -> NodeOffset {
  node_group_idx.0 << StorageConfig::NODE_GROUP_SIZE_LOG2
}

#[inline]
pub fn get_node_group_idx(node_offset: NodeOffset) -> NodeGroupIdx {
  NodeGroupIdx(node_offset >> StorageConfig::NODE_GROUP_SIZE_LOG2)
}

pub const MAGIC_BYTES: &[u8; 16] = b"CHEGUERSDB\0\0\0\0\0\0";
