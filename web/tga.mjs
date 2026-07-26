// Minimal TGA reader — build-time only, for slicing Civ4's GameFont.tga into web icons
// (docs/bonus-sprite-bake.md). Civ4 shipped UI/font art as TGA (uncompressed load, simple 32-bit
// alpha — see docs/ported-terrain-art-system.md). GameFont.tga is RLE 32-bit BGRA, bottom-up.
//
//   import { decodeTga } from './tga.mjs';
//   const { width, height, rgba } = decodeTga(fs.readFileSync('GameFont.tga'));  // top-down RGBA
//
// Supports truecolour (type 2 raw / 10 RLE, 24/32 bpp) AND colour-mapped (type 1 raw / 9 RLE, 8 bpp
// with a 16/24/32-bit palette).
//
// The colour-mapped path exists for Civ4's TERRAIN MASKS — `heightmap/coastblendmasks/*`, the
// `coasts`/`hills`/`peaks` height tiles, `textures/coastscalemask.tga` — which are all 8-bit
// palettised (see docs/civ4-texture-inventory.md §4). Refusing them was not a small gap: it locked
// out the entire authored blend-mask family, which is the faithful alternative to the renderer's
// procedural falloff.

export function decodeTga(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const idlen = dv.getUint8(0);
  const cmapType = dv.getUint8(1);
  if (cmapType !== 0 && cmapType !== 1) throw new Error('TGA: unsupported colour-map type ' + cmapType);
  const type = dv.getUint8(2);                 // 1/9 = colour-mapped raw/RLE, 2/10 = truecolour raw/RLE
  if (![1, 2, 9, 10].includes(type)) throw new Error('TGA: unsupported image type ' + type);
  const mapped = type === 1 || type === 9;
  const cmapFirst = dv.getUint16(3, true), cmapLen = dv.getUint16(5, true), cmapBits = dv.getUint8(7);
  const w = dv.getUint16(12, true), h = dv.getUint16(14, true);
  const bpp = dv.getUint8(16);                  // 8 (index) for mapped, else 24 or 32
  if (mapped ? bpp !== 8 : (bpp !== 24 && bpp !== 32)) throw new Error('TGA: unsupported bpp ' + bpp);
  const topOrigin = (dv.getUint8(17) & 0x20) !== 0;   // descriptor bit 5: 0 = bottom-up
  const bpx = bpp >> 3;                          // bytes per source pixel (index / BGR / BGRA)
  let off = 18 + idlen;
  // the palette, if any: entries are BGR(A) like the pixels, and `cmapFirst` offsets the index space
  let pal = null;
  if (cmapType === 1) {
    if (![15, 16, 24, 32].includes(cmapBits)) throw new Error('TGA: unsupported palette depth ' + cmapBits);
    const pbx = cmapBits === 15 ? 2 : cmapBits >> 3;
    pal = new Uint8Array(cmapLen * 4);
    for (let i = 0; i < cmapLen; i++) {
      const o = off + i * pbx, d = i * 4;
      if (pbx === 2) {                           // 15/16-bit: 5-5-5 (+1 alpha bit)
        const v = dv.getUint16(o, true);
        pal[d] = ((v >> 10) & 31) * 255 / 31; pal[d + 1] = ((v >> 5) & 31) * 255 / 31;
        pal[d + 2] = (v & 31) * 255 / 31; pal[d + 3] = cmapBits === 16 && !(v & 0x8000) ? 0 : 255;
      } else {
        pal[d] = dv.getUint8(o + 2); pal[d + 1] = dv.getUint8(o + 1); pal[d + 2] = dv.getUint8(o);
        pal[d + 3] = pbx === 4 ? dv.getUint8(o + 3) : 255;
      }
    }
    off += cmapLen * pbx;
  }
  const n = w * h, rgba = new Uint8Array(n * 4);
  const put = mapped
    ? (di, o) => {                               // one palette index → RGBA
        const p = (dv.getUint8(o) - cmapFirst) * 4;
        if (p < 0 || p + 3 >= pal.length) { rgba[di] = rgba[di + 1] = rgba[di + 2] = 0; rgba[di + 3] = 255; return; }
        rgba[di] = pal[p]; rgba[di + 1] = pal[p + 1]; rgba[di + 2] = pal[p + 2]; rgba[di + 3] = pal[p + 3];
      }
    : (di, o) => {                               // one source pixel (BGRA) → RGBA
        rgba[di] = dv.getUint8(o + 2); rgba[di + 1] = dv.getUint8(o + 1); rgba[di + 2] = dv.getUint8(o);
        rgba[di + 3] = bpx === 4 ? dv.getUint8(o + 3) : 255;
      };
  if (type === 1 || type === 2) {
    for (let i = 0; i < n; i++) put(i * 4, off + i * bpx);
  } else {                                       // RLE packets (9 = mapped, 10 = truecolour)
    let i = 0;
    while (i < n) {
      const hdr = dv.getUint8(off++), count = (hdr & 0x7f) + 1;
      if (hdr & 0x80) {                          // run: one pixel repeated
        for (let k = 0; k < count && i < n; k++, i++) put(i * 4, off);
        off += bpx;
      } else {                                   // literal: count raw pixels
        for (let k = 0; k < count && i < n; k++, i++) { put(i * 4, off); off += bpx; }
      }
    }
  }
  if (!topOrigin) {                              // bottom-up → flip to top-down rows
    const row = w * 4, tmp = new Uint8Array(row);
    for (let y = 0; y < (h >> 1); y++) {
      const a = y * row, b = (h - 1 - y) * row;
      tmp.set(rgba.subarray(a, a + row)); rgba.copyWithin(a, b, b + row); rgba.set(tmp, b);
    }
  }
  return { width: w, height: h, rgba };
}
