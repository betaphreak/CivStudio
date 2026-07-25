"use strict";
// The plot layer on Pixi — P2 of docs/pixi-migration-plan.md, and the migration's GO/NO-GO.
//
// FLAG-GATED, DEFAULT OFF (`?pixiPlots=1`). Two reasons, and the first is a plan correction worth
// reading before P3:
//
//   1. ORDER. #gl composites BENEATH #map, so every layer still on the 2D canvas draws ABOVE every
//      migrated one. Layers therefore have to migrate in BACK-TO-FRONT order, and `plots` is entry 3
//      in layers.LAYERS — behind it sit `raster`, `lakes` and `seaCells`, plus the screen-space sea
//      base and the realm fog-under. Migrating `plots` alone puts it under an opaque land raster,
//      which hides it completely. The plan had P2 (plots) before P4 (the static geographic layers);
//      that ordering is wrong for a below-canvas strangler and P3/P4 need to swap.
//   2. So P2 is a MEASUREMENT, not a shipment. The flag lets the fps delta be measured on the real
//      map at real zoom (tools/webverify/pixi-p2-verify.mjs) without putting a broken layer order on
//      prod — which web/ would auto-deploy on push.
//
// Under the flag, main.drawRaster stands down where the plot layer fully covers it (alpha 1), so the
// flagged view is coherent enough to screenshot. That suppression is flag-only scaffolding and dies
// with the flag once the back prefix has migrated.
//
// WHAT IS ACTUALLY DIFFERENT HERE, and why it should be faster: the 2D path calls pxr/pyr four times
// per province per frame to place a blit that never moves relative to the map, then issues a
// drawImage per province. This places each province's sprite in BASE space — where the rectangle
// contains no camera term at all (pixi-cam.baseRect) — and lets one container transform and one
// batched GPU pass do the rest. The province offscreens themselves are shared verbatim with the 2D
// path (plotcanvas.provinceTexture), so nothing about the expensive rasterisation changes.
import { MAP, VIEW } from "./core.mjs";
import { world } from "./pixi.mjs";
import { baseRect } from "./pixi-cam.mjs";
import { provinceTexture } from "./plotcanvas.mjs";
import { Container, Sprite } from "./vendor/pixi.min.mjs";

// ---- the flag ----
// Read once at module eval: this is a spike switch, not a runtime toggle, and re-reading it per frame
// would invite half-migrated frames.
const ENABLED = (() => {
  try { return /^(1|on|true|yes)$/i.test(new URLSearchParams(location.search).get("pixiPlots") || ""); }
  catch (e) { return false; }
})();

/** Is the Pixi plot layer driving? When false nothing in this module runs and the 2D path is intact. */
export const pixiPlotsEnabled = () => ENABLED;

/**
 * Does Pixi own the BACK of the scene? Same flag, different question — and the one that matters for
 * whether anything on #gl is visible at all.
 *
 * P2's discovery: the back of the 2D frame is a stack of OPAQUE FULL-AREA FILLS — the `#070a10` void
 * fill, then sea.drawSeaBase (fills the viewport from the latitude at each screen row), then
 * drawRealmFogUnder (parchment over the whole map region), then the land raster. #gl composites
 * BENEATH #map, so every one of them occludes it completely. The plot sprites were placed exactly
 * right and rendered a perfectly good frame that was 100% hidden; only a framebuffer read-back
 * proved it was there (tools/webverify/pixi-p2-diag.mjs).
 *
 * So a below-canvas strangler cannot show ANY migrated layer until that whole prefix has moved. Under
 * the flag those four fills stand down (main.paintScene / main.drawRaster) so the flagged view can be
 * looked at — which means no ocean and no fog under the flag, deliberately. This predicate and its
 * suppressions are scaffolding: they die when P3 migrates the prefix for real.
 */
export const pixiOwnsBackground = () => ENABLED;

const plots = new Container();
plots.label = "plots";
if (ENABLED) world.addChild(plots);

// province object → its Sprite. Keyed on the province itself (stable object identity, no id needed).
// Sprites are POOLED, never destroyed: provinces cross the viewport edge constantly during a pan, and
// churning textures/sprites there would trade the win away. An off-screen sprite costs one
// `visible = false`.
const sprites = new Map();
let seen = new Set();

/**
 * Begin a frame. `alpha` is the plot layer's band fade — the same value the 2D path puts in
 * ctx.globalAlpha, applied here as container alpha (Pixi applies it per child at render, so it
 * composites the same way a per-blit globalAlpha does, including where padded province boxes overlap).
 */
export function beginPlots(alpha) {
  plots.alpha = alpha;
  plots.visible = alpha > 0;
  seen = new Set();
}

/**
 * Place one province's offscreen. Called from plots.drawPlots in place of blitProvinceCanvas, with
 * whichever canvas that frame chose (flat or textured) and its matching box.
 *
 * The rect is recomputed every frame even though it is camera-independent, because the BOX can change
 * under it: the textured build pads by 2 cells (buildPlotTexCanvas PAD), so a province swapping
 * flat→textured changes size. Six arithmetic ops and four property writes per visible province is far
 * below the four pxr/pyr calls plus a drawImage it replaces, and it cannot go stale.
 */
export function placePlot(p, canvas, box, smooth) {
  let s = sprites.get(p);
  if (!s) { s = new Sprite(); s.label = "plot"; sprites.set(p, s); plots.addChild(s); }
  const tex = provinceTexture(canvas, smooth);
  if (s.texture !== tex) s.texture = tex;      // width/height below must be set AFTER the texture
  const r = baseRect(MAP, VIEW, box);
  s.position.set(r.x, r.y);
  s.width = r.w; s.height = r.h;
  s.visible = true;
  seen.add(p);
}

/** End a frame: hide the sprites of provinces that fell out of view (pooled, not destroyed). */
export function endPlots() {
  for (const [p, s] of sprites) if (!seen.has(p)) s.visible = false;
}

/** Live sprite counts, for the P2 verifier and a future diag readout — a leak here is otherwise
 *  invisible until it is a memory problem (docs/pixi-migration-plan.md P5). */
export function plotStats() {
  let visible = 0;
  for (const s of sprites.values()) if (s.visible) visible++;
  return { pooled: sprites.size, visible, containerChildren: plots.children.length };
}

/** Drop every sprite — a realm switch reloads the page today, so this exists for the plane toggle
 *  and for tests that need a clean slate rather than for the running app. */
export function resetPlots() {
  for (const s of sprites.values()) { s.parent?.removeChild(s); s.destroy(); }
  sprites.clear(); seen = new Set();
}
