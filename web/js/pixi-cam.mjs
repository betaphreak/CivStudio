"use strict";
// The Pixi camera seam's MATH — pure, zero-import, and therefore testable (pixi-cam.test.mjs).
//
// Same split, and the same reason, as band-math.mjs / bands.mjs: anything that imports core.mjs
// cannot load under node (core reads window.BUNDLE at module-eval), so the arithmetic takes the
// camera and viewport as ARGUMENTS and imports nothing. js/pixi.mjs keeps the thin wrapper that
// pushes the result onto the actual container.
//
// WHY THIS EXISTS AT ALL, given how small it turned out. During the migration two renderers draw
// one scene (docs/pixi-migration-plan.md), and a silent disagreement between them is the worst bug
// class available: it would not throw, it would just put things a few pixels wrong at some zooms.
// So the transform gets a NAME, a test, and a browser-side assertion against the real core.mjs
// (tools/webverify/pixi-p1-verify.mjs) rather than being three property writes buried in a paint
// function. It is also the single place an isometric Ground regime would insert its shear.
//
// THE PROJECTION, for reference (core.mjs:44-50):
//   baseXr(sp) = VIEW.dx + (sp - MAP.x0) / (MAP.x1 - MAP.x0) * VIEW.dw     ← BASE space
//   pxr(sp)    = cam.x + cam.k * baseXr(sp)                                ← SCREEN space
// The second line is affine in the first, which is exactly what a container transform is — so the
// camera stops being per-point arithmetic and becomes one matrix. That is the whole win, and the
// reason worldTransform() below is a near-identity: the codebase already had the right split, it
// just applied the camera half by hand, per drawn thing, per frame.

/**
 * The `world` container's transform for a camera state — position + uniform scale.
 *
 * Children of `world` are positioned in BASE space (baseXr/baseYr output) and this supplies the
 * camera. A child already carrying pxr/pyr would get the camera applied twice; see js/pixi.mjs's
 * header for the rule.
 *
 * @param {{x:number,y:number,k:number}} cam the live camera (core.cam)
 * @returns {{x:number,y:number,k:number}} container position and scale
 */
export function worldTransform(cam) {
  return { x: cam.x, y: cam.y, k: cam.k };
}

/**
 * Apply a worldTransform to a base-space point — the composition the tests and the browser-side
 * verifier assert against core.pxr/pyr. Not used in the render path (Pixi does this on the GPU);
 * it exists so "what the transform means" is executable rather than described.
 */
export function applyWorldTransform(t, bx, by) {
  return { x: t.x + t.k * bx, y: t.y + t.k * by };
}

/**
 * The map clip in BASE space: the imported map's own raster extent, beyond which there is no real
 * data (main.paintScene clips to it so the sea never paints the letterbox void).
 *
 * main.mjs computes this rect in SCREEN space, re-deriving `cam.x + cam.k * VIEW.dx` and friends on
 * every frame. In base space it is just the fit rectangle — and because the mask is a child of
 * `world`, the camera transform carries it for free. Same pixels, no per-frame arithmetic, and it
 * cannot drift out of step with the layers it clips.
 *
 * @param {{dx:number,dy:number,dw:number,dh:number}} VIEW the crop fit rectangle (core.VIEW)
 */
export function mapClipRect(VIEW) {
  return { x: VIEW.dx, y: VIEW.dy, w: VIEW.dw, h: VIEW.dh };
}

/**
 * A per-province offscreen's destination rectangle in BASE space — the Pixi equivalent of what
 * plotcanvas.blitProvinceCanvas computes in screen space:
 *
 *   dest = [pxr(box.x0), pyr(box.y0), pxr(box.x0+box.w) - pxr(box.x0), pyr(box.y0+box.h) - pyr(box.y0)]
 *
 * The `box` is in source-pixel plot space ({x0,y0,w,h} from plotcanvas.plotBounds), because a plot IS
 * a province land pixel on the 5632x2048 raster.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: in base space the rectangle does not mention the camera at
 * all, so a province's sprite has the SAME position and size at every zoom and pan — the transform on
 * `world` does the rest. That is the structural reason the migration is worth doing: the 2D path
 * recomputes four pxr/pyr calls per province per frame to place a blit that never actually moves
 * relative to the map.
 *
 * @param {{x0:number,y0:number,x1:number,y1:number}} MAP the crop extent in source px (core.MAP)
 * @param {{dx:number,dy:number,dw:number,dh:number}} VIEW the crop fit rectangle (core.VIEW)
 * @param {{x0:number,y0:number,w:number,h:number}} box the offscreen's plot-space box
 */
export function baseRect(MAP, VIEW, box) {
  const sx = VIEW.dw / (MAP.x1 - MAP.x0), sy = VIEW.dh / (MAP.y1 - MAP.y0);
  return {
    x: VIEW.dx + (box.x0 - MAP.x0) * sx,
    y: VIEW.dy + (box.y0 - MAP.y0) * sy,
    w: box.w * sx,
    h: box.h * sy,
  };
}
