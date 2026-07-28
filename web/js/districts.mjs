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
import { P, ctx, plotPxAt, provOnScreen, isPolitical, BUNDLE, projectOn, pllOn } from "./core.mjs";
import { drawBuildIcon } from "./build-catalog.mjs";
import { bandAlpha } from "./bands.mjs";
import { TOWN_ENV } from "./town-style.mjs";
import { liveColony } from "./overlays/live.mjs";
import { nearestPlots, indexDistricts, plotKey, buildingsOf } from "./district-plots.mjs";

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
    { const [cx, cy] = projectOn(colony.centerX + 0.5, colony.centerY + 0.5); return { x: cx, y: cy }; }
  const [lx, ly] = pllOn(colony.longitude, colony.latitude);
  return { x: lx, y: ly };
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
  return nearestPlots(urban, n, c.x, c.y, q => projectOn(q.x + 0.5, q.y + 0.5)[0], q => projectOn(q.x + 0.5, q.y + 0.5)[1]);
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

/** The district view — a small district chip on every city's urban plots (abandoned unless the plot
 *  is one the live colony's districts occupy; its centre plot draws the CITY_CENTER art) + the POV
 *  colony's buildings, each on the plot it actually stands on, as icons. Fades in at deep zoom
 *  (reading a city's plots) and back out again as the TOWN layer takes the same ground (§8a). */
export function drawDistricts() {
  const chips = bandAlpha([4.5, 5.5]);          // the neighborhood chips, past the interim pip
  const icons = bandAlpha([4.5, 5.5, 6.0, 6.8]); // building icons: fade out as the town takes over
  // THE HANDOVER TO THE TOWN LAYER (docs/towngen-port.md §8a). Over its bands town.mjs is the only
  // thing drawing built ground: two surfaces cannot both claim to say what stands on a plot, and
  // that is exactly how the two-footprint disagreement of §2.1 happened. So the chips fade out as
  // the town fades in — but ONLY on the province the town is actually drawn for. Everywhere else
  // there is no session, no colony and no town, and a chip is still the only thing saying "a city
  // stands here"; retiring it globally would empty the map at deep zoom.
  const handover = 1 - bandAlpha(TOWN_ENV);
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
  for (const p of P) {
    if (!p._plots || !p._plots.length || !provOnScreen(p)) continue;
    const live = p === liveProv;
    const a = live ? chips * handover : chips;   // the town supersedes the chips on its own ground
    if (a <= 0.01) continue;
    ctx.globalAlpha = a;
    for (const q of p._plots) {
      if (!q.urban) continue;
      const active = live && (!built || built.has(q));
      drawNeighborhood(active, ...projectOn(q.x + 0.5, q.y + 0.5), s, live && isCenter(q, colony));
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
      const [px0, py0] = has ? projectOn(dist.x, dist.y) : [centre.x - plotPx / 2, centre.y - plotPx / 2];
      const x0 = px0, y0 = py0;
      // no footprints here any more: the sqrt-grid of blocks this drew past band 6 was a placeholder
      // for exactly what T6 now serves — real lots, cut to the plot's real households and buildings,
      // with the building standing on its own block. §8a retires it rather than layering it under.
      if (icons > 0.01) {
        ctx.globalAlpha = icons;
        drawPlotIcons(dist, x0 + plotPx / 2, y0 + plotPx / 2, plotPx);
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
