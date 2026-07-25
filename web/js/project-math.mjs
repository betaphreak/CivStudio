"use strict";
// The PROJECTION seam's math — pure, zero-import, and therefore testable (project-math.test.mjs).
//
// A PROJECTOR maps the map's SOURCE-PIXEL space — the coordinates every province ring, every plot and
// every bbox is stored in — to screen space. Today's is the 2D camera's, and it has two properties the
// whole frontend leans on without saying so:
//
//   AFFINE     — a straight line in source space is a straight line on screen, so a province ring can
//                be a Path2D of projected vertices and a province offscreen can be one drawImage.
//   SEPARABLE  — screen x depends on the source x ALONE and screen y on the source y alone. This is
//                the only reason core.pxr/pyr can exist as two ONE-ARGUMENT functions.
//
// A 3D camera's projection is neither (docs/terrain-3d.md): once the camera tilts, a point's screen
// position depends on its source x, its source y AND its ground height jointly. So the seam's real
// signature is the joint project(sx, sy, h) that core.mjs exposes, and pxr/pyr survive only as a fast
// path that a projector opts into by declaring `separable`.
//
// What lives here is the arithmetic that has no business being written twice: the INVERSE of the 2D
// camera's 1-D affine map (hand-rolled in two places before this — hittest.plotAt and
// core.latAtScreenY — and untested in both), and the general scale probe that replaces the
// `pxr(1) - pxr(0)` idiom once a projector stops being separable. The forward map stays in core.mjs
// with baseXr/baseYr, which are exported and used directly by callers; splitting only the inverse out
// keeps one copy of each formula rather than two copies of both.

/**
 * Invert one axis of the 2D camera's affine map for the source coordinate.
 *
 * The forward map that core.mjs applies on each axis is
 *
 *     screen = camv + k * (d0 + (sp - s0) / (s1 - s0) * dd)
 *              └─ camera ─┘   └──────── baseXr / baseYr ────────┘
 *
 * where (d0, dd) is the crop's fit rectangle on that axis (VIEW.dx/dw or VIEW.dy/dh) and (s0, s1) the
 * crop's extent in source pixels (MAP.x0/x1 or MAP.y0/y1). This returns `sp`.
 *
 * The round trip is exact only to floating-point round-off (it divides by k and dd and multiplies
 * back) — around 1e-13 source pixels, i.e. nothing. What IS bit-exact, and deliberately so, is the
 * agreement with the hand-rolled inverse this replaced: the operation order below matches
 * latAtScreenY's original expression term for term, so swapping it in changes no pixel. That mattered
 * because its output feeds a Mercator log/atan that colours the ocean by climate band, where a
 * last-bit wobble can show up as a seam.
 */
export const invAffine1 = (screen, camv, k, d0, dd, s0, s1) =>
  s0 + ((screen - camv) / k - d0) / dd * (s1 - s0);

/**
 * Screen pixels per source pixel AT a source-space point — what the `pxr(1) - pxr(0)` scale probes in
 * the layer code actually mean when they say "one plot's on-screen size" (a plot IS one source pixel;
 * see plotcanvas.blitProvinceCanvas, which blits a province's offscreen straight through pxr/pyr).
 *
 * Written as a LOCAL measurement because that is what survives a tilt. Under the 2D camera the answer
 * is the same everywhere and isotropic — fitView takes `s = min(w/cw, h/ch)` and scales both axes by
 * it, so VIEW.dw/(x1-x0) === VIEW.dh/(y1-y0) — which is why one scalar has been enough. Under a
 * perspective camera the near edge of the map is larger than the far edge, so the answer becomes a
 * function of position, and a caller that probed at the origin would size every icon on screen from
 * whatever the origin happened to be.
 *
 * Takes the projector's joint `project` rather than importing one, which is what keeps this pure.
 */
export function scaleAt(project, sx, sy) {
  const o = project(sx, sy, 0), e = project(sx + 1, sy, 0);
  return Math.hypot(e[0] - o[0], e[1] - o[1]);
}
