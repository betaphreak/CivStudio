"use strict";
// Route ribbons — the pure geometry behind the road/trail/rail draw layer (docs/route-rendering.md).
// No imports, so it unit-tests in node (route-ribbon.test.mjs) without the browser globals core.mjs
// pulls in.
//
// THIS REPLACED AUTO-TILING, and the reason is the projector rather than taste. The old layer stamped
// one of six baked connection sprites per plot, rotated to match the plot's neighbour mask
// (route-tiling.mjs, now deleted). That works only while a plot is an axis-aligned SQUARE on screen —
// under the tilted 3D camera a plot is a trapezoid, so a rotated square cell no longer meets its
// neighbour at the shared edge, and the network comes apart exactly where roads are supposed to join.
//
// A ribbon has no such constraint: it is a polyline between plot CENTRES, so it meets its neighbours
// by being continuous rather than by two stamped cells happening to align. It also drapes for free —
// every vertex goes through core.projectOn, which sits it at its own terrain height — and it needs no
// art, which is what let the top-down NIF bake go (docs/terrain-3d.md §The top-down projector goes).
//
// The same idea already carries the rivers (docs/river-rendering.md); this is that, with a road's
// per-tier width instead of a river's recovered one.

/** Orthogonal neighbour offsets, N first then clockwise. N is −y (north = up), as on the map. */
export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * The half-spokes a routed plot draws: one per orthogonal neighbour that carries the SAME tier, as a
 * unit offset. Half, because each plot draws from its own centre to the shared edge — the neighbour
 * draws the other half, so a segment is covered exactly twice and a dead end stops at the boundary
 * rather than poking into empty ground.
 *
 * @param has `(dx, dy) => boolean` — does the orthogonal neighbour carry this tier
 */
export function spokes(has) {
  return DIRS.filter(([dx, dy]) => has(dx, dy));
}

/**
 * Per-tier ribbon style. Widths are FRACTIONS OF A PLOT, not pixels: the layer multiplies by the
 * plot's on-screen size at its own position, so a ribbon narrows with perspective exactly as the
 * ground it lies on does. A pioneered dirt trail whispers and a built road speaks — the hierarchy the
 * old atlas carried in its per-tier alpha.
 */
export const TIER = {
  trail: { width: 0.045, color: "#8a7654", alpha: 0.5 },
  road:  { width: 0.085, color: "#a89272", alpha: 0.9 },
  rail:  { width: 0.07,  color: "#5a5550", alpha: 0.95 },
};

/** A tier's stroke width in px for a plot of `plotPx`, floored so it never vanishes to nothing. */
export function strokeWidth(tier, plotPx) {
  const t = TIER[tier];
  return t ? Math.max(1, plotPx * t.width) : 0;
}

/**
 * An isolated routed plot — no same-tier neighbour at all — still has to read as something. It draws
 * a dot rather than a spoke to nowhere: a lone trailed city core before its network exists, which the
 * old atlas spent a whole `iso` sprite on.
 */
export function isIsolated(spokeList) {
  return spokeList.length === 0;
}
