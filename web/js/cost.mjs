"use strict";
// The movement-cost overlay: per-plot elevation traversal difficulty, its own toggled layer
// (layers.mjs id "cost"). Split out of plots.mjs — it shares only the offscreen primitives.
//
// Mirrors the engine's elevation-aware corridor cost (ProvincePlotPool.slopeFactor): the flat plot
// cost is scaled by Tobler's hiking function exp(3.5·(|slope+0.05|−0.05)), with slope = Δelevation·0.06,
// clamped to [~0.84, 8]. On this static map we colour each plot by the STEEPEST step touching it — the
// max |Δelevation| to a 4-neighbour, taken as a climb — i.e. the difficulty a caravan pays to cross it.
// Flat ground (factor ≈ 1) stays clear; ridges and steep faces glow amber→red, showing where corridors
// slow and bend. Constants track ProvincePlotPool exactly, so the overlay is faithful to the routing
// it explains.
import { P, K_PLOT, NB4, ctx, provSrcBox, lerp, S, provOnScreen } from "./core.mjs";
import { bandAlpha, kBand } from "./bands.mjs";
import { buildPixelCanvas, blitProvinceCanvas } from "./plotcanvas.mjs";

const COST_K = 0.06, COST_TK = 3.5, COST_OFF = 0.05, COST_CAP = 8;
function costFactor(maxDelta) {
  const s = maxDelta * COST_K;
  return Math.min(COST_CAP, Math.exp(COST_TK * (Math.abs(s + COST_OFF) - COST_OFF)));
}
// green → yellow → orange → red ramp (matches the #costKey legend gradient), keyed on a log
// scale over the factor's [1, cap] range so the mid climbs are legible, not crushed near red.
const COST_STOPS = [[0, 90, 190, 70], [0.35, 230, 210, 40], [0.65, 240, 140, 30], [1, 214, 40, 42]];
function costColor(f) {
  const t = Math.min(1, Math.max(0, Math.log(f) / Math.log(COST_CAP)));
  let i = 0; while (i < COST_STOPS.length - 2 && t > COST_STOPS[i + 1][0]) i++;
  const a = COST_STOPS[i], b = COST_STOPS[i + 1], u = (t - a[0]) / (b[0] - a[0]);
  return [lerp(a[1], b[1], u) | 0, lerp(a[2], b[2], u) | 0, lerp(a[3], b[3], u) | 0, t];
}
// rasterise a province's plots to a 1px/plot cost heat offscreen (built once, blitted scaled
// and smoothed), transparent where the ground is effectively flat so the terrain reads through.
function buildCostCanvas(p, plots) {
  const grid = new Map();
  for (const q of plots) grid.set(q.x * 1e5 + q.y, q);
  const { canvas, box } = buildPixelCanvas(plots, (q, d, o) => {
    const e = q.elevation | 0; let md = 0;
    for (const nb of NB4) { const n = grid.get((q.x + nb[0]) * 1e5 + (q.y + nb[1])); if (n) { const dd = Math.abs((n.elevation | 0) - e); if (dd > md) md = dd; } }
    const f = costFactor(md);
    if (f < 1.03) { d[o + 3] = 0; return; }                 // effectively flat → clear
    const c = costColor(f);
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = (255 * (0.12 + 0.6 * c[3])) | 0;
  });
  p._mcanvas = canvas; p._mbox = box;
}
// blit the cost overlay for the provinces in view (same cull/scale as drawPlots), when the
// toggle is on and we are zoomed into the plot layer. Drawn over the terrain, under outlines.
export function drawCostOverlay() {
  if (!S.showCost) return;
  const a = bandAlpha(kBand([K_PLOT, 6.5]));   // fade in over the plots band
  if (a <= 0) return;
  const smooth = ctx.imageSmoothingEnabled;
  ctx.globalAlpha = a; ctx.imageSmoothingEnabled = true;
  for (const p of P) {
    if (!p._plots || !p._plots.length) continue;            // unloaded (drawPlots requests it) or empty
    const bb = provSrcBox(p); if (!bb) continue;
    if (!provOnScreen(p)) continue;   // projected AABB, so the cull is right under a tilted camera too
    if (!p._mcanvas) buildCostCanvas(p, p._plots);
    blitProvinceCanvas(p._mcanvas, p._mbox);
  }
  ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = smooth;
}
