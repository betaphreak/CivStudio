"use strict";
// Route draw layer — the trail/road/rail network as vector RIBBONS (docs/route-rendering.md).
// For each routed plot it strokes a half-segment toward every same-tier orthogonal neighbour, so the
// network is continuous by construction: neighbouring plots each draw their half and the two meet at
// the shared edge. The pure geometry is route-ribbon.mjs; this file is the drawing.
//
// It used to stamp baked Civ4 connection sprites, auto-tiled per plot (route-tiling.mjs + three
// committed WebP atlases, all now deleted). Two reasons that had to go, and only the second is about
// looks:
//   1. A stamped square cell only meets its neighbour while a plot is an axis-aligned square on
//      screen. Under the tilted camera a plot is a trapezoid, so the tiles came apart at exactly the
//      joins they existed to make.
//   2. The atlases came out of nifbake's TOP-DOWN projection, the one path in that renderer that was
//      not a camera view of the model, and deleting it was the point (docs/terrain-3d.md §P5).
// Ribbons need no art, drape on the terrain for free (every vertex goes through projectOn, which
// sits it at its own height), and read at any tilt.
//
// Data source: the engine's per-plot RouteType maps to a tier via ROUTE_BY_TYPE. In Live mode the
// standing route layer is fetched per province from the viewport-windowed feed (routefetch.mjs →
// route-index.mjs), so a late-joining or reloading client sees the whole network. Off Live (WorldMap),
// or before a province's layer loads, city-core plots — which the engine founds on a TRAIL
// (ProvincePlotPool) and which the plot grid flags `urban` — stand in as the trail tier, so a trailed
// city core is visible on zoom-in with no session. docs/route-rendering.md §Viewport-windowed route
// persistence.
import { P, ctx, plotPxAt, provOnScreen, isPolitical, projectOn } from "./core.mjs";
import { bandAlpha } from "./bands.mjs";
import { spokes, TIER, strokeWidth, isIsolated } from "./route-ribbon.mjs";
import { routeType, routeVersion } from "./route-index.mjs";
import { ensureProvinceRoutes } from "./routefetch.mjs";

// ROUTE_* engine type → ribbon tier. This used to ride the baked bundle's `byType`; the bundle no
// longer ships route art, so the mapping lives here — it is a property of the ENGINE's route ladder
// (docs/route-rendering.md, geo.RouteType), not of any atlas.
const ROUTE_BY_TYPE = {
  ROUTE_TRAIL: "trail", ROUTE_DIRT_ROAD: "trail", ROUTE_GRAVEL_ROAD: "road",
  ROUTE_ROAD: "road", ROUTE_PAVED_ROAD: "road", ROUTE_HIGHWAY: "road",
  ROUTE_RAILROAD: "rail", ROUTE_MAGLEV: "rail",
};

/** The route tier a plot draws in, or null. Prefers the live per-plot RouteType from the global
 *  route-index (the trails bands pioneered + trailed cores the feed serves), then any static
 *  `q.route`, then treats urban city-core plots as a trail (the stand-in before the layer loads /
 *  off Live) — a city earns its paved roads by building them. */
function plotTier(q) {
  const live = routeType(q.x, q.y);
  if (live && ROUTE_BY_TYPE[live]) return ROUTE_BY_TYPE[live];
  if (q.route && ROUTE_BY_TYPE[q.route]) return ROUTE_BY_TYPE[q.route];
  if (q.urban) return "trail";
  return null;
}

// A province's ribbon spokes — {x, y, tier, spokes} per routed plot — computed once and cached on the
// province. The connectivity depends only on the plots and the route field, NEITHER of which changes
// per frame, so recomputing it every paint would be pure waste. Invalidated by the field version and
// by the plots array identity (a province's plots arrive asynchronously).
function routeRibbons(p) {
  const v = routeVersion();
  if (p._ribbons && p._ribbonsV === v && p._ribbonsP === p._plots)
    return p._ribbons;
  const routed = new Map();
  for (const q of p._plots) { const t = plotTier(q); if (t) routed.set(q.x + "," + q.y, t); }
  const out = [];
  for (const q of p._plots) {
    const tier = routed.get(q.x + "," + q.y);
    if (!tier) continue;
    // connect only to same-tier neighbours (a trail doesn't fuse into a paved road). A neighbour
    // counts if this province's own map has it (covers the urban stand-in, which the global index
    // may not) OR the GLOBAL route-index does (a plot in the NEXT province, so roads meet across the
    // seam — the cross-province connectivity, like rivers). docs/route-rendering.md.
    out.push({ x: q.x, y: q.y, tier, spokes: spokes((dx, dy) =>
      routed.get((q.x + dx) + "," + (q.y + dy)) === tier
      || ROUTE_BY_TYPE[routeType(q.x + dx, q.y + dy)] === tier) });
  }
  p._ribbons = out; p._ribbonsV = v; p._ribbonsP = p._plots;
  return out;
}

/** Stroke one plot's spokes: centre → the shared edge, for each connected neighbour. */
function strokePlot(t, plotPx) {
  const [cx, cy] = projectOn(t.x + 0.5, t.y + 0.5);       // the plot's centre, at its own height
  if (isIsolated(t.spokes)) {                             // a lone routed plot: a dot, not a stub
    ctx.beginPath();
    ctx.arc(cx, cy, strokeWidth(t.tier, plotPx) * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = TIER[t.tier].color;
    ctx.fill();
    return;
  }
  ctx.beginPath();
  for (const [dx, dy] of t.spokes) {
    // the EDGE midpoint, projected in its own right rather than interpolated on screen — under the
    // tilted camera the halfway point of a plot is not the halfway point of its projection, and
    // interpolating there is what would put a kink in every join
    const [ex, ey] = projectOn(t.x + 0.5 + dx * 0.5, t.y + 0.5 + dy * 0.5);
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
  }
  ctx.stroke();
}

/** Draw the route network over the routed plots of every on-screen province. */
export function drawRoutes() {
  if (isPolitical()) return;
  const a = bandAlpha([3.5, 4.5]);   // fade in Province→Terrain, then hold — per-plot ground detail
  if (a <= 0.01) return;
  ctx.save();
  ctx.lineCap = "round";             // a rounded cap is what makes two halves meet as one ribbon
  ctx.lineJoin = "round";
  for (const p of P) {
    if (!provOnScreen(p)) continue;
    // we are zoomed into the route band and this province is in view — make sure its live route layer
    // is fetched (a no-op off Live, when loaded, or while pending). Bounds fetching to the viewport.
    ensureProvinceRoutes(p);
    if (!p._plots || !p._plots.length) continue;
    for (const t of routeRibbons(p)) {
      // the plot's own on-screen size: under the tilted camera the scale is a function of position,
      // so the argument-less plotPxAt() would size every ribbon by the map's far corner
      const plotPx = plotPxAt(t.x, t.y);
      if (!(plotPx > 0.5)) continue;
      const style = TIER[t.tier];
      ctx.globalAlpha = a * style.alpha;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = strokeWidth(t.tier, plotPx);
      strokePlot(t, plotPx);
    }
  }
  ctx.restore();
}
