"use strict";
// TERRAIN CORNERS — who owns each vertex of the plot lattice, and therefore which authored blend
// cell to stamp on which plot. Pure, zero-import, and therefore testable (terrain-corners.test.mjs).
//
// Phase 2 of docs/land-blend-plan.md. Nothing renders from this yet; phase 3 is what replaces the
// procedural feather in plots.mjs with the cells baked by `bakeLandBlendCells` (phase 1).
//
// WHY CORNERS AND NOT EDGES. Civ4 blends terrain on a mesh whose vertices are plot CORNERS, and its
// art is authored to match: each `TextureBlend<n>` cell's alpha is a mask for exactly the corners `n`
// names (measured — all 224 baked cells bind to their config's corners, see build.mjs). So the
// question the art asks is "which of my four corners belong to terrain A", and answering it in terms
// of edges loses the diagonal cases entirely. This is the same lesson `water-terrain.coastConfig`
// records for the coast, where the edge nibble was shipped as the index and reverted.
//
// THE OWNERSHIP RULE. A corner belongs to the highest-`LayerOrder` terrain among the (up to four)
// plots touching it. That is what Civ4 exports LayerOrder for, and it makes the pass ORDER-
// INDEPENDENT: the same corner resolves the same way regardless of which neighbour is visited first,
// which is the property heightfield.mjs argues for at length. The consequence is deliberately
// asymmetric — a higher-layer terrain bleeds onto its lower neighbours and never the reverse — and
// that asymmetry is the effect being reproduced, not a bug in it.
//
// WHY THE INDEX IS GLOBAL AND KEYED BY SOURCE PIXEL. A plot on a province edge has neighbours in
// ANOTHER province, and provinces arrive from /api/plots asynchronously and in view order, so a
// per-province lookup cannot see across the boundary. shore-index.mjs makes this argument in full and
// it transfers verbatim; the two indexes are separate only because they answer different questions.

/** Plot-grid key — the same encoding plots.mjs, heightfield.mjs and shore-index.mjs use. */
export const pkey = (x, y) => x * 1e5 + y;

/**
 * A CORNER is named by the plot whose NORTH-WEST vertex it is, so corner (cx, cy) is the meeting
 * point of plots (cx-1, cy-1), (cx, cy-1), (cx-1, cy) and (cx, cy). y increases southward, matching
 * the plot grid everywhere else in the viewer.
 *
 * A plot's own four corners are therefore NW (x, y), NE (x+1, y), SE (x+1, y+1), SW (x, y+1) — and in
 * that order, because Civ4's table bits are 1=NW 2=NE 4=SE 8=SW (proven twice: by the coast table,
 * and independently by the baked cells' alpha).
 */
const CORNER_OFFSETS = [[0, 0], [1, 0], [1, 1], [0, 1]];   // NW, NE, SE, SW — bit i = 1 << i
const TOUCHING = [[-1, -1], [0, -1], [-1, 0], [0, 0]];      // the four plots meeting at a corner

/**
 * Index a province's plots by source pixel. EVERY terrain is stored, water included.
 *
 * WATER COMPETES FOR CORNERS LIKE ANY OTHER TERRAIN, and it wins them: the eight water terrains carry
 * LayerOrders 50–71 against land's 2–31, so a corner touching any water plot belongs to the water. It
 * has no cell in the land blend sheet, so the effect is SUPPRESSION — no land cell is painted into a
 * vertex the sea owns. That is the correct outcome twice over: it is what LayerOrder means, and the
 * land↔water transition is already drawn there by Civ4's painted coast tile, which coast.mjs stamps
 * on the water plot. Excluding water would paint a land neighbour's cell into that corner and then
 * blend the coast over the same vertex from the other side.
 *
 * Because every plot is stored, `index.has(k)` means exactly "known" and an absent key means "not
 * loaded yet" and nothing else — which is what `cornerResolved` needs to be trustworthy. This module
 * therefore never has to be told which terrains are water; it only needs their LayerOrder, which is
 * in the same `terrain-art.json` table as everything else's.
 *
 * Returns how many pixels were NEWLY indexed, so the caller can treat a re-fetch of an
 * already-indexed province as no new information rather than as a reason to invalidate canvases.
 */
export function indexTerrain(index, plots) {
  let n = 0;
  for (const q of plots) {
    const k = pkey(q.x, q.y);
    if (index.has(k)) continue;
    index.set(k, q.terrain);
    n++;
  }
  return n;
}

/**
 * The terrain owning corner (cx, cy): the highest-LayerOrder terrain among the four plots touching
 * it, or null when none of them has loaded yet.
 *
 * TIES BREAK LEXICOGRAPHICALLY on the terrain key. The 16 land terrains all have DISTINCT LayerOrders
 * (measured off terrain-art.json: PERMAFROST 2 … DUNES 31), so a tie needs one of the nine synthetic
 * terrains, which share their borrowed source's layer — CAVERN and URBAN both sit at ROCKY's 13,
 * GLACIER at PERMAFROST's 2. The tie-break is arbitrary but it must be STABLE, or the same corner
 * would resolve differently depending on visit order and the boundary would shimmer between bakes.
 */
export function cornerOwner(index, cx, cy, LY) {
  let best = null, bestLy = -Infinity;
  for (const [dx, dy] of TOUCHING) {
    const t = index.get(pkey(cx + dx, cy + dy));
    if (t === undefined) continue;          // not loaded — the one thing that cannot own a corner
    const ly = LY[t] || 0;
    if (ly > bestLy || (ly === bestLy && t < best)) { bestLy = ly; best = t; }
  }
  return best;
}

/** True when every plot touching corner (cx, cy) is known — i.e. its owner cannot still change. */
export function cornerResolved(index, cx, cy) {
  for (const [dx, dy] of TOUCHING) if (!index.has(pkey(cx + dx, cy + dy))) return false;
  return true;
}

/**
 * The blend work for the plot at (x, y): every distinct terrain OTHER than the plot's own that owns
 * at least one of its four corners, with the 4-bit config naming which.
 *
 * Returns `{configs, gaps}`:
 *
 *   configs — `[[terrain, cfg], …]`, sorted by LayerOrder ASCENDING so a caller that draws them in
 *             order paints the highest layer last, which is what "higher layers paint over lower"
 *             means. Empty for an interior plot, which is most of the map.
 *   gaps    — the keys of this plot's corners that are not yet fully resolved, for PRECISE staleness:
 *             record them with the baked canvas and re-bake only when one RESOLVES. Do not treat a
 *             non-empty `gaps` as "stale" on its own — a plot at the world edge has corners that will
 *             never resolve, and re-baking on that would thrash forever (docs/land-blend-plan.md §6).
 *
 * NOT EVERY OWNER IS DRAWABLE, AND THAT IS HOW SUPPRESSION WORKS. A corner won by water, or by one of
 * the nine synthetic terrains, is reported here like any other, but neither has a column in the baked
 * blend sheet (which carries the 16 land terrains only). The caller skips what it cannot draw, and
 * the corner keeps the plot's own ground — which is the right picture: for water because coast.mjs
 * already draws that vertex from the water side, for the synthetic terrains because they have no
 * `CIV4ArtDefines_Terrain.xml` entry to draw from. Reporting them and letting the caller skip is what
 * stops a LOWER land neighbour from claiming a corner it did not win.
 *
 * CONFIG 15 IS POSSIBLE AND IS NOT AN ERROR. A lone plot ringed by a higher-layer terrain has all
 * four corners taken, and the authored table's config 15 is the FLAT INTERIOR cell — that terrain's
 * ordinary ground tile, which the caller already has. The baked blend sheet carries configs 1–14
 * only, so the caller must special-case 15 by drawing the ground tile rather than looking for a
 * column that is not there.
 *
 * Config 0 cannot occur: a terrain is only listed here because it owns a corner.
 */
export function blendConfigs(index, x, y, LY) {
  const self = index.get(pkey(x, y));
  const bits = new Map();
  const gaps = [];
  for (let i = 0; i < 4; i++) {
    const cx = x + CORNER_OFFSETS[i][0], cy = y + CORNER_OFFSETS[i][1];
    if (!cornerResolved(index, cx, cy)) gaps.push(pkey(cx, cy));
    const owner = cornerOwner(index, cx, cy, LY);
    if (!owner || owner === self) continue;
    bits.set(owner, (bits.get(owner) || 0) | (1 << i));
  }
  const configs = [...bits].sort((a, b) => (LY[a[0]] || 0) - (LY[b[0]] || 0) || (a[0] < b[0] ? -1 : 1));
  return { configs, gaps };
}
