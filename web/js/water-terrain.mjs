"use strict";
// WATER TERRAIN — the seabed's half of the terrain key, and the only place that knows how a water
// plot's `TERRAIN_*` becomes a colour, a climate band and a depth along the shelf ramp.
//
// Why this exists at all: every water plot has carried a real terrain key for as long as the shelf
// has had plots — `MapTerrainCodec.water()` stamps `TERRAIN_COAST`/`TERRAIN_SEA` plus a climate
// suffix, or the `TERRAIN_LAKE_SHORE`/`TERRAIN_LAKE` pair — and the renderer read NONE of it. The
// shelf was drawn from `landDist` alone, so a polar shelf, a tropical shelf and a lake were the same
// pixels, and the terrain atlas had no water columns to key on anyway (TerrainArtExporter kept land
// only). Both halves are fixed now; this module is the seam between them.
//
// THE CLIMATE BAND COMES FROM THE KEY, NOT THE LATITUDE, and that is a bug fix rather than a
// refactor. The engine bands water on TEMPERATURE and says why in MapTerrainCodec.climateBand: "This
// used to band on |latitude| (polar ≥ 66°, tropical ≤ 23°) — but the EU4 map's inverse-Mercator
// latitudes put temperate Cannor at 60–75°, so its seas rendered polar and iced over." The client
// kept banding on latitude regardless, so Cannor's shelf was drawn with the POLAR coast atlas and
// the polar shallow colour — the exact failure the engine had already diagnosed and fixed.

/** Plots further out than this (in `landDist`) sit at the full open-sea colour. */
export const WATER_DEPTH = 10;

// terrain key -> the pair its depth ramp runs between, and the climate atlas it takes.
//
// COAST and SEA of a band share ONE pair, which is what keeps the ramp continuous: the key flips
// COAST -> SEA at landDist 2, and if each end owned its own colours the shelf would step at that
// ring. Instead the key selects the ramp and `landDist` selects the position along it.
const SHELF = {
  TERRAIN_COAST:          { shallow: "TERRAIN_COAST", deep: "TERRAIN_SEA", band: "temp" },
  TERRAIN_SEA:            { shallow: "TERRAIN_COAST", deep: "TERRAIN_SEA", band: "temp" },
  TERRAIN_COAST_POLAR:    { shallow: "TERRAIN_COAST_POLAR", deep: "TERRAIN_SEA_POLAR", band: "polar" },
  TERRAIN_SEA_POLAR:      { shallow: "TERRAIN_COAST_POLAR", deep: "TERRAIN_SEA_POLAR", band: "polar" },
  TERRAIN_COAST_TROPICAL: { shallow: "TERRAIN_COAST_TROPICAL", deep: "TERRAIN_SEA_TROPICAL", band: "trop" },
  TERRAIN_SEA_TROPICAL:   { shallow: "TERRAIN_COAST_TROPICAL", deep: "TERRAIN_SEA_TROPICAL", band: "trop" },
  // freshwater: its own key pair (so a lake can diverge from the ocean later) but the temperate
  // atlas, since there is no painted lake art to band by
  TERRAIN_LAKE_SHORE:     { shallow: "TERRAIN_LAKE_SHORE", deep: "TERRAIN_LAKE", band: "temp" },
  TERRAIN_LAKE:           { shallow: "TERRAIN_LAKE_SHORE", deep: "TERRAIN_LAKE", band: "temp" },
};

/** The shelf ramp a water terrain key rides, or null if the key is not water (or is absent). */
export function shelf(terrain) {
  return (terrain && SHELF[terrain]) || null;
}

/**
 * Which coast-art atlas a water plot takes, from its own terrain key — `null` when the key is
 * missing or unknown, which is the caller's cue to fall back to the province latitude.
 */
export function waterBand(terrain) {
  const s = shelf(terrain);
  return s ? s.band : null;
}

/**
 * The Civ4 `TextureBlend` index for a water plot: which of its four CORNERS are water, where a corner
 * is water only when EVERY plot touching it is — the diagonal AND the two orthogonals that flank it.
 *
 * WHICH NIBBLE, AND WHY IT IS NOT JUST A SHIFT. The table is corner-keyed; that half was settled by
 * measuring water coverage per QUADRANT, and it stands:
 *
 * | config class  | cell | NW  | NE  | SW  | SE  |
 * |---------------|-----:|----:|----:|----:|----:|
 * | single bit    |    1 |   0 |   0 |   0 |  30 |
 * | adjacent pair |    3 |  49 |  53 |   0 |   0 |
 * | opposite pair |    2 |   0 |  28 |  40 |   0 |
 * | three bits    |    4 |  91 | 100 |   3 |  84 |
 * | all four      |   29 | 100 | 100 | 100 | 100 |
 *
 * A single-bit cell is an 8%-water CORNER WEDGE — an edge band would be a third of the tile and would
 * span two quadrants. The opposite pair sits on a DIAGONAL (NE+SW). Cell 1's water is in SE, and the
 * table's rotations then line up one-for-one with our bits: cfg 04 rot 0 → SE, cfg 08 rot 90 → SW,
 * cfg 01 rot 180 → NW, cfg 02 rot 270 → NE. Set bit = that corner is WATER, i.e. the cell paints
 * water in that quadrant. (The edge nibble was tried as the index once, shipped and reverted — see
 * `ae4f592`. It is still not the index; it is an INPUT to the index, which is the distinction this
 * function turns on.)
 *
 * WHAT WAS WRONG WITH `>> 4` ALONE. It asked only "is the DIAGONAL plot water", and a corner is not
 * its diagonal — it is the meeting point of four plots. Civ4 blends terrain on a mesh whose vertices
 * are plot corners, so a corner belongs to land as soon as ANY plot touching it is land. Measured over
 * 3,000 real shoreline plots from the v13 plot cache, against corner occupancy derived independently
 * from the plots themselves:
 *
 * - the diagonal-only rule agreed with corner occupancy on 48.87% of them;
 * - this rule agrees on 100.00% — the byte carries everything needed, so no corner lattice is
 *   required to index the art (`docs/coast-corner-lattice-plan.md` §1 proposed one for this);
 * - the 2.30% that took cell 29 (flat, no shoreline at all — land touching only orthogonally, so all
 *   four diagonals were water) falls to 0.00%.
 *
 * The silent 2.3% was never the size of the fault. Roughly half of every shoreline took a real cell
 * with its shore in the wrong corner: a cove with land on three sides drew as mostly WATER with a
 * land wedge (cfg 14) where it should be mostly LAND with a water wedge in the SE (cfg 4).
 *
 * Returns 0..15. 0 — every corner touching land, i.e. a one-plot lake or a one-plot-wide channel —
 * has no table entry and draws no tile, leaving the plain water beneath (2.6% of shoreline plots,
 * up from 0.2%; see the plan doc §1).
 */
export function coastConfig(coast) {
  const b = coast || 0;
  const N = b & 8, S = b & 4, E = b & 1, W = b & 2;    // orthogonal edges: 1=E 2=W 4=S 8=N
  let cfg = 0;                                          // Civ4 table bits: 1=NW 2=NE 4=SE 8=SW
  if ((b & 16) && N && W) cfg |= 1;                     // 16=NW
  if ((b & 32) && N && E) cfg |= 2;                     // 32=NE
  if ((b & 64) && S && E) cfg |= 4;                     // 64=SE
  if ((b & 128) && S && W) cfg |= 8;                    // 128=SW
  return cfg;
}

/** Position along the shelf ramp: 0 on the ring that touches land, 1 at open-sea depth. */
export function shelfMix(landDist, depth = WATER_DEPTH) {
  return Math.min(1, Math.max(0, ((landDist || 0) - 1) / depth));
}

/**
 * The water colour for a plot: its ramp's two endpoint colours mixed by depth.
 *
 * `colorOf` looks a terrain key up in the bundle's colour table and must return null for a key it
 * does not carry — the eight water terrains only arrived with the seabed bake, so a page served an
 * older bundle has none of them, and a lookup that guessed instead would paint the whole shelf the
 * generic missing-terrain grey-green. `fallback` ({shallow, deep}) is what that case uses: the
 * art-derived pair the shallow-water fill shipped with, keyed on province latitude by the caller.
 */
export function shelfColor(terrain, landDist, colorOf, fallback) {
  const s = shelf(terrain);
  const a = (s && colorOf(s.shallow)) || (fallback && fallback.shallow);
  const b = (s && colorOf(s.deep)) || (fallback && fallback.deep);
  if (!a || !b) return null;
  const t = shelfMix(landDist);
  return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
}
