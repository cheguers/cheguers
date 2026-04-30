//! Manual little-endian byte encoding helpers.
//! Zero external dependencies — all page-format I/O goes through these.

pub fn write_u8(buf: &mut [u8], pos: &mut usize, val: u8) {
  buf[*pos] = val;
  *pos += 1;
}

pub fn read_u8(buf: &[u8], pos: &mut usize) -> u8 {
  let v = buf[*pos];
  *pos += 1;
  v
}

pub fn write_u32(buf: &mut [u8], pos: &mut usize, val: u32) {
  let bytes = val.to_le_bytes();
  buf[*pos..*pos + 4].copy_from_slice(&bytes);
  *pos += 4;
}

pub fn read_u32(buf: &[u8], pos: &mut usize) -> u32 {
  let bytes: [u8; 4] = buf[*pos..*pos + 4].try_into().unwrap();
  *pos += 4;
  u32::from_le_bytes(bytes)
}

pub fn write_u64(buf: &mut [u8], pos: &mut usize, val: u64) {
  let bytes = val.to_le_bytes();
  buf[*pos..*pos + 8].copy_from_slice(&bytes);
  *pos += 8;
}

pub fn read_u64(buf: &[u8], pos: &mut usize) -> u64 {
  let bytes: [u8; 8] = buf[*pos..*pos + 8].try_into().unwrap();
  *pos += 8;
  u64::from_le_bytes(bytes)
}

pub fn write_u16(buf: &mut [u8], pos: &mut usize, val: u16) {
  let bytes = val.to_le_bytes();
  buf[*pos..*pos + 2].copy_from_slice(&bytes);
  *pos += 2;
}

pub fn read_u16(buf: &[u8], pos: &mut usize) -> u16 {
  let bytes: [u8; 2] = buf[*pos..*pos + 2].try_into().unwrap();
  *pos += 2;
  u16::from_le_bytes(bytes)
}

pub fn write_bytes(buf: &mut [u8], pos: &mut usize, data: &[u8]) {
  let len = data.len();
  buf[*pos..*pos + len].copy_from_slice(data);
  *pos += len;
}

pub fn read_bytes<'a>(buf: &'a [u8], pos: &mut usize, len: usize) -> &'a [u8] {
  let start = *pos;
  *pos += len;
  &buf[start..start + len]
}

pub fn write_i64(buf: &mut [u8], pos: &mut usize, val: i64) {
  write_u64(buf, pos, val as u64);
}

pub fn read_i64(buf: &[u8], pos: &mut usize) -> i64 {
  read_u64(buf, pos) as i64
}

pub fn write_f64(buf: &mut [u8], pos: &mut usize, val: f64) {
  write_u64(buf, pos, val.to_bits());
}

pub fn read_f64(buf: &[u8], pos: &mut usize) -> f64 {
  f64::from_bits(read_u64(buf, pos))
}

/// Pack booleans into a bit-packed byte array.
/// `bits` is written MSB-first within each byte: bits[0] → byte[0].bit7
pub fn pack_bitmask(bits: &[bool]) -> Vec<u8> {
  let num_bytes = bits.len().div_ceil(8);
  let mut mask = vec![0u8; num_bytes];
  for (i, &b) in bits.iter().enumerate() {
    if b {
      mask[i / 8] |= 1 << (7 - (i % 8));
    }
  }
  mask
}

pub fn unpack_bitmask(mask: &[u8], num_bits: usize) -> Vec<bool> {
  let mut bits = vec![false; num_bits];
  for i in 0..num_bits {
    bits[i] = (mask[i / 8] >> (7 - (i % 8))) & 1 == 1;
  }
  bits
}
