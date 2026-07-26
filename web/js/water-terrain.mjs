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
 * The Civ4 `TextureBlend` index for a water plot, from our 8-bit sea mask.
 *
 * TWO conversions, and both were being skipped.
 *
 * **1. The EDGE nibble, not the corner one.** `docs/coastlines.md` §A: the low nibble is the
 * orthogonal edges, the high nibble the diagonal corners. The renderer fed the table `coast >> 4` —
 * the corners — but the table is edge-shaped, which its own contents prove: bits 1/2/4/8 select one
 * cell at four rotations, adjacent pairs (03/06/12/09) a corner cell, OPPOSITE pairs (05/10) a strip
 * cell, three-set (07/14/13/11) a nearly-enclosed cell, and 15 the flat interior tile 29. Read as
 * corners, `05` and `10` are adjacent pairs being handed a strip.
 *
 * **2. The bit ORDER differs.** Ours is `1=E, 2=W, 4=S, 8=N`; Civ4's is `1=N, 2=E, 4=S, 8=W`,
 * recovered from the table's own rotations — cell 1's painted water faces S unrotated, and the table
 * gives cfg 04 rotation 0, cfg 08 rotation 90 (→W), cfg 01 rotation 180 (→N), cfg 02 rotation 270
 * (→E). Only `S` happens to coincide, so three of the four single-bit configurations were rotating
 * the shoreline to the wrong side of the plot.
 *
 * Set bit = that neighbour is WATER, in both conventions — that part agrees, so only the permutation
 * is needed. Returns 0..15; 0 means no neighbour is water (the table has no entry, nothing is drawn).
 */
export function coastConfig(coast) {
  const e = (coast || 0) & 15;
  return ((e & 1) ? 2 : 0)    // our E → Civ4 E
       | ((e & 2) ? 8 : 0)    // our W → Civ4 W
       | ((e & 4) ? 4 : 0)    // our S → Civ4 S
       | ((e & 8) ? 1 : 0);   // our N → Civ4 N
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
