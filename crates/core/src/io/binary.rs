//! Manual little-endian byte encoding helpers.
//! Zero external dependencies — all page-format I/O goes through these.

macro_rules! le_codec {
  ($write:ident, $read:ident, $ty:ty) => {
    #[inline]
    pub fn $write(buf: &mut [u8], pos: &mut usize, val: $ty) {
      const N: usize = std::mem::size_of::<$ty>();
      buf[*pos..*pos + N].copy_from_slice(&val.to_le_bytes());
      *pos += N;
    }

    #[inline]
    pub fn $read(buf: &[u8], pos: &mut usize) -> $ty {
      const N: usize = std::mem::size_of::<$ty>();
      let bytes = <[u8; N]>::try_from(&buf[*pos..*pos + N]).expect("slice length matches array");
      *pos += N;
      <$ty>::from_le_bytes(bytes)
    }
  };
}

le_codec!(write_u8, read_u8, u8);
le_codec!(write_u16, read_u16, u16);
le_codec!(write_u32, read_u32, u32);
le_codec!(write_u64, read_u64, u64);
le_codec!(write_i64, read_i64, i64);

#[inline]
pub fn write_f64(buf: &mut [u8], pos: &mut usize, val: f64) {
  write_u64(buf, pos, val.to_bits());
}

#[inline]
pub fn read_f64(buf: &[u8], pos: &mut usize) -> f64 {
  f64::from_bits(read_u64(buf, pos))
}

#[inline]
pub fn write_bytes(buf: &mut [u8], pos: &mut usize, data: &[u8]) {
  buf[*pos..*pos + data.len()].copy_from_slice(data);
  *pos += data.len();
}

#[inline]
pub fn read_bytes<'a>(buf: &'a [u8], pos: &mut usize, len: usize) -> &'a [u8] {
  let slice = &buf[*pos..*pos + len];
  *pos += len;
  slice
}

/// Pack booleans MSB-first within each byte: `bits[0]` → `byte[0].bit7`.
pub fn pack_bitmask(bits: &[bool]) -> Vec<u8> {
  let mut mask = vec![0u8; bits.len().div_ceil(8)];
  for (i, &b) in bits.iter().enumerate() {
    if b {
      mask[i / 8] |= 1 << (7 - (i % 8));
    }
  }
  mask
}

pub fn unpack_bitmask(mask: &[u8], num_bits: usize) -> Vec<bool> {
  (0..num_bits)
    .map(|i| (mask[i / 8] >> (7 - (i % 8))) & 1 == 1)
    .collect()
}
