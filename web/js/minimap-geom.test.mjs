import test from "node:test";
import assert from "node:assert/strict";
import { viewportQuad, worthShowing } from "./minimap-geom.mjs";

const BOX = { x: 10, y: 20, w: 40, h: 30 };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test("a yaw of zero is the plain upright rectangle, corner for corner", () => {
  // the guarantee that matters below band 5: no yaw, no change to a picture that has always been
  // an axis-aligned rect — not "close enough", identical
  assert.deepEqual(viewportQuad(BOX, 0), [[10, 20], [50, 20], [50, 50], [10, 50]]);
});

test("an absent yaw is treated as zero", () => {
  assert.deepEqual(viewportQuad(BOX, undefined), viewportQuad(BOX, 0));
  assert.deepEqual(viewportQuad(BOX, NaN * 0), viewportQuad(BOX, 0));
});

test("the quad keeps its centre and its side lengths whatever the yaw", () => {
  // a rotation moves the corners and nothing else — if either of these drifts, the marker is
  // reporting a camera that has zoomed or panned when it only turned
  for (const yaw of [15, 45, 90, 180, -30]) {
    const q = viewportQuad(BOX, yaw);
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    near(cx, 30, `centre x at yaw ${yaw}`);
    near(cy, 35, `centre y at yaw ${yaw}`);
    near(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), BOX.w, `top edge at yaw ${yaw}`);
    near(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]), BOX.h, `left edge at yaw ${yaw}`);
  }
});

test("the quad stays a rectangle — adjacent edges meet at a right angle", () => {
  const q = viewportQuad(BOX, 45);
  const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
  const e2 = [q[3][0] - q[0][0], q[3][1] - q[0][1]];
  near(e1[0] * e2[0] + e1[1] * e2[1], 0, "edges are perpendicular");
});

test("a clockwise camera yaw turns the marker clockwise on a north-up map", () => {
  // terrain3d yaws the camera CLOCKWISE, so the screen's top edge swings from due north toward the
  // north-WEST. On the thumbnail (y grows southward) the top edge's midpoint must therefore move
  // left of centre while staying above it.
  const q = viewportQuad(BOX, 45);
  const topMidX = (q[0][0] + q[1][0]) / 2, topMidY = (q[0][1] + q[1][1]) / 2;
  assert.ok(topMidX < 30, "the top of the screen leans west");
  assert.ok(topMidY < 35, "…and is still the northern side");
});

test("a 90° yaw swaps the screen axes onto the map", () => {
  const q = viewportQuad(BOX, 90);
  // screen-right now points due north (up the thumbnail), so the top edge runs vertically and its
  // length is the box's WIDTH laid along the map's y axis
  near(q[1][0] - q[0][0], 0, "the top edge no longer runs east-west");
  near(Math.abs(q[1][1] - q[0][1]), BOX.w, "it runs north-south, and is still the width");
});

test("worthShowing hides the marker only when it frames essentially everything", () => {
  assert.equal(worthShowing(1, 1), false, "the whole world — the outline would be the border");
  assert.equal(worthShowing(0.99, 0.99), false, "still effectively everything");
  assert.equal(worthShowing(0.5, 1), true, "zoomed on one axis is worth marking");
  assert.equal(worthShowing(1, 0.5), true, "…and so is the other");
});
