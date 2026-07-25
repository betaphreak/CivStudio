"use strict";
// Unit tests for the pure projection seam (project-math.mjs). Run: npm test --prefix web
//
// The inverse camera map had no tests before this and two hand-rolled copies (hittest.plotAt,
// core.latAtScreenY). It is about to become load-bearing: docs/terrain-3d.md P2 turns screen→plot into
// a raycast and every hover, tooltip and city-screen click goes through the inverse in the meantime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { invAffine1, scaleAt } from "./project-math.mjs";

// A real-ish view: the Halcann crop's fit rectangle in a 1600x900 viewport, taken from the shape
// fitView produces (dx/dy centre the crop, dw/dh are the crop scaled to contain).
const V = { d0: 120, dd: 1360, s0: 1800, s1: 4400 };
// the forward map exactly as core.mjs applies it — the thing invAffine1 has to undo
const fwd = (sp, camv, k) => camv + k * (V.d0 + (sp - V.s0) / (V.s1 - V.s0) * V.dd);
const inv = (screen, camv, k) => invAffine1(screen, camv, k, V.d0, V.dd, V.s0, V.s1);

test("invAffine1 undoes the forward map, across the whole zoom range", () => {
  // Tolerance, not equality: the round trip divides by k and dd and multiplies back, so it is exact
  // only to round-off. 1e-9 SOURCE PIXELS is a billionth of a plot — far below anything the app can
  // express, let alone draw. The claim that has to be bit-exact is the next test's.
  for (const k of [1, 5, 16, 40, 128, 512])            // the whole zoom range (K_MAX is 512)
    for (const camv of [0, -300.5, 1720.25])
      for (const sp of [V.s0, V.s0 + 1, 2931, 4399.5, V.s1]) {
        const round = inv(fwd(sp, camv, k), camv, k);
        assert.ok(Math.abs(round - sp) < 1e-9, `round trip at k=${k} cam=${camv} sp=${sp} gave ${round}`);
      }
});

test("invAffine1 matches the formula latAtScreenY hand-rolled", () => {
  // core.latAtScreenY used to compute this inline; it now calls unproject, which calls invAffine1.
  // A last-bit difference here would show as a seam in the ocean's climate banding, so assert the two
  // are the SAME expression and not merely close.
  const camv = -412.75, k = 6.5;
  for (const y of [0, 1, 449.5, 900]) {
    const hand = V.s0 + (((y - camv) / k - V.d0) / V.dd) * (V.s1 - V.s0);
    assert.equal(inv(y, camv, k), hand, `screen y=${y}`);
  }
});

test("invAffine1 is exact at the crop edges (the clamped camera's resting places)", () => {
  // clampPan parks the camera against the map edges constantly, so these are not corner cases.
  const k = 32, camv = 77;
  assert.equal(inv(fwd(V.s0, camv, k), camv, k), V.s0, "west/north edge");
  assert.equal(inv(fwd(V.s1, camv, k), camv, k), V.s1, "east/south edge");
});

// ---- scaleAt ----
// a separable affine projector, as core builds for the 2D camera
const affineProj = (camx, camy, k) => (sx, sy) => [fwd(sx, camx, k), fwd(sy, camy, k)];

test("scaleAt reproduces the pxr(1) - pxr(0) idiom it replaces", () => {
  for (const k of [1, 5, 16, 512]) {
    const project = affineProj(0, 0, k);
    const idiom = fwd(1, 0, k) - fwd(0, 0, k);        // exactly what the four call sites computed
    assert.ok(Math.abs(scaleAt(project, 0, 0) - idiom) < 1e-9, `k=${k}`);
  }
});

test("scaleAt is position-independent under the 2D camera", () => {
  const project = affineProj(-90, 210, 24);
  const at = (x, y) => scaleAt(project, x, y);
  assert.ok(Math.abs(at(1800, 1800) - at(4399, 4399)) < 1e-9,
    "affine + separable means one plot is the same size everywhere — which is why one scalar sufficed");
});

test("scaleAt varies with position under a non-separable projector", () => {
  // The whole reason the probe became a function of position: a fake perspective projector that
  // shrinks with depth. This is the case a `pxr(1) - pxr(0)` probe at the origin gets wrong.
  const persp = (sx, sy) => { const d = 1 + (sy - 1800) / 2000; return [sx / d, sy / d]; };
  const near = scaleAt(persp, 2000, 1800), far = scaleAt(persp, 2000, 4000);
  assert.ok(near > far, `near ${near} should be larger on screen than far ${far}`);
});

test("scaleAt measures along the projected edge, not just its x component", () => {
  // A projector that rotates 45°: one source pixel still spans one unit, but it is diagonal on screen,
  // so an x-only difference would report 1/√2 of the truth. hypot is what makes the probe honest.
  const rot = (sx, sy) => [(sx - sy) / Math.SQRT2, (sx + sy) / Math.SQRT2];
  assert.ok(Math.abs(scaleAt(rot, 100, 100) - 1) < 1e-12);
});
