// Rectify a beach colour ramp out of a Civ4 coast blend atlas. Build-time only (web/build.mjs);
// kept out of build.mjs so it can be unit-tested against a synthetic atlas, since the real art is a
// dev-machine/fetch dependency CI cannot assume. See docs/civ4-texture-inventory.md §4.
//
// `textures/coast*blend.dds` is a 4x8 atlas of 128px painted shore tiles. Transparent = the LAND side
// (the land terrain shows through there); the opaque paint runs land-edge -> sand -> shallows -> deep.
// So the profile is NOT an axis-aligned slice — the shoreline inside each cell is a painted curve —
// it is the image resampled along the alpha gradient:
//
//   1. Walk the alpha boundary (an opaque pixel with a transparent 4-neighbour).
//   2. Take the inward normal from a Sobel of the alpha (alpha increases inward, so the gradient
//      already points the right way) and march K px along it, dropping any row that leaves the
//      painted region early.
//   3. ALIGN before averaging. Each row's sand band is a different width — the painted rim varies
//      cell to cell — so averaging raw depths smears the sand->water step into grey mush (measured:
//      the naive mean looks nothing like the art). Normalise each row by its OWN transition, the last
//      depth where warmth (r-b) still exceeds a quarter of that row's peak, then average on the
//      normalised axis. u=0 is the land edge, u=1 the seaward edge of the sand.

/** Alpha at (x,y), 0 outside the image. */
const alphaAt = (img, x, y) =>
  (x < 0 || y < 0 || x >= img.width || y >= img.height) ? 0 : img.rgba[((y * img.width + x) << 2) + 3];

/**
 * @param {{width:number,height:number,rgba:Uint8Array}} img  decoded coast blend atlas (RGBA)
 * @param {object} [opt]
 * @param {number} [opt.stops=9]   ramp entries emitted
 * @param {number} [opt.uMax=1.25] how far past the sand's seaward edge the ramp reaches (1 = the edge)
 * @param {number} [opt.depth=48]  px marched inward per row
 * @returns {number[][]|null} `stops` RGB triples from the land edge outward, or null if no row qualified
 */
export function beachRampFromAtlas(img, opt = {}) {
  const { stops = 9, uMax = 1.25, depth = 48 } = opt;
  const { width: W, height: H, rgba } = img;
  const A = (x, y) => alphaAt(img, x, y);
  const acc = Array.from({ length: stops }, () => [0, 0, 0, 0]);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      if (A(x, y) < 128) continue;
      if (A(x - 1, y) >= 128 && A(x + 1, y) >= 128 && A(x, y - 1) >= 128 && A(x, y + 1) >= 128) continue;
      let gx = 0, gy = 0;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const w = A(x + i, y + j);
          gx += w * i * (j === 0 ? 2 : 1);
          gy += w * j * (i === 0 ? 2 : 1);
        }
      const len = Math.hypot(gx, gy);
      if (len < 1) continue;
      const nx = gx / len, ny = gy / len, row = [];
      for (let t = 0; t < depth; t++) {
        const sx = Math.round(x + nx * t), sy = Math.round(y + ny * t);
        if (sx < 0 || sy < 0 || sx >= W || sy >= H || A(sx, sy) < 128) break;
        const o = (sy * W + sx) * 4;
        row.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
      }
      if (row.length < depth) continue;                    // a clean, full-depth run or nothing
      let wmax = 0;
      for (const c of row) wmax = Math.max(wmax, c[0] - c[2]);
      if (wmax < 20) continue;                             // no sand on this row
      let T = 0;
      for (let t = 0; t < row.length; t++) if (row[t][0] - row[t][2] > wmax * 0.25) T = t;
      if (T < 3) continue;                                 // too thin to normalise reliably
      for (let i = 0; i < stops; i++) {
        const ft = (i / (stops - 1)) * uMax * T;
        const t0 = Math.min(row.length - 1, Math.floor(ft)), t1 = Math.min(row.length - 1, t0 + 1), f = ft - t0;
        for (let c = 0; c < 3; c++) acc[i][c] += row[t0][c] * (1 - f) + row[t1][c] * f;
        acc[i][3]++;
      }
    }
  if (!acc[0][3]) return null;
  return acc.map(a => [a[0] / a[3] | 0, a[1] / a[3] | 0, a[2] / a[3] | 0]);
}
