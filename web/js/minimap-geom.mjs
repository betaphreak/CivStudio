"use strict";
// The minimap's VIEWPORT SHAPE — pure, and therefore testable (minimap-geom.test.mjs). Same split
// as band-math.mjs / bands.mjs: the arithmetic takes its inputs as arguments and imports nothing,
// while minimap.mjs reads the camera and paints.
//
// The thumbnail is always NORTH-UP: it is a picture of the world raster, and rotating that would
// make the one stable reference on screen move. The camera, from band 5 up, is not — terrain3d
// yaws it clockwise as it pitches (docs/terrain-3d.md §The camera's yaw), so the slice of world on
// screen stops being an axis-aligned box. Drawing that slice as an upright rectangle told the
// viewer the map was facing north when it was facing north-west.
//
// So the marker becomes a QUAD: the same box, turned to match where the camera is actually looking.

/**
 * The four corners of the camera's footprint, in the same units as `box`.
 *
 * The screen's own axes, expressed on a north-up map: with the camera yawed `yawDeg` clockwise,
 * terrain3d puts screen-up along ground (−sin ψ, −cos ψ) and screen-right along (cos ψ, −sin ψ)
 * — at ψ = 0 that is (0, −1) and (1, 0), i.e. up is up and right is right, which is why a yaw of
 * zero reproduces the plain rectangle exactly (corner-for-corner, not merely to within rounding).
 *
 * The box is NOT clamped to the map here. Clamping the extent before rotating would shorten one
 * side of the quad and skew the whole shape; the caller clips the drawn path instead.
 *
 * @param {{x: number, y: number, w: number, h: number}} box the camera's footprint as an upright box
 * @param {number} yawDeg camera yaw, degrees clockwise (0 → an upright rectangle)
 * @returns {Array<[number, number]>} the four corners, clockwise from top-left as the camera sees them
 */
export function viewportQuad(box, yawDeg) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const hw = box.w / 2, hh = box.h / 2;
  const ps = (yawDeg || 0) * Math.PI / 180, s = Math.sin(ps), c = Math.cos(ps);
  const rx = c, ry = -s;        // screen-right, on the north-up map
  const ux = -s, uy = -c;       // screen-up
  const at = (a, b) => [cx + a * hw * rx + b * hh * ux, cy + a * hw * ry + b * hh * uy];
  return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
}

/**
 * Whether the camera's footprint is small enough for the marker to mean anything. At the world view
 * the box is the whole map and the outline would trace the thumbnail's own border, which says
 * nothing — so the minimap hides instead (the caller adds its own band rule on top).
 *
 * Judged on the CLAMPED fractions: what is off the edge of the map is not something the viewer can
 * pan to, so it should not count toward "you are looking at all of it".
 *
 * @param {number} fw framed width as a fraction of the map, clamped to [0, 1]
 * @param {number} fh framed height as a fraction of the map, clamped to [0, 1]
 * @returns {boolean} whether to show the marker
 */
export const worthShowing = (fw, fh) => fw < 0.985 || fh < 0.985;
