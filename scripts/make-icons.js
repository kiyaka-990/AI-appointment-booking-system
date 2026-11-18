/**
 * Generates the install icons (PNG) for the app without any dependency.
 * Run with `npm run icons` after changing the brand colours.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const GLYPHS = {
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110']
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const letters = 'BS';
  const scale = Math.max(2, Math.round((size * 0.52) / (letters.length * 6 - 1)));
  const textWidth = (letters.length * 6 - 1) * scale;
  const textHeight = 7 * scale;
  const startX = Math.round((size - textWidth) / 2);
  const startY = Math.round((size - textHeight) / 2);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      // Diagonal teal gradient.
      const t = (x + y) / (size * 2);
      let r = Math.round(15 + (11 - 15) * t);
      let g = Math.round(118 + (95 - 118) * t);
      let b = Math.round(110 + (89 - 110) * t);

      // White "BS" from a 5x7 bitmap, scaled up.
      const localX = x - startX;
      const localY = y - startY;
      if (localX >= 0 && localY >= 0 && localX < textWidth && localY < textHeight) {
        const glyphIndex = Math.floor(localX / (6 * scale));
        const withinGlyph = localX - glyphIndex * 6 * scale;
        if (withinGlyph < 5 * scale) {
          const col = Math.floor(withinGlyph / scale);
          const row = Math.floor(localY / scale);
          const glyph = GLYPHS[letters[glyphIndex]];
          if (glyph && glyph[row] && glyph[row][col] === '1') {
            r = 255;
            g = 255;
            b = 255;
          }
        }
      }

      const offset = rowStart + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [32, 180, 192, 512]) {
  const file = path.join(outDir, size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`);
  fs.writeFileSync(file, makePng(size));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${size}x${size})`);
}
