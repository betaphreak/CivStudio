"use strict";
// WHERE THE TREES GO — pure, zero-import, and therefore testable (foliage.test.mjs).
// docs/terrain-3d.md §The plan → P3.
//
// Extracted from plots.mjs, which baked foliage straight into each province's offscreen canvas: it chose the
// sprites, jittered them across the plot and drew them, all in one function. The 3D ground needs the same
// choices without the drawing — a tree has to become an upright quad standing on the mesh rather than a
// top-down stamp lying in the texture — so the CHOOSING moves here and both renderers ask it.
//
// The point of the split is that the two must AGREE. If the 3D path invented its own scatter, crossing band 5
// would rearrange every forest on the map; instead there is one deterministic answer per plot and the two
// consumers differ only in how they draw it. Which is also why the numbers below and the exact ORDER of the
// random draws are copied verbatim rather than tidied: the sequence IS the placement, so reordering two lines
// here silently moves every tree in the world.
//
// Everything is returned in PLOT FRACTIONS (0..1 across a plot), because that is the one unit both callers
// can use: the 2D bake multiplies by its tiles-per-plot, and the 3D path multiplies by 1 — a plot IS one
// source pixel.

/** Small deterministic RNG seeded by a plot's coords, so a plot's foliage is stable across rebuilds. */
export function mkRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** The per-plot seed. Hashes the coords so neighbouring plots scatter independently. */
export const foliageSeed = (x, y) => (x * 73856093) ^ (y * 19349663);

/**
 * feature → which sprite atlas, how many, and how big — or null for a feature with no foliage art (drawn as
 * bare terrain). First match wins, so the ORDER of these tests is part of the behaviour: JUNGLE before
 * FOREST, and SWAMP before anything that might also match WETLAND.
 *
 * CACTUS and BAMBOO have no billboard imposter in the Civ4 art; tools/nifbake renders their 3D .nif models to
 * sprite sheets at build time (docs/features-art.md). Tall grass is procedural and handled by the caller
 * before this is reached.
 */
export function foliageGroup(feature) {
  if (!feature) return null;
  if (/JUNGLE|RAINFOREST/.test(feature))          return { key: "leafy",  lo: 3, hi: 5, scale: 0.60 };  // dense
  if (/SWAMP|BOG|MARSH|WETLAND/.test(feature))    return { key: "swamp",  lo: 2, hi: 3, scale: 0.44 };
  if (/SAVANNA/.test(feature))                    return { key: "palm",   lo: 1, hi: 2, scale: 0.6 };   // sparse
  if (/OASIS/.test(feature))                      return { key: "palm",   lo: 1, hi: 2, scale: 0.55 };
  if (/CACTUS|KAKTUS/.test(feature))              return { key: "cactus", lo: 1, hi: 2, scale: 0.55 };
  if (/BAMBOO/.test(feature))                     return { key: "bamboo", lo: 2, hi: 3, scale: 0.55 };
  if (/FOREST|WOOD|TAIGA|MANGROVE/.test(feature)) return { key: "leafy",  lo: 2, hi: 4, scale: 0.55 };
  return null;
}

/** Whether a feature draws as procedural grass tufts rather than sprites (see plots.stampGrass). */
export const isGrassFeature = f => !!f && /VERY_TALL_GRASS|SWORD_GRASS|TALL_GRASS/.test(f);

/**
 * Choose and place a plot's foliage. `sprites` is the atlas's rect list ([x, y, w, h] each), needed here
 * because a sprite's ASPECT decides its width — so the caller cannot compute that without re-picking the same
 * sprite, which is exactly the sort of duplicated draw that drifts apart.
 *
 * Returns `{ key, items }`, each item's `x`/`y` the sprite CENTRE and `w`/`h` its size, all in plot fractions,
 * sorted back-to-front by `y`. Null when the feature has no foliage or the atlas is empty.
 *
 * The sort is only load-bearing for the 2D path, which relies on draw order for overlap; the 3D path
 * depth-tests instead. It is done here anyway so both see the same list, and because a stable order makes the
 * geometry a pure function of the plot.
 */
export function placeFoliage(feature, plotX, plotY, sprites) {
  const g = foliageGroup(feature);
  if (!g || !sprites || !sprites.length) return null;
  const rng = mkRng(foliageSeed(plotX, plotY));
  const n = g.lo + (rng() * (g.hi - g.lo + 1) | 0);
  const items = [];
  for (let i = 0; i < n; i++) {
    // ORDER MATTERS: sprite, then height, then x, then y. This is the sequence the 2D bake has always drawn
    // in, and every forest on the map is downstream of it.
    const sp = sprites[rng() * sprites.length | 0];
    const h = g.scale * (0.82 + 0.36 * rng());
    items.push({ sp, w: h * sp[2] / sp[3], h, x: 0.16 + 0.68 * rng(), y: 0.22 + 0.6 * rng() });
  }
  items.sort((a, b) => a.y - b.y);
  return { key: g.key, items };
}
