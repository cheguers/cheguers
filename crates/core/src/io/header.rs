use crate::config;
use crate::types::{PageIdx, PageRange};

use crate::error::StorageError;
use crate::io::page::Page;
use crate::io::binary;

/// The database header lives at page 0 of every `.cheguers` file.
pub struct DatabaseHeader {
  pub version:              u32,
  pub db_id:                [u8; 16],
  pub catalog_page_range:   PageRange,
}

impl DatabaseHeader {
  #[must_use]
  pub fn new(db_id: [u8; 16]) -> Self {
    Self {
      version: config::StorageConfig::STORAGE_VERSION,
      db_id,
      catalog_page_range: PageRange { start_page: PageIdx(0), num_pages: 0 },
    }
  }

  /// Serialize the header into a page buffer.
  #[must_use]
  pub fn serialize(&self) -> Page {
    let mut page = Page::new();
    let buf = page.as_bytes_mut();
    let mut pos = 0usize;

    binary::write_bytes(buf, &mut pos, config::MAGIC_BYTES);
    binary::write_u32(buf, &mut pos, self.version);
    binary::write_bytes(buf, &mut pos, &self.db_id);
    binary::write_u64(buf, &mut pos, self.catalog_page_range.start_page.0);
    binary::write_u32(buf, &mut pos, self.catalog_page_range.num_pages);

    page
  }

  /// Deserialize from a page. Returns an error if magic bytes don't match.
  pub fn deserialize(page: &Page) -> Result<Self, StorageError> {
    let buf = page.as_bytes();
    let mut pos = 0usize;

    let magic = binary::read_bytes(buf, &mut pos, 16);
    if magic != config::MAGIC_BYTES {
      return Err(StorageError::CorruptHeader);
    }

    let version = binary::read_u32(buf, &mut pos);

    let mut db_id = [0u8; 16];
    let id_bytes = binary::read_bytes(buf, &mut pos, 16);
    db_id.copy_from_slice(id_bytes);

    let start_page = PageIdx(binary::read_u64(buf, &mut pos));
    let num_pages = binary::read_u32(buf, &mut pos);

    Ok(Self {
      version,
      db_id,
      catalog_page_range: PageRange { start_page, num_pages },
    })
  }

  pub fn set_catalog_page_range(&mut self, range: PageRange) {
    self.catalog_page_range = range;
  }
}
