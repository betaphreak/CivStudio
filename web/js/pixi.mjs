"use strict";
// The PixiJS renderer seam — P0 of docs/pixi-migration-plan.md.
//
// WHAT THIS IS. A second canvas (#gl) sitting BENEATH the existing 2D canvas (#map), owning a Pixi
// v8 renderer and the three root containers the scene will migrate into, one layer at a time. As of
// P0 it draws NOTHING: the containers are empty and the canvas is transparent, so the page looks
// and performs exactly as it did. The point of the phase is that the renderer boots cleanly on both
// backends and the resize path is shared — not that anything appears.
//
// WHY THREE ROOTS, not one. They mirror the order main.paintScene() already paints in:
//   screenBelow  the screen-space stack UNDER the world — layers.SCREEN_LAYERS (sea base). Today
//                that rule is enforced by a 10-line comment in layers.mjs ("must NOT run per world
//                copy"); here it is structural, because screenBelow is not a child of `world` and so
//                the camera transform cannot reach it.
//   world        everything the camera moves — LAYERS. P1 puts cam on this container's transform.
//   screenAbove  the screen-space stack OVER the world — the realm-fog void hatch, the minimap.
// Back-to-front, which is addChild order, which is why they are added in exactly that sequence.
//
// THE ONE RULE THE MIGRATION RESTS ON. Everything added under `world` is positioned in BASE space —
// core.baseXr/baseYr output, the unzoomed crop-fit coordinates — and NEVER in screen space
// (core.pxr/pyr). The camera is the container transform (P1, js/pixi-cam.mjs); a sprite that has
// already had cam applied to it would get it applied twice. If you find yourself reaching for px()
// or py() while adding something to `world`, that is the bug.
//
// ASYNC INIT. Pixi v8 replaced the v7 constructor with `await app.init(...)`, but the app boots
// synchronously through app.js's import chain. So: the containers are constructed eagerly (a
// Container needs no renderer) and handed out immediately, while the renderer is attached to them
// when init resolves. Callers get stable references from module eval; nothing has to await.
//
// The vendored bundle is js/vendor/pixi.min.mjs (pinned; see web/README.md for the re-vendor
// recipe). There is no bundler — the site still ships raw .mjs, which is why this imports a file
// rather than a package name.
import { Application, Container, Graphics } from "./vendor/pixi.min.mjs";
import { worldTransform, mapClipRect } from "./pixi-cam.mjs";

// The three scene roots, live from module eval so importers never deal with a null. Empty of
// migrated layers until P2 — `world` does carry the clip mask below, which is not a layer.
export const screenBelow = new Container();
export const world = new Container();
export const screenAbove = new Container();
screenBelow.label = "screenBelow"; world.label = "world"; screenAbove.label = "screenAbove";

// The map clip (P1): the imported map's raster extent, beyond which there is no real data. A child
// of `world`, so its geometry is in BASE space and the camera transform carries it — where
// main.paintScene re-derives the same rectangle in screen space every frame. Being a mask it is
// never itself drawn; being a child it cannot fall out of step with the layers it clips.
const mapClip = new Graphics();
mapClip.label = "mapClip";
world.addChild(mapClip);
world.mask = mapClip;
let clipFor = "";   // the VIEW rect the mask geometry was last built for

let app = null;                 // the Application, once init resolves
let booting = null;             // the in-flight init promise (initPixi is idempotent)
let pending = null;             // the last size asked for before the renderer existed

/** The live Application, or null before initPixi() resolves. Prefer the exported containers. */
export const pixiApp = () => app;

/** Which backend actually won — "webgpu" | "webgl" | null. Reported in the top bar by js/diag.mjs
 *  so a silent fallback to WebGL2 on a machine that should have had WebGPU is visible, not guessed. */
export const pixiBackend = () => (app ? app.renderer.type === 1 /* WEBGL */ ? "webgl" : "webgpu" : null);

/**
 * Boot the renderer onto #gl. Idempotent — returns the same promise on repeat calls, and resolves
 * to null if the canvas is absent (nothing else in the app should care yet).
 *
 * NEVER FATAL. A machine with no working WebGPU *and* no WebGL2 must still get the map: the 2D
 * canvas above is, as of P0, still drawing the entire scene. So a failure here is reported and
 * swallowed rather than thrown — and it stays that way until P7 deletes the 2D path, at which point
 * this becomes a hard requirement and the failure branch must become a real error screen.
 */
export function initPixi() {
  if (booting) return booting;
  const canvas = document.getElementById("gl");
  if (!canvas) return (booting = Promise.resolve(null));

  const a = new Application();
  booting = a.init({
    canvas,
    // TRANSPARENT, deliberately — the plan said #070a10, but a background colour here would paint a
    // dark rectangle beneath #map, and P0's whole claim is that the page is pixel-identical. The
    // clear colour becomes real at P7, when #map goes away and this canvas owns the void fill.
    backgroundAlpha: 0,
    // Size the BACKING STORE only and let styles.css keep owning the display size (canvas#gl is
    // inset:0/100%×100%, exactly like canvas#map). autoDensity would write inline px width/height
    // and fight the stylesheet; resize() below mirrors what main.resize does for the 2D canvas.
    autoDensity: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    antialias: false,           // the terrain is nearest-sampled pixel art; AA would only blur it
    preference: "webgpu",       // v8 falls back to WebGL2 on its own; pixiBackend() reports which won
    // The scene renders ON DEMAND (js/repaint.mjs owns the policy: coalesce + cap). A free-running
    // Pixi ticker would burn frames nobody asked for and muddy the fps comparison P2 is judged on.
    autoStart: false,
    sharedTicker: false,
  }).then(() => {
    app = a;
    app.stage.addChild(screenBelow, world, screenAbove);   // back-to-front, per the header
    if (pending) { resizePixi(pending.w, pending.h, pending.dpr); pending = null; }
    return app;
  }).catch(e => {
    // Report and carry on — the 2D canvas is still drawing everything (see NEVER FATAL above).
    if (window.__status) window.__status("Pixi renderer unavailable — " + (e && e.message || e), "warn");
    return null;
  });
  return booting;
}

/**
 * Track the stage size. Called from main.resize() with the same rect and dpr the 2D canvas gets, so
 * the two renderers can never disagree about how big the viewport is. Safe before init: the last
 * size asked for is replayed once the renderer exists.
 */
export function resizePixi(w, h, dpr) {
  if (!(w > 0) || !(h > 0)) return;              // same degenerate-size guard as main.resize
  if (!app) { pending = { w, h, dpr }; return; }
  app.renderer.resize(w, h, dpr);
}

/**
 * Push the camera onto `world` and keep the clip mask sized — P1 of the migration plan.
 *
 * Called from main.paintScene() with core's live `cam` and `VIEW`. They are passed IN rather than
 * imported so this module stays free of core.mjs (which reads window.BUNDLE at eval and therefore
 * cannot load outside a browser) — the same argument-passing discipline band-math.mjs uses, and what
 * lets tools/webverify/pixi-harness.mjs boot the renderer with no app at all.
 *
 * Three property writes replace the per-point `cam.x + cam.k * baseXr(sp)` the 2D path runs for
 * every drawn thing on every frame. The arithmetic itself, and its agreement with core.pxr/pyr,
 * lives in js/pixi-cam.mjs.
 */
export function syncCamera(cam, VIEW) {
  const t = worldTransform(cam);
  world.position.set(t.x, t.y);
  world.scale.set(t.k);
  // The clip is base-space, so it depends on VIEW alone — rebuild only when the fit rectangle
  // actually moves (resize / realm switch), not on every pan and zoom.
  const key = VIEW.dx + ":" + VIEW.dy + ":" + VIEW.dw + ":" + VIEW.dh;
  if (key !== clipFor) {
    const r = mapClipRect(VIEW);
    mapClip.clear().rect(r.x, r.y, r.w, r.h).fill(0xffffff);   // a mask reads coverage, not colour
    clipFor = key;
  }
}

/** Render the Pixi scene once. Called from main.paintScene(); a no-op until the renderer exists.
 *  Explicit because autoStart is off — draw() in js/repaint.mjs stays the app's only paint trigger. */
export function renderPixi() {
  if (app) app.render();
}
