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
// The table is indexed by the four CORNERS, proven by per-quadrant water coverage (see the function's
// own table): a single-bit cell is an 8% corner wedge, and the 'opposite pair' class sits on a
// diagonal (NE+SW). A corner is water only when every plot touching it is — the diagonal AND the two
// orthogonals — which is what makes this more than a `>> 4`.
const E = 1, W = 2, S = 4, N = 8;                     // ours, low nibble (orthogonal edges)
const NW = 16, NE = 32, SE = 64, SW = 128;            // ours, high nibble (diagonals)
const ALL = E | W | S | N | NW | NE | SE | SW;        // open water: every neighbour is water
const cNW = 1, cNE = 2, cSE = 4, cSW = 8;             // Civ4's table bits

test('a corner is water only when the diagonal AND both flanking edges are', () => {
  assert.equal(coastConfig(NW | N | W), cNW);
  assert.equal(coastConfig(NE | N | E), cNE);
  assert.equal(coastConfig(SE | S | E), cSE);
  assert.equal(coastConfig(SW | S | W), cSW);
  // the diagonal alone is NOT the corner — this is exactly what the old `>> 4` got wrong
  for (const d of [NW, NE, SE, SW]) assert.equal(coastConfig(d), 0);
});

test('one orthogonal land neighbour dries BOTH corners on that edge', () => {
  // THE BUG. Land to the north only: both diagonals are still water, so `>> 4` returned 15 — the flat
  // interior cell — and no shoreline was drawn at all (2.3% of shoreline plots, measured).
  const landN = ALL & ~N;
  assert.notEqual(((landN >> 4) & 15), 0);            // the old rule saw four water diagonals…
  assert.equal((landN >> 4) & 15, 15);                // …i.e. open sea
  assert.equal(coastConfig(landN), cSE | cSW);        // …while the north corners are in fact land
});

test('a cove with land on three sides is mostly LAND, not mostly water', () => {
  // the top measured divergence (cfg 14 -> 4, 126 plots): water open only to the SE
  const cove = SE | S | E;                             // every other neighbour is land
  assert.equal((cove >> 4) & 15, cSE);                 // (the old rule happened to agree here)
  assert.equal(coastConfig(cove), cSE);
  // …but add the diagonals back with the edges still land and the two rules part company
  const wedge = ALL & ~N & ~W;                         // land N and W; all four diagonals water
  assert.equal((wedge >> 4) & 15, 15);                 // old: open sea
  assert.equal(coastConfig(wedge), cSE);               // new: a single water wedge in the SE
});

test('opposite corners stay opposite, adjacent corners stay adjacent', () => {
  const OPPOSITE = [cNW | cSE, cNE | cSW];             // the table's strip cells (05/10)
  assert.ok(OPPOSITE.includes(coastConfig(NW | SE | N | S | E | W)));
  assert.ok(OPPOSITE.includes(coastConfig(NE | SW | N | S | E | W)));
  for (const adj of [[NW, NE, N, W, E], [NE, SE, N, S, E], [SE, SW, S, E, W], [SW, NW, N, S, W]])
    assert.ok(!OPPOSITE.includes(coastConfig(adj.reduce((a, b) => a | b))),
      adj + ' should not map to an opposite pair');
});

test('three water corners leaves exactly one dry — cell 4 is 3-of-4 wet', () => {
  const cfg = coastConfig(ALL & ~SW);                  // only the SW diagonal is land
  assert.equal(cfg, cNW | cNE | cSE);
  assert.equal(4 - [1, 2, 4, 8].filter(b => cfg & b).length, 1);
});

test('fully open water still takes the flat interior cell', () => {
  assert.equal(coastConfig(ALL), 15);                  // all water → cell 29
});

test('every corner touching land draws nothing, and that is a known small gap', () => {
  // a one-plot-wide E-W channel: land N and S dries all four corners. No table entry for 0, so the
  // plain water beneath shows through (2.6% of shoreline plots, up from 0.2% — see coastConfig).
  assert.equal(coastConfig(ALL & ~N & ~S), 0);
  assert.equal(coastConfig(0), 0);
  assert.equal(coastConfig(undefined), 0);
});
