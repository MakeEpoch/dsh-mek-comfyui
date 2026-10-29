/**
 * Read pixel dimensions straight from image bytes.
 *
 * ComfyUI usually reports `metadata.width/height` on an output image, but not
 * every node does (a `PreviewImage` or a third-party save node may omit it), and
 * a proxied/older server may omit it entirely. The gallery needs the numbers for
 * its grid and the chat tool reports them, so the header is the fallback: it is
 * cheap, needs no dependency, and covers the four formats the plugin accepts.
 */

/**
 * Detect the media type from magic bytes.
 * @param {Buffer | Uint8Array} bytes
 * @returns {'image/png'|'image/jpeg'|'image/webp'|'image/gif'|null}
 */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Dimensions from the file header.
 * @param {Buffer | Uint8Array} bytes
 * @returns {{ width: number, height: number } | null}
 */
export function readImageSize(bytes) {
  const mediaType = sniffMediaType(bytes);
  if (!mediaType) return null;
  try {
    if (mediaType === 'image/png') return readPng(bytes);
    if (mediaType === 'image/jpeg') return readJpeg(bytes);
    if (mediaType === 'image/gif') return readGif(bytes);
    if (mediaType === 'image/webp') return readWebp(bytes);
  } catch {
    return null;
  }
  return null;
}

function readPng(bytes) {
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR",
  // then width and height as big-endian 32-bit integers.
  if (bytes.length < 24) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const width = readUInt32BE(bytes, 16);
  const height = readUInt32BE(bytes, 20);
  return valid(width, height);
}

function readGif(bytes) {
  if (bytes.length < 10) return null;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  return valid(width, height);
}

function readJpeg(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0..SOF15 carry the frame dimensions; skip DHT/JPG/DAC (C4, C8, CC).
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return valid(width, height);
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function readWebp(bytes) {
  if (bytes.length < 30) return null;
  const format = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (format === 'VP8X') {
    // Canvas size is stored as (width-1) and (height-1), 24-bit little-endian.
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return valid(width, height);
  }
  if (format === 'VP8 ') {
    // Lossy: 3-byte frame tag, then the 14-bit dimensions after the start code.
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    return valid(width, height);
  }
  if (format === 'VP8L') {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return valid(width, height);
  }
  return null;
}

function readUInt32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function valid(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}
