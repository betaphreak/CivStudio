"use strict";
// Unit tests for the global route index (route-index.mjs) — the client's cross-province route store.
// Run: node --test web/js/ (the web/ direction is node:test — see docs/route-rendering.md,
// web-unit-tests-wanted). Focus: per-province replacement (a refetch REPLACES a province's keys),
// version bumps that drive the draw layer's tiling-cache invalidation, and the cross-province seam
// fusion that a per-province index could not do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeType, routeVersion, applyProvince, clearRoutes } from "./route-index.mjs";
import { spokes } from "./route-ribbon.mjs";

// the index is module-global (one per page); reset between tests so they don't bleed
function reset() { clearRoutes(); }

test("applyProvince indexes a province's plots by global (x,y)", () => {
  reset();
  applyProvince(10, [{ x: 3, y: 4, type: "ROUTE_TRAIL" }, { x: 3, y: 5, type: "ROUTE_TRAIL" }]);
  assert.equal(routeType(3, 4), "ROUTE_TRAIL");
  assert.equal(routeType(3, 5), "ROUTE_TRAIL");
  assert.equal(routeType(9, 9), null);
});

test("a refetch REPLACES a province's contribution (stale keys drop, upgrades apply)", () => {
  reset();
  applyProvince(10, [{ x: 1, y: 1, type: "ROUTE_TRAIL" }, { x: 1, y: 2, type: "ROUTE_TRAIL" }]);
  // rev 2: (1,2) is gone, (1,1) upgraded to a road
  applyProvince(10, [{ x: 1, y: 1, type: "ROUTE_ROAD" }]);
  assert.equal(routeType(1, 1), "ROUTE_ROAD", "upgrade applied");
  assert.equal(routeType(1, 2), null, "a plot dropped from the province's layer is removed");
});

test("a province's refetch does not disturb another province's keys", () => {
  reset();
  applyProvince(10, [{ x: 1, y: 1, type: "ROUTE_TRAIL" }]);
  applyProvince(20, [{ x: 50, y: 50, type: "ROUTE_TRAIL" }]);
  applyProvince(10, []);   // province 10 emptied
  assert.equal(routeType(1, 1), null, "province 10's key is gone");
  assert.equal(routeType(50, 50), "ROUTE_TRAIL", "province 20's key is untouched");
});

test("version bumps only on a real change (the draw layer's re-tile signal)", () => {
  reset();
  const v0 = routeVersion();
  assert.equal(applyProvince(10, [{ x: 1, y: 1, type: "ROUTE_TRAIL" }]), true);
  const v1 = routeVersion();
  assert.ok(v1 > v0, "a new plot bumps the version");
  // re-applying the identical layer is a no-op — no version bump, so cached tiles stay valid
  assert.equal(applyProvince(10, [{ x: 1, y: 1, type: "ROUTE_TRAIL" }]), false);
  assert.equal(routeVersion(), v1, "an unchanged refetch does not bump the version");
});

test("clearRoutes drops everything and bumps the version (a session switch)", () => {
  reset();
  applyProvince(10, [{ x: 1, y: 1, type: "ROUTE_TRAIL" }]);
  const v = routeVersion();
  clearRoutes();
  assert.equal(routeType(1, 1), null);
  assert.ok(routeVersion() > v);
});

// The whole reason the index is GLOBAL: a plot on province A's edge must fuse with the trail that
// enters from the adjacent province B. A per-province index (the old snapshot merge) could not — it
// only saw A's own plots, so every boundary plot drew a dead-end stub.
test("cross-province seam fuses via the global index", () => {
  reset();
  // province A owns the plot at (5,5); province B owns its eastern neighbour (6,5). Same tier.
  applyProvince(1, [{ x: 5, y: 5, type: "ROUTE_TRAIL" }]);
  const tierAt = (x, y) => routeType(x, y);   // both provinces carry ROUTE_TRAIL, so type == tier here
  // before B loads, (5,5) sees no neighbour → nothing to run to
  let s = spokes((dx, dy) => tierAt(5 + dx, 5 + dy) === "ROUTE_TRAIL");
  assert.deepEqual(s, [], "no neighbour yet → no spoke");
  // B's layer arrives — now (5,5)'s eastern neighbour is routed, across the province seam
  applyProvince(2, [{ x: 6, y: 5, type: "ROUTE_TRAIL" }]);
  s = spokes((dx, dy) => tierAt(5 + dx, 5 + dy) === "ROUTE_TRAIL");
  assert.deepEqual(s, [[1, 0]],
    "the boundary plot now runs east into province B");
});

test("different tiers do not fuse across the seam", () => {
  reset();
  applyProvince(1, [{ x: 5, y: 5, type: "ROUTE_TRAIL" }]);
  applyProvince(2, [{ x: 6, y: 5, type: "ROUTE_ROAD" }]);   // a road, not a trail
  const s = spokes((dx, dy) => routeType(5 + dx, 5 + dy) === "ROUTE_TRAIL");
  assert.deepEqual(s, [], "a trail does not fuse into a neighbouring road");
});
