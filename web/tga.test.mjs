// Tests for the TGA decoder — run with `node --test` (built-in runner, no deps).
// Focus: the COLOUR-MAPPED path added for Civ4's terrain masks (docs/civ4-texture-inventory.md §4
// P3) — heightmap/coastblendmasks and friends are 8-bit palettised, which the truecolour-only
// decoder refused outright. Buffers are synthesized in-memory so the test is hermetic and never
// touches the gitignored art caches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTga } from './tga.mjs';

// A colour-mapped TGA: 18-byte header, then a BGR(A) palette, then one index byte per pixel.
// `topOrigin` false matches how Civ4 ships them (bottom-up), which the decoder must flip.
function makeMapped({ width, height, palette, indices, rle = false, cmapFirst = 0, palBits = 24, topOrigin = false }) {
  const pbx = palBits >> 3;
  const body = [];
  if (rle) {
    // one literal packet per row, so the run/literal walk is exercised without hand-packing runs
    for (let y = 0; y < height; y++) {
      const row = indices.slice(y * width, (y + 1) * width);
      body.push(row.length - 1, ...row);                      // literal packet: high bit clear
    }
  } else body.push(...indices);
  const buf = Buffer.alloc(18 + palette.length * pbx + body.length);
  buf.writeUInt8(0, 0);                       // no id field
  buf.writeUInt8(1, 1);                       // colour-map type: present
  buf.writeUInt8(rle ? 9 : 1, 2);             // image type
  buf.writeUInt16LE(cmapFirst, 3);
  buf.writeUInt16LE(palette.length, 5);
  buf.writeUInt8(palBits, 7);
  buf.writeUInt16LE(width, 12);
  buf.writeUInt16LE(height, 14);
  buf.writeUInt8(8, 16);                      // 8 bpp index
  buf.writeUInt8(topOrigin ? 0x20 : 0, 17);
  let o = 18;
  for (const [r, g, b, a] of palette) {       // stored BGR(A)
    buf.writeUInt8(b, o); buf.writeUInt8(g, o + 1); buf.writeUInt8(r, o + 2);
    if (pbx === 4) buf.writeUInt8(a ?? 255, o + 3);
    o += pbx;
  }
  for (const v of body) buf.writeUInt8(v, o++);
  return buf;
}

const px = (d, x, y) => [0, 1, 2, 3].map(c => d.rgba[((y * d.width + x) << 2) + c]);

test('decodes an 8-bit colour-mapped TGA through its palette', () => {
  const d = decodeTga(makeMapped({
    width: 2, height: 2,
    palette: [[10, 20, 30], [200, 100, 50]],
    indices: [1, 0, 0, 1],                    // bottom-up: this is the BOTTOM row first
  }));
  assert.equal(d.width, 2);
  assert.equal(d.height, 2);
  // bottom-up source → the decoder flips, so the file's first row lands at the BOTTOM
  assert.deepEqual(px(d, 0, 1), [200, 100, 50, 255]);
  assert.deepEqual(px(d, 0, 0), [10, 20, 30, 255]);
});

test('honours the top-origin descriptor bit instead of flipping', () => {
  const d = decodeTga(makeMapped({
    width: 2, height: 2,
    palette: [[10, 20, 30], [200, 100, 50]],
    indices: [1, 0, 0, 1],
    topOrigin: true,
  }));
  assert.deepEqual(px(d, 0, 0), [200, 100, 50, 255]);
});

test('decodes the RLE colour-mapped variant (type 9)', () => {
  const raw = { width: 3, height: 2, palette: [[0, 0, 0], [255, 255, 255], [7, 8, 9]], indices: [0, 1, 2, 2, 1, 0] };
  const a = decodeTga(makeMapped(raw));
  const b = decodeTga(makeMapped({ ...raw, rle: true }));
  assert.deepEqual([...b.rgba], [...a.rgba], 'RLE and raw decode to the same pixels');
});

test('applies the palette origin offset (cmapFirst)', () => {
  // indices start at 5, so index 5 must resolve to palette entry 0
  const d = decodeTga(makeMapped({
    width: 1, height: 1, cmapFirst: 5, palette: [[1, 2, 3]], indices: [5],
  }));
  assert.deepEqual(px(d, 0, 0), [1, 2, 3, 255]);
});

test('a 32-bit palette carries alpha', () => {
  const d = decodeTga(makeMapped({
    width: 1, height: 1, palBits: 32, palette: [[9, 9, 9, 64]], indices: [0],
  }));
  assert.deepEqual(px(d, 0, 0), [9, 9, 9, 64]);
});

test('an out-of-range index is opaque black, not a crash or garbage', () => {
  // Defensive: a malformed file must not read past the palette and emit whatever was next in memory.
  const d = decodeTga(makeMapped({ width: 1, height: 1, palette: [[1, 2, 3]], indices: [200] }));
  assert.deepEqual(px(d, 0, 0), [0, 0, 0, 255]);
});

test('still rejects what it genuinely cannot read', () => {
  const bad = makeMapped({ width: 1, height: 1, palette: [[1, 2, 3]], indices: [0] });
  bad.writeUInt8(3, 2);                       // type 3 = uncompressed greyscale, not supported
  assert.throws(() => decodeTga(bad), /unsupported image type 3/);
  const badPal = makeMapped({ width: 1, height: 1, palette: [[1, 2, 3]], indices: [0] });
  badPal.writeUInt8(12, 7);                   // 12-bit palette entries
  assert.throws(() => decodeTga(badPal), /unsupported palette depth 12/);
});

test('the truecolour path is unchanged', () => {
  // 2x1, 24bpp, top-origin, raw — the shape GameFont.tga bakes rely on.
  const buf = Buffer.alloc(18 + 6);
  buf.writeUInt8(2, 2);
  buf.writeUInt16LE(2, 12); buf.writeUInt16LE(1, 14);
  buf.writeUInt8(24, 16); buf.writeUInt8(0x20, 17);
  buf.set([30, 20, 10, 50, 100, 200], 18);    // BGR, BGR
  const d = decodeTga(buf);
  assert.deepEqual(px(d, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(px(d, 1, 0), [200, 100, 50, 255]);
});
