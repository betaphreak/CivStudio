"use strict";
// Per-province offscreen primitives, shared by every layer that rasterises a plot grid: the terrain
// ground (plots.mjs), the movement-cost heat (cost.mjs), and anything later that needs the same
// 1px/plot → screen mapping. Split out of plots.mjs so those layers don't have to import each other.
import { ctx, pxr, pyr } from "./core.mjs";
import { draw } from "./repaint.mjs";

// Load a baked art image once: on load run `onReady` (flip its ready flag / invalidate caches) and
// repaint. Returns the Image, or null when the asset is absent from the bundle (LFS not pulled /
// file:// build) so each caller keeps its procedural fallback.
export function loadArt(asset, onReady) {
  if (!asset) return null;
  const img = new Image();
  img.onload = () => { onReady(); draw(); };
  img.src = asset.src;
  return img;
}

// min/max plot coords of a province's grid plus the derived offscreen size (one pixel per plot).
// Shared by every per-province offscreen builder.
export function plotBounds(plots) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const q of plots) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// rasterise a province's plots to a 1px/plot offscreen: `perPlot(q, d, o)` writes plot `q`'s RGBA at
// byte offset `o` into the pixel buffer `d` (cells with no plot stay transparent). Returns
// {canvas, box:{x0,y0,w,h}} — the box maps the offscreen back to source-pixel plot space for blitting.
export function buildPixelCanvas(plots, perPlot) {
  const { x0, y0, w, h } = plotBounds(plots);
  const oc = document.createElement("canvas"); oc.width = w; oc.height = h;
  const octx = oc.getContext("2d"), im = octx.createImageData(w, h), d = im.data;
  for (const q of plots) perPlot(q, d, ((q.y - y0) * w + (q.x - x0)) * 4);
  octx.putImageData(im, 0, 0);
  return { canvas: oc, box: { x0, y0, w, h } };
}

// blit a province offscreen (built in source-pixel plot space, box = {x0,y0,w,h}) to the screen at
// the current camera — the scaled drawImage keeps hover/pan redraws to one call per province.
export function blitProvinceCanvas(canvas, box) {
  const dX = pxr(box.x0), dY = pyr(box.y0);
  ctx.drawImage(canvas, dX, dY, pxr(box.x0 + box.w) - dX, pyr(box.y0 + box.h) - dY);
}
