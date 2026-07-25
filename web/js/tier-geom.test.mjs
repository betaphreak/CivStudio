"use strict";
// Unit tests for the tier-boundary geometry (tier-geom.mjs). Run: npm test --prefix web
// The cull these test is what took the tier overlay from 26 ms/frame (85% of all layer cost at 5.5x)
// to ~0.2 ms — so a regression that quietly stops culling is a big one, and silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexTierRings, tierRingVisible } from "./tier-geom.mjs";

// a plausible /api/tiers slice: absolute source pixels on the 5632x2048 province raster
const GROUPS = {
  gerudia: [[[100, 100], [200, 100], [200, 180], [100, 180]]],
  bulwar:  [[[3000, 900], [3100, 950], [3050, 1000]],
            [[3400, 800], [3500, 800], [3500, 900], [3400, 900]]],
};

test("indexTierRings flattens groups and boxes every ring", () => {
  const rings = indexTierRings(GROUPS);
  assert.equal(rings.length, 3, "one entry per ring, not per group");
  assert.deepEqual({ x0: rings[0].x0, y0: rings[0].y0, x1: rings[0].x1, y1: rings[0].y1 },
    { x0: 100, y0: 100, x1: 200, y1: 180 });
  assert.deepEqual({ x0: rings[1].x0, y0: rings[1].y0, x1: rings[1].x1, y1: rings[1].y1 },
    { x0: 3000, y0: 900, x1: 3100, y1: 1000 });
  assert.equal(rings[0].ring, GROUPS.gerudia[0], "the ring is referenced, not copied");
});

test("indexTierRings skips empty and missing rings rather than boxing them to Infinity", () => {
  const rings = indexTierRings({ a: [[], null, [[5, 5], [6, 6]]] });
  assert.equal(rings.length, 1);
  assert.equal(rings[0].x0, 5);
});

test("indexTierRings on an empty tier is an empty list, not a throw", () => {
  assert.deepEqual(indexTierRings({}), []);
  assert.deepEqual(indexTierRings({ a: [] }), []);
});

// identity-ish projection so the assertions read in source coordinates
const idX = x => x, idY = y => y;

test("tierRingVisible keeps rings that intersect the viewport and drops the rest", () => {
  const r = { x0: 100, y0: 100, x1: 200, y1: 180 };
  assert.ok(tierRingVisible(r, idX, idY, 1400, 900, 0), "fully inside");
  assert.ok(tierRingVisible({ x0: -50, y0: -50, x1: 50, y1: 50 }, idX, idY, 1400, 900, 0), "straddling the top-left");
  assert.ok(tierRingVisible({ x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, idX, idY, 1400, 900, 0),
    "a ring larger than the viewport must NOT be culled");
  assert.ok(!tierRingVisible({ x0: 2000, y0: 100, x1: 2100, y1: 180 }, idX, idY, 1400, 900, 0), "off to the right");
  assert.ok(!tierRingVisible({ x0: 100, y0: 2000, x1: 200, y1: 2100 }, idX, idY, 1400, 900, 0), "off the bottom");
  assert.ok(!tierRingVisible({ x0: -300, y0: 100, x1: -200, y1: 180 }, idX, idY, 1400, 900, 0), "off to the left");
});

test("the margin keeps a just-offscreen ring whose stroke would bleed inward", () => {
  const justLeft = { x0: -20, y0: 100, x1: -4, y1: 180 };   // 4px outside the left edge
  assert.ok(!tierRingVisible(justLeft, idX, idY, 1400, 900, 0), "no margin → culled");
  assert.ok(tierRingVisible(justLeft, idX, idY, 1400, 900, 8), "with margin → kept, so its stroke can bleed in");
});

test("tierRingVisible respects the camera through the projection it is handed", () => {
  // a ring at source x 3000..3100 is off screen at one camera and on screen at another; the predicate
  // must follow the projection rather than the raw source box
  const r = { x0: 3000, y0: 900, x1: 3100, y1: 1000 };
  const cam = (k, tx, ty) => [x => tx + k * x, y => ty + k * y];
  let [px, py] = cam(1, 0, 0);
  assert.ok(!tierRingVisible(r, px, py, 1400, 900, 0), "unpanned: off screen");
  [px, py] = cam(1, -2900, -850);
  assert.ok(tierRingVisible(r, px, py, 1400, 900, 0), "panned onto it: visible");
  [px, py] = cam(0.2, 0, 0);
  assert.ok(tierRingVisible(r, px, py, 1400, 900, 0), "zoomed out: visible");
});

test("monotonic projections map a source box corner-for-corner", () => {
  // the assumption tierRingVisible documents and relies on: with an increasing affine projection the
  // min/max source corners ARE the min/max screen corners, so two projections suffice
  const r = indexTierRings(GROUPS)[1];
  for (const k of [0.2, 1, 7, 512]) {
    const px = x => 31 + k * x, py = y => -17 + k * y;
    const xs = r.ring.map(p => px(p[0])), ys = r.ring.map(p => py(p[1]));
    assert.equal(Math.min(...xs), px(r.x0));
    assert.equal(Math.max(...xs), px(r.x1));
    assert.equal(Math.min(...ys), py(r.y0));
    assert.equal(Math.max(...ys), py(r.y1));
  }
});
