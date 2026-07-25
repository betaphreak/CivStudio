"use strict";
// Unit tests for foliage placement (foliage.mjs). Run: npm test --prefix web
//
// This module exists so the 2D bake and the 3D prop layer place trees IDENTICALLY (docs/terrain-3d.md P3), and
// that is what most of these assert. It is a property no screenshot can check: two renderers scattering
// forests differently would look perfectly fine in either frame and rearrange the world at the seam between
// them. The determinism tests are the contract; the rest guard the classification order, which is behaviour
// rather than style — first match wins, so moving a line moves biomes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkRng, foliageSeed, foliageGroup, isGrassFeature, placeFoliage } from "./foliage.mjs";

// a stand-in atlas: three sprites of different aspect, so width-from-aspect is exercised
const SPRITES = [[0, 0, 40, 40], [40, 0, 20, 60], [60, 0, 80, 40]];

test("mkRng is deterministic and stays in [0, 1)", () => {
  const a = mkRng(12345), b = mkRng(12345);
  for (let i = 0; i < 200; i++) {
    const v = a();
    assert.equal(v, b(), "same seed, same sequence");
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test("mkRng survives a zero seed", () => {
  // foliageSeed can legitimately return 0 (plot 0,0), and a zero state would make the LCG constant
  const r = mkRng(0);
  const first = [r(), r(), r()];
  assert.ok(new Set(first).size === 3, `degenerate sequence: ${first}`);
});

test("neighbouring plots get independent scatter", () => {
  const seeds = new Set();
  for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) seeds.add(foliageSeed(x, y));
  assert.equal(seeds.size, 400, "no two plots in a neighbourhood may share a seed");
});

// ---- classification: first match wins, so the ORDER is the behaviour ----
test("foliageGroup routes each biome to its atlas", () => {
  assert.equal(foliageGroup("FEATURE_FOREST").key, "leafy");
  assert.equal(foliageGroup("FEATURE_JUNGLE").key, "leafy");
  assert.equal(foliageGroup("FEATURE_SWAMP").key, "swamp");
  assert.equal(foliageGroup("FEATURE_OASIS").key, "palm");
  assert.equal(foliageGroup("FEATURE_SAVANNA").key, "palm");
  assert.equal(foliageGroup("FEATURE_CACTUS").key, "cactus");
  assert.equal(foliageGroup("FEATURE_BAMBOO").key, "bamboo");
  assert.equal(foliageGroup("FEATURE_TAIGA").key, "leafy");
  assert.equal(foliageGroup(null), null);
  assert.equal(foliageGroup("FEATURE_FLOOD_PLAINS"), null, "a ground quality, not foliage");
});

test("JUNGLE is denser than FOREST, and both are leafy", () => {
  const j = foliageGroup("FEATURE_JUNGLE"), f = foliageGroup("FEATURE_FOREST");
  assert.equal(j.key, f.key);
  assert.ok(j.lo > f.lo && j.hi > f.hi, "jungle must be the thicker of the two");
});

test("when two patterns match, the EARLIER test wins", () => {
  // The ordering is behaviour, not style, and this pins the two cases where it is observable:
  //   MARSH_JUNGLE  matches JUNGLE (1st) and MARSH (2nd) → jungle, the denser reading
  //   MANGROVE_SWAMP matches SWAMP (2nd) and MANGROVE (last) → swamp
  // Reordering foliageGroup's tests would silently re-biome every plot matching both.
  assert.equal(foliageGroup("FEATURE_MARSH_JUNGLE").key, "leafy", "JUNGLE is tested before MARSH");
  assert.equal(foliageGroup("FEATURE_MANGROVE_SWAMP").key, "swamp", "SWAMP is tested before MANGROVE");
});

test("isGrassFeature catches the procedural cases and nothing else", () => {
  for (const f of ["FEATURE_TALL_GRASS", "FEATURE_VERY_TALL_GRASS", "FEATURE_SWORD_GRASS"])
    assert.ok(isGrassFeature(f), f);
  assert.ok(!isGrassFeature("FEATURE_FOREST"));
  assert.ok(!isGrassFeature(null));
});

// ---- placement ----
test("placeFoliage is deterministic per plot — the contract the two renderers rely on", () => {
  const a = placeFoliage("FEATURE_FOREST", 1200, 830, SPRITES);
  const b = placeFoliage("FEATURE_FOREST", 1200, 830, SPRITES);
  assert.deepEqual(a, b, "same plot, same trees — or crossing band 5 rearranges every forest");
  const c = placeFoliage("FEATURE_FOREST", 1201, 830, SPRITES);
  assert.notDeepEqual(a.items, c.items, "a different plot must scatter differently");
});

test("placeFoliage returns plot FRACTIONS, inside the plot", () => {
  for (let x = 0; x < 60; x++) {
    const pl = placeFoliage("FEATURE_JUNGLE", x, 7, SPRITES);
    for (const it of pl.items) {
      assert.ok(it.x > 0 && it.x < 1, `x out of plot: ${it.x}`);
      assert.ok(it.y > 0 && it.y < 1, `y out of plot: ${it.y}`);
      assert.ok(it.h > 0 && it.h < 1, `implausible height: ${it.h}`);
      assert.ok(it.w > 0, `implausible width: ${it.w}`);
    }
  }
});

test("sprite count honours the group's lo/hi", () => {
  const g = foliageGroup("FEATURE_FOREST");
  const seen = new Set();
  for (let x = 0; x < 400; x++) {
    const n = placeFoliage("FEATURE_FOREST", x, 3, SPRITES).items.length;
    assert.ok(n >= g.lo && n <= g.hi, `count ${n} outside [${g.lo}, ${g.hi}]`);
    seen.add(n);
  }
  assert.ok(seen.size > 1, "the count must actually vary, or every plot looks identical");
});

test("width comes from the chosen sprite's aspect", () => {
  // the tall sprite (20x60) must come out narrower than its height; the wide one (80x40) wider
  for (let x = 0; x < 200; x++)
    for (const it of placeFoliage("FEATURE_FOREST", x, 11, SPRITES).items)
      assert.ok(Math.abs(it.w / it.h - it.sp[2] / it.sp[3]) < 1e-12, "aspect must match the atlas rect");
});

test("items come back sorted back-to-front", () => {
  for (let x = 0; x < 100; x++) {
    const items = placeFoliage("FEATURE_JUNGLE", x, 5, SPRITES).items;
    for (let i = 1; i < items.length; i++)
      assert.ok(items[i].y >= items[i - 1].y, "the 2D path draws in this order for overlap");
  }
});

test("placeFoliage declines gracefully with no art or no foliage", () => {
  assert.equal(placeFoliage("FEATURE_FOREST", 0, 0, []), null, "empty atlas");
  assert.equal(placeFoliage("FEATURE_FOREST", 0, 0, null), null, "missing atlas");
  assert.equal(placeFoliage("FEATURE_FLOOD_PLAINS", 0, 0, SPRITES), null, "feature with no foliage");
  assert.equal(placeFoliage(null, 0, 0, SPRITES), null, "no feature at all");
});
