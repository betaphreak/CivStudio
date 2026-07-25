"use strict";
// Unit tests for the Pixi camera seam (pixi-cam.mjs). Run: npm test --prefix web
//
// The point of these is the DIFFERENTIAL one: for the whole migration two renderers draw one scene,
// so `worldTransform` composed with base-space coordinates must land on exactly the pixel
// core.pxr/pyr would have produced. core.mjs cannot be imported here (it reads window.BUNDLE at
// module-eval), so the reference formulas below are transcribed from it.
//
//   ⚠ THE REFERENCE IS A COPY. If core.mjs:44-50 ever changes, these mirrors must change with it,
//   or the tests will keep passing while agreeing with the wrong thing. The un-driftable version of
//   this check runs in a real browser against the real core.mjs — tools/webverify/pixi-p1-verify.mjs
//   — and that is the authority. These tests exist to catch the arithmetic fast, on every `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { worldTransform, applyWorldTransform, mapClipRect } from "./pixi-cam.mjs";

// ---- reference implementation, transcribed from core.mjs:44-50 ----
const refBaseXr = (MAP, VIEW, sp) => VIEW.dx + (sp - MAP.x0) / (MAP.x1 - MAP.x0) * VIEW.dw;
const refBaseYr = (MAP, VIEW, sp) => VIEW.dy + (sp - MAP.y0) / (MAP.y1 - MAP.y0) * VIEW.dh;
const refPxr = (MAP, VIEW, cam, sp) => cam.x + cam.k * refBaseXr(MAP, VIEW, sp);
const refPyr = (MAP, VIEW, cam, sp) => cam.y + cam.k * refBaseYr(MAP, VIEW, sp);

// A plausible whole-world fit: the 5632x2048 province raster (MapTerrainCodec) contained in a
// 1400x900 viewport, plus a cropped realm to prove nothing assumes the full sheet.
const WORLD = { x0: 0, y0: 0, x1: 5632, y1: 2048 };
const REALM = { x0: 1120, y0: 320, x1: 3040, y1: 1400 };
function fit(MAP, w, h) {
  const cw = MAP.x1 - MAP.x0, ch = MAP.y1 - MAP.y0;
  const s = Math.min(w / cw, h / ch);
  return { w, h, dw: cw * s, dh: ch * s, dx: (w - cw * s) / 2, dy: (h - ch * s) / 2, dpr: 1 };
}

test("worldTransform composed with base space equals core.pxr/pyr", () => {
  // sampled across both crops, the full k range (1 → K_MAX 512) and off-centre pans
  for (const MAP of [WORLD, REALM]) {
    const VIEW = fit(MAP, 1400, 900);
    for (const k of [1, 1.7, 5, 16, 64, 233, 512])
      for (const [ox, oy] of [[0, 0], [-311, 97], [1420.5, -880.25]]) {
        const cam = { k, x: ox, y: oy };
        const t = worldTransform(cam);
        for (const sp of [MAP.x0, MAP.x0 + 1, (MAP.x0 + MAP.x1) / 2, MAP.x1 - 1, MAP.x1]) {
          const got = applyWorldTransform(t, refBaseXr(MAP, VIEW, sp), refBaseYr(MAP, VIEW, sp));
          assert.ok(Math.abs(got.x - refPxr(MAP, VIEW, cam, sp)) < 1e-9,
            `x disagrees at k=${k} sp=${sp}: ${got.x} vs ${refPxr(MAP, VIEW, cam, sp)}`);
          assert.ok(Math.abs(got.y - refPyr(MAP, VIEW, cam, sp)) < 1e-9,
            `y disagrees at k=${k} sp=${sp}: ${got.y} vs ${refPyr(MAP, VIEW, cam, sp)}`);
        }
      }
  }
});

test("worldTransform is a pure read of the camera — it never mutates it", () => {
  const cam = { k: 7, x: 12, y: -4 };
  const t = worldTransform(cam);
  assert.deepEqual(cam, { k: 7, x: 12, y: -4 }, "cam was written to");
  t.x = 999; t.k = 999;
  assert.deepEqual(cam, { k: 7, x: 12, y: -4 }, "the result aliases cam");
});

test("worldTransform at the identity camera leaves base space alone", () => {
  // cam.k >= 1 always (the fitView world-fit floor), so k=1/x=0/y=0 is the widest real state
  const t = worldTransform({ k: 1, x: 0, y: 0 });
  assert.deepEqual(applyWorldTransform(t, 123.5, -4), { x: 123.5, y: -4 });
});

test("mapClipRect in base space maps onto the screen rect main.paintScene computes", () => {
  // main.mjs:154-159 derives the clip in SCREEN space; as a child of `world` the mask is in base
  // space and the camera carries it. Both must describe the same rectangle.
  for (const MAP of [WORLD, REALM]) {
    const VIEW = fit(MAP, 1400, 900);
    for (const cam of [{ k: 1, x: 0, y: 0 }, { k: 12, x: -400, y: -220 }, { k: 512, x: 9e4, y: -3e4 }]) {
      const t = worldTransform(cam), r = mapClipRect(VIEW);
      const tl = applyWorldTransform(t, r.x, r.y);
      const br = applyWorldTransform(t, r.x + r.w, r.y + r.h);
      // the screen-space form, transcribed from main.paintScene
      const xLeft = cam.x + cam.k * VIEW.dx, xRight = cam.x + cam.k * (VIEW.dx + VIEW.dw);
      const yTop = cam.y + cam.k * VIEW.dy, yBot = cam.y + cam.k * (VIEW.dy + VIEW.dh);
      assert.ok(Math.abs(tl.x - Math.min(xLeft, xRight)) < 1e-9, "clip left");
      assert.ok(Math.abs(tl.y - Math.min(yTop, yBot)) < 1e-9, "clip top");
      assert.ok(Math.abs((br.x - tl.x) - Math.abs(xRight - xLeft)) < 1e-9, "clip width");
      assert.ok(Math.abs((br.y - tl.y) - Math.abs(yBot - yTop)) < 1e-9, "clip height");
    }
  }
});

test("mapClipRect is the fit rectangle, independent of the camera", () => {
  const VIEW = fit(WORLD, 1400, 900);
  assert.deepEqual(mapClipRect(VIEW), { x: VIEW.dx, y: VIEW.dy, w: VIEW.dw, h: VIEW.dh });
  // `contain` fitting letterboxes on exactly one axis (whichever the crop's aspect leaves slack on),
  // and the clip must NOT stretch into that void — keeping the letterbox unpainted is why it exists.
  // Asserted axis-agnostically: this REALM crop is WIDER than the 1400x900 viewport so it letterboxes
  // vertically, but the guarantee is about whichever axis has slack, not about a particular one.
  for (const [MAP, w, h] of [[REALM, 1400, 900], [WORLD, 900, 1400]]) {
    const v = fit(MAP, w, h), c = mapClipRect(v);
    const slackX = v.dx > 1e-9, slackY = v.dy > 1e-9;
    assert.ok(slackX || slackY, "contain fitting must letterbox on some axis");
    if (slackX) assert.ok(c.w < v.w, "clip must stay inside the horizontal letterbox");
    if (slackY) assert.ok(c.h < v.h, "clip must stay inside the vertical letterbox");
  }
});
