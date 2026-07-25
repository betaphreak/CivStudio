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
import { mkRng, foliageSeed, foliageGroup, isGrassFeature, placeFoliage, placeRelief, RELIEF } from "./foliage.mjs";

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

// ---- relief props: the mountain that stands on a PEAK plot (docs/terrain-3d.md §P4b) ----
//
// These matter because relief moved from the MESH to a PROP. The mesh no longer builds a mountain
// (heightfield.HEIGHT.PEAK dropped 3.4 → 0.8), so if placeRelief silently returns nothing, mountainous
// terrain does not look flatter — it looks ABSENT, and a screenshot of gentle green hills where the Serpentspine
// should be is not obviously a bug.

test("placeRelief gives a PEAK plot exactly one centred prop", () => {
  const pl = placeRelief("PEAK", 4, 7, SPRITES);
  assert.ok(pl, "a PEAK must get a prop");
  assert.equal(pl.key, RELIEF.PEAK.key);
  assert.equal(pl.items.length, 1, "one mountain, not a scatter — that is the whole difference from foliage");
  assert.equal(pl.items[0].x, 0.5, "centred on its plot");
  assert.equal(pl.items[0].y, 0.5);
});

test("placeRelief returns the same record SHAPE as placeFoliage", () => {
  // the 3D geometry builder takes both with no branch, so a missing field is a silent NaN in a vertex buffer
  const rel = placeRelief("PEAK", 1, 1, SPRITES).items[0];
  const fol = placeFoliage("FEATURE_FOREST", 1, 1, SPRITES).items[0];
  assert.deepEqual(Object.keys(rel).sort(), Object.keys(fol).sort());
});

test("a relief prop overhangs its plot, so peaks interlock into a range", () => {
  // a Civ4 mountain is wider than its tile; below ~1 they read as separate cones on a grid
  for (let x = 0; x < 200; x++) {
    const it = placeRelief("PEAK", x, 13, SPRITES).items[0];
    assert.ok(it.h > 1, `a mountain must overhang its plot: ${it.h}`);
    assert.ok(it.h < 2.2, `...but not swamp its neighbours: ${it.h}`);
    assert.ok(Math.abs(it.w / it.h - it.sp[2] / it.sp[3]) < 1e-12, "aspect from the atlas rect");
  }
});

test("relief props are deterministic per plot and vary between plots", () => {
  const at = (x, y) => JSON.stringify(placeRelief("PEAK", x, y, SPRITES));
  assert.equal(at(9, 9), at(9, 9), "same plot, same mountain across rebuilds");
  const seenSprite = new Set(), seenHeight = new Set();
  for (let x = 0; x < 300; x++) {
    const it = placeRelief("PEAK", x, 21, SPRITES).items[0];
    seenSprite.add(it.sp[0]); seenHeight.add(it.h);
  }
  assert.equal(seenSprite.size, SPRITES.length, "every variant must get used, or two thirds of the art is dead");
  assert.ok(seenHeight.size > 50, "heights must vary, or a range is one model repeated");
});

test("only PEAK gets relief, and missing art declines gracefully", () => {
  assert.equal(placeRelief("HILL", 0, 0, SPRITES), null, "HILL stays vertex displacement, not a prop");
  assert.equal(placeRelief("FLAT", 0, 0, SPRITES), null);
  assert.equal(placeRelief(undefined, 0, 0, SPRITES), null, "a plot with no plotType");
  assert.equal(placeRelief("LAGOON_OF_MYSTERY", 0, 0, SPRITES), null, "an unknown C2C plotType must not throw");
  assert.equal(placeRelief("PEAK", 0, 0, []), null, "empty atlas");
  assert.equal(placeRelief("PEAK", 0, 0, null), null, "atlas not baked");
});

test("relief and foliage draw independently, so a forested peak gets both", () => {
  // both use foliageSeed(x, y) but consume it separately; the assertion is that neither is empty and the
  // relief prop is not accidentally one of the foliage items
  const rel = placeRelief("PEAK", 6, 6, SPRITES);
  const fol = placeFoliage("FEATURE_FOREST", 6, 6, SPRITES);
  assert.ok(rel && fol, "a forested peak has a mountain AND trees");
  assert.ok(rel.items[0].h > Math.max(...fol.items.map(i => i.h)), "the mountain dwarfs the trees");
});
