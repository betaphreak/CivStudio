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
// Our bits (docs/coastlines.md §A): 1=E, 2=W, 4=S, 8=N, set = that neighbour is water.
// Civ4's (recovered from the blend table's own rotations):  1=N, 2=E, 4=S, 8=W.
const E = 1, W = 2, S = 4, N = 8;                     // ours
const cN = 1, cE = 2, cS = 4, cW = 8;                 // Civ4's

test("coastConfig maps each single direction to Civ4's bit for the SAME direction", () => {
  assert.equal(coastConfig(N), cN);
  assert.equal(coastConfig(E), cE);
  assert.equal(coastConfig(S), cS);
  assert.equal(coastConfig(W), cW);
});

test("coastConfig reads the EDGE nibble and ignores the diagonal corners", () => {
  // 16=NW, 32=NE, 64=SE, 128=SW — none of these may reach the table
  for (const corner of [16, 32, 64, 128, 16 | 32 | 64 | 128])
    assert.equal(coastConfig(corner), 0);
  assert.equal(coastConfig(N | 32 | 128), cN);        // corners set alongside an edge change nothing
});

test("opposite pairs stay opposite, adjacent pairs stay adjacent", () => {
  // this is the property the old corner-nibble read broke: the table gives 05/10 the STRIP cells and
  // 03/06/12/09 the CORNER cells, so a pair that is opposite for us must be opposite for Civ4 too
  const OPPOSITE = [cN | cS, cE | cW];
  assert.ok(OPPOSITE.includes(coastConfig(N | S)));
  assert.ok(OPPOSITE.includes(coastConfig(E | W)));
  for (const adj of [N | E, E | S, S | W, W | N])
    assert.ok(!OPPOSITE.includes(coastConfig(adj)), `${adj} should not map to an opposite pair`);
});

test("three land neighbours leaves exactly one water bit — the shore faces the water", () => {
  // a plot wedged in a bay: only its northern neighbour is water
  assert.equal(coastConfig(N), cN);
  assert.equal(Number.isInteger(Math.log2(coastConfig(N))), true);   // exactly one bit
});

test("fully enclosed and fully open are preserved", () => {
  assert.equal(coastConfig(N | E | S | W), 15);       // all water → the flat interior cell 29
  assert.equal(coastConfig(0), 0);                    // no water neighbour → no entry, nothing drawn
  assert.equal(coastConfig(undefined), 0);
});
