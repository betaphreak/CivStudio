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
