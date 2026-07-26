"use strict";
// node --test web/js/water-terrain.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { shelf, waterBand, shelfMix, shelfColor, coastConfig, WATER_DEPTH } from "./water-terrain.mjs";

const COAST = [43, 71, 101], SEA = [30, 66, 96];
const TROP_COAST = [40, 78, 106], TROP_SEA = [38, 82, 108];
const TABLE = {
  TERRAIN_COAST: COAST, TERRAIN_SEA: SEA,
  TERRAIN_COAST_TROPICAL: TROP_COAST, TERRAIN_SEA_TROPICAL: TROP_SEA,
  TERRAIN_COAST_POLAR: [48, 70, 92], TERRAIN_SEA_POLAR: [36, 62, 82],
  TERRAIN_LAKE_SHORE: [43, 71, 101], TERRAIN_LAKE: [30, 66, 96],
};
const colorOf = k => TABLE[k] || null;

test("every water terrain key the engine can stamp has a shelf", () => {
  // the exact key set MapTerrainCodec.water() produces: COAST/SEA × (temperate, _POLAR, _TROPICAL),
  // plus the freshwater pair
  for (const k of ["TERRAIN_COAST", "TERRAIN_COAST_POLAR", "TERRAIN_COAST_TROPICAL",
                   "TERRAIN_SEA", "TERRAIN_SEA_POLAR", "TERRAIN_SEA_TROPICAL",
                   "TERRAIN_LAKE_SHORE", "TERRAIN_LAKE"])
    assert.ok(shelf(k), `${k} has no shelf entry`);
});

test("land and unknown keys are not water", () => {
  for (const k of ["TERRAIN_GRASSLAND", "TERRAIN_CAVERN", "TERRAIN_NOPE", "", null, undefined])
    assert.equal(shelf(k), null);
  assert.equal(waterBand("TERRAIN_GRASSLAND"), null);
});

test("the climate band comes from the key's suffix", () => {
  assert.equal(waterBand("TERRAIN_COAST"), "temp");
  assert.equal(waterBand("TERRAIN_SEA"), "temp");
  assert.equal(waterBand("TERRAIN_COAST_POLAR"), "polar");
  assert.equal(waterBand("TERRAIN_SEA_TROPICAL"), "trop");
  assert.equal(waterBand("TERRAIN_LAKE"), "temp");       // no painted lake art to band by
});

test("COAST and SEA of a band share one ramp, so the shelf does not step where the key flips", () => {
  // the key flips COAST -> SEA at landDist 2; the colour either side of that must be continuous
  const a = shelfColor("TERRAIN_COAST", 2, colorOf, null);
  const b = shelfColor("TERRAIN_SEA", 2, colorOf, null);
  assert.deepEqual(a, b);
  for (const band of ["", "_POLAR", "_TROPICAL"]) {
    const s = shelf(`TERRAIN_COAST${band}`), d = shelf(`TERRAIN_SEA${band}`);
    assert.deepEqual(s, d);
  }
});

test("the ramp runs shallow at the shore to open-sea at depth, and clamps", () => {
  assert.equal(shelfMix(1), 0);
  assert.equal(shelfMix(1 + WATER_DEPTH), 1);
  assert.equal(shelfMix(999), 1);
  assert.equal(shelfMix(0), 0);              // land (landDist 0) never reaches here, but must not go negative
  assert.equal(shelfMix(undefined), 0);
  assert.deepEqual(shelfColor("TERRAIN_COAST", 1, colorOf, null), COAST);
  assert.deepEqual(shelfColor("TERRAIN_SEA", 1 + WATER_DEPTH, colorOf, null), SEA);
});

test("a tropical shelf ramps to TROPICAL open water, not to the temperate colour", () => {
  // the bug this fixes: every province used to ramp to seaBands.temp regardless of its climate
  const deep = shelfColor("TERRAIN_SEA_TROPICAL", 1 + WATER_DEPTH, colorOf, null);
  assert.deepEqual(deep, TROP_SEA);
  assert.notDeepEqual(deep, SEA);
  assert.deepEqual(shelfColor("TERRAIN_COAST_TROPICAL", 1, colorOf, null), TROP_COAST);
});

test("a bundle with no water colours falls back to the art-derived pair", () => {
  const none = () => null;                    // older bundle: colour table has no water keys
  const fb = { shallow: [1, 2, 3], deep: [11, 22, 33] };
  assert.deepEqual(shelfColor("TERRAIN_COAST", 1, none, fb), [1, 2, 3]);
  assert.deepEqual(shelfColor("TERRAIN_SEA", 1 + WATER_DEPTH, none, fb), [11, 22, 33]);
  // …and with neither, nothing is invented — the caller leaves the plot transparent
  assert.equal(shelfColor("TERRAIN_COAST", 1, none, null), null);
  assert.equal(shelfColor("TERRAIN_GRASSLAND", 1, colorOf, null), null);
});

test("a plot with no terrain key at all still paints, via the fallback", () => {
  const fb = { shallow: [1, 2, 3], deep: [11, 22, 33] };
  assert.deepEqual(shelfColor(undefined, 1, colorOf, fb), [1, 2, 3]);
});

// ---- coastConfig: our sea mask -> Civ4's TextureBlend index -------------------------------------
// The table is indexed by the DIAGONAL CORNERS, proven by per-quadrant water coverage (see the
// function's own table): a single-bit cell is an 8% corner wedge, and the 'opposite pair' class sits
// on a diagonal (NE+SW). Our high nibble already uses Civ4's order, so the mapping is identity.
const NW = 16, NE = 32, SE = 64, SW = 128;            // ours (high nibble)
const cNW = 1, cNE = 2, cSE = 4, cSW = 8;             // Civ4's table bits

test('coastConfig maps each diagonal to Civ4 bit for the SAME diagonal', () => {
  assert.equal(coastConfig(NW), cNW);
  assert.equal(coastConfig(NE), cNE);
  assert.equal(coastConfig(SE), cSE);
  assert.equal(coastConfig(SW), cSW);
});

test('coastConfig reads the CORNER nibble and ignores the orthogonal edges', () => {
  // 1=E, 2=W, 4=S, 8=N — the edge bits must not reach the table (this is the regression that
  // shipped once: feeding the low nibble rotated every shoreline off its corner)
  for (const edge of [1, 2, 4, 8, 15])
    assert.equal(coastConfig(edge), 0);
  assert.equal(coastConfig(NW | 4 | 8), cNW);         // edges set alongside a corner change nothing
});

test('opposite corners stay opposite, adjacent corners stay adjacent', () => {
  const OPPOSITE = [cNW | cSE, cNE | cSW];            // the table's strip cells (05/10)
  assert.ok(OPPOSITE.includes(coastConfig(NW | SE)));
  assert.ok(OPPOSITE.includes(coastConfig(NE | SW)));
  for (const adj of [NW | NE, NE | SE, SE | SW, SW | NW])
    assert.ok(!OPPOSITE.includes(coastConfig(adj)), adj + ' should not map to an opposite pair');
});

test('three water corners leaves exactly one dry — cell 4 is 3-of-4 wet', () => {
  const cfg = coastConfig(NW | NE | SE);
  assert.equal(cfg, cNW | cNE | cSE);
  assert.equal(4 - [1, 2, 4, 8].filter(b => cfg & b).length, 1);
});

test('fully enclosed and fully open are preserved', () => {
  assert.equal(coastConfig(NW | NE | SE | SW), 15);   // all water → the flat interior cell 29
  assert.equal(coastConfig(0), 0);                    // no water corner → no entry, nothing drawn
  assert.equal(coastConfig(undefined), 0);
});
