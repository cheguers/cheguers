use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::config::StorageConfig;
use crate::error::StorageError;
use crate::io::page::Page;
use crate::types::PageIdx;

/// Manages a `.cheguers` data file — page-level read/write.
pub struct FileManager {
  file:      File,
  path:      PathBuf,
  num_pages: u64,
}

impl FileManager {
  pub fn create(path: &Path) -> Result<Self, StorageError> {
    let file = OpenOptions::new()
      .create_new(true)
      .read(true)
      .write(true)
      .open(path)
      .map_err(|e| StorageError::Io(format!("create {}: {e}", path.display())))?;
    Ok(Self { file, path: path.to_path_buf(), num_pages: 0 })
  }

  pub fn open(path: &Path) -> Result<Self, StorageError> {
    let file = OpenOptions::new()
      .read(true)
      .write(true)
      .open(path)
      .map_err(|e| StorageError::Io(format!("open {}: {e}", path.display())))?;
    let file_len = file
      .metadata()
      .map_err(|e| StorageError::Io(format!("metadata: {e}")))?
      .len();
    Ok(Self {
      file,
      path: path.to_path_buf(),
      num_pages: file_len / StorageConfig::PAGE_SIZE,
    })
  }

  #[inline]
  pub fn path(&self) -> &Path {
    &self.path
  }

  #[inline]
  pub fn num_pages(&self) -> u64 {
    self.num_pages
  }

  pub fn read_page(&mut self, idx: PageIdx) -> Result<Page, StorageError> {
    self.seek_to(idx)?;
    let mut page = Page::new();
    self
      .file
      .read_exact(page.as_bytes_mut())
      .map_err(|e| StorageError::Io(format!("read page {idx}: {e}")))?;
    Ok(page)
  }

  pub fn write_page(&mut self, idx: PageIdx, page: &Page) -> Result<(), StorageError> {
    self.seek_to(idx)?;
    self
      .file
      .write_all(page.as_bytes())
      .map_err(|e| StorageError::Io(format!("write page {idx}: {e}")))?;
    if idx.0 >= self.num_pages {
      self.num_pages = idx.0 + 1;
    }
    Ok(())
  }

  /// Allocate `count` new pages at the end of the file. Returns the first page index.
  pub fn allocate_pages(&mut self, count: u64) -> Result<PageIdx, StorageError> {
    let first = PageIdx(self.num_pages);
    let zeroes = vec![0u8; (count * StorageConfig::PAGE_SIZE) as usize];
    self
      .file
      .seek(SeekFrom::End(0))
      .map_err(|e| StorageError::Io(format!("seek end: {e}")))?;
    self
      .file
      .write_all(&zeroes)
      .map_err(|e| StorageError::Io(format!("allocate: {e}")))?;
    self.num_pages += count;
    Ok(first)
  }

  pub fn read_page_range(&mut self, start: PageIdx, count: u32) -> Result<Vec<Page>, StorageError> {
    (0..count as u64)
      .map(|i| self.read_page(PageIdx(start.0 + i)))
      .collect()
  }

  pub fn write_page_range(&mut self, start: PageIdx, pages: &[Page]) -> Result<(), StorageError> {
    for (i, page) in pages.iter().enumerate() {
      self.write_page(PageIdx(start.0 + i as u64), page)?;
    }
    Ok(())
  }

  pub fn sync(&mut self) -> Result<(), StorageError> {
    self
      .file
      .flush()
      .map_err(|e| StorageError::Io(format!("flush: {e}")))
  }

  fn seek_to(&mut self, idx: PageIdx) -> Result<(), StorageError> {
    let offset = idx.0 * StorageConfig::PAGE_SIZE;
    self
      .file
      .seek(SeekFrom::Start(offset))
      .map_err(|e| StorageError::Io(format!("seek: {e}")))?;
    Ok(())
  }
}
