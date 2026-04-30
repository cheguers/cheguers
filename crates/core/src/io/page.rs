use std::fmt;

use crate::config::StorageConfig;

const PAGE_BYTES: usize = StorageConfig::PAGE_SIZE as usize;

/// All disk reads and writes are in page-sized units.
/// Physical references on disk are stable (page_idx, slot) pairs, not raw pointers.
pub struct Page {
  data: Box<[u8; PAGE_BYTES]>,
}

impl Page {
  #[must_use]
  pub fn new() -> Self {
    Self { data: Box::new([0u8; PAGE_BYTES]) }
  }

  #[must_use]
  pub fn from_bytes(bytes: &[u8]) -> Self {
    let mut page = Self::new();
    let len = bytes.len().min(PAGE_BYTES);
    page.data[..len].copy_from_slice(&bytes[..len]);
    page
  }

  #[must_use]
  pub fn to_vec(&self) -> Vec<u8> {
    self.data.to_vec()
  }

  #[inline]
  pub fn as_bytes(&self) -> &[u8] {
    self.data.as_slice()
  }

  #[inline]
  pub fn as_bytes_mut(&mut self) -> &mut [u8] {
    self.data.as_mut_slice()
  }
}

impl Default for Page {
  fn default() -> Self {
    Self::new()
  }
}

impl fmt::Debug for Page {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "Page({PAGE_BYTES} bytes)")
  }
}
