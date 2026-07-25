"use strict";
// A subtle city marker over each urban core plot. This is the INTERIM treatment: the old urban
// visuals — the synthetic grey-concrete ground tile, the Civ4 med_europe city sprite, and the
// procedural roof-lot footprints that used to live here — were all pulled pending proper Civ6
// district tiles (docs/urban-plots.md, docs/civ6-art-replacement.md). Urban plots now render as
// their surrounding countryside (re-terrained in plots.mjs markUrbanPlots); this layer just draws
// a small, muted pip so a city site is still locatable on the map.
//
// Real data only: markUrbanPlots flags each city-core plot `urban`; we draw one marker per flagged
// plot. No new server data — these are the plots drawPlots already streams.
import { P, ctx, plotPxAt, provOnScreen, isPolitical, projectOn } from "./core.mjs";
import { bandAlpha } from "./bands.mjs";

// one small settlement pip centred on an urban plot: a soft stone disc with a thin keyline and a
// faint highlight — reads as a marker, not a texture. Sized to a fraction of a plot but clamped so
// it stays a discreet dot across zoom.
function drawMarker(cx, cy, plotPx) {
  const r = Math.max(2.5, Math.min(plotPx * 0.22, 9));
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(74,60,46,0.72)";                 // muted stone/umber
  ctx.fill();
  ctx.lineWidth = Math.max(0.75, r * 0.18);
  ctx.strokeStyle = "rgba(238,232,222,0.75)";            // pale keyline so it reads on any ground
  ctx.stroke();
  ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(250,246,238,0.55)";              // faint top-left highlight
  ctx.fill();
}

// the city-CENTRE plot of a province: the urban plot nearest the urban centroid — the one exact
// plot a city sits on. Cached on the province (urban plots are generation-fixed). Null if no urban
// core. This replaces the old one-pip-per-urban-plot field, which read as noise, not a place.
function cityCenter(p) {
  if (p._cityCenter !== undefined) return p._cityCenter;
  let sx = 0, sy = 0, n = 0;
  for (const q of p._plots) if (q.urban) { sx += q.x; sy += q.y; n++; }
  if (!n) return (p._cityCenter = null);
  const mx = sx / n, my = sy / n;
  let best = Infinity, cx = 0, cy = 0;
  for (const q of p._plots) if (q.urban) {
    const d = (q.x - mx) * (q.x - mx) + (q.y - my) * (q.y - my);
    if (d < best) { best = d; cx = q.x; cy = q.y; }
  }
  return (p._cityCenter = [cx, cy]);
}

/** One subtle marker per city, on its centre plot — fades in once you're reading a region's terrain. */
export function drawCity() {
  const a = bandAlpha([3.5, 4.5]);   // fade in through Province→Terrain, then hold (locatable in-region)
  if (a <= 0.01 || isPolitical()) return;
  const plotPx = plotPxAt();
  ctx.save();
  ctx.globalAlpha = a;
  for (const p of P) {
    if (!p._plots || !p._plots.length || !provOnScreen(p)) continue;
    const c = cityCenter(p);
    if (c) drawMarker(...projectOn(c[0] + 0.5, c[1] + 0.5), plotPx);   // the plot CENTRE, on the terrain
  }
  ctx.restore();
}
