/*
 * Builds a small, real PNG for tests that need one on disk.
 *
 * Generated rather than committed: a checked-in fixture of random pixels is
 * half a megabyte of incompressible noise living in git forever, and this is
 * twenty lines.
 *
 * It has to be a genuinely valid PNG — the assertions that use it check
 * naturalWidth, because a corrupted file still produces a perfectly
 * happy-looking <img> element.
 */
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** A w x h RGB png with a deterministic pattern. */
function makePng(w = 96, h = 64) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      raw[o++] = (x * 5 + y * 11) & 255;
      raw[o++] = (x ^ y) & 255;
      raw[o++] = (x * y) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                          // bit depth
  ihdr[9] = 2;                          // colour type: truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makePng };
