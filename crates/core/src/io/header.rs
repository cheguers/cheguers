use crate::config::{self, StorageConfig};
use crate::error::StorageError;
use crate::io::binary;
use crate::io::page::Page;
use crate::types::{PageIdx, PageRange};

/// The database header lives at page 0 of every `.cheguers` file.
pub struct DatabaseHeader {
  pub version:            u32,
  pub db_id:              [u8; 16],
  pub catalog_page_range: PageRange,
}

impl DatabaseHeader {
  #[must_use]
  pub fn new(db_id: [u8; 16]) -> Self {
    Self {
      version: StorageConfig::STORAGE_VERSION,
      db_id,
      catalog_page_range: PageRange { start_page: PageIdx(0), num_pages: 0 },
    }
  }

  #[must_use]
  pub fn serialize(&self) -> Page {
    let mut page = Page::new();
    let buf = page.as_bytes_mut();
    let mut pos = 0;

    binary::write_bytes(buf, &mut pos, config::MAGIC_BYTES);
    binary::write_u32(buf, &mut pos, self.version);
    binary::write_bytes(buf, &mut pos, &self.db_id);
    binary::write_u64(buf, &mut pos, self.catalog_page_range.start_page.0);
    binary::write_u32(buf, &mut pos, self.catalog_page_range.num_pages);

    page
  }

  pub fn deserialize(page: &Page) -> Result<Self, StorageError> {
    let buf = page.as_bytes();
    let mut pos = 0;

    if binary::read_bytes(buf, &mut pos, 16) != config::MAGIC_BYTES {
      return Err(StorageError::CorruptHeader);
    }

    let version = binary::read_u32(buf, &mut pos);
    let db_id = <[u8; 16]>::try_from(binary::read_bytes(buf, &mut pos, 16))
      .expect("read_bytes returns exactly 16 bytes");
    let start_page = PageIdx(binary::read_u64(buf, &mut pos));
    let num_pages = binary::read_u32(buf, &mut pos);

    Ok(Self {
      version,
      db_id,
      catalog_page_range: PageRange { start_page, num_pages },
    })
  }

  #[inline]
  pub fn set_catalog_page_range(&mut self, range: PageRange) {
    self.catalog_page_range = range;
  }
}
