/*
 * Width and height of an image, straight from its header bytes.
 *
 * The report anchors every picture to a cell, and Excel needs the size in
 * EMU before it will draw one. Reading four numbers out of the file header is
 * all it needs - decoding the picture itself would mean an image library
 * this machine cannot install from behind the factory proxy.
 *
 * Handles the formats the fleet actually produces: webp (what the cameras
 * send), plus jpeg/png/gif so converted thumbnails work too.
 */

const fs = require('fs');

const HEAD_BYTES = 64 * 1024; // enough for any jpeg SOF marker in practice

const readHead = (file) => {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
};

const webpSize = (b) => {
  // RIFF....WEBP then a chunk telling which of the three encodings it is
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    // lossy: 3-byte frame tag, 3-byte start code, then 14-bit width/height
    if (b.length < 30) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // lossless: 14 bits each, packed into the 4 bytes after the signature
    if (b.length < 25) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // extended: 24-bit canvas size minus one
    if (b.length < 30) return null;
    return {
      width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
    };
  }
  return null;
};

const jpegSize = (b) => {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    // SOF0..SOF15, minus the four that are not frame headers
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
};

/** { type, ext, width, height } for a buffer, or null when unrecognised. */
const imageInfo = (b) => {
  if (!b || b.length < 24) return null;

  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
    return { type: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    const s = jpegSize(b);
    return s && { type: 'image/jpeg', ext: 'jpeg', ...s };
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const s = webpSize(b);
    return s && { type: 'image/webp', ext: 'webp', ...s };
  }
  if (b.toString('ascii', 0, 3) === 'GIF') {
    return { type: 'image/gif', ext: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  return null;
};

/** Same, reading only the head of a file. */
const imageInfoOf = (file) => {
  try {
    return imageInfo(readHead(file));
  } catch (error) {
    return null;
  }
};

module.exports = { imageInfo, imageInfoOf };
