import { P, BUNDLE, px, cam, VIEW, ctx, LABEL_FONT, pll, project, pllOn, ACTIVE_REALM } from "./core.mjs";
import { bandAlpha, kBand, GEO_TIER_ENV } from "./bands.mjs";

// Stellaris-style map lettering: the shared bundled geometric sans (see core.LABEL_FONT).
const LABEL_FAM = LABEL_FONT;

// EU4-style province labels: the name is laid on the polygon's own long axis (angled) and scaled
// to span it, instead of horizontal beside the centroid. Phase (a) uses a STRAIGHT baseline — the
// principal axis of the shape (PCA over its ring vertices) — which a curved medial-axis spline can
// later replace, since drawTextOnPath already walks an arbitrary polyline.

// principal-axis baseline of a province, in SOURCE-pixel space (view-independent, so cached once).
// Returns {cx,cy,ux,uy,half,thick}: the oriented centre, the unit long-axis direction, and the
// half-extents along / across it. null for a ring-less (sea/lake) province.
function labelAxis(p) {
  if (p._axis !== undefined) return p._axis;
  if (!p.rings) return (p._axis = null);
  let n = 0, cx = 0, cy = 0;
  for (const ring of p.rings) for (const pt of ring) { cx += pt[0]; cy += pt[1]; n++; }
  if (n < 3) return (p._axis = null);
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const ring of p.rings) for (const pt of ring) {
    const dx = pt[0] - cx, dy = pt[1] - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);      // principal eigenvector angle
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  let tmin = 1e9, tmax = -1e9, smin = 1e9, smax = -1e9;
  for (const ring of p.rings) for (const pt of ring) {
    const dx = pt[0] - cx, dy = pt[1] - cy;
    const t = dx * ux + dy * uy, s = dx * vx + dy * vy;
    if (t < tmin) tmin = t; if (t > tmax) tmax = t;
    if (s < smin) smin = s; if (s > smax) smax = s;
  }
  const mid = (tmin + tmax) / 2;
  return (p._axis = {
    cx: cx + mid * ux, cy: cy + mid * uy, ux, uy,
    half: (tmax - tmin) / 2, thick: (smax - smin) / 2,
  });
}

// the source-space baseline the name rides: the offline curved medial spine (p.lab, phase b) when
// present, else the straight principal axis (phase a). { pts:[[x,y],…], thick } or null.
function labelPath(p) {
  if (p.lab) return { pts: p.lab.p, thick: p.lab.t };
  const ax = labelAxis(p);
  if (!ax) return null;
  return {
    pts: [[ax.cx - ax.ux * ax.half, ax.cy - ax.uy * ax.half],
          [ax.cx + ax.ux * ax.half, ax.cy + ax.uy * ax.half]],
    thick: ax.thick,
  };
}

// Catmull-Rom subdivision, so the few control points of a curved baseline read as one smooth curve
// (glyph tangents flow instead of kinking at each point). `seg` sub-segments per span.
function smoothPolyline(P, seg) {
  if (P.length < 3) return P;
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || P[i + 1];
    for (let j = 0; j < seg; j++) {
      const t = j / seg, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(P[P.length - 1]);
  return out;
}

// lay `name` glyph-by-glyph along a screen-space polyline `pts` ([[x,y],…]), each glyph rotated to
// the local tangent and centred on the path, with a dark halo behind. Canvas has no text-on-path,
// so we advance by measured glyph widths. `track` = extra px between glyphs (spread to fill).
function drawTextOnPath(name, pts, size, track, weight, color) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const L = cum[cum.length - 1];
  ctx.font = `${weight} ${size}px ${LABEL_FAM}`;
  const chars = [...name];
  const adv = chars.map(c => ctx.measureText(c).width);
  const total = adv.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1);
  const sample = d => {
    d = Math.max(0, Math.min(L, d));
    let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1, f = (d - cum[i - 1]) / seg;
    return {
      x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
      y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
      ang: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]),
    };
  };
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  let s = (L - total) / 2;                                // centre the word on the path
  for (let i = 0; i < chars.length; i++) {
    const pt = sample(s + adv[i] / 2);
    ctx.save(); ctx.translate(pt.x, pt.y); ctx.rotate(pt.ang);
    ctx.lineWidth = Math.max(1.5, size * 0.2); ctx.strokeStyle = "rgba(8,12,19,.68)";
    ctx.strokeText(chars[i], 0, 0);
    ctx.fillStyle = color; ctx.fillText(chars[i], 0, 0);
    ctx.restore();
    s += adv[i] + track;
  }
}

function drawLabels() {
  drawGeoLabels();          // zoom-banded continent/super-region/region tiers, behind the rest
  const placed = [];
  const fits = b => {
    if (b.x < 3 || b.y < 3 || b.x+b.w > VIEW.w-3 || b.y+b.h > VIEW.h-3) return false;
    return !placed.some(q => b.x < q.x+q.w && b.x+b.w > q.x && b.y < q.y+q.h && b.y+b.h > q.y);
  };
  const label = (name, ax, ay, o) => {
    ctx.font = o.font;
    const tw = ctx.measureText(name).width, gap = o.dot ? 9 : 5;
    for (const side of [1, -1]) {
      const bx = side>0 ? ax+gap : ax-gap-tw;
      const box = { x: bx, y: ay-o.size/2-1, w: tw, h: o.size+2 };
      if (!fits(box)) continue;
      placed.push(box);
      if (o.dot) {
        ctx.beginPath(); ctx.arc(ax,ay,o.dotR||3,0,7); ctx.fillStyle=o.dot; ctx.fill();
        ctx.lineWidth=1.2; ctx.strokeStyle="rgba(9,13,20,.9)"; ctx.stroke();
      }
      ctx.textAlign="left"; ctx.textBaseline="middle";
      ctx.lineJoin="round"; ctx.lineWidth=2.6; ctx.strokeStyle="rgba(8,12,19,.68)";
      ctx.strokeText(name, bx, ay);
      ctx.fillStyle=o.color; ctx.fillText(name, bx, ay);
      return;
    }
  };
  // EU4-style province label: the name laid on the shape's principal axis (angled) and scaled to
  // span it. Culls to the viewport and collides against `placed` via the label's own screen AABB,
  // so nothing is drawn for an off-screen or overlapped province.
  const drawProvLabel = (p, o) => {
    const lp = labelPath(p);
    if (!lp) return;
    let spts = lp.pts.map(([x, y]) => project(x, y));       // source → screen (projected: may be tilted)
    if (spts.length > 2) spts = smoothPolyline(spts, 5);    // smooth a curved (phase-b) baseline
    if (spts[spts.length - 1][0] < spts[0][0]) spts.reverse();   // keep text left-to-right (never upside-down)
    // arc length on screen (for scale + text spanning) and in source (for the thickness scale)
    let L = 0; for (let i = 1; i < spts.length; i++) L += Math.hypot(spts[i][0] - spts[i - 1][0], spts[i][1] - spts[i - 1][1]);
    if (L < 14) return;                                     // too small on screen to read
    let srcL = 0; for (let i = 1; i < lp.pts.length; i++) srcL += Math.hypot(lp.pts[i][0] - lp.pts[i - 1][0], lp.pts[i][1] - lp.pts[i - 1][1]);
    const thick = lp.thick * (L / (srcL || 1));             // shape thickness on screen
    // fit: cap glyph height by the thickness, fit width to ~88% of the baseline, and spread the
    // leftover length as inter-letter tracking (EU4 tracks names out to span the region)
    const target = L * 0.88, n = [...p.name].length;
    ctx.font = `${o.weight} 100px ${LABEL_FAM}`;
    const w100 = p._nw ?? (p._nw = ctx.measureText(p.name).width);
    let size = Math.min(o.max, thick * 1.4), track = 0;
    const natW = w100 * size / 100;
    if (natW > target) size *= target / natW;               // shrink to fit the length
    else { track = (target - natW) / Math.max(1, n - 1); if (track > size * 0.5) track = size * 0.5; }
    if (size < o.min) return;                               // too cramped — leave it unlabeled
    // the baseline's screen AABB, padded by half a glyph height, for the viewport cull + overlap test
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const [x, y] of spts) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    const hh = size * 0.62;
    const box = { x: minx - hh, y: miny - hh, w: (maxx - minx) + 2 * hh, h: (maxy - miny) + 2 * hh };
    if (!fits(box)) return;                                 // off-viewport (fits() rejects edge overflow) or overlapping
    placed.push(box);
    drawTextOnPath(p.name, spts, size, track, o.weight, o.color);
  };
  // province names fade in only once zoomed in (below that the geographic tiers own the
  // map): label the provinces actually on screen, largest first and collision-culled, so
  // names resolve wherever you zoom rather than only for the globally-biggest few
  {
    const pa = bandAlpha(kBand([6.5, 8.5]));   // province names fade in (bands ≈2.70→3.09)
    if (pa > 0.01) {
      const inView = [];
      for (const p of P) {
        if (p.type!=="LAND") continue;
        const [x, y] = pllOn(p.lon, p.lat);
        if (x < -40 || y < -20 || x > VIEW.w+40 || y > VIEW.h+20) continue;   // cull to viewport
        inView.push({ p, x, y });
      }
      inView.sort((a,b)=> b.p.plots - a.p.plots);
      ctx.save(); ctx.globalAlpha = pa;
      for (let i=0; i<inView.length && i<90; i++)
        drawProvLabel(inView[i].p, { weight:600, min:8, max:26, color:"#9fb0c8" });
      ctx.restore();
      // sea/lake names: secondary, deeper in (they'd clutter the world view), a cool italic and
      // drawn AFTER land so land wins any label-collision. Uses the coastal water provinces now shipped.
      const wpa = bandAlpha(kBand([8.5, 10.5]));   // sea/lake names fade in (bands ≈3.09→3.39)
      if (wpa > 0.01) {
        const water = [];
        for (const p of P) {
          if (p.type!=="SEA" && p.type!=="LAKE") continue;
          const [x, y] = pllOn(p.lon, p.lat);
          if (x < -40 || y < -20 || x > VIEW.w+40 || y > VIEW.h+20) continue;
          water.push({ p, x, y });
        }
        water.sort((a,b)=> b.p.plots - a.p.plots);
        ctx.save(); ctx.globalAlpha = wpa;
        const FW=`italic 500 10px ${LABEL_FAM}`;
        for (let i=0; i<water.length && i<40; i++)
          label(water[i].p.name, water[i].x, water[i].y, { font:FW, size:10, color:"#82b2cc" });
        ctx.restore();
      }
    }
  }
}

// ---- zoom-banded geographic tier labels (continent -> super-region -> region) ----
// Each tier is visible across a cam.k band and cross-fades at the seams, so zooming out
// coarsens the labelling (province -> region -> super-region -> continent) and zooming in
// refines it. Anchors + names come from BUNDLE.geo (built by build.mjs). k = [fadeIn0,
// full, holdTo, fadeOut1].
// The visibility envelopes come from bands.GEO_TIER_ENV — the single source shared with the tier
// BOUNDARIES (overlays/tiers.mjs) and the top-bar band CAPTION (bandcaption.mjs), so all three
// coarsen together. Only the type styling is per-label. The trapezoid math + cross-fade live in
// bands.bandAlpha (was a local tierAlpha here).
const GEO_TIERS = [
  { arr:"continents",   env:GEO_TIER_ENV.continents,   size:16, weight:"800", color:"#e6edf7", halo:4.2, track:"3px", upper:true },
  { arr:"superRegions", env:GEO_TIER_ENV.superRegions, size:16, weight:"800", color:"#cdd9ea", halo:3.7, track:"1.5px", upper:true },
  { arr:"regions",      env:GEO_TIER_ENV.regions,      size:14, weight:"800", color:"#aebcd2", halo:3.3, track:"0px", upper:false },
];
function drawGeoLabels() {
  const G = BUNDLE.geo; if (!G) return;
  for (const t of GEO_TIERS) {
    const a = bandAlpha(t.env);
    if (a <= 0.01) continue;
    const items = G[t.arr] || [];
    const placed = [];               // per-tier collision, so tiers can cross-fade over each other
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `${t.weight} ${t.size}px ${LABEL_FAM}`;
    ctx.letterSpacing = t.track;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const g of items) {         // pre-sorted largest-first = priority
      // a tier label belongs to ONE realm — the one holding most of its plots — and its lon/lat is
      // that realm's centroid (WorldBundle.rollupTier). So the Serpentspine's map is not captioned
      // CANNOR across ground it does not own. docs/realms.md §Phase 4.
      if (ACTIVE_REALM && g.realm && g.realm !== ACTIVE_REALM) continue;
      const name = t.upper ? g.name.toUpperCase() : g.name;
      const [cx, cy] = pll(g.lon, g.lat), tw = ctx.measureText(name).width;
      const box = { x: cx - tw/2, y: cy - t.size/2 - 1, w: tw, h: t.size + 2 };
      if (box.x < 3 || box.y < 3 || box.x+box.w > VIEW.w-3 || box.y+box.h > VIEW.h-3) continue;
      if (placed.some(q => box.x < q.x+q.w && box.x+box.w > q.x && box.y < q.y+q.h && box.y+box.h > q.y)) continue;
      placed.push(box);
      ctx.lineWidth = t.halo * 0.7; ctx.strokeStyle = "rgba(8,12,19,.68)"; ctx.strokeText(name, cx, cy);
      ctx.fillStyle = t.color; ctx.fillText(name, cx, cy);
    }
    ctx.restore();
  }
  ctx.letterSpacing = "0px";
}
export { drawLabels, drawGeoLabels };
