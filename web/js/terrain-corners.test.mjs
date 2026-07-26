"use strict";
// node --test web/js/terrain-corners.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { pkey, indexTerrain, cornerOwner, cornerResolved, blendConfigs } from "./terrain-corners.mjs";

// real LayerOrders, off terrain-art.json — the 16 land terrains are all distinct, and the synthetic
// ones share the layer of the source they borrow (CAVERN and URBAN both sit on ROCKY's 13)
const LY = {
  TERRAIN_PERMAFROST: 2, TERRAIN_TUNDRA: 3, TERRAIN_DESERT: 6, TERRAIN_PLAINS: 7,
  TERRAIN_GRASSLAND: 8, TERRAIN_LUSH: 9, TERRAIN_ROCKY: 13, TERRAIN_DUNES: 31,
  TERRAIN_CAVERN: 13, TERRAIN_URBAN: 13,
  TERRAIN_COAST: 50, TERRAIN_SEA: 56,
};
const WATER = new Set(["TERRAIN_COAST", "TERRAIN_SEA"]);
const isWater = t => WATER.has(t);
const plot = (x, y, terrain) => ({ x, y, terrain });
// NOTE the order: indexTerrain keeps the FIRST write for a pixel (test 2), so a plot that overrides
// one cell of a block has to be listed BEFORE it.
const built = (...plots) => { const m = new Map(); indexTerrain(m, plots, isWater); return m; };
// a filled w×h block of one terrain with its top-left at (x0,y0)
const block = (x0, y0, w, h, t) => {
  const out = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push(plot(x, y, t));
  return out;
};

test("water is indexed as null, so 'sea' and 'not loaded' stay distinguishable", () => {
  const m = built(plot(1, 1, "TERRAIN_GRASSLAND"), plot(2, 1, "TERRAIN_COAST"));
  assert.equal(m.get(pkey(1, 1)), "TERRAIN_GRASSLAND");
  assert.equal(m.get(pkey(2, 1)), null);      // known, and known not to be land
  assert.equal(m.has(pkey(2, 1)), true);
  assert.equal(m.get(pkey(9, 9)), undefined); // not loaded
  assert.equal(m.has(pkey(9, 9)), false);
});

test("re-indexing a province reports nothing new, so it cannot invalidate cached canvases", () => {
  const m = new Map();
  const plots = [plot(1, 1, "TERRAIN_GRASSLAND"), plot(2, 1, "TERRAIN_SEA")];
  assert.equal(indexTerrain(m, plots, isWater), 2);
  assert.equal(indexTerrain(m, plots, isWater), 0);
  assert.equal(indexTerrain(m, [...plots, plot(3, 1, "TERRAIN_LUSH")], isWater), 1);
});

test("a corner belongs to the highest LayerOrder among the four plots touching it", () => {
  // corner (5,5) is the meeting point of (4,4) (5,4) (4,5) (5,5)
  const m = built(plot(4, 4, "TERRAIN_TUNDRA"), plot(5, 4, "TERRAIN_DUNES"),
                  plot(4, 5, "TERRAIN_PLAINS"), plot(5, 5, "TERRAIN_GRASSLAND"));
  assert.equal(cornerOwner(m, 5, 5, LY), "TERRAIN_DUNES");   // 31 beats 8, 7, 3
});

test("water owns no corner — the land↔water edge is the coast tile's job, not this one", () => {
  const m = built(plot(4, 4, "TERRAIN_SEA"), plot(5, 4, "TERRAIN_COAST"),
                  plot(4, 5, "TERRAIN_SEA"), plot(5, 5, "TERRAIN_TUNDRA"));
  assert.equal(cornerOwner(m, 5, 5, LY), "TERRAIN_TUNDRA");  // despite SEA's LayerOrder 56
  assert.equal(cornerOwner(built(plot(5, 5, "TERRAIN_SEA")), 5, 5, LY), null);
});

test("nothing loaded yet owns nothing — no guess gets baked in", () => {
  assert.equal(cornerOwner(new Map(), 5, 5, LY), null);
});

test("an equal-LayerOrder tie breaks stably, whatever the visit order", () => {
  // CAVERN and ROCKY both sit at 13; the answer must not depend on which was indexed first
  const a = built(plot(4, 4, "TERRAIN_CAVERN"), plot(5, 5, "TERRAIN_ROCKY"));
  const b = built(plot(5, 5, "TERRAIN_ROCKY"), plot(4, 4, "TERRAIN_CAVERN"));
  assert.equal(cornerOwner(a, 5, 5, LY), cornerOwner(b, 5, 5, LY));
  assert.equal(cornerOwner(a, 5, 5, LY), "TERRAIN_CAVERN");   // lexicographic tie-break
});

test("cornerResolved is false until all four touching plots are known", () => {
  const m = built(plot(4, 4, "TERRAIN_TUNDRA"), plot(5, 4, "TERRAIN_TUNDRA"), plot(4, 5, "TERRAIN_TUNDRA"));
  assert.equal(cornerResolved(m, 5, 5), false);
  indexTerrain(m, [plot(5, 5, "TERRAIN_TUNDRA")], isWater);
  assert.equal(cornerResolved(m, 5, 5), true);
  // a water plot RESOLVES a corner — it is an answer, just not an owner
  const w = built(plot(4, 4, "TERRAIN_SEA"), plot(5, 4, "TERRAIN_SEA"),
                  plot(4, 5, "TERRAIN_SEA"), plot(5, 5, "TERRAIN_SEA"));
  assert.equal(cornerResolved(w, 5, 5), true);
});

test("an interior plot has no blend work — which is most of the map", () => {
  const m = built(...block(4, 4, 3, 3, "TERRAIN_GRASSLAND"));
  const { configs, gaps } = blendConfigs(m, 5, 5, LY);
  assert.deepEqual(configs, []);
  assert.deepEqual(gaps, []);
});

test("the config bits are 1=NW 2=NE 4=SE 8=SW", () => {
  const corners = { 1: [4, 4], 2: [6, 4], 4: [6, 6], 8: [4, 6] };   // the diagonal that touches each corner
  for (const [cfg, [dx, dy]] of Object.entries(corners)) {
    const m = built(plot(dx, dy, "TERRAIN_DUNES"), ...block(4, 4, 3, 3, "TERRAIN_GRASSLAND"));
    assert.deepEqual(blendConfigs(m, 5, 5, LY).configs, [["TERRAIN_DUNES", +cfg]], `corner for cfg ${cfg}`);
  }
});

test("an orthogonal neighbour takes the TWO corners it shares, not one", () => {
  // DUNES to the north of (5,5) touches its NW (1) and NE (2) corners
  const m = built(plot(5, 4, "TERRAIN_DUNES"), ...block(4, 4, 3, 3, "TERRAIN_GRASSLAND"));
  assert.deepEqual(blendConfigs(m, 5, 5, LY).configs, [["TERRAIN_DUNES", 3]]);
});

test("the bleed is asymmetric: a higher layer takes corners from a lower one and never the reverse", () => {
  const m = built(plot(4, 4, "TERRAIN_DUNES"), ...block(4, 4, 3, 3, "TERRAIN_TUNDRA"));
  // TUNDRA (3) yields its NW corner to DUNES (31)…
  assert.deepEqual(blendConfigs(m, 5, 5, LY).configs, [["TERRAIN_DUNES", 1]]);
  // …and DUNES gives nothing back: it owns its own SE corner too
  assert.deepEqual(blendConfigs(m, 4, 4, LY).configs, []);
});

test("two neighbours are returned lowest layer first, so a caller painting in order layers correctly", () => {
  const m = built(plot(4, 4, "TERRAIN_DUNES"), plot(6, 4, "TERRAIN_TUNDRA"),
                  ...block(4, 4, 3, 3, "TERRAIN_PERMAFROST"));
  const { configs } = blendConfigs(m, 5, 5, LY);
  assert.deepEqual(configs, [["TERRAIN_TUNDRA", 2], ["TERRAIN_DUNES", 1]]);   // 3 before 31
});

test("a plot ringed by a higher layer reports config 15 — the flat interior, not an error", () => {
  const m = built(plot(4, 4, "TERRAIN_DUNES"), plot(6, 4, "TERRAIN_DUNES"),
                  plot(6, 6, "TERRAIN_DUNES"), plot(4, 6, "TERRAIN_DUNES"),
                  ...block(4, 4, 3, 3, "TERRAIN_PLAINS"));
  assert.deepEqual(blendConfigs(m, 5, 5, LY).configs, [["TERRAIN_DUNES", 15]]);
});

test("the answer does not depend on which province arrived first", () => {
  const west = block(4, 4, 1, 3, "TERRAIN_DUNES"), east = block(5, 4, 2, 3, "TERRAIN_GRASSLAND");
  const a = new Map(); indexTerrain(a, west, isWater); indexTerrain(a, east, isWater);
  const b = new Map(); indexTerrain(b, east, isWater); indexTerrain(b, west, isWater);
  assert.deepEqual(blendConfigs(a, 5, 5, LY), blendConfigs(b, 5, 5, LY));
  assert.deepEqual(blendConfigs(a, 5, 5, LY).configs, [["TERRAIN_DUNES", 9]]);   // NW + SW
});

test("gaps name the unresolved corners, and close as the neighbours land", () => {
  const m = built(plot(5, 5, "TERRAIN_GRASSLAND"));
  const lone = blendConfigs(m, 5, 5, LY);
  assert.deepEqual(lone.gaps, [pkey(5, 5), pkey(6, 5), pkey(6, 6), pkey(5, 6)]);
  assert.deepEqual(lone.configs, []);                       // …and it guesses nothing meanwhile
  indexTerrain(m, block(4, 4, 3, 3, "TERRAIN_DUNES"), isWater);   // (5,5) already indexed, so it holds
  const filled = blendConfigs(m, 5, 5, LY);
  assert.deepEqual(filled.gaps, []);
  assert.deepEqual(filled.configs, [["TERRAIN_DUNES", 15]]);
});
