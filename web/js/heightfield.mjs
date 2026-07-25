"use strict";
// The terrain HEIGHT FIELD — pure, zero-import, and therefore testable (heightfield.test.mjs).
// docs/terrain-3d.md §The plan → P1.
//
// Turns the per-plot data the client already has (plotType, elevation) into the corner heights a
// terrain mesh needs. Two things about it are load-bearing, and both came out of the spike:
//
// plotType IS THE HEIGHT SOURCE. The imported heightmap is continental and low-frequency — the spike's
// test province spans 99..145 of 255 — so exaggerating `elevation` alone inflates a smooth swell and
// reads as a warped carpet, no matter how far you push it. The eye reads terrain from the DISCRETE
// per-plot FLAT/HILL/PEAK variation, which is also how Civ4 gets its mountains. Both sources are here
// and separately scaled, but PEAK/HILL carry the look.
//
// HEIGHTS SIT ON CORNERS, NOT PLOTS. A corner's height is the mean of the up-to-4 plots touching it,
// which interpolates between plots instead of stamping a square per plot. Stamping is precisely what
// made the old 2D elevation hillshade read as a per-plot checkerboard (plots.mjs §3 records its
// removal), so this is the one detail that must not be simplified away.
//
// WHY THE STORE IS A GLOBAL PLOT INDEX, not per-province corner lattices. A corner on a province
// boundary is touched by plots of BOTH provinces, and plot grids arrive per-province asynchronously
// (plotfetch.loadPlots). Index every plot by its source pixel and derive corners on demand, and a
// boundary corner simply takes contributions from whatever has loaded — no seam once the neighbour
// lands, and no per-province lattice to invalidate. It also makes SMOOTHING a pure function of the
// loaded set rather than a stateful pass: one smoothing pass is defined below as the mean of a corner
// and its four lattice neighbours, all computed from unsmoothed values, so the result never depends
// on the order provinces arrived in. That property is why this can be a plain function.

/** Height model, in SOURCE-PIXEL units — one plot is one source pixel, so these are plot-widths.
 *  The values are the spike's (tools/spike-iso3d, `shot-civ-oblique.png`): PEAK 3.4 / HILL 1.0 /
 *  elevation ×6 read as terrain, where elevation ×30 with no plotType relief did not. */
export const HEIGHT = { PEAK: 3.4, HILL: 1.0, ELEV: 6 };

/** Plot-grid key. Same encoding plots.mjs uses for its per-province `_grid`, so the two agree. */
export const pkey = (x, y) => x * 1e5 + y;

/**
 * One plot's own height. `null` for an absent plot, so callers can tell "no plot here" (outside the
 * province, or not yet loaded) from "a plot at height 0" — the difference between a hole in the mesh
 * and flat ground.
 *
 * No elevation floor is subtracted. Per-province flooring (what the spike did) would rest every
 * province on its own local minimum and step at every border; a global floor is unknowable until the
 * whole world has loaded. A uniform offset is invisible from any camera, so there is no reason to
 * subtract anything at all — the terrain simply sits a few plot-widths above y=0, which is where the
 * sea plane lives.
 */
export function plotHeight(q, P = HEIGHT) {
  if (!q) return null;
  const relief = q.plotType === "PEAK" ? P.PEAK : q.plotType === "HILL" ? P.HILL : 0;
  return relief + (q.elevation | 0) / 255 * P.ELEV;
}

/**
 * Add a province's plots to the index, which stores the resolved HEIGHT per source pixel rather than
 * the plot record. Two reasons that is worth the indirection: `smoothCornerAt` touches 20 plots, so
 * resolving the model once per plot instead of once per query is the difference between a mesh build
 * being free and being noticeable; and it gives `flat` somewhere to live.
 *
 * `flat` indexes the plots at height 0 — for SEA/LAKE provinces, whose shelf plots carry elevation
 * values that mean depth, not altitude. They must still be INDEXED rather than skipped: a coastal land
 * corner averages them, so the shore ramps down to sea level instead of ending in a cliff the height of
 * the continental heightmap (~2.4 plot-widths at a typical coast).
 *
 * Returns how many source pixels were newly indexed.
 */
export function indexPlots(index, plots, { flat = false, P = HEIGHT } = {}) {
  let n = 0;
  for (const q of plots) {
    const k = pkey(q.x, q.y);
    if (index.has(k)) continue;
    index.set(k, flat ? 0 : plotHeight(q, P));
    n++;
  }
  return n;
}

/**
 * Raw height of the lattice corner (lx, ly) — the mean over the up-to-4 plots touching it. Lattice
 * point (lx, ly) is the top-left corner of plot (lx, ly), so the plots touching it are the four at
 * (lx-1..lx, ly-1..ly). `null` when none of them is indexed.
 */
export function cornerAt(index, lx, ly) {
  let sum = 0, n = 0;
  for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
    const h = index.get(pkey(lx + dx, ly + dy));
    if (h !== undefined) { sum += h; n++; }
  }
  return n ? sum / n : null;
}

/**
 * One smoothing pass: the corner averaged with its four lattice neighbours, over RAW corner values.
 * Missing neighbours are skipped rather than treated as zero, so the province silhouette keeps its
 * shape instead of being dragged down at the edges.
 *
 * Defining the pass over raw values (rather than iterating in place over a lattice) is what makes this
 * order-independent: the same corner yields the same height whichever province was indexed first, and
 * a mesh rebuilt after its neighbour arrives converges to the final answer rather than to a smoothed
 * smoothing. Note that this is ONE pass by construction — a wider kernel would need real iteration,
 * which is the point at which heights would have to be baked instead (see the doc).
 */
export function smoothCornerAt(index, lx, ly) {
  const c = cornerAt(index, lx, ly);
  if (c === null) return null;
  let sum = c, n = 1;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const h = cornerAt(index, lx + dx, ly + dy);
    if (h !== null) { sum += h; n++; }
  }
  return sum / n;
}

/**
 * Ground height at a FRACTIONAL source position — bilinear across the four corners of the plot it falls in.
 *
 * The mesh only ever needs heights at integer lattice points, so this exists for things that STAND on the
 * terrain: a tree scattered at 0.37 of the way across its plot has to meet the ground where the mesh actually
 * is, not at the plot's corner. Snapping to the nearest corner instead would leave props floating above or
 * sunk into any sloped plot — and a slope is precisely where it shows.
 *
 * Missing corners (outside the loaded set) fall back to the mean of those present, so a prop at a province's
 * edge sits at a sensible height rather than being dragged to zero. Null only when the plot has no corners at
 * all, i.e. there is no terrain there to stand on.
 */
export function groundAt(index, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const h00 = smoothCornerAt(index, x0, y0), h10 = smoothCornerAt(index, x0 + 1, y0);
  const h01 = smoothCornerAt(index, x0, y0 + 1), h11 = smoothCornerAt(index, x0 + 1, y0 + 1);
  let sum = 0, n = 0;
  for (const h of [h00, h10, h01, h11]) if (h !== null) { sum += h; n++; }
  if (!n) return null;
  const mean = sum / n;
  const a = h00 === null ? mean : h00, b = h10 === null ? mean : h10;
  const c = h01 === null ? mean : h01, d = h11 === null ? mean : h11;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
