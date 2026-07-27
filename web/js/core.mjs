"use strict";
import { resolveBase } from "./server-base.mjs";
import { invAffine1, scaleAt, screenAABB } from "./project-math.mjs";

const BUNDLE = window.BUNDLE;

// the spectator-server origin the /api/* calls target. The resolution itself lives in
// server-base.mjs — the lobby and the sign-in inside it need the same answer BEFORE the bundle
// exists, and this module reads window.BUNDLE at import time, so it cannot be their source for it.
// The server is the single source of the map/geo bundle (/api/bundle) and the jar-derivable assets
// /api/tiers and /api/techs.
const SERVER_BASE = resolveBase();
const apiUrl = path => SERVER_BASE + path;

// ---- data prep ----
// Realm selection (docs/realms.md): the view is cropped to ONE realm — its baked background + minimap
// (MAP) and its provinces (P). ?realm=<key> picks it; absent or unknown DEFAULTS to Cannor (the Old
// World's west, and where every legacy link pointed). If the server ships no realms block at all
// (pre-Phase-3), fall back to the whole-world map.
// Everything downstream reads MAP/P, so the crop, projection, minimap and province set all follow here.
const _realmParam = (typeof location !== "undefined"
  ? new URLSearchParams(location.search).get("realm") : "") || "";
// `halcann` is the retired Old-World realm, kept as a read-only alias for Cannor so shared links and
// old session specs keep working (docs/realms.md §Halcann must be migrated, not just renamed). It is
// resolved here and never written back — switchRealm always emits the real key.
const LEGACY_REALMS = { halcann: "cannor" };
const _realmWanted = LEGACY_REALMS[_realmParam] || _realmParam;
const DEFAULT_REALM = "cannor";
const ACTIVE_REALM = BUNDLE.realms
  ? (BUNDLE.realms[_realmWanted] ? _realmWanted : DEFAULT_REALM) : "";
const _realmActive = !!(BUNDLE.realms && BUNDLE.realms[ACTIVE_REALM]);
// rewrite a legacy key out of the address bar, so the link the user copies next is the real one
if (_realmActive && LEGACY_REALMS[_realmParam] && typeof history !== "undefined") {
  try {
    const u = new URL(location.href);
    u.searchParams.set("realm", ACTIVE_REALM);
    history.replaceState(history.state, "", u.toString());
  } catch { /* file:// or a locked-down browser — the alias still resolved, only the URL lags */ }
}
// A realm renders ONLY its provinces: foreign land at the crop edge (outlines, dots, labels) drops out,
// and cross-realm neighbour/adjacency lines suppress for free (their far endpoint is no longer in P).
// Also the per-frame perf lever — the cull/hit-test loops shrink to the realm's share.
const P = _realmActive ? BUNDLE.provinces.filter(p => p.realm === ACTIVE_REALM) : BUNDLE.provinces;
const fmtInt = n => Math.round(n).toLocaleString("en-US");
// projection: lon/lat -> the exact source pixel on terrain.bmp (the inverse of the
// maps ProvinceExporter used) -> the baked crop's fit rectangle -> screen, with a
// pan/zoom camera (cam.k scale, cam.x/cam.y translate) applied last. Using the same
// source-pixel formulas the build baked with keeps dots/rings pinned to the map.
const MAP = _realmActive ? BUNDLE.realms[ACTIVE_REALM].map : BUNDLE.map;
const sxSrc = lon => (lon + 180) / 360 * (MAP.W - 1);
const sySrc = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r / 2 + Math.PI / 4)) / Math.PI) / 2 * MAP.H; };
let VIEW = { w:0, h:0, dx:0, dy:0, dw:0, dh:0, dpr:1 };
const cam = { k: 1, x: 0, y: 0 };
function fitView(w, h) {
  const cw = MAP.x1 - MAP.x0, ch = MAP.y1 - MAP.y0;   // crop extent in source px
  const s = Math.min(w / cw, h / ch);                 // contain: whole crop visible at k=1
  VIEW.w = w; VIEW.h = h; VIEW.dw = cw * s; VIEW.dh = ch * s;
  VIEW.dx = (w - VIEW.dw) / 2; VIEW.dy = (h - VIEW.dh) / 2;
  S.baseVersion++;
}
// base (unzoomed) screen coords, then the camera
const baseXr = sp => VIEW.dx + (sp - MAP.x0) / (MAP.x1 - MAP.x0) * VIEW.dw;
const baseYr = sp => VIEW.dy + (sp - MAP.y0) / (MAP.y1 - MAP.y0) * VIEW.dh;
// The SEPARABLE FAST PATH of the active projector (the seam is just below). Kept as direct arithmetic
// rather than routed through PROJ for two reasons: provOnScreen alone runs ~50k times a frame (see the
// measured note further down) and the general path returns an [x, y] pair, which at that rate is real
// allocation; and this way installing the seam changes no pixel anywhere.
//
// Valid ONLY while PROJ.separable. A tilted projector makes screen x depend on the source y as well,
// at which point these two lie, and their call sites have to move to project(). docs/terrain-3d.md
// §The plan → P2 carries that conversion list.
const pxr = sp => cam.x + cam.k * baseXr(sp);
const pyr = sp => cam.y + cam.k * baseYr(sp);
const px = lon => pxr(sxSrc(lon));
const py = lat => pyr(sySrc(lat));
/** A lon/lat point → screen [x, y], through the ACTIVE projector — the paired form of px/py, and what a
 *  layer must use once the camera can tilt. Most call sites were literally `px(p.lon), py(p.lat)` on one
 *  line, so this is the same shape; the separable pair survives only for callers that genuinely have one
 *  axis in hand (a viewport-wide fill, a scale probe). */
const pll = (lon, lat) => PROJ.project(sxSrc(lon), sySrc(lat), 0);

// ---- the projection seam (docs/terrain-3d.md §The plan → P0) ----
// ONE swappable object mapping the map's source-pixel space to screen space. The 3D terrain renderer
// installs its camera's projection here, and every layer that asks through project()/unproject()
// follows the tilt without being touched. js/project-math.mjs explains why the JOINT signature — not
// the separable pxr/pyr pair above — is the real seam.
//
// `h` is ground height in source-pixel units: one plot IS one source pixel (plotcanvas.blitProvinceCanvas
// blits a province offscreen straight through pxr/pyr), so the spike's PEAK 3.4 / HILL 1.0 are already
// in these units and need no conversion. The 2D camera ignores h — its map is flat.
const affineProjector = {
  separable: true,
  project: (sx, sy) => [cam.x + cam.k * baseXr(sx), cam.y + cam.k * baseYr(sy)],
  unproject: (mx, my) => [
    invAffine1(mx, cam.x, cam.k, VIEW.dx, VIEW.dw, MAP.x0, MAP.x1),
    invAffine1(my, cam.y, cam.k, VIEW.dy, VIEW.dh, MAP.y0, MAP.y1),
  ],
};
let PROJ = affineProjector;
/** The 2D camera's inverse, WHICHEVER projector is installed. The 3D camera is placed by working backwards
 *  from the 2D one (terrain3d.syncCamera), so it needs the affine answer specifically: asking through
 *  unproject would ask the camera being placed where it is looking, which is circular. */
const affineUnproject = (mx, my) => affineProjector.unproject(mx, my);
/** Install a projector (the 3D renderer's camera); no argument restores the 2D one. Bumps baseVersion,
 *  because every cached province Path2D and every debounced readout keys off it — a projector swap that
 *  forgot to would paint the new projection through stale geometry. */
function setProjector(p) { PROJ = p || affineProjector; S.baseVersion++; }
/** Is the active projection separable — i.e. are pxr/pyr, and axis-aligned source-space rects, valid? */
const separable = () => PROJ.separable;
/** Source pixel (sx, sy) at ground height `h` → screen [x, y]. */
const project = (sx, sy, h) => PROJ.project(sx, sy, h);
/** Screen (mx, my) → source pixel [sx, sy] on the ground plane. Was hand-rolled in latAtScreenY (now
 *  routed through here) and, differently, inside hittest.plotAt (which P2 replaces with a raycast). */
const unproject = (mx, my) => PROJ.unproject(mx, my);
// ---- standing ON the terrain (docs/terrain-3d.md §The plan → P4) ----
// A second seam, the vertical counterpart of the projector. project() takes a height because the caller knows
// it; almost no caller does — a resource icon, a city marker, a district, a province outline all just want to
// sit on the GROUND, wherever the ground happens to be. Installed by terrain3d (which owns the height field)
// exactly as the projector is, so core stays ignorant of the renderer.
let GROUND_H = null;
/** Install the terrain-height lookup (terrain3d.groundHeightAt); no argument reverts to a flat world. */
function setGroundHeight(fn) { GROUND_H = fn || null; S.baseVersion++; }
/**
 * Project a source point STANDING ON THE TERRAIN rather than at sea level.
 *
 * Under the 2D camera this is exactly project(): the affine projector ignores height, so the lookup is skipped
 * entirely and bands 0-4 pay nothing. Under a tilted camera it is the difference between an icon sitting on its
 * hill and sitting at the hill's sea-level shadow — which, at 34° and 3.4 plot-widths of relief, is a couple of
 * plots downhill.
 */
const projectOn = (sx, sy) =>
  PROJ.separable || !GROUND_H ? PROJ.project(sx, sy, 0) : PROJ.project(sx, sy, GROUND_H(sx, sy));
/** projectOn for a lon/lat point — the paired form, as pll is to project. */
const pllOn = (lon, lat) => projectOn(sxSrc(lon), sySrc(lat));

/** One plot's on-screen size in px at a source-space point — the honest form of the `pxr(1) - pxr(0)`
 *  idiom the layer code used to spell out (project-math.scaleAt says why it must become a function of
 *  position). Under the 2D camera the answer is identical everywhere, so the arguments are optional and
 *  the fast path reproduces the old expression exactly. */
const plotPxAt = (sx = 0, sy = 0) => PROJ.separable ? pxr(sx + 1) - pxr(sx) : scaleAt(project, sx, sy);

// inverse of sySrc: the latitude at a SOURCE pixel row (undo the Mercator). Split out of latAtScreenY
// so the 3D sea plane can bake its climate gradient in map space — the same colours the 2D gradient
// samples per screen row, but independent of the camera (js/terrain3d.mjs).
const latAtSourceY = sp => {
  const t = (1 - 2 * sp / MAP.H) * Math.PI;
  return (2 * Math.atan(Math.exp(t)) - Math.PI / 2) * 180 / Math.PI;
};
// inverse of py: the latitude at a screen y (undo camera → crop rect → source pixel → the
// Mercator sySrc). Used to colour the ocean by climate band down the viewport.
const latAtScreenY = y => latAtSourceY(unproject(0, y)[1]);
const TCOL = BUNDLE.terrainColors || {};
const K_PLOT = 5;                 // camera scale at which plots begin to fade in
const K_TEX = 16;                 // camera scale at which flat tiles give way to real textures
const K_MAX = 512;                // deepest zoom (8× past the old 64× cap — a magnifier past the finest baked LoD)
// the shared map-label typeface: the bundled Jost* (a free geometric sans in the Futura/
// Century-Gothic family — the Stellaris UI look, @font-face in styles.css), falling back to
// Century Gothic where installed, then system geometric sans. Every map label (province names,
// geographic tiers, caravan/water labels, the live overlay) uses this.
const LABEL_FONT = "'Jost','Century Gothic','Futura','Trebuchet MS',sans-serif";
const TT = BUNDLE.terrainTiles;   // ground-texture atlas {src, tile, cols:{TERRAIN_*: column}} or null
const RIVER = BUNDLE.river;        // water tile {src, tile} for the river ribbon, or null (flat-fill fallback)
const SEA = BUNDLE.sea;            // greyscale ripple tile {src, tile} for the ocean layer, or null (gradient only)
const SHORE = BUNDLE.shore;        // greyscale shore-wave tile {src, tile} for the shallows, or null (flat shallows)
const ICE_ART = BUNDLE.ice;        // real Civ4 pack-ice tile {src, tile}, or null (procedural pale floes)
const BONUS_ICONS = BUNDLE.bonusIcons;  // real Civ4 resource icons {src, cell, cols, index:{type:i}}, or null (procedural glyphs)
const IMPROVEMENT_OVERLAYS = BUNDLE.improvementOverlays; // flat Civ6 SV improvement overlays {IMPROVEMENT_*: {src,w,h}}, or null (placement deferred — nothing carries an improvement yet)
const TREES = BUNDLE.trees;        // real Civ4 foliage sprites {leafy,palm,swamp:{src,w,h,sprites}}, or null (procedural blobs)
// (BUNDLE.routes is gone: routes are vector ribbons, not baked art — web/js/route-ribbon.mjs)

const SEA_BANDS = BUNDLE.seaBands; // {trop, temp, polar, shore} climate sea + shallows colours
// the real Civ4 sand ramps, rectified out of the coast blend atlases at bake time (build.mjs
// bakeBeachRamps): {trop, temp, polar} each an RGB ramp running the LAND edge → past the waterline.
// Null when the art was absent — coast.mjs then keeps its hand-picked sand.
const BEACH = BUNDLE.beach;
// the real Civ4 wave-crest strip {src, w, h} for the surf at the water's edge, or null (coast.mjs
// then keeps its procedural white feather). White rgb + the foam shape in alpha, tiling along its
// long axis — so it stamps along a shoreline edge.
const FOAM = BUNDLE.foam;
// Civ4's authored 16-way shoreline stencil {src, cell, n} — a horizontal strip of 16 alpha masks
// indexed by a plot's diagonal-sea nibble (plot.coast >> 4), alpha = water coverage. Null → coastal
// plots stay square (docs/civ4-texture-inventory.md §4 P3).
const COAST_MASK = BUNDLE.coastMask;
// Civ4's painted coast transition tiles + the authored blend table that selects between them:
// {cell, cols, blend:{cfg:[[cell,rot],…]}, trop/temp/polar:{src}}. Null → no coast tile is drawn
// (docs/civ4-texture-inventory.md §4 P3). Stamped on WATER plots, never land — see coast.mjs.
const COAST_TILES = BUNDLE.coastTiles;
// Civ4's translucent HILL overlay + the alpha-weighted mean the 1px/plot overview tints with
// (build.mjs bakeHillWash). Null on an older bundle — plots.mjs then keeps its invented brightening.
const HILL_WASH = BUNDLE.hillWash;
// Civ4's authored land-transition cells: 17 layers × 15 configs, config 15 being the flat interior
// (build.mjs bakeLandBlendCells). Null on an older bundle — plots.mjs then keeps its procedural feather.
const LAND_BLEND = BUNDLE.landBlend;
// per-province trade good (docs/trade-goods.md), loaded eagerly from the static web/tradegoods.js
// (a <script defer> in index.html, so window.TRADEGOODS is set before the app module evaluates).
// {icons:{src,cell,cols,index:{key:col}}, goods:{key:{name,color,category}}, prov:{provId:key}} or null.
const TRADE_GOODS = window.TRADEGOODS || null;
// political layer: filled lazily from web/political.js on first switch to Political mode
// (see panel.ensurePolitical). Kept as stable object refs so importers see the populated tables.
const COUNTRIES = {};   // owner tag -> {name, color}
const CULTURES = {};     // culture key -> {name, group, color}
const RELIGIONS = {};    // religion key -> {name, group, color}
const GEO_NAMES = BUNDLE.geoNames || {};   // raw-key -> display-name dictionaries for province crumbs
// resolve a province's geographic crumb tiers ([displayName, rawKey] each, or null) from its raw
// keys — the names live once in GEO_NAMES instead of being duplicated onto every province
function provGeo(p) {
  const reg = p.region, area = p.area, cont = p.continent;
  return {
    continent: cont ? [GEO_NAMES.continent?.[cont] || null, cont] : null,
    superRegion: reg ? [GEO_NAMES.superByRegion?.[reg] || null, GEO_NAMES.superKeyByRegion?.[reg] || null] : null,
    region: reg ? [GEO_NAMES.region?.[reg] || null, reg] : null,
    area: area ? [GEO_NAMES.area?.[area] || null, area] : null,
  };
}
// whether the active overlay is a political colouring (nation/culture/faith)
function isPolitical() {
  return S.overlay === "nation" || S.overlay === "culture" || S.overlay === "faith";
}
// the four underground Dwarovar province types (open caves, holds, roads) — matches
// ProvinceType.isUnderground(). They are the SERPENTSPINE REALM (docs/realms.md §Serpentspine
// membership is by type, not continent), so `P` already holds them or not according to the active
// realm; this predicate survives only to mark a cave mouth on a surface realm's map. There is no
// plane toggle and no z axis: the Dwarovar provinces have their own pixels, so they were never a
// plane at the same coordinates (docs/realms.md §The Serpentspine was never a plane).
const UNDERGROUND_TYPES = new Set(["CAVERN", "DWARVEN_HOLD", "DWARVEN_HOLD_SURFACE", "DWARVEN_ROAD"]);
const isUnderground = p => UNDERGROUND_TYPES.has(p.type);
// the active political dimension for a province under the current overlay: its raw key + the
// {name, color} table entry, or a null entry when the overlay isn't political / the province has none
function polOf(p) {
  switch (S.overlay) {
    case "nation":  return { key: p.owner,    e: p.owner    && COUNTRIES[p.owner] };
    case "culture": return { key: p.culture,  e: p.culture  && CULTURES[p.culture] };
    case "faith":   return { key: p.religion, e: p.religion && RELIGIONS[p.religion] };
    default:        return { key: null, e: null };
  }
}
const LY = BUNDLE.terrainLayer || {};   // TERRAIN_* -> Civ4 LayerOrder (higher bleeds over lower)
const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const _rgb = {};                  // "#rrggbb" -> [r,g,b], memoised
function terrainRgb(type) {
  const h = TCOL[type]; if (!h) return [70, 74, 68];
  return _rgb[h] || (_rgb[h] = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
}
// a province's source-pixel bounding box (from its outline rings), cached; null for seas
function provSrcBox(p) {
  if (p._sbox !== undefined) return p._sbox;
  if (!p.rings) {
    // ring-less (sea/lake) provinces carry a plot-extent bbox instead (build.mjs packPlots)
    if (p.bbox) return p._sbox = { x0: p.bbox[0], y0: p.bbox[1], x1: p.bbox[2], y1: p.bbox[3] };
    return p._sbox = null;
  }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const ring of p.rings) for (const pt of ring) {
    if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
    if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
  }
  return p._sbox = { x0, y0, x1, y1 };
}
// viewport cull: whether a province's projected source-pixel bbox intersects the viewport at the
// CURRENT camera. Non-wrap-aware by design — the callers that wrap (renderScene, provinceAt) already
// shift the camera / cursor one world-copy at a time, so each pass tests against its own copy. The
// bbox is cached (provSrcBox), so this is 4 transforms + compares. Ring-less provinces (no bbox) →
// false. Mirrors the cull drawPlots already applies, now shared by the polygon layers.
function provOnScreen(p) {
  const box = provSrcBox(p);
  if (!box) return false;
  if (!PROJ.separable) {   // tilted: the box projects to a trapezoid, so all four corners must be bounded
    const bb = screenAABB(project, box.x0, box.y0, box.x1, box.y1);
    return bb.x1 >= 0 && bb.x0 <= VIEW.w && bb.y1 >= 0 && bb.y0 <= VIEW.h;
  }
  const ax = pxr(box.x0), bx = pxr(box.x1), ay = pyr(box.y0), by = pyr(box.y1);
  return Math.max(ax, bx) >= 0 && Math.min(ax, bx) <= VIEW.w
      && Math.max(ay, by) >= 0 && Math.min(ay, by) <= VIEW.h;
}
// NOTE (perf, measured 2026-07-16): the obvious next move here is to hoist a per-frame "visible
// provinces" list — ~10 layers each loop all 5264 provinces calling provOnScreen, once per world
// copy. It was tried and REVERTED: it changed paint time by nothing (1×: 83.7ms → 88.0ms median,
// i.e. slightly worse, within noise). provOnScreen is ~4 arithmetic ops over a cached bbox, so even
// 100k of them is ~1ms — the culling loop was never the cost. Don't re-derive this; profile first.
// The real hotspot at Atlas zoom is sea.drawPolarIce (see the note there).
// whether screen point (sx,sy) lies within a province's projected bbox, optionally grown by `margin`
// px. A cheap pre-filter for the hover hit-test: a bbox miss cannot be a polygon hit, so this culls
// the expensive point-in-polygon / nearest-centroid scans to the few provinces actually under the
// cursor. Projected at the current camera, exactly as the hit-test itself is, so it never changes the
// result (a strict superset of the polygon test; margin covers the centroid pass's radius).
function provBoxHas(p, sx, sy, margin = 0) {
  const box = provSrcBox(p);
  if (!box) return false;
  if (!PROJ.separable) {   // see provOnScreen: two corners no longer bound a projected rectangle
    const bb = screenAABB(project, box.x0, box.y0, box.x1, box.y1);
    return sx >= bb.x0 - margin && sx <= bb.x1 + margin && sy >= bb.y0 - margin && sy <= bb.y1 + margin;
  }
  const ax = pxr(box.x0), bx = pxr(box.x1), ay = pyr(box.y0), by = pyr(box.y1);
  return sx >= Math.min(ax, bx) - margin && sx <= Math.max(ax, bx) + margin
      && sy >= Math.min(ay, by) - margin && sy <= Math.max(ay, by) + margin;
}
const lerp = (a,b,t) => a + (b-a)*t;
/**
 * Path2D of a province's rings, rebuilt on view change — the geometry behind province borders, the lake and
 * sea-cell washes, the impassable wash, the political fills and the hover/selected highlights.
 *
 * Goes through projectOn, so every ring vertex sits at the terrain height under IT: a border crossing a ridge
 * climbs the ridge instead of being drawn at the ridge's sea-level shadow, a couple of plots downhill. Only the
 * straight segment between two vertices can still cut a hill, and these outlines are dense enough that it
 * rarely reads — which is why the borders are drawn this way rather than baked into each province's texture as
 * the plan first proposed. Projecting them keeps ONE copy of the geometry, needs no texture invalidation, and
 * works for the per-frame layers (hover, selection) that a bake could never have covered.
 *
 * It was left on pxr/pyr through P2, which was a real bug: under a tilted camera those two lie, so every
 * polygon in the scene was drawn in the wrong place. Cached per viewVersion, and the height lookup is skipped
 * outright under the 2D camera, so this costs nothing below band 5.
 */
function provPath(p) {
  if (p._pv === S.viewVersion) return p._path;
  const path = new Path2D();
  for (const ring of p.rings) {
    ring.forEach((pt,i)=>{ const [x,y]=projectOn(pt[0],pt[1]); i?path.lineTo(x,y):path.moveTo(x,y); });
    path.closePath();
  }
  p._path = path; p._pv = S.viewVersion; return path;
}
const cv = document.getElementById("map"), ctx = cv.getContext("2d");
const stage = document.getElementById("stage");
// A CSS custom property off :root, MEMOISED. getComputedStyle forces a style resolution, and this is
// called from inside the draw loop — drawSelectedHighlight runs it per world copy per frame while a
// province is selected, live.mjs per caravan — so an un-cached read is a forced style recalc in the
// middle of a paint, a classic jank source. These tokens only change when the theme does, so cache
// per token and let the theme flip invalidate.
//
// An EMPTY result is never cached: a caller that runs before the stylesheet resolves would otherwise
// pin "" forever and permanently fall back (every call site is `cssVar("--accent") || "#e8b76a"`).
const _cssVarCache = new Map();
const cssVar = n => {
  let v = _cssVarCache.get(n);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    if (v) _cssVarCache.set(n, v);
  }
  return v;
};
// panel.mjs flips <html data-theme> to switch themes; observing the attribute means a future theme
// entry point can't forget to invalidate (which a manual clear() call would invite).
if (typeof MutationObserver !== "undefined" && typeof document !== "undefined")
  new MutationObserver(() => _cssVarCache.clear())
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
function clampAxis(camv, base, dim, viewDim) {
  const size = cam.k * dim, pos = camv + cam.k * base;
  if (size <= viewDim) return (viewDim - size) / 2 - cam.k * base;   // centre, no pan on this axis
  // clamp the map's edges to the viewport edges (margin 0): once an axis is larger than the viewport
  // you may pan within it, but never past its edge — so the map always fills the viewport and no
  // out-of-bounds void (nor the sea fill over it) can be panned into view. A realm crop is a finite
  // sheet; there is nothing beyond its edge to reveal.
  return Math.min(0, Math.max(viewDim - size, pos)) - cam.k * base;
}
function clampPan() {
  // the map is a finite sheet, not a cylinder — clamp BOTH axes to its edges, no east-west wrap.
  // docs/realms.md §The trap: the wrap is deleted, not flagged, so panning east hits the antimeridian
  // edge instead of coming round the other side. clampAxis is the same "clamp this axis" logic the
  // poles have always used (a province at the very edge can still be centred; the void fills beyond).
  cam.x = clampAxis(cam.x, VIEW.dx, VIEW.dw, VIEW.w);   // east-west, to the map edges
  cam.y = clampAxis(cam.y, VIEW.dy, VIEW.dh, VIEW.h);   // north-south, to the poles
}

/**
 * Put the BASE-space point (bx, by) at the centre of the viewport, optionally rescaling to `k`
 * first (clamped to the zoom range). Base space is what baseXr/baseYr and VIEW.dx/dw produce —
 * screen pixels at cam.k = 1 — so callers pass e.g. baseXr(sxSrc(lon)) for a lon/lat, or
 * VIEW.dx + fx*VIEW.dw for a world fraction.
 *
 * Commits the camera properly: centre, clampPan(), bump baseVersion. Those three go together —
 * baseVersion is the cache key for every province Path2D and the debounce gate for the legend and
 * band caption, so a centre that forgets to bump it silently paints a stale frame. This was
 * hand-inlined at four sites (focusProvince, focusProvinceFit, minimap.navTo, live.frameOn), which
 * is three chances too many to drop a step.
 *
 * Does NOT repaint — the callers differ on that (some draw immediately, the minimap coalesces).
 */
function centerOn(bx, by, k) {   // exported in the list at the foot of this module, like its neighbours
  if (k != null) cam.k = Math.max(1, Math.min(K_MAX, k));
  cam.x = VIEW.w / 2 - cam.k * bx;
  cam.y = VIEW.h / 2 - cam.k * by;
  clampPan();
  S.baseVersion++;
}

/**
 * Switch to another realm (docs/realms.md §The fog must not be mute — the one switch-realm action the
 * dropdown, the on-map arrow and opening a session all fire). Navigates to the realm's URL: the crop,
 * province set, background and minimap are all derived from ?realm= at load, so re-deriving them live
 * would mean invalidating every per-province cache — a reload is simpler, and makes each realm a
 * shareable URL and a back/forward history entry, which the doc wants anyway.
 *
 *  - no `dest`      → the dropdown: land on band WORLD, the whole realm (drops any ?p=/?z=).
 *  - dest {province[, zoom]} → the arrow / a session: land on that province (the far portal, or the
 *    colony) at the given zoom, so a crossing arrives at its far end.
 */
function switchRealm(realmKey, dest) {
  const u = new URL(location.href);
  if (realmKey) u.searchParams.set("realm", realmKey); else u.searchParams.delete("realm");
  if (dest && dest.province != null) {
    u.searchParams.set("p", dest.province);
    if (dest.zoom != null) u.searchParams.set("z", Math.round(dest.zoom));
  } else {
    u.searchParams.delete("p");
    u.searchParams.delete("z");
  }
  // a realm switch is a deliberate navigation to the MAP — don't reopen the lobby over it on the fresh
  // load (index.html's openLobbyDuringLoad honours this), else the switch reads as "nothing happened".
  try { sessionStorage.setItem("cs.realmSwitch", "1"); } catch { /* private mode — the lobby just opens */ }
  location.assign(u.toString());   // pushes history; the fresh load crops to the new realm
}

// ---- shared mutable state (was top-level lets; folded into one object so the modules
// can read/write it across the ES-module boundary) ----
export const S = {
  baseVersion: 0,        // bumped on real projection/camera change (pan/zoom/resize)
  viewVersion: 0,        // per-world-copy cache key derived from baseVersion in draw()
  showHeat: true,
  showCost: false,
  pov: "god",            // camera POV: "god" (free look) | "timeline" (coming soon)
  // the overlay (one at a time), from the URL hash for deep links. There is no `plane`: the
  // Serpentspine is a REALM now, not a second plane over this one (docs/realms.md §The Serpentspine
  // was never a plane), so `?realm=serpentspine` is what `#underworld` used to be.
  // DEFAULT TO POLITICAL, because 2D is now the political view and 3D is the terrain one. Out here
  // the map answers "who holds this", and the ground answers it only from band 5 up, where the 3D
  // terrain takes over and bands.releasePolitical drops this overlay. A hash deep-link still forces
  // any other overlay (#none for the plain physical map, #live for the Spectate session view).
  overlay: /none|physical/.test(location.hash) ? "none"
    : /nation|political/.test(location.hash) ? "nation"
    : /culture/.test(location.hash) ? "culture"
    : /faith|religion/.test(location.hash) ? "faith"
    : /live|spectate/.test(location.hash) ? "live" : "nation",
  polHi: null,           // a nation/culture/faith key to spotlight on the map (legend/search hover)
  hoverProv: null,
  dragging: false,       // mid-pan (drawPlots skips textures while panning)
  selected: null,        // journey idx or null
  selectedProv: null,    // province whose full detail fills the sidebar, or null
  techOpen: false,       // the tech-tree modal is up — paint() pauses map rendering behind it
  cityOpen: false,       // the city screen is up (same deal: a full-canvas modal over the stage)
  // the active Civ4-style advisor mode (see js/advisors.mjs) — a thin grouping ABOVE the
  // overlay/techOpen render states it maps onto. Derived from those at init, then owned
  // by setAdvisor(); the render layer still keys off overlay/techOpen, never this.
  advisor: "mainmap",
  // Screen-space glyph hit-targets (cave entrances, teleporters), rebuilt by main.paint() each frame
  // and hit-tested by the hover handler. Declared here — not conjured by the first paint — so the
  // object's shape is honest: a reader of S should not have to grep paint() to learn a field exists.
  markers: [],
  // where the camera was before a legend/search click flew it somewhere, so that focus can be undone
  camBeforeFocus: null,
  // The camera's YAW in degrees clockwise, as terrain3d actually applied it this frame (0 whenever
  // the 3D ground is not installed — ?terrain3d=0, a load still in flight, or any band below the
  // tilt ramp). Published here rather than exported from terrain3d.mjs so that north-up chrome can
  // ask "which way is the map facing" without importing three: the minimap draws its viewport as a
  // quad rotated by this, and the arrow keys would need it to pan screen-relative.
  camYaw: 0,
};

export { P, fmtInt, apiUrl, SERVER_BASE, centerOn, MAP, sxSrc, sySrc, VIEW, cam, fitView, baseXr, baseYr, pxr, pyr, px, py, pll,
  project, unproject, projectOn, pllOn, setProjector, setGroundHeight, separable, plotPxAt, affineUnproject, TCOL, LABEL_FONT, K_PLOT, K_TEX, K_MAX, TT, RIVER, SEA, SHORE, ICE_ART, BONUS_ICONS, TREES, IMPROVEMENT_OVERLAYS, SEA_BANDS, BEACH, FOAM, COAST_MASK, COAST_TILES, HILL_WASH, LAND_BLEND, TRADE_GOODS, COUNTRIES, CULTURES, RELIGIONS, provGeo, polOf, isPolitical, isUnderground, latAtScreenY, latAtSourceY, LY, NB4, terrainRgb, provSrcBox, provOnScreen, provBoxHas, lerp, provPath, cv, ctx, stage, cssVar, clampAxis, clampPan, BUNDLE, ACTIVE_REALM, switchRealm };
