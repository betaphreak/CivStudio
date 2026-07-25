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

// ---- the tilted ground projection (P2) ----
import { groundHomography, applyH, invertH, unapplyH } from "./project-math.mjs";

// Camera matrices are column-major, as three's Matrix4.elements is: e[col * 4 + row].
const M = (...rows) => {                                  // write rows, store columns
  const e = new Array(16).fill(0);
  rows.forEach((r, row) => r.forEach((v, col) => { e[col * 4 + row] = v; }));
  return e;
};

test("groundHomography deletes the HEIGHT column and keeps the x, y, w rows", () => {
  // An identity PV maps world (sx, h, sy, 1) → clip (sx, h, sy, 1), so its clip y IS the height. Dropping
  // the height column therefore leaves a ground map whose y row is all zeros — which is the point: on the
  // ground plane, height contributes nothing, so it is removed from the arithmetic rather than passed as 0.
  const ident = M([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]);
  assert.deepEqual(groundHomography(ident), [1, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test("applyH folds clip → NDC → screen, flipping y so north is at the top", () => {
  // A camera looking straight DOWN: world +X → clip x, world +Z (SOUTH, since source y grows southward) →
  // clip -y, so that after applyH's flip it comes out screen-down. This is the arrangement terrain3d's
  // camera produces via `up = -Z`, reduced to its essentials.
  const H = groundHomography(M([1, 0, 0, 0], [0, 0, -1, 0], [0, 0, 0, 0], [0, 0, 0, 1]));
  const W = 1600, Hh = 900;
  assert.deepEqual(applyH(H, 0, 0, W, Hh), [800, 450], "the origin lands at the viewport centre");
  assert.deepEqual(applyH(H, -1, -1, W, Hh), [0, 0], "north-west is TOP-left");
  assert.deepEqual(applyH(H, 1, 1, W, Hh), [1600, 900], "south-east is bottom-right");
  assert.deepEqual(applyH(H, 0, -1, W, Hh), [800, 0], "due north is straight up the screen");
});

test("applyH pushes points behind the camera off-screen instead of wrapping them", () => {
  // w row = -1, so every point has W < 0: geometry behind the viewer. Projecting it naively would place it
  // mirrored through the centre, i.e. plausibly ON SCREEN, and a layer would draw it.
  const H = [1, 0, 0, 0, 1, 0, 0, 0, -1];
  const [x, y] = applyH(H, 0.5, 0.5, 1600, 900);
  assert.ok(x < -1e6 && y < -1e6, `expected far off-screen, got ${x},${y}`);
});

test("invertH round-trips a real perspective-style homography", () => {
  // a homography with genuine perspective: the w row depends on sy, so scale falls off with distance —
  // exactly the structure a tilted camera produces
  const H = [1.4, 0.1, -20, 0.05, 1.1, 8, 0.0004, 0.0011, 1];
  const Hi = invertH(H);
  assert.ok(Hi, "should be invertible");
  const W = 1400, Hh = 900;
  for (const [sx, sy] of [[0, 0], [120, -300], [-900, 450], [2000, 1700]]) {
    const [mx, my] = applyH(H, sx, sy, W, Hh);
    const [rx, ry] = unapplyH(Hi, mx, my, W, Hh);
    assert.ok(Math.abs(rx - sx) < 1e-6 && Math.abs(ry - sy) < 1e-6,
      `round trip ${sx},${sy} → ${mx},${my} → ${rx},${ry}`);
  }
});

test("invertH reports a singular homography rather than returning garbage", () => {
  assert.equal(invertH([1, 2, 3, 2, 4, 6, 1, 1, 1]), null, "rank-deficient (row 2 = 2× row 1)");
  assert.equal(invertH([0, 0, 0, 0, 0, 0, 0, 0, 0]), null);
});

test("a perspective ground homography foreshortens with distance", () => {
  // the property that distinguishes the tilt from a shear: equal steps in source space do NOT map to equal
  // steps on screen once the w row varies
  const H = [1, 0, 0, 0, 1, 0, 0, 0.001, 1];
  const near = applyH(H, 0, 0, 1400, 900), mid = applyH(H, 0, 400, 1400, 900), far = applyH(H, 0, 800, 1400, 900);
  const d1 = Math.abs(mid[1] - near[1]), d2 = Math.abs(far[1] - mid[1]);
  assert.ok(d2 < d1, `the far step (${d2.toFixed(1)}px) must be smaller than the near one (${d1.toFixed(1)}px)`);
});

// ---- tiltAt ----
import { tiltAt, TILT_MAX, TILT_IN, TILT_FULL } from "./band-math.mjs";

test("tiltAt holds flat below the 3D band and maxes out inside Ground", () => {
  assert.equal(tiltAt(0), 0, "Atlas is straight down");
  assert.equal(tiltAt(4.99), 0);
  assert.equal(tiltAt(TILT_IN), 0, "at the seam the camera is still exactly overhead");
  assert.equal(tiltAt(TILT_FULL), TILT_MAX);
  assert.equal(tiltAt(9), TILT_MAX, "and stays there to the zoom cap");
});

test("tiltAt is monotonic and eased at both ends", () => {
  let prev = -1;
  for (let b = 4.5; b <= 7; b += 0.05) { const t = tiltAt(b); assert.ok(t >= prev - 1e-12, `monotonic at ${b}`); prev = t; }
  // the eased entry is what keeps the 2D layers from jumping as they hand over to the projected path:
  // just past the seam the pitch must still be a small fraction of a degree
  assert.ok(tiltAt(TILT_IN + 0.05) < 0.2, `entry too abrupt: ${tiltAt(TILT_IN + 0.05)}°`);
  assert.ok(TILT_MAX - tiltAt(TILT_FULL - 0.05) < 0.2, `exit too abrupt: ${tiltAt(TILT_FULL - 0.05)}°`);
  assert.ok(Math.abs(tiltAt((TILT_IN + TILT_FULL) / 2) - TILT_MAX / 2) < 1e-9, "half way through is half tilted");
});

// ---- heightScaleAt ----
import { heightScaleAt } from "./band-math.mjs";

test("heightScaleAt is 1 where the height model was tuned, and eases off going deeper", () => {
  assert.equal(heightScaleAt(TILT_IN), 1, "band 5 is the spike's own scale");
  assert.equal(heightScaleAt(3), 1, "clamped above — nothing below band 5 renders in 3D anyway");
  assert.ok(Math.abs(heightScaleAt(7) - 0.5) < 1e-9, "two bands deeper, half the exaggeration");
  assert.ok(heightScaleAt(6) < 1 && heightScaleAt(6) > 0.5, "one band deeper, in between");
});

test("heightScaleAt still grows a landform on approach, just slower than the zoom", () => {
  // The property that makes descending feel like descending: a peak's SCREEN height must keep increasing
  // with zoom, or the terrain would appear to flatten as you close in. Screen height ∝ 2^b · scale(b), and
  // halving every two bands leaves a net 2^(b/2).
  const screenH = b => Math.pow(2, b) * heightScaleAt(b);
  for (let b = 5; b < 8; b += 0.25)
    assert.ok(screenH(b + 0.25) > screenH(b), `a peak must still grow between bands ${b} and ${b + 0.25}`);
});

test("heightScaleAt keeps real relief at the deepest zoom", () => {
  assert.ok(heightScaleAt(9) >= 0.3, "clamped — the deep end must not flatten back into a map");
  assert.equal(heightScaleAt(1e6), 0.3, "and the clamp holds however far the cap moves");
});
