use std::fmt;

use crate::config::StorageConfig;

/// A fixed-size page — the fundamental I/O unit.
///
/// All disk reads and writes are in page-sized units.
/// Physical references on disk are stable (page_idx, slot) pairs, not raw pointers.
pub struct Page {
  data: Box<[u8; StorageConfig::PAGE_SIZE as usize]>,
}

impl Page {
  #[must_use]
  pub fn new() -> Self {
    Self { data: Box::new([0u8; StorageConfig::PAGE_SIZE as usize]) }
  }

  #[must_use]
  pub fn from_bytes(bytes: &[u8]) -> Self {
    let mut data = Box::new([0u8; StorageConfig::PAGE_SIZE as usize]);
    let len = bytes.len().min(StorageConfig::PAGE_SIZE as usize);
    data[..len].copy_from_slice(&bytes[..len]);
    Self { data }
  }

  #[must_use]
  pub fn to_vec(&self) -> Vec<u8> {
    self.data.to_vec()
  }

  pub fn as_bytes(&self) -> &[u8] {
    self.data.as_ref()
  }

  pub fn as_bytes_mut(&mut self) -> &mut [u8] {
    self.data.as_mut()
  }
}

impl Default for Page {
  fn default() -> Self {
    Self::new()
  }
}

impl fmt::Debug for Page {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "Page({} bytes)", StorageConfig::PAGE_SIZE)
  }
}
