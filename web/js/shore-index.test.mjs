"use strict";
// node --test web/js/shore-index.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { pkey, indexLand, shoreTerrain } from "./shore-index.mjs";

const WATER = new Set(["TERRAIN_COAST", "TERRAIN_SEA", "TERRAIN_LAKE"]);
const isWater = t => WATER.has(t);
const plot = (x, y, terrain) => ({ x, y, terrain });
const built = (...plots) => { const m = new Map(); indexLand(m, plots, isWater); return m; };

test("only land is indexed — a water neighbour is not an answer to 'what land is beside me'", () => {
  const m = built(plot(1, 1, "TERRAIN_GRASSLAND"), plot(2, 1, "TERRAIN_COAST"), plot(3, 1, "TERRAIN_SEA"));
  assert.equal(m.size, 1);
  assert.equal(m.get(pkey(1, 1)), "TERRAIN_GRASSLAND");
});

test("a water plot takes the land terrain beside it", () => {
  // land to the north of (5,5)
  const m = built(plot(5, 4, "TERRAIN_DESERT"));
  assert.equal(shoreTerrain(m, 5, 5), "TERRAIN_DESERT");
});

test("no land indexed yet returns null, so nothing gets baked on a guess", () => {
  assert.equal(shoreTerrain(new Map(), 5, 5), null);
  assert.equal(shoreTerrain(built(plot(99, 99, "TERRAIN_TUNDRA")), 5, 5), null);
});

test("an edge neighbour outvotes a corner one — it has twice the shoreline in contact", () => {
  // one orthogonal TUNDRA (weight 2) against one diagonal DESERT (weight 1)
  const m = built(plot(5, 4, "TERRAIN_TUNDRA"), plot(4, 4, "TERRAIN_DESERT"));
  assert.equal(shoreTerrain(m, 5, 5), "TERRAIN_TUNDRA");
  // …but two diagonals (1+1) beat one edge (2)? No — strictly greater is required, so the edge holds
  const m2 = built(plot(5, 4, "TERRAIN_TUNDRA"), plot(4, 4, "TERRAIN_DESERT"), plot(6, 4, "TERRAIN_DESERT"));
  assert.equal(shoreTerrain(m2, 5, 5), "TERRAIN_TUNDRA");
  // three diagonals do beat it
  const m3 = built(plot(5, 4, "TERRAIN_TUNDRA"), plot(4, 4, "TERRAIN_DESERT"),
                   plot(6, 4, "TERRAIN_DESERT"), plot(4, 6, "TERRAIN_DESERT"));
  assert.equal(shoreTerrain(m3, 5, 5), "TERRAIN_DESERT");
});

test("the majority land terrain wins, not merely the first found", () => {
  const m = built(plot(4, 5, "TERRAIN_GRASSLAND"), plot(6, 5, "TERRAIN_DESERT"), plot(5, 6, "TERRAIN_DESERT"));
  assert.equal(shoreTerrain(m, 5, 5), "TERRAIN_DESERT");
});

test("the answer does not depend on which province arrived first", () => {
  // the whole point of a global index: a boundary plot sees both sides once both have landed
  const west = [plot(4, 5, "TERRAIN_GRASSLAND")], east = [plot(6, 5, "TERRAIN_DESERT"), plot(6, 4, "TERRAIN_DESERT")];
  const a = new Map(); indexLand(a, west, isWater); indexLand(a, east, isWater);
  const b = new Map(); indexLand(b, east, isWater); indexLand(b, west, isWater);
  assert.equal(shoreTerrain(a, 5, 5), shoreTerrain(b, 5, 5));
  assert.equal(shoreTerrain(a, 5, 5), "TERRAIN_DESERT");
});

test("re-indexing the same province reports nothing new, so it cannot invalidate cached canvases", () => {
  const m = new Map();
  const plots = [plot(1, 1, "TERRAIN_GRASSLAND"), plot(2, 1, "TERRAIN_LUSH")];
  assert.equal(indexLand(m, plots, isWater), 2);
  assert.equal(indexLand(m, plots, isWater), 0);
  assert.equal(indexLand(m, [...plots, plot(3, 1, "TERRAIN_PLAINS")], isWater), 1);
});

test("a land plot's own pixel is not consulted — only its neighbours", () => {
  // (5,5) is itself land in the index; asking for its shore must ignore that and find nothing
  const m = built(plot(5, 5, "TERRAIN_GRASSLAND"));
  assert.equal(shoreTerrain(m, 5, 5), null);
});
