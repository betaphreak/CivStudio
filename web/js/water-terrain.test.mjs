"use strict";
// node --test web/js/water-terrain.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { shelf, waterBand, shelfMix, shelfColor, WATER_DEPTH } from "./water-terrain.mjs";

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
