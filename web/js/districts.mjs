"use strict";
// The district view (docs/district-buildout.md D5): at deep zoom, each city's urban core plots
// show a small Civ6 NEIGHBORHOOD chip — the default district every urban plot carries (the other
// district types emerge from the buildings actually raised on a plot, during gameplay). A plot
// that isn't linked to a live settlement reads as ABANDONED (a ruined-neighborhood variant); the
// spectated colony's own province renders active neighborhoods, and its built buildings ring its
// center as flat button icons on little plinths. The chips are small ICONS centred on each plot,
// not full-hex tiles blanketing the cell. This layer supersedes the interim pip (city.mjs) as you
// zoom into a city.
//
// Two sources: the map's urban plots (BUNDLE, geographic — every city) and the live session
// snapshot (the POV colony's placed buildings, from the D3 district feed). Both fade in deep.
import { P, ctx, pxr, pyr, px, py, plotPxAt, provOnScreen, isPolitical, BUNDLE } from "./core.mjs";
import { drawBuildIcon } from "./build-catalog.mjs";
import { bandAlpha } from "./bands.mjs";
import { liveColony } from "./overlays/live.mjs";
import { nearestPlots, indexDistricts, plotKey, buildingsOf } from "./district-plots.mjs";
import { footprintCells, plotBlocks } from "./footprints.mjs";

// --- Civ6 district-hex chips (D4a): {TYPE: {src,w,h}} → loaded Images. We draw NEIGHBORHOOD
// (+ its baked ABANDONED variant); CITY_CENTER is a last-ditch fallback. ---
const TILES = (BUNDLE && BUNDLE.districtTiles) || null;
const tileImg = {};
if (TILES) for (const [type, a] of Object.entries(TILES)) { const im = new Image(); im.src = a.src; tileImg[type] = im; }

// the neighborhood chip is drawn small — a fraction of the plot, capped — so it reads as a marker
// centred on the plot, not a tile blanketing the cell (the old full-hex D_HEX_SCALE pile-up).
function iconSize(plotPx) { return Math.max(10, Math.min(plotPx * 0.55, 46)); }

// (the /api/buildings join — names, costs and the button-icon sheet — lives in build-catalog.mjs,
//  shared with the decree modal and the city screen)

// The colony's CITY CENTER in screen px — the centre of its `centerX`/`centerY` plot, the
// water-first plot the engine actually founded on. Falls back to the colony's lat/lon, which is its
// PROVINCE's anchor and can sit a plot or two off the true centre (docs/urban-plots.md) — only
// reached for a colony whose centre plot isn't laid yet, or an older server that omits the fields.
function centerPx(colony, plotPx) {
  if (Number.isFinite(colony.centerX) && Number.isFinite(colony.centerY))
    return { x: pxr(colony.centerX) + plotPx / 2, y: pyr(colony.centerY) + plotPx / 2 };
  return { x: px(colony.longitude), y: py(colony.latitude) };
}

// the province that hosts the live colony (so its urban plots read as ACTIVE, not abandoned). The
// colony says which province it sits in outright (ColonyView.provinceId), so this is a lookup — it
// used to be a plot-bounding-box containment scan over every loaded province, inferring from the
// colony's map point what the feed already knew. Null when that province isn't on screen (every
// visible urban plot is then correctly an unlinked, abandoned site).
function colonyProvince(colony) {
  if (!colony.provinceId) return null;
  for (const p of P)
    if (p.id === colony.provinceId && p._plots && p._plots.length && provOnScreen(p)) return p;
  return null;
}

// The set of the live colony's urban plots that are actually BUILT — a city of N districts lights N
// of its province's urban plots; the rest of the urban core is unclaimed ground and still reads as
// abandoned. The lit plots are the N nearest the city center, so the core is live and the outskirts
// are ruins. Null means "every urban plot is live" (the core is fully built out).
function livePlots(prov, colony, plotPx) {
  const n = Math.max(0, colony.startingDistricts | 0);
  const urban = prov._plots.filter(q => q.urban);
  const c = centerPx(colony, plotPx);
  return nearestPlots(urban, n, c.x, c.y, q => pxr(q.x) + plotPx / 2, q => pyr(q.y) + plotPx / 2);
}

// is `q` the colony's city-center plot?
const isCenter = (q, colony) => q.x === colony.centerX && q.y === colony.centerY;

// draw a small district chip centred at (cx, cy), sized to `s` px. `active` picks the live art;
// otherwise the ABANDONED (ruined) variant — its own baked webp when present, else the live tile
// drawn desaturated/darkened so an unlinked site still reads as forsaken. A live colony's own
// centre plot draws the CITY_CENTER chip rather than a generic neighborhood, so the city reads as
// having a seat; an abandoned site is ruins either way.
function drawNeighborhood(active, cx, cy, s, center = false) {
  const live = (center && tileImg.CITY_CENTER) || tileImg.NEIGHBORHOOD || tileImg.CITY_CENTER;
  let im = active ? live : (tileImg.NEIGHBORHOOD_ABANDONED || live);
  if (!im || !im.complete || !im.naturalWidth) return;
  const fake = !active && !tileImg.NEIGHBORHOOD_ABANDONED;  // no baked variant → fake the ruin look
  if (fake) { ctx.save(); ctx.filter = "grayscale(0.9) brightness(0.62)"; ctx.globalAlpha *= 0.85; }
  ctx.drawImage(im, cx - s / 2, cy - s / 2, s, s);
  if (fake) ctx.restore();
}

// --- owner tints: whose building this is, at a glance (the feed's owner classes) ---
const OWNER_TINT = {
  RULER: "#c9a24a",       // the crown's gold
  NOBLE: "#9b7bc0",       // an aristocratic violet
  HOUSEHOLD: "#c3ab8b",   // warm hearth stone
  NONE: "#8b8b86",        // unowned — orphaned or inherited ground
};
const tintOf = owner => OWNER_TINT[owner] || OWNER_TINT.NONE;

// draw one building's button icon on a small plinth centred at (cx, cy), sized to `s` px
function drawBuildingIcon(id, cx, cy, s) {
  // plinth: a soft shadow ellipse so the icon reads as sitting in the district
  ctx.beginPath(); ctx.ellipse(cx, cy + s * 0.42, s * 0.5, s * 0.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(30,24,18,0.35)"; ctx.fill();
  drawBuildIcon(ctx, id, cx, cy, s);
}

// (2a) OVERVIEW LOD — one plot's buildings as button icons ringed (then spiralled) around it.
// Reads as "something stands here, and roughly how much".
function drawPlotIcons(dist, cx, cy, plotPx) {
  const ids = buildingsOf(dist).map(b => b.id);
  for (const u of (dist.underway || [])) ids.push(u.id);
  if (!ids.length) return;
  const bs = Math.max(8, Math.min(plotPx * 0.4, 20));
  for (let i = 0; i < ids.length; i++) {
    const ring = Math.floor(i / 8), slot = i % 8;
    const rad = plotPx * (0.45 + ring * 0.42);
    const ang = (slot / 8) * Math.PI * 2 + ring * 0.4;
    drawBuildingIcon(ids[i], cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, bs);
  }
}

// (2b) DEEP LOD (band 6, docs/zoom-bands.md) — the plot as ground with blocks on it: one footprint
// per building, owner-tinted, and a part-filled scaffold for anything still rising. This is where a
// settlement stops being icons and starts being a place.
function drawPlotFootprints(dist, x0, y0, plotPx) {
  const blocks = plotBlocks(buildingsOf(dist), dist.underway);
  if (!blocks.length) return;
  const cells = footprintCells(blocks.length, plotPx, x0, y0);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], c = cells[i];
    if (b.progress == null) {
      ctx.fillStyle = tintOf(b.owner);
      ctx.fillRect(c.x, c.y, c.w, c.h);
      // a thin south/east shadow so a block reads as standing, not painted on
      ctx.fillStyle = "rgba(24,20,16,0.28)";
      ctx.fillRect(c.x, c.y + c.h, c.w + 1, 1);
      ctx.fillRect(c.x + c.w, c.y, 1, c.h + 1);
    } else {
      // a scaffold: the outline of what will stand, filled from the ground up by progress
      const built = c.h * b.progress;
      ctx.fillStyle = tintOf(b.owner);
      ctx.globalAlpha *= 0.75;
      ctx.fillRect(c.x, c.y + c.h - built, c.w, built);
      ctx.globalAlpha /= 0.75;
      ctx.strokeStyle = tintOf(b.owner);
      ctx.lineWidth = Math.max(0.6, c.w * 0.06);
      ctx.setLineDash([c.w * 0.22, c.w * 0.16]);
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.setLineDash([]);
    }
  }
}

/** The district view — a small district chip on every city's urban plots (abandoned unless the plot
 *  is one the live colony's districts occupy; its centre plot draws the CITY_CENTER art) + the POV
 *  colony's buildings, each on the plot it actually stands on. Icons at the overview zoom, real
 *  footprints past band 6. Fades in at deep zoom (reading a city's plots). */
export function drawDistricts() {
  const chips = bandAlpha([4.5, 5.5]);          // the neighborhood chips, past the interim pip
  const icons = bandAlpha([4.5, 5.5, 6.0, 6.8]); // building icons: fade out as footprints take over
  const feet = bandAlpha([6.0, 6.8]);            // band-6 footprints (docs/zoom-bands.md)
  if (chips <= 0.01 || isPolitical()) return;
  const plotPx = plotPxAt();
  if (plotPx < 2) return;            // too small to read
  ctx.save();

  const colony = liveColony();
  const anchored = colony && (Number.isFinite(colony.latitude) || Number.isFinite(colony.centerX));
  const liveProv = anchored ? colonyProvince(colony) : null;
  const built = liveProv ? livePlots(liveProv, colony, plotPx) : null;
  const s = iconSize(plotPx);

  // (1) geographic: a small district chip on every city's urban core plots. Abandoned by default
  // (an unlinked map site); active on the live colony's province — but only on the plots its
  // districts actually occupy, the rest of that core being unbuilt ground.
  ctx.globalAlpha = chips;
  for (const p of P) {
    if (!p._plots || !p._plots.length || !provOnScreen(p)) continue;
    const live = p === liveProv;
    for (const q of p._plots) {
      if (!q.urban) continue;
      const active = live && (!built || built.has(q));
      drawNeighborhood(active, pxr(q.x) + plotPx / 2, pyr(q.y) + plotPx / 2, s, live && isCenter(q, colony));
    }
  }

  // (2) live: the POV colony's buildings, ON THE PLOTS THEY STAND ON. The feed carries each plot's
  // raster coordinates, so a household's hut sits on that household's ground instead of piling onto
  // the city centre with everything else (which is what this drew before the coordinates shipped).
  if (anchored && Array.isArray(colony.districts)) {
    const centre = centerPx(colony, plotPx);
    for (const dist of colony.districts) {
      // An older server sends no coordinates (they arrived with the city screen). Fall back to the
      // pre-coordinate behaviour — everything ringed on the centre — rather than drawing nothing:
      // the static site can be a deploy ahead of the server, and a colony that suddenly has no
      // buildings at all reads as a broken sim, which is a worse lie than the old one.
      const has = Number.isFinite(dist.x) && Number.isFinite(dist.y);
      const x0 = has ? pxr(dist.x) : centre.x - plotPx / 2;
      const y0 = has ? pyr(dist.y) : centre.y - plotPx / 2;
      if (icons > 0.01) {
        ctx.globalAlpha = icons;
        drawPlotIcons(dist, x0 + plotPx / 2, y0 + plotPx / 2, plotPx);
      }
      if (feet > 0.01) {
        ctx.globalAlpha = feet;
        drawPlotFootprints(dist, x0, y0, plotPx);
      }
    }
  }
  ctx.restore();
}

/** What the live colony has standing (or rising) on the plot at raster (x, y), or null. The map
 *  tooltip's join — the same index the draw uses, so hover and paint can never disagree. */
export function districtAt(x, y) {
  const colony = liveColony();
  if (!colony || !Array.isArray(colony.districts)) return null;
  if (dIndexFor !== colony.districts) { dIndex = indexDistricts(colony.districts); dIndexFor = colony.districts; }
  return dIndex.get(plotKey(x, y)) || null;
}
let dIndex = new Map(), dIndexFor = null;   // memoized per snapshot (the array identity is the key)
