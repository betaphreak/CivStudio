import test from "node:test";
import assert from "node:assert/strict";
import { spokes, DIRS, TIER, strokeWidth, isIsolated } from "./route-ribbon.mjs";

const from = set => (dx, dy) => set.has(`${dx},${dy}`);

test("a plot spokes toward each same-tier orthogonal neighbour", () => {
  const s = spokes(from(new Set(["0,-1", "1,0"])));
  assert.deepEqual(s, [[0, -1], [1, 0]], "north and east, in DIRS order");
});

test("a straight run spokes both ways, so the two halves meet in the middle", () => {
  assert.deepEqual(spokes(from(new Set(["0,-1", "0,1"]))), [[0, -1], [0, 1]]);
});

test("a dead end draws one spoke — to the neighbour, not into empty ground", () => {
  assert.equal(spokes(from(new Set(["1,0"]))).length, 1);
});

test("a crossroads spokes all four ways", () => {
  assert.equal(spokes(() => true).length, 4);
});

test("an isolated plot has no spokes and is flagged for the dot", () => {
  const s = spokes(() => false);
  assert.deepEqual(s, []);
  assert.equal(isIsolated(s), true);
  assert.equal(isIsolated(spokes(from(new Set(["1,0"])))), false);
});

test("diagonals never connect — routes run on the orthogonal grid", () => {
  assert.deepEqual(spokes(from(new Set(["1,1", "-1,-1"]))), []);
  for (const [dx, dy] of DIRS) assert.ok(Math.abs(dx) + Math.abs(dy) === 1, `${dx},${dy} is orthogonal`);
});

test("the tier hierarchy is real: a trail is thinner and fainter than a road", () => {
  assert.ok(TIER.trail.width < TIER.road.width, "a dirt trail is narrower than a built road");
  assert.ok(TIER.trail.alpha < TIER.road.alpha, "and it whispers where the road speaks");
});

test("stroke width scales with the plot and never disappears", () => {
  assert.equal(strokeWidth("road", 100), 8.5);
  assert.equal(strokeWidth("road", 200), 17, "doubling the plot doubles the ribbon");
  assert.equal(strokeWidth("trail", 0.1), 1, "floored to a hairline rather than nothing");
  assert.equal(strokeWidth("nonsense", 100), 0, "an unknown tier draws nothing");
});
