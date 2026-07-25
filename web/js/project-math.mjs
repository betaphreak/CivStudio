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

// ---- the tilted GROUND projection, as a homography (docs/terrain-3d.md §The plan → P2) ----
//
// THE OBSERVATION THE WHOLE TILT RESTS ON. A perspective camera's projection of one PLANE is a 2D
// homography — a 3×3 projective transform — not a general 3D transform. Nearly everything the 2D layers
// project lives on the ground plane: province rings, plot boxes, bounding boxes, label anchors, icons. So
// the tilt does not have to cost them a 4×4 matrix multiply and a Vector3 each; it costs 6 multiplies and a
// divide, which is the same order as the affine camera they already pay for.
//
// That is what makes the tilt affordable at all. provOnScreen alone runs ~50k times a frame (see the
// measured note in core.mjs), and it has to project FOUR corners once the projection stops being separable,
// because opposite corners no longer bound a projected rectangle. 200k full matrix transforms per frame is
// not affordable; 200k homography applications is.
//
// It also keeps the INVERSE exact and closed-form — a 3×3 inverse — so screen→ground stays a formula rather
// than becoming a raycast. Only picking the terrain SURFACE needs a ray, because that has height.

/**
 * Pull the ground-plane homography out of a camera's combined projection×view matrix.
 *
 * `e` is a column-major 4×4 (three's `Matrix4.elements`, so `e[col * 4 + row]`). Setting the height
 * component to zero deletes the matrix's second COLUMN, leaving a 4×3 map from (sx, sy, 1); of its rows only
 * x, y and w matter, giving the 3×3 below. Rows are returned flat in row-major order, which is what applyH
 * and invertH expect.
 */
export function groundHomography(e) {
  return [
    e[0], e[8], e[12],      // clip x ← (sx, sy, 1)
    e[1], e[9], e[13],      // clip y
    e[3], e[11], e[15],     // clip w
  ];
}

/**
 * Apply a homography to a source-space point and land in SCREEN pixels for a `w`×`h` viewport.
 *
 * Clip → NDC → screen is folded in here rather than left to callers: the y flip (NDC y grows up, screen y
 * grows down) is the single easiest thing to get wrong in this file, and it would present as a map that is
 * mirrored north-south — which on a fictional world is genuinely hard to notice.
 *
 * Behind the camera (W ≤ 0) the projection is meaningless; the point is pushed far off-screen instead of
 * being allowed to wrap around to a plausible-looking position, so a cull rejects it rather than a layer
 * drawing a province from behind the viewer in the middle of the frame.
 */
export function applyH(H, sx, sy, w, h) {
  const W = H[6] * sx + H[7] * sy + H[8];
  if (W <= 1e-9) return [-1e7, -1e7];
  const X = (H[0] * sx + H[1] * sy + H[2]) / W;
  const Y = (H[3] * sx + H[4] * sy + H[5]) / W;
  return [(X + 1) * 0.5 * w, (1 - Y) * 0.5 * h];
}

/** Invert a 3×3 homography (row-major, as groundHomography returns). Null if it is singular. */
export function invertH(H) {
  const [a, b, c, d, e, f, g, i, j] = H;
  const A = e * j - f * i, B = f * g - d * j, C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) return null;
  const s = 1 / det;
  return [
    A * s, (c * i - b * j) * s, (b * f - c * e) * s,
    B * s, (a * j - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * i) * s, (a * e - b * d) * s,
  ];
}

/**
 * The screen-space axis-aligned bounding box of a source-space rectangle, under any projector.
 *
 * All FOUR corners are projected. Under the separable affine camera two would do, because opposite corners
 * bound the other two; a tilted camera maps the rectangle to a TRAPEZOID whose screen extent is not
 * determined by any two of its corners, so a two-corner box can be smaller than the shape it is supposed to
 * contain — and a cull built on it drops geometry that is on screen. Conservative by construction, which is
 * what a cull needs.
 *
 * Ground-plane only, deliberately: its callers are the 2D layers, and every one of them draws something
 * ANCHORED to the ground (rings, labels, icons), so terrain height above the box is not theirs to bound.
 * The meshes' own visibility is the renderer's business, and three frustum-culls them.
 */
export function screenAABB(project, x0, y0, x1, y1) {
  const a = project(x0, y0, 0), b = project(x1, y0, 0), c = project(x1, y1, 0), d = project(x0, y1, 0);
  return {
    x0: Math.min(a[0], b[0], c[0], d[0]), x1: Math.max(a[0], b[0], c[0], d[0]),
    y0: Math.min(a[1], b[1], c[1], d[1]), y1: Math.max(a[1], b[1], c[1], d[1]),
  };
}

/** Screen pixels → the source-space point on the GROUND plane, through an inverted homography. */
export function unapplyH(Hinv, mx, my, w, h) {
  const X = mx / w * 2 - 1, Y = 1 - my / h * 2;          // screen → NDC, undoing applyH's flip
  const W = Hinv[6] * X + Hinv[7] * Y + Hinv[8];
  if (!W) return [NaN, NaN];
  return [
    (Hinv[0] * X + Hinv[1] * Y + Hinv[2]) / W,
    (Hinv[3] * X + Hinv[4] * Y + Hinv[5]) / W,
  ];
}
