"use strict";
// THE SHORE INDEX — which land terrain a water plot's beach should be standing on. Pure, zero-import,
// and therefore testable (shore-index.test.mjs).
//
// WHY THIS EXISTS. Civ4's painted coast tile is a TRANSITION, not a picture of water: measured on
// `coastblend.dds`, the cell config 12 selects (cell 3 at 180°) is opaque grey-green surf on its
// seaward half — alpha 204..226 — and alpha 10..38 on its landward half. That low alpha is an
// instruction: "let the terrain underneath show through here". On Civ4's mesh the terrain underneath
// is the LAND, which is why the landward half of a Civ4 coast tile reads as beach.
//
// We stamp the cell on the water plot (coast.mjs explains at length why the water plot is the right
// one), and a water plot's ground is the interior water texture — cell 29, a flat `21,45,82`. So the
// authored transparency revealed BLUE where it was drawing a beach, and every shoreline carried a
// dark blue band between the sand and the grass. Nothing was wrong with the art or the alpha; there
// was simply no land under it.
//
// WHY IT MUST BE GLOBAL, keyed by source pixel. A water plot's land neighbours belong to a DIFFERENT
// province, and provinces arrive from /api/plots asynchronously and in view order. A per-province
// lookup cannot see across that boundary — which is exactly the argument heightfield.mjs makes for
// its own global index, and it transfers verbatim:
//
//   > Index every plot by its source pixel and derive [it] on demand, and a boundary [lookup] simply
//   > takes contributions from whatever has loaded — no seam once the neighbour lands.
//
// The consequence to respect is that a water province baked BEFORE its land neighbour arrived has a
// stale canvas. `version()` is what lets the draw loop notice: it moves whenever new land is indexed,
// and plots.mjs re-bakes any water province whose canvas predates the move.

/** Plot-grid key — the same encoding plots.mjs and heightfield.mjs use, so all three agree. */
export const pkey = (x, y) => x * 1e5 + y;

// The eight neighbours, with the WEIGHT each contributes to "which land does my beach meet".
// Orthogonal neighbours share a full edge with this plot and diagonals only a corner, so an edge
// neighbour has twice the shoreline in contact and outvotes a corner one. Fixed order, so a tie
// resolves the same way on every machine and in every draw order — this feeds a texture choice, and
// a choice that wobbled between frames would shimmer.
const NB8 = [
  [1, 0, 2], [-1, 0, 2], [0, 1, 2], [0, -1, 2],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

/**
 * Add a province's LAND plots to the index, keyed by source pixel and storing only the terrain key.
 *
 * Water plots are skipped rather than stored: the index answers one question — "what land is next to
 * me" — and a water neighbour is not an answer to it. `isWater` is passed in rather than hardcoded so
 * this module stays free of the water-terrain table (that lives in water-terrain.mjs, which knows the
 * eight keys and their shelves).
 *
 * Returns how many pixels were newly indexed, so the caller can bump `version` only on real change —
 * a re-fetch of an already-indexed province must not look like new information, or it would
 * invalidate every water canvas for nothing.
 */
export function indexLand(index, plots, isWater) {
  let n = 0;
  for (const q of plots) {
    if (isWater(q.terrain)) continue;
    const k = pkey(q.x, q.y);
    if (index.has(k)) continue;
    index.set(k, q.terrain);
    n++;
  }
  return n;
}

/**
 * The land terrain a water plot at (x, y) meets — the highest-weighted terrain among its eight
 * neighbours, or `null` when no land neighbour has been indexed yet.
 *
 * Null is a real answer and the caller must handle it: it means "the land beside this plot has not
 * loaded", not "there is no land". Painting a guess there would bake the guess into a cached canvas.
 */
export function shoreTerrain(index, x, y) {
  let best = null, bestW = 0;
  const w = new Map();
  for (const [dx, dy, weight] of NB8) {
    const t = index.get(pkey(x + dx, y + dy));
    if (t === undefined) continue;
    const acc = (w.get(t) || 0) + weight;
    w.set(t, acc);
    if (acc > bestW) { bestW = acc; best = t; }   // strict > keeps the FIRST of a tie, per NB8's order
  }
  return best;
}
