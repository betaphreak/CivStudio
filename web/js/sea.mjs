"use strict";
// The OCEAN — the screen-space base the whole scene floats on.
//
// Why this is its own module and its own registry (SCREEN_LAYERS in layers.mjs) rather than a normal
// LAYERS entry: everything in LAYERS is drawn once per on-screen WORLD COPY, because the cylindrical
// wrap re-renders the scene per copy with a shifted camera. This is SCREEN-SPACE — it fills the
// viewport once, from the latitude at each screen row, and knows nothing about world copies. Running
// it per copy would re-fill the same pixels N times and, worse, composite the soft-light ripple N
// times over itself (each pass darkening the last). So it is drawn once per frame, ahead of the wrap
// loop, and the registry models that as a separate ordered stack instead of pretending it is a
// per-copy layer.
//
// Extracted from main.mjs, which had accumulated it as hardcoded calls inside paint() — the last
// draws in the scene that weren't in a registry. See docs/zoom-bands.md §Layer registry.
//
// REMOVED (2026-07-16): the screen-space polar ICE CAP that used to sit over this — a latitude-ramped
// Civ4 pack-ice tile across the open ocean. It was the single most expensive draw in the scene
// (~18.8 ms/frame at Atlas zoom, more than every other layer combined, and the reason world zoom ran
// ~12 fps) and it did not earn that: it read as a grey tiling expanse over the empty polar seas.
// Deleted rather than optimised. The per-plot coastal shelf floes (plots.drawSeaIce) are unaffected —
// those are driven by real FEATURE_ICE terrain data at deep zoom and are baked into the plot canvas.
import { VIEW, cam, MAP, SEA, SEA_BANDS, ctx, latAtScreenY, K_PLOT, K_TEX } from "./core.mjs";
import { bandAlpha, kBand, ground3D } from "./bands.mjs";

// A redraw request, injected by main (initSea) so this module never imports main.mjs back — the
// image loads are async and must repaint whenever they land. Same idiom as initMinimap(draw).
let redraw = () => {};

// the ocean layer, drawn behind the (transparent-sea) land raster so it shows through only the
// sea: a climate-banded COLOUR from a vertical latitude gradient (tropical → temperate → polar),
// modulated by a screen-space greyscale RIPPLE tile via `soft-light`. Either half degrades: no
// SEA_BANDS → a flat sea fill; no ripple tile → gradient only; neither → the flat void.
const seaImg = new Image();
let seaPat = null;
/** Wire the async art loads to a repaint. Called once by main; safe to call before the images land. */
export function initSea(onLoad) {
  redraw = onLoad || redraw;
  if (SEA) { seaImg.onload = () => { seaPat = ctx.createPattern(seaImg, "repeat"); redraw(); }; seaImg.src = SEA.src; }
}

// piecewise sea colour by |latitude|: tropical (≤23°) → temperate (~40°) → polar (≥60°), then a
// fade toward deep-ocean dark past 72° so the empty polar seas beyond the mapped land read as
// deep water (and the soft-light ripple stops showing its tiling on that flat grey expanse).
export function seaColorAt(lat) {
  const B = SEA_BANDS, a = Math.abs(lat);
  const mix = (u, v, f) => [u[0]+(v[0]-u[0])*f, u[1]+(v[1]-u[1])*f, u[2]+(v[2]-u[2])*f];
  let c;
  if (a <= 23) c = B.trop;
  else if (a >= 60) c = B.polar;
  else if (a <= 40) c = mix(B.trop, B.temp, (a - 23) / 17);
  else c = mix(B.temp, B.polar, (a - 40) / 20);
  if (a > 72) c = mix(c, [12, 18, 28], Math.min(1, (a - 72) / 16));
  return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`;
}
// fill the viewport with the ocean base: the latitude colour gradient, then the ripple overlay
const SEA_WAVE = 1.0;   // ripple tile size, in map-raster px per texture px (world-view wave scale)
export function drawSeaBase() {
  // From band 5 the 3D ground owns the back of the frame and draws the ocean as a plane at sea level
  // (js/terrain3d.mjs §1). This fill is viewport-wide and opaque, so leaving it on would hide the mesh
  // entirely — it is the wall of opaque full-area fills that forced Pixi's back-to-front migration.
  // Note the ripple below already fades out by K_TEX (band 4), so nothing is lost at these zooms.
  if (ground3D()) return;
  const w = VIEW.w, h = VIEW.h;
  if (SEA_BANDS) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    for (let i = 0; i <= 16; i++) g.addColorStop(i / 16, seaColorAt(latAtScreenY((i / 16) * h)));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  } else { ctx.fillStyle = "#090d14"; ctx.fillRect(0, 0, w, h); }
  // ripples (soft-light so grey=128 keeps the gradient colour). The pattern is ANCHORED to the
  // map — it pans and scales with the world instead of being a fixed screen grid — and fades out
  // by deep zoom, where the upscaled tile would blur and open water is calm anyway.
  if (seaPat) {
    const fade = 1 - bandAlpha(kBand([K_PLOT, K_TEX]));   // 1 ≤K_PLOT → 0 ≥K_TEX (fade out over the plot band)
    // confine the ripple to the mapped-latitude band (the raster's on-screen Y extent). Beyond it —
    // the empty polar seas between the map's top/bottom edge and the ±89° scene clip — the tile would
    // repeat as a visible static grid, so those bands stay flat gradient instead.
    const my0 = Math.max(0, cam.y + cam.k * VIEW.dy), my1 = Math.min(h, cam.y + cam.k * (VIEW.dy + VIEW.dh));
    if (fade > 0.02 && my1 > my0) {
      const s = cam.k * (VIEW.dw / MAP.dw) * SEA_WAVE;              // map px → screen, so it zooms with the map
      seaPat.setTransform(new DOMMatrix([s, 0, 0, s, cam.x + cam.k * VIEW.dx, cam.y + cam.k * VIEW.dy]));
      ctx.save();
      ctx.globalCompositeOperation = "soft-light"; ctx.globalAlpha = fade;
      ctx.fillStyle = seaPat; ctx.fillRect(0, my0, w, my1 - my0);
      ctx.restore();
    }
  }
}
