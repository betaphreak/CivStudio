// Build the WorldMap's data from the committed map resources — run-independent.
//
//   node web/build.mjs [seed]        (seed only names the baked terrain asset; default 24601)
//
// Reads the committed world-bundle (content-source.mjs) for the province map + outlines
// (borders.json) + geographic hierarchy + tech tree, distils them into one
// JSON bundle written to web/data.js (which index.html loads), and bakes a dark-tinted crop of
// the real EU4 terrain raster (data/anbennar/terrain.bmp) into a real image asset at
// web/assets/terrain.png that the page references — the image is never inlined into the data.
// The live caravans come from the spectator server (the Caravans view), so NO output/<seed>
// run is needed.
//
// The baked art assets (terrain.png crop, terrain-tiles/river/sea/shore/ice/
// trees/bonus-icons) are seed-independent — their content comes from the Civ4 art and
// the whole-world raster, not the run — so they carry stable names (no seed suffix);
// only data.js is per-seed. The page loads each by the exact filename the bundle
// records (BUNDLE.<asset>.src), so stable names need no page change.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeDds } from './dds.mjs';
import { decodeTga } from './tga.mjs';
import { loadGameFont, resourceCellRGBA, CELL as GF_CELL } from './gamefont.mjs';
import { get as civ4Get, resolveArt as civ4ResolveArt, prefetch as civ4Prefetch } from './civ4.mjs';
import { decodeCached, resampleRGBA, octagonBacking, compositeCentered } from './imgutil.mjs';
import { beachRampFromAtlas } from './beachramp.mjs';
import { bundleResource, bundleResourceOpt } from './content-source.mjs';
import { prefetch as anbPrefetch, get as anbGet } from './anbennar.mjs';
import { bakeNifGroup, renderRouteNif, routeHalfExtent } from '../tools/nifbake/render.mjs';
import { PEAK_GROUP, PEAK_MANIFEST, peakVariants } from '../tools/fpk/bake-peaks.mjs';
import sharp from 'sharp';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB, '..');

// CIV4'S OWN GROUND COMPOSITE, and the two invented numbers it replaced.
//
// A TerrainArtInfo binds `<Path>` (a 4×8 sheet of 32 authored cells — the terrain's painted ground,
// with the 16-way blend shapes in the low cells) and `<Detail>` (a big seamless grain sheet). Civ4
// draws the cell MODULATED BY the detail at modulate2x, which is a multiply followed by a ×2 — the
// ×2 is why the two near-neutral layers do not come out half-dark when combined.
//
// We used to do neither half. The ground tile was the DETAIL alone, box-downsampled and then
// rescaled so its mean equalled a computed display colour; that display colour was the whole-atlas
// base × detail mean × 2.35. Both were substitutes: the recolour discarded the authored base
// entirely and pushed the grain to a hue no artist chose, and 2.35 was a hand-fitted stand-in for
// the ×2 that Civ4 actually applies. Measured over the real atlases the difference is small in
// luminance (grassland: authored 100 vs the lifted 117) and total in provenance.
//
// Dropping the ×2 as well is not an option worth having: base × detail / 255 is half the authored
// value by construction (grassland lum 50), so a map built that way is dark for a reason that lives
// in nobody's art. See docs/civ4-texture-inventory.md and the `use-authored-art-not-substitutes` rule.
//
// These two live up HERE, above the module-eval bakes (bakeTerrain, some 200 lines below), because
// those call terrainRealColors during module evaluation — a const declared further down would still
// be in its temporal dead zone. Same reason `_prLookup` is hoisted; the file notes it there too.
const MODULATE2X = 2;

/** Every TerrainArtInfo `<Path>` is a 4×8 sheet of 32 square cells (256×512 at 64px, measured). */
const ATLAS_COLS = 4;

/** Corner configurations the land blend table covers: 1–14. See bakeLandBlendCells (hoisted for the same reason). */
const LAND_BLEND_CFGS = 14;

// Baked art assets ship as WebP (see docs) rather than PNG: the ground-texture atlas alone drops
// ~2.7 MB → ~0.37 MB, and the whole eager image payload roughly quarters, with no visible loss.
// sharp's encoder is async, so bakes stay synchronous and just QUEUE their raw pixels here (the
// same contiguous (rgb, alpha) buffers the bakes build); flushImages() encodes the queue to WebP in one async
// pass before the bundle is written. Photographic layers (terrain raster, tile atlas, water tiles)
// use lossy quality; hard-edged sprites/icons use a high quality with full-quality alpha so their
// cut-out edges stay crisp. Browser support for WebP is universal, so no fallback is shipped.
const IMAGE_QUEUE = [];
// Interleave a contiguous rgb (w·h·3) + optional alpha (w·h) — the layout the bakes produce — into
// the RGB/RGBA buffer sharp's raw input wants.
function toRaw(w, h, rgb, alpha) {
  if (!alpha) return { raw: rgb, channels: 3 };
  const out = Buffer.allocUnsafe(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2]; out[i * 4 + 3] = alpha[i];
  }
  return { raw: out, channels: 4 };
}
// Queue an image for WebP encoding and return its `assets/<name>.webp` src.
function queueWebp(name, w, h, rgb, alpha, opts = {}) {
  const { raw, channels } = toRaw(w, h, rgb, alpha);
  IMAGE_QUEUE.push({ name, w, h, raw, channels, quality: opts.quality ?? 82 });
  return `assets/${name}.webp`;
}
// Queue a pre-interleaved RGBA buffer (w·h·4) — used by the nif sprite baker, which builds RGBA.
function queueWebpRGBA(name, w, h, rgba, opts = {}) {
  IMAGE_QUEUE.push({ name, w, h, raw: rgba, channels: 4, quality: opts.quality ?? 82 });
  return `assets/${name}.webp`;
}
// Encode every queued image to assets/<name>.webp; returns {name.webp: byteLength} for the size logs.
async function flushImages(assets) {
  fs.mkdirSync(assets, { recursive: true });
  const sizes = {};
  for (const im of IMAGE_QUEUE) {
    const buf = await sharp(im.raw, { raw: { width: im.w, height: im.h, channels: im.channels } })
      .webp({ quality: im.quality, alphaQuality: 100, effort: 5 })
      .toBuffer();
    const file = `${im.name}.webp`;                    // name may carry a category subfolder (e.g. water/river)
    const out = path.join(assets, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    sizes[file] = buf.length;
  }
  return sizes;
}
// The map is run-independent: the site's live caravans come from the server (see Caravans
// view / docs/client-server.md), so build.mjs no longer reads a recorded run — only the
// committed map/geo/terrain/tech resources. SEED still names the baked terrain assets.
const SEED = process.argv[2] || '24601';

const allProv = bundleResource('/map/provinces.json');
const byId = new Map(allProv.map(p => [p.id, p]));

// land-like province types: dry surface LAND, the four underground Dwarovar types, and the
// seven special Anbennar surface terrains — all settleable, all shipped and rendered. See
// docs/underworld.md.
const LANDLIKE = new Set(["LAND",
  "CAVERN", "DWARVEN_HOLD", "DWARVEN_HOLD_SURFACE", "DWARVEN_ROAD",
  "ANCIENT_FOREST", "GLADEWAY", "FEY_GLADEWAY", "BLOODGROVES", "MUSHROOM_FOREST",
  "SHADOW_SWAMP", "GLACIER", "URBAN"]);

// WorldMap: ship every land-like province (the whole world, surface + underground), not
// just the caravan crop — the caravan run only supplies the optional Caravan-mode overlay.
const sub = new Set(allProv.filter(p => LANDLIKE.has(p.type)).map(p => p.id));

// coastal water provinces (SEA/LAKE) that generated a shelf field also ship, so their near-shore
// resource plots render (docs/coastlines.md Phase F). They carry NO ocean polygon — the border
// exporter skips oceans — so a plot-extent bbox (computed in packPlots) drives their culling
// instead. Deep-ocean provinces with no shelf have no grid and are left out.
const provinceDir = path.join(ROOT, 'civstudio-engine/src/main/resources/map/provinces');
const water = new Set(allProv
  .filter(p => (p.type === "SEA" || p.type === "LAKE") && fs.existsSync(path.join(provinceDir, `${p.id}.json.gz`)))
  .map(p => p.id));
const shipped = new Set([...sub, ...water]);   // every province the page ships (land + coastal water)

// canonical province outlines (source-pixel rings), attached to the displayed subset
const borders = JSON.parse(fs.readFileSync(path.join(ROOT, 'civstudio-server/src/main/resources/map/borders.json'), 'utf8'));
const ringsById = new Map(borders.map(b => [b.id, b.rings]));

// The geographic-tier boundary polygons (continent / super-region / region) are no longer baked
// here: the server serves them straight from the engine jar's map/tierborders.json at GET
// /api/tiers (web/js/overlays/tiers.mjs), so there is no committed assets/tiers.json to copy.

// geographic hierarchy display names, keyed for per-province lookup and the label rollup.
// Continent names mirror Continent.java displayName() (the Anbennar landmass per EU4 raw key).
const CONTINENT_NAME = {
  europe: 'Cannor', asia: 'Haless', africa: 'Sarhal', north_america: 'Aelantir',
  south_america: 'Aelantir', serpentspine: 'Serpentspine', oceania: 'Hinuilands',
};
const superRegions = bundleResource('/map/superregions.json');
const regionsMeta = bundleResource('/map/regions.json');
const areasMeta = bundleResource('/map/areas.json');
const srNameByRegion = {};   // region key -> super-region display name
const srKeyByRegion = {};    // region key -> super-region raw (Clausewitz) key
for (const s of superRegions) for (const rk of s.regions) { srNameByRegion[rk] = s.name; srKeyByRegion[rk] = s.key; }
const regionDisplayName = {};   // region key -> display name
for (const r of regionsMeta) regionDisplayName[r.key] = r.name;
const areaDisplayName = {};   // area key -> display name
for (const a of areasMeta) areaDisplayName[a.key] = a.name;

// political reference tables (optional resources; the political map mode colours
// province polygons by their owner tag, and joins culture/religion for the sidebar)
const countryByTag = Object.fromEntries(bundleResourceOpt('/map/countries.json').map(c => [c.tag, { name: c.name, color: c.color }]));
const cultureByKey = Object.fromEntries(bundleResourceOpt('/map/cultures.json').map(c => [c.key, { name: c.name, group: c.group, color: c.color }]));
const religionByKey = Object.fromEntries(bundleResourceOpt('/map/religions.json').map(r => [r.key, { name: r.name, group: r.group, color: r.color }]));

// ---- EU4-style label baseline (phase b): the curved spine a province name is laid along ----
// Approximates the polygon's medial axis: scanline-rasterise the interior, take the shape's
// principal axis (PCA), then slice the interior perpendicular to that axis and take each slice's
// mid-line — the sequence of slice midpoints is a curve that bends with the shape. Returns
// { t: <thickness px>, p: [[x,y],…] } in SOURCE pixels (a few smoothed control points), or null
// for a ring-less / too-thin province (the client then falls back to the straight principal axis).
function labelBaseline(rings) {
  if (!rings || !rings.length) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const edges = [];
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    edges.push([a[0], a[1], b[0], b[1]]);
    if (a[0] < x0) x0 = a[0]; if (a[0] > x1) x1 = a[0]; if (a[1] < y0) y0 = a[1]; if (a[1] > y1) y1 = a[1];
  }
  const W = x1 - x0, H = y1 - y0;
  if (W < 3 || H < 3) return null;
  const step = Math.max(1, Math.round(Math.max(W, H) / 110));   // ~110 samples across the long side
  // scanline fill → interior sample points (even-odd rule)
  const pts = [];
  for (let y = y0 + step / 2; y < y1; y += step) {
    const xs = [];
    for (const [ax, ay, bx, by] of edges)
      if ((ay <= y) !== (by <= y)) xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2)
      for (let x = xs[i] + step / 2; x < xs[i + 1]; x += step) pts.push([x, y]);
  }
  if (pts.length < 8) return null;
  // PCA over the interior samples → principal (long) direction u, perpendicular v
  let n = pts.length, cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { const dx = x - cx, dy = y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  // bin the interior by axis coordinate t; each bin's mean perpendicular s is a spine point, its
  // s-range is the local width (→ thickness)
  let tmin = 1e9, tmax = -1e9;
  const T = pts.map(([x, y]) => { const t = (x - cx) * ux + (y - cy) * uy; if (t < tmin) tmin = t; if (t > tmax) tmax = t; return t; });
  const K = 8, span = (tmax - tmin) || 1;
  const sum = new Array(K).fill(0), cnt = new Array(K).fill(0), smin = new Array(K).fill(1e9), smax = new Array(K).fill(-1e9);
  for (let i = 0; i < n; i++) {
    const k = Math.max(0, Math.min(K - 1, Math.floor((T[i] - tmin) / span * K)));
    const s = (pts[i][0] - cx) * vx + (pts[i][1] - cy) * vy;
    sum[k] += s; cnt[k]++; if (s < smin[k]) smin[k] = s; if (s > smax[k]) smax[k] = s;
  }
  const mean = [], widths = [];
  for (let k = 0; k < K; k++) if (cnt[k]) { mean[k] = sum[k] / cnt[k]; widths.push(smax[k] - smin[k]); } else mean[k] = null;
  if (widths.length < 2) return null;
  // smooth the spine (moving average over the filled bins), then emit a control point per filled bin
  const out = [];
  for (let k = 0; k < K; k++) {
    if (mean[k] == null) continue;
    let acc = 0, m = 0;
    for (let d = -1; d <= 1; d++) if (mean[k + d] != null) { acc += mean[k + d]; m++; }
    const s = acc / m, t = tmin + (k + 0.5) / K * span;
    out.push([Math.round(cx + t * ux + s * vx), Math.round(cy + t * uy + s * vy)]);
  }
  if (out.length < 2) return null;
  widths.sort((a, b) => a - b);
  const thick = widths[widths.length >> 1];   // thickness = median slice width
  // only ship a curved baseline when the spine actually bends: a straight/convex province is served
  // identically by the client's own principal-axis fallback, so shipping it would just bloat data.js.
  // Keep it when the max deviation of the spine from its end-to-end chord is ≥ ~a fifth of the width.
  const a = out[0], b = out[out.length - 1], cl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let maxDev = 0;
  for (let i = 1; i < out.length - 1; i++) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - out[i][1]) - (a[0] - out[i][0]) * (b[1] - a[1])) / cl;
    if (d > maxDev) maxDev = d;
  }
  if (maxDev < thick * 0.22) return null;
  return { t: Math.round(thick), p: out };
}

const provinces = [...shipped].map(id => byId.get(id)).filter(Boolean).map(p => ({
  id: p.id, name: p.name, lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3),
  plots: p.plots, waterPlots: p.waterPlots || 0, type: p.type,
  // EU4 development (base_tax + base_production + base_manpower) and the city_terrain flag. Kept in
  // step with the server's projection in WorldBundle.projectProvince: the two bundle producers must
  // agree, or the same rail reads one thing off /api/bundle and another off a static bake.
  dev: (p.base_tax || 0) + (p.base_production || 0) + (p.base_manpower || 0),
  ...(p.city ? { city: true } : {}),   // omitted when false — only the 113 cities carry the key
  // geography as raw Clausewitz keys only; display names are resolved client-side from the shipped
  // `geoNames` dictionaries (interning them here duplicated ~850 KB of names across all provinces)
  region: p.region || null, area: p.area || null, continent: p.continent || null,
  realm: p.realm || null,                // which realm's crop this province belongs to (Phase 1); groups the per-realm bakes
  winter: p.winter || null,
  nb: p.neighbors.filter(n => shipped.has(n)),
  rings: ringsById.get(p.id) || null,    // outline in source pixels (null for sea/lake → bbox culls, packPlots)
  lab: labelBaseline(ringsById.get(p.id)),   // curved label baseline (medial spine); null → client uses the straight axis
}));

// ---- bake the dark terrain background from the real EU4 raster ----
// provinces.json derived each province's coordinates from terrain.bmp pixels:
//   lon = (cx - xmin) / (xmax - xmin) * 360 - 180   (linear in pixel x; xmin≈0, xmax≈W-1)
//   lat = mercatorLatitude(pixel y)                 (web-mercator in pixel y)
// so lon/lat invert back to the exact source pixel, and a crop aligns 1:1 with
// the province dots as long as the page projects with the same two formulas.
// realm fog-mask lookup state, declared here (not by provinceRealmLookup/realmAt below) because the
// per-realm bakes call those at module-eval, before a `let` further down would leave its dead zone.
let _prLookup = null;
const PBMP_ROW = 5632 * 3;   // provinces.bmp: 24-bit, width a multiple of 4 → no row padding

const map = bakeTerrain(provinces);

// ---- per-realm crops + background bakes (docs/realms.md Phase 3 — Crop and bake) ----
// Each realm crops to its own provinces' pixel extent, baked at up to 2816px — so it spends the same
// output budget on ~45% of the world, roughly 2× the detail. The whole-world `map` above stays the
// DEFAULT view; the client selects a realm's crop via ?realm= (Phase 5 turns that into the dropdown
// default). Realm.NONE provinces (the 3 quirks + deep ocean) belong to no realm and are not baked.
const REALM_KEYS = ['halcann', 'aelantir', 'hinuilands'];
const realms = {};
for (const rk of REALM_KEYS) {
  const rprovs = provinces.filter(p => p.realm === rk);
  if (!rprovs.length) { console.warn(`  realm ${rk}: no provinces — skipped`); continue; }
  assertContiguousX(rprovs, rk);
  realms[rk] = { map: bakeTerrain(rprovs, `terrain/terrain-${rk}`, rk) };
  console.log(`  realm ${rk}: ${rprovs.length} provinces, crop ${realms[rk].map.dw}×${realms[rk].map.dh}px`);
}

// Fail loudly if a realm's provinces straddle the antimeridian (non-contiguous in x). Every realm is
// contiguous once the three quirks are Realm.NONE (docs/realms.md §Three quirk provinces), and each is
// ≤46% of the raster wide — so a span past ~70% means a seam-straddling province slipped in. Drop it or
// fix its continent; the roll does not come back to accommodate it (§Assert the no-roll invariant).
function assertContiguousX(provs, realmKey) {
  const W = 5632;
  const sx = lon => (lon + 180) / 360 * (W - 1);
  let x0 = 1e9, x1 = -1e9;
  for (const p of provs) { const x = sx(p.lon); if (x < x0) x0 = x; if (x > x1) x1 = x; }
  const span = x1 - x0;
  if (span > W * 0.7)
    throw new Error(`realm ${realmKey} spans ${(span / W * 100).toFixed(0)}% of the raster in x — a `
      + `province straddles the antimeridian (non-contiguous). Drop it or fix its continent `
      + `(docs/realms.md §Three quirk provinces); the roll is not coming back.`);
}

// per-plot terrain zoom layer (a base WorldMap layer the Caravan View draws over):
// pack every displayed province's canonical plot grid into one range-fetched
// plots.pack (index inlined below), and expose the terrain display colours the
// page tints plots with (docs §10). Slice B also bakes a real ground-texture
// atlas the page draws per plot at deep zoom.
// ---- routes (roads / trails / rails) config — used by the prefetch below and bakeRoutes() later.
// docs/route-rendering.md. The three route TIERS the map draws, each a C2C route style: a dirt TRAIL,
// a stone ROAD, a RAILROAD. Declared here (above the prefetch) so routeArtPaths() can warm them.
// `byType` maps the engine's Plot.routeType (RouteType.type) onto a tier.
const ROUTE_TIERS = [
  { key: 'trail', nifDir: 'path',         prefix: 'road',     tex: 'Art/Terrain/Routes/path/roadprimitive.dds' },
  { key: 'road',  nifDir: 'roman roads',  prefix: 'road',     tex: 'Art/Terrain/Routes/roman roads/roadroman.dds' },
  { key: 'rail',  nifDir: 'modrailroads', prefix: 'railroad', tex: 'Art/Terrain/Routes/railroads/railroad.dds' },
];
// semantic piece → Civ4 route-model connection (route-models.json) → candidate filename stems, in
// order (split-LoD styles carry a `-000`, unsplit ones don't). The canonical orientation is baked;
// the draw layer rotates by 90° multiples to cover the other masks (Civ4 `Rotations "0 90 180 270"`).
const ROUTE_PIECES = [
  { name: 'iso',      conn: '-',       stems: ['a00'] },              // isolated nub
  { name: 'end',      conn: 'N',       stems: ['a01'] },              // terminus (points N)
  { name: 'straight', conn: 'N S',     stems: ['b03-000', 'b03'] },   // through (│, N–S)
  { name: 'corner',   conn: 'N E',     stems: ['b05-000', 'b05'] },   // L-turn (└)
  { name: 'tee',      conn: 'N NE S',  stems: ['c07', 'c07-000'] },   // Y/T junction
  { name: 'cross',    conn: 'N E S W', stems: ['d01-000', 'd01'] },   // + crossroads
];
const ROUTE_BY_TYPE = {
  ROUTE_TRAIL: 'trail', ROUTE_PATH: 'trail',
  ROUTE_ROAD: 'road', ROUTE_PAVED_ROAD: 'road',
  ROUTE_RAILROAD: 'rail',
};
const SIZE_ROUTE = 96;   // px longest-side each piece renders at, before atlas packing

// The three class backing colours the resource octagons are drawn on. These were sampled out of
// Civ6's Resources256 atlas; with the Civ6 depot gone they are the measured values, kept as constants
// so the icon set still reads as one backed style rather than losing its class colour-coding.
const CLASS_BACKING_RGB = { bonus: [196, 148, 40], luxury: [82, 54, 112], strategic: [156, 44, 40] };

// The SURF — real Civ4 foam for the water's edge (docs/civ4-texture-inventory.md §4 P2).
//
// `waves/wave_crest.dds` is 256×128 of pure WHITE rgb with the whole shape in its ALPHA: a scalloped
// foam band starting at row 2, densest at rows 8–13, trailing off to nothing by ~row 48. So it is a
// foam MASK, not a colour texture, and it tiles along its 256px axis — exactly a shoreline strip.
//
// Its sibling `wave_base.dds` is NOT used, and that is a finding rather than an oversight: its rgb is
// flat grey and its alpha peaks at 153 with a mean of 20 — a near-empty smudge with no structure. The
// pair reads as "soft base + white crest" in the file listing; measured, only the crest carries art.
//
// Returns {src, w, h} (RGBA, so the renderer can tint and stamp it) or null when the art is absent —
// drawFoam then keeps its procedural white feather.
//
// Only the CREST is kept, not the whole wash. The alpha runs 2..~48, but it is dense over rows 3–21
// and then trails at a tenth of that for another 27 — and shipping the trail made the shoreline read
// as a pale haze at map zooms rather than a line of surf, because a few screen pixels cannot resolve
// a long soft ramp. Cropping to the dense rows gives a crisp lap that survives downscaling.
const FOAM_ROWS = 26;                                  // rows of wave_crest that carry the dense crest

// THE COAST TILES — Civ4's painted shore transition tiles, and the authored table that picks between
// them (docs/civ4-texture-inventory.md §4 P3, the "wiggle" half).
//
// `textures/coast*blend.dds` is a 4x8 atlas of 32 hand-painted 128px tiles: sand, shallows and deep
// water with the shoreline carried in the alpha. `CIV4ArtDefines_Terrain.xml` says which cell to draw
// for each 4-bit diagonal configuration, and at what rotation — `<TextureBlend3>3,0  7,180  11,0 …`
// is config 3 offering cells 3/7/11/… as VARIANTS, each with its own rotation. Variants are what stop
// a long coastline repeating one painted curve, so they are kept and the renderer picks per plot.
//
// This is drawn on the WATER plot, never the land one — see coast.mjs extendCoastIntoWater for why
// that direction is the whole point.
//
// Returns {cell, cols, blend:{cfg:[[cell,rot],…]}, temp/trop/polar:{src}} or null.
const COAST_TILE_ATLASES = {
  temp:  ['Art/Terrain/textures/coastblend.dds',      'ART_DEF_TERRAIN_COAST'],
  trop:  ['Art/Terrain/textures/coasttropblend.dds',  'ART_DEF_TERRAIN_COAST_TROPICAL'],
  polar: ['Art/Terrain/textures/coastpolarblend.dds', 'ART_DEF_TERRAIN_COAST_POLAR'],
};

// The ocean's LAST-RESORT colours, used only when the sea art cannot be decoded. These were the
// `SEA_ANCHOR` luminances the sea bands were pinned to: the art supplied the hue and this supplied the
// brightness, which made it the one invented number left in the water pipeline. bakeSeaBands now puts
// the sea on the same rule as every land terrain (base × detail, lifted), so these are a fallback
// rather than the answer. See docs/civ4-texture-inventory.md §6.
const SEA_FALLBACK = { trop: [38, 82, 108], temp: [30, 66, 96], polar: [36, 62, 82] };

/**
 * The cells the authored blend table names for config 15 — all four corners this same terrain, i.e.
 * the FLAT INTERIOR ground with no blend in it. That is the authored answer to "which pixels are
 * this terrain", and it is per-terrain data rather than a guess: 17 variants for each of the 16 land
 * terrains (cells 15,16,18..32), the single cell 29 for all eight water terrains.
 *
 * Empty for the nine synthetic terrains (cavern, mushroom forest, glacier, urban, …), which have no
 * `CIV4ArtDefines_Terrain.xml` entry at all — see the fallback in bakeTerrainTiles.
 */
function interiorCells(e) {
  return String((e.blend && e.blend['15']) || '')
    .split(/\s+/).filter(Boolean).map(s => +s.split(',')[0]).filter(n => n > 0);
}

// Warm the C2C art cache in parallel so the synchronous resolveArt/loadGameFont bakes below hit the
// disk cache instead of a per-file round trip (see civ4.mjs). Collect the terrain-art manifest's
// textures plus the water/tree/foam art the bakes reference by literal path; a miss just falls back
// to the sync fetch, so this list only needs to cover the bulk to be worth it.
await (async () => {
  const arts = [];
  for (const e of bundleResourceOpt('/map/terrain-art.json')) arts.push(e.path, e.grid, e.detail);
  arts.push(
    'Art/Terrain/Routes/Rivers/allriverssmall.dds', 'Art/Terrain/waves/wave_crest.dds',
    'Art/Terrain/textures/water/seadetail.dds', 'Art/Terrain/textures/water/shoredetail.dds',
    'Art/Terrain/textures/water/seablend.dds', 'Art/Terrain/textures/water/seatropblend.dds',
    'Art/Terrain/textures/water/seapolblend.dds', 'Art/Terrain/textures/water/seadeepblend.dds',
    // the coast blend atlases the beach ramps are rectified out of (bakeBeachRamps), the shallows'
    // grain (bakeShoreTile), and the surf strip (bakeFoamStrip)
    'Art/Terrain/textures/coastblend.dds', 'Art/Terrain/textures/coasttropblend.dds',
    'Art/Terrain/textures/coastpolarblend.dds', 'Art/Terrain/textures/coastdetail.dds',
    ...Array.from({ length: 16 }, (_, i) =>                 // the 16-way shoreline stencil (bakeCoastMasks)
      `Art/Terrain/heightmap/coastblendmasks/coastscalemask${String(i).padStart(2, '0')}.tga`),
    'Art/Terrain/features/icepack/icepack_1024.dds', 'Art/Terrain/features/treeleafy/trees_1024.dds',
    'Art/Terrain/features/savanna/palms_1024.dds', 'Art/Terrain/features/swamp/trees1.dds');
  arts.push(...routeArtPaths());   // the road/rail segment nifs + their textures (bakeRoutes)
  await civ4Prefetch({ arts, files: ['CIV4BonusInfos.xml', 'CIV4ArtDefines_Bonus.xml', 'res/Fonts/GameFont_120.tga'] });
})();
// Warm the Anbennar trade-good icon strip + its ordering source for bakeTradeGoodIcons (see anbennar.mjs).
await anbPrefetch(['gfx/interface/resources.dds', 'common/tradegoods/00_tradegoods.txt', 'map/terrain.bmp', 'map/provinces.bmp', 'map/definition.csv']);

// The two WATER art bakes run FIRST, ahead of the terrain colours, because the water terrains take
// their display colour from them (waterColors) and the tile atlas is recoloured to those colours.
// Everything else here is independent, so this is a pure reorder.
const seaBands = bakeSeaBands();             // {trop, temp, polar, shore} climate sea + shore colours
const coastTiles = bakeCoastTiles();         // Civ4's painted shore transition tiles + the authored blend table, or null
const terrainColors = terrainDisplayColors(terrainRealColors(), waterColors(seaBands, coastTiles));
const terrainLayer = terrainLayerOrders();   // TERRAIN_* -> Civ4 LayerOrder (drives edge blending)
const terrainTiles = bakeTerrainTiles(terrainColors);
const landBlend = bakeLandBlendCells();      // Civ4's authored land transition cells, or null (renderer keeps its feather)
const river = bakeRiverTile();               // {src, tile} water tile, or null (flat-fill fallback)
const sea = bakeSeaTile();                   // {src, tile} greyscale ripple tile, or null (gradient-only fallback)
const shore = bakeShoreTile();               // {src, tile} greyscale shore-wave tile for the shallows, or null
const ice = bakeIceTile();                   // {src, tile} real Civ4 pack-ice tile, or null (procedural pale floes)
const bonusIcons = bakeBonusIcons();         // {src, cell, cols, index:{type:i}} real Civ4 resource icons, or null
const tradeGoodIcons = bakeTradeGoodIcons(); // {src, cell, cols, index:{key:col}} Anbennar trade-good icons, or null
const trees = bakeFeatureSprites();          // {leafy,palm,swamp:{src,w,h,sprites}} real foliage cutouts, or null
const routes = bakeRoutes();                 // {trail,road,rail:{src,w,h,cell:{piece:[x,y,w,h]}}} baked route sprites, or null
const improvementOverlays = bakeImprovementOverlays(); // {IMPROVEMENT_*: {src,w,h}} Civ4 improvement models via nifbake, or null
const districtTiles = null;                   // Civ6-only art, removed — no Civ4 district-hex equivalent exists
// (seaBands + coastTiles are baked above, ahead of the terrain colours that read them)
const beach = bakeBeachRamps();              // {trop, temp, polar} real Civ4 sand ramps, or null (hand-picked sand)
const foam = bakeFoamStrip();                // {src, w, h} real Civ4 wave-crest strip, or null (procedural feather)
const coastMask = bakeCoastMasks();          // {src, cell, n} Civ4 16-way shoreline stencil, or null (square plots)
const plotProvinceCount = computeWaterBboxes(provinces);

// encode every queued art asset to WebP (one async pass now the bakes have run); imgSizes feeds the
// size logs below. The bundle records each asset's .webp src, so the page loads them unchanged.
const imgSizes = await flushImages(path.join(WEB, 'assets'));

// ---- geographic label tiers (continent -> super-region -> region) ----------
// Roll the committed hierarchy up into per-tier label records {name, lat, lon, w}, where
// (lat, lon) is the plot-weighted centroid of the tier's land provinces and w its total
// plots (label priority). The page reveals a coarser/finer tier per zoom band. The name
// maps (CONTINENT_NAME / srNameByRegion / regionDisplayName) are defined above, next to the
// per-province enrichment that shares them; both Americas map to Aelantir and merge by name.

// plot-weighted centroid of the land provinces a nameFn buckets together
function rollupTier(nameFn) {
  const acc = new Map();
  for (const id of sub) {
    const p = byId.get(id);
    if (!p || !LANDLIKE.has(p.type)) continue;
    const name = nameFn(p);
    if (!name) continue;
    const w = p.plots || 1;
    const a = acc.get(name) || (acc.set(name, { name, sx: 0, sy: 0, w: 0 }).get(name));
    a.sx += p.lon * w; a.sy += p.lat * w; a.w += w;
  }
  return [...acc.values()]
    .map(a => ({ name: a.name, lon: +(a.sx / a.w).toFixed(3), lat: +(a.sy / a.w).toFixed(3), w: a.w }))
    .sort((x, y) => y.w - x.w);   // largest first = label priority
}
const geo = {
  continents: rollupTier(p => CONTINENT_NAME[p.continent]),
  superRegions: rollupTier(p => srNameByRegion[p.region]),
  regions: rollupTier(p => regionDisplayName[p.region] || null),
};

// geography display-name dictionaries, trimmed to the tiers the shipped provinces reference.
// Provinces carry only raw keys; the client resolves crumb names through these (see core.provGeo).
const usedRegions = new Set(provinces.map(p => p.region).filter(Boolean));
const usedAreas = new Set(provinces.map(p => p.area).filter(Boolean));
const usedContinents = new Set(provinces.map(p => p.continent).filter(Boolean));
const pickKeys = (src, keys) => Object.fromEntries([...keys].filter(k => src[k] != null).map(k => [k, src[k]]));
const geoNames = {
  continent: pickKeys(CONTINENT_NAME, usedContinents),
  region: pickKeys(regionDisplayName, usedRegions),
  area: pickKeys(areaDisplayName, usedAreas),
  superByRegion: pickKeys(srNameByRegion, usedRegions),      // region key -> super-region display name
  superKeyByRegion: pickKeys(srKeyByRegion, usedRegions),    // region key -> super-region raw key
};

// the political layer is split into web/political.js, fetched lazily on first switch to Political
// mode — World/Caravan never pay for it. Tables trimmed to the tags/keys owned provinces reference;
// controller shipped only when it differs from owner (occupation), else the client defaults it.
const shippedRaw = [...shipped].map(id => byId.get(id)).filter(Boolean);
const pickBy = (src, keys) => { const o = {}; for (const k of keys) if (k && src[k] && !o[k]) o[k] = src[k]; return o; };
const political = {
  countries: pickBy(countryByTag, shippedRaw.map(p => p.owner)),
  cultures: pickBy(cultureByKey, shippedRaw.map(p => p.culture)),
  religions: pickBy(religionByKey, shippedRaw.map(p => p.religion)),
  provinces: shippedRaw.filter(p => p.owner || p.culture || p.religion).map(p => ({
    id: p.id, o: p.owner || null,
    ct: (p.controller && p.controller !== p.owner) ? p.controller : null,
    c: p.culture || null, r: p.religion || null,
  })),
};
fs.writeFileSync(path.join(WEB, 'political.js'), `window.POLITICAL = ${JSON.stringify(political)};\n`);

// The per-province trade good ships in its own small web/tradegoods.js (loaded eagerly at boot — it
// draws in the default World view, unlike the lazy political layer): the icon-atlas descriptor, the
// good metadata (name/colour/category from the engine's tradegoods.json), and each shipped province's
// good key. The client stamps the icon on the province at the right zoom, like the per-plot bonuses.
const tgMeta = bundleResourceOpt('/map/tradegoods.json');
const tradeGoods = {
  icons: tradeGoodIcons,   // {src, cell, cols, index:{key:col}} or null (icon strip absent)
  goods: Object.fromEntries(tgMeta.map(g => [g.key, { name: g.name, color: g.color, category: g.category }])),
  prov: Object.fromEntries(shippedRaw.filter(p => p.trade_goods).map(p => [p.id, p.trade_goods])),
};
fs.writeFileSync(path.join(WEB, 'tradegoods.js'), `window.TRADEGOODS = ${JSON.stringify(tradeGoods)};\n`);

// committed Anbennar loading-screen art (baked locally by web/bake-loading.mjs — System.Drawing JPEG);
// the page shows one at random 1:1 (viewport crops) while the map loads. Absent → the page skips it.
const loadingDir = path.join(WEB, 'assets', 'loading');
const loading = fs.existsSync(loadingDir)
  ? fs.readdirSync(loadingDir).filter(f => /^loading-\d+\.jpg$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/))).map(f => `assets/loading/${f}`)
  : [];

// EU4 special adjacencies (straits/canals/lake crossings/Dwarovar tunnels) between provinces that
// are not visually adjacent. Short ones draw as red dotted connection lines; ones too far to draw a
// sensible line are flagged teleport=1 and the viewer marks each endpoint instead (a "teleporter",
// like the cave-entrance markers). Compact as [from, to, type, teleport]; both endpoints must ship.
const provLL = new Map(provinces.map(p => [p.id, p]));
const gcKm = (a, b) => {
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const dLa = la2 - la1, dLo = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const TELEPORT_KM = 800;   // beyond this a straight connection line would sprawl across the map
const adjacencies = (bundleResourceOpt('/map/adjacencies.json') || [])
  .filter(a => shipped.has(a.from) && shipped.has(a.to))
  .map(a => {
    const pa = provLL.get(a.from), pb = provLL.get(a.to);
    const teleport = pa && pb && gcKm(pa, pb) > TELEPORT_KM ? 1 : 0;
    return [a.from, a.to, a.type || '', teleport];
  });

// The map/geo backbone (provinces + rings + lab, geo, geoNames, adjacencies — the ~2.2 MB bulk)
// is now assembled and served by the Java spectator server from the same committed map resources
// (com.civstudio.server.web.WorldBundle -> GET /api/bundle); the browser fetches window.BUNDLE at
// boot instead of loading a committed data.js. build.mjs owns only the ASSET side: it still bakes
// every binary asset (below) and writes this small manifest describing them — the baked-file
// descriptors, the plots.pack byte index, and the ring-less provinces' cull boxes — which the
// server can't regenerate (the Civ4 art + plot grids are absent from the server image). The
// server merges this manifest into the engine-derived bundle. See docs/client-server.md and
// web/README.md. (`provinces`/`geo`/`geoNames`/`adjacencies` are still computed above — the
// terrain bake and the size logs read them — but are no longer written here.)
const bboxes = {};                    // ring-less (sea/lake) provinces' plot-extent cull box (source px)
for (const p of provinces) if (p.bbox) bboxes[p.id] = p.bbox;
const manifest = {
  seed: +SEED,
  map, realms, terrainColors, terrainLayer, terrainTiles, landBlend, river, sea, shore, ice, bonusIcons, trees, routes, improvementOverlays, districtTiles, seaBands, beach, foam, coastMask, coastTiles,
  loading,                            // committed loading-screen art (assets/loading/loading-*.jpg), or []
  bboxes,                             // {provId: [x0,y0,x1,y1]} for ring-less provinces (server can't derive)
};
// The manifest is a web-only serving artifact (not read by the engine sim), so it lives in the
// SERVER module's resources — WorldBundle loads it from the merged classpath at /map/web-asset-manifest.json.
const manifestPath = path.join(ROOT, 'civstudio-server/src/main/resources/map/web-asset-manifest.json');
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

const terrainBytes = imgSizes[map.src.replace('assets/', '')] || 0;
const manifestKb = (JSON.stringify(manifest).length / 1024).toFixed(0);
const politicalKb = (fs.statSync(path.join(WEB, 'political.js')).size / 1024).toFixed(0);
console.log(`Built civstudio-server/src/main/resources/map/web-asset-manifest.json (${manifestKb} KB, merged + served at /api/bundle) + web/political.js (${politicalKb} KB, lazy) + web/${map.src} (${(terrainBytes / 1024).toFixed(0)} KB) from seed ${SEED}`);
console.log(`  ${provinces.length} provinces (run-independent — live caravans come from the server)`);
console.log(`  terrain crop ${map.dw}×${map.dh}px`);
console.log(`  geo labels: ${geo.continents.length} continents · ${geo.superRegions.length} super-regions · ${geo.regions.length} regions`);
console.log(`  plots: ${plotProvinceCount} provinces have a canonical grid (served per-province by the server at /api/plots/{id}; ring-less bboxes computed)`);
console.log(`  terrain tiles: ${terrainTiles ? terrainTiles.src + ' (' + Object.keys(terrainTiles.cols).length + ' textures)' : 'skipped (no terrain-art.json / LFS textures)'}`);
console.log(`  land blend: ${landBlend ? `${landBlend.src} (${Object.keys(landBlend.index).length} terrains × ${landBlend.cols} configs @${landBlend.cell}px)` : 'skipped (no terrain-art.json / land blend atlases) — renderer keeps its procedural feather'}`);
console.log(`  river tile: ${river ? river.src : 'skipped (no allriverssmall.dds / LFS)'}`);
console.log(`  sea tile: ${sea ? sea.src : 'skipped (no seadetail.dds / LFS)'} · bands trop/temp/polar ${JSON.stringify([seaBands.trop, seaBands.temp, seaBands.polar])}`);
console.log(`  beach ramps: ${beach ? `real Civ4 sand, temp ${beach.temp[0].join(',')} → ${beach.temp[beach.temp.length - 1].join(',')}` : 'skipped (no coastblend.dds) — renderer keeps its hand-picked sand'}`);
console.log(`  foam strip: ${foam ? `${foam.src} (${foam.w}×${foam.h})` : 'skipped (no wave_crest.dds) — renderer keeps its procedural feather'}`);
console.log(`  coast masks: ${coastMask ? `${coastMask.src} (${coastMask.n}×${coastMask.cell}²)` : 'skipped (no coastblendmasks) — renderer keeps square coastal plots'}`);
console.log(`  coast tiles: ${coastTiles ? `${Object.keys(coastTiles.blend).length} configs, 3 bands` : 'skipped (no coast*blend.dds / XML) — renderer keeps the flat sand tint'}`);
console.log(`  ice tile: ${ice ? ice.src : 'skipped (no icepack_1024.dds / LFS)'}`);
console.log(`  improvement overlays: ${improvementOverlays ? Object.keys(improvementOverlays).length + ' Civ4 models (placement deferred)' : 'skipped (no improvement art)'}`);

// ---------------------------------------------------------------------------
// terrain baking
// ---------------------------------------------------------------------------
function bakeTerrain(provs, name = 'terrain/terrain', realmKey = null) {
  // the EU4 terrain raster is no longer vendored under data/anbennar — prefer a local copy if present,
  // else the on-demand Anbennar cache (warmed by the anbPrefetch of map/terrain.bmp above)
  const vendored = path.join(ROOT, 'data/anbennar/terrain.bmp');
  const BMP = fs.existsSync(vendored) ? vendored : anbGet('map/terrain.bmp');
  if (!BMP) throw new Error('terrain.bmp not found (vendored or in the Anbennar cache) — cannot bake terrain');
  const W = 5632, H = 2048;                       // the EU4 province raster size
  // lon/lat -> source pixel (the inverse of ProvinceExporter's forward maps)
  const sx = lon => (lon + 180) / 360 * (W - 1);
  const sy = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r / 2 + Math.PI / 4)) / Math.PI) / 2 * H; };

  // crop to the displayed provinces + a margin, in source pixels
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of provs) {
    const x = sx(p.lon), y = sy(p.lat);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const mx = (x1 - x0) * 0.06 + 40, my = (y1 - y0) * 0.08 + 40;
  x0 = Math.max(0, Math.floor(x0 - mx)); x1 = Math.min(W - 1, Math.ceil(x1 + mx));
  y0 = Math.max(0, Math.floor(y0 - my)); y1 = Math.min(H - 1, Math.ceil(y1 + my));
  const cropW = x1 - x0 + 1, cropH = y1 - y0 + 1;

  const buf = fs.readFileSync(BMP);
  const dataOff = buf.readUInt32LE(10);
  const idxAt = (x, y) => buf[dataOff + (H - 1 - y) * W + x];  // 8-bit, bottom-up, W is 4-aligned
  // realm fog mask (docs/realms.md §The background is baked): when baking one realm, resolve each land
  // pixel's province→realm from provinces.bmp and DROP the pixels that belong to another realm (the
  // Atlantic overlap — Brazil's tip in Halcann's crop, Cannor in Aelantir's). A dropped pixel is
  // treated exactly like a sea sub-pixel below (excluded from colour, lowers alpha), so foreign land
  // reads as the realm's surrounding ocean rather than a stray coastline. Pixel-accurate to the paint,
  // free per frame. The whole-world bake passes realmKey=null and masks nothing.
  const pr = realmKey ? provinceRealmLookup() : null;
  const TINT = terrainTint(terrainRealColors());
  // latitude cooling: terrain.bmp ignores latitude (it paints the far north green), so tint the
  // high-latitude land pixels toward a pale tundra tone by the C2C temperature model — mirrors
  // geo/LatitudeClimate (temp = 40 - 0.6·|lat|, cool below 12°, full below -6°). Per-pixel here, so
  // latitude-only; the per-plot terrain layer additionally folds in each province's winter severity.
  const COLD_TINT = [120, 128, 135];
  const latOfSrcY = sp => { const t = (1 - 2 * sp / H) * Math.PI; return (2 * Math.atan(Math.exp(t)) - Math.PI / 2) * 180 / Math.PI; };
  const coldBlendAt = lat => { const temp = 40 - 54 * Math.min(1, Math.abs(lat) / 90); return (temp >= 12 ? 0 : temp <= -6 ? 1 : (12 - temp) / 18) * 0.7; };

  // downsample by box-averaging the tinted colours (index averaging is meaningless);
  // the whole-world crop needs more pixels than the old caravan crop to stay legible
  const dw = Math.min(cropW, 2816);
  const scale = cropW / dw;
  const dh = Math.round(cropH / scale);
  // EVERY water index is baked TRANSPARENT — ocean, inland_ocean AND coast — so the sea layer shows
  // through and land stays opaque. Coast (35) used to be kept opaque "so its shore tint survives at
  // world zoom", painted SHALLOW [27,45,68] at full alpha. That was invisible only because the plot
  // layer covered it with a bright invented water colour; once that fill was removed the raster's own
  // dark shore band was exposed and every coastline read as BLACK SQUARES on prod. It is water, so it
  // belongs here: the shore comes from Civ4's painted coast tiles, not from a tint in the raster.
  //
  // Colour averages LAND sub-pixels only (sea tint never dilutes the land) and alpha is the land
  // fraction, so a downsampled coastal pixel is a soft, partly-transparent land edge over the water.
  const WATER = new Set([15, 17, 35]);
  const rgb = Buffer.alloc(dw * dh * 3);
  const alpha = Buffer.alloc(dw * dh);
  const sea = new Uint8Array(dw * dh);      // 1 = a pure-ocean pixel (no land sub-pixel) — depth pass fills it
  for (let j = 0; j < dh; j++) {
    const by0 = y0 + Math.floor(j * scale), by1 = Math.max(by0 + 1, y0 + Math.floor((j + 1) * scale));
    const cf = coldBlendAt(latOfSrcY((by0 + by1) / 2));   // latitude cooling blend for this row
    for (let i = 0; i < dw; i++) {
      const bx0 = x0 + Math.floor(i * scale), bx1 = Math.max(bx0 + 1, x0 + Math.floor((i + 1) * scale));
      let r = 0, g = 0, b = 0, nl = 0, ntot = 0;
      for (let yy = by0; yy < by1 && yy <= y1; yy++)
        for (let xx = bx0; xx < bx1 && xx <= x1; xx++) {
          ntot++;
          const idx = idxAt(xx, yy);
          if (WATER.has(idx)) continue;      // sea sub-pixel: excluded from colour, lowers alpha
          if (pr && realmAt(pr, xx, yy) !== realmKey) continue;   // foreign land → fogged (see the mask note above)
          const t = TINT[idx]; r += t[0]; g += t[1]; b += t[2]; nl++;
        }
      const k = j * dw + i, o = k * 3;
      if (nl > 0) {
        let cr = r / nl, cg = g / nl, cb = b / nl;
        if (cf > 0) { cr = cr * (1 - cf) + COLD_TINT[0] * cf; cg = cg * (1 - cf) + COLD_TINT[1] * cf; cb = cb * (1 - cf) + COLD_TINT[2] * cf; }
        rgb[o] = cr | 0; rgb[o + 1] = cg | 0; rgb[o + 2] = cb | 0; alpha[k] = Math.round(nl / ntot * 255);
      } else sea[k] = 1;                     // pure ocean: rgb/alpha stay 0 until the depth pass below
    }
  }

  // depth banding: darken open ocean by distance from land (a bathymetry proxy — the heightmap
  // has no sea-level datum here). A distance transform over the ocean gives each sea pixel its
  // distance to the nearest coast; a smoothstep shelf→deep ramp becomes the alpha of a dark
  // seadeep tint painted into the (otherwise transparent) sea pixels, so the climate gradient
  // shows on the shelf and deep water reads dark. See docs/coastlines.md Phase C.
  const dist = distanceToLand(sea, dw, dh);
  const DEEP = seaDeepColor();               // dark deep-water tint (seadeepblend hue, dark theme)
  const DMAX = 26, MAXA = 168;               // shelf width in crop px; peak darkening alpha
  for (let k = 0; k < dw * dh; k++) {
    if (!sea[k]) continue;
    let t = Math.min(1, dist[k] / DMAX); t = t * t * (3 - 2 * t);   // smoothstep: 0 at the coast → 1 in the deep
    alpha[k] = Math.round(t * MAXA);
    const o = k * 3; rgb[o] = DEEP[0]; rgb[o + 1] = DEEP[1]; rgb[o + 2] = DEEP[2];
  }

  // the terrain crop is a real image asset (not inlined into the data); RGBA so the sea is
  // transparent. Lossy WebP with full-quality alpha: the raster is the blurred base under the crisp
  // per-plot terrain and shown small at world view, so lossy RGB is invisible while alphaQuality 100
  // keeps the coastline cut-out sharp.
  const src = queueWebp(name, dw, dh, rgb, alpha, { quality: 80 });

  return {
    src,
    // the crop's extent in source-pixel space; the page re-derives sx/sy and
    // places dots at (sx-x0)/(x1-x0), (sy-y0)/(y1-y0) over this same image.
    x0, y0, x1, y1, W, H, dw, dh,
  };
}

// ---- realm fog mask lookup: provinces.bmp (province-per-pixel) → realm ----
// Lazily loaded once and shared across the per-realm bakes. provinces.bmp is a 24-bit BGR raster
// (one unique colour per province, bottom-up); definition.csv maps that colour → province id, and
// the shipped provinces carry their realm (Phase 1). We fold both into one colour→realm map so a
// pixel resolves with a single lookup. This is the same raster/decode ProvinceExporter reads on the
// Java side (colour key = r<<16 | g<<8 | b). `_prLookup`/`PBMP_ROW` are declared up by the bake calls
// (they run at module-eval before this line, so a `let` here would sit in its temporal dead zone).
function provinceRealmLookup() {
  if (_prLookup) return _prLookup;
  const bmpPath = anbGet('map/provinces.bmp');
  const defPath = anbGet('map/definition.csv');
  if (!bmpPath || !defPath)
    throw new Error('provinces.bmp / definition.csv not found (Anbennar cache) — cannot bake the realm fog mask');
  const colorToRealm = new Map();
  for (const line of fs.readFileSync(defPath, 'utf8').split(/\r?\n/).slice(1)) {   // slice(1): skip header
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split(';');
    if (p.length < 4) continue;
    const id = +p[0], r = +p[1], g = +p[2], b = +p[3];
    if (!Number.isFinite(id)) continue;
    const prov = byId.get(id);
    if (prov && prov.realm) colorToRealm.set((r << 16) | (g << 8) | b, prov.realm);
  }
  const buf = fs.readFileSync(bmpPath);
  _prLookup = { buf, dataOff: buf.readUInt32LE(10), colorToRealm };
  return _prLookup;
}
function realmAt(pr, x, y) {
  const o = pr.dataOff + (2048 - 1 - y) * PBMP_ROW + x * 3;   // bottom-up
  return pr.colorToRealm.get((pr.buf[o + 2] << 16) | (pr.buf[o + 1] << 8) | pr.buf[o]);   // BGR → RGB key
}

// EU4 terrain.bmp palette index -> a dark, in-palette colour. The BMP's own
// palette is semantic (indices are terrain categories, not real RGB), so the
// classification mirrors MapTerrainCodec: water, flat land, hill, peak, snow,
// desert, marsh, jungle — each a muted tone that fits the dashboard's dark theme.
//
// When `real` (a Map of TERRAIN_* -> real Civ4 texture colour, from terrain-art.json
// + the .dds textures) is present, the land categories take the real terrain's HUE
// but keep the hand-tuned tint's LUMINANCE — so the map stays exactly as dark, now
// coloured by real Civ4 art rather than hand-picked values (docs §10). Absent (LFS
// art not pulled), it falls back to the hand-tuned tints unchanged.
function terrainTint(real) {
  const SEA = [18, 31, 51], SHALLOW = [27, 45, 68];
  const LAND = [42, 52, 68], GRASS = [41, 55, 60], PLAIN = [52, 58, 62];
  const DESERT = [67, 61, 50], SCRUB = [58, 58, 50], MARSH = [37, 53, 57];
  const HILL = [52, 63, 84], PEAK = [88, 96, 114], SNOW = [140, 150, 172], JUNGLE = [37, 60, 53];
  const t = new Array(256).fill(LAND);
  const set = (c, ...ix) => ix.forEach(i => t[i] = c);
  set(SEA, 15, 17);                       // ocean / inland_ocean
  // (35 = coastline is in the WATER set above, so this colour is never painted into the raster; kept
  //  because terrainDisplayColors still reports a shallow tint for other consumers.)
  set(SHALLOW, 35);                       // coastline
  set(GRASS, 0, 5, 10, 11, 12, 14, 255);  // grasslands / farmlands / forest / woods
  set(HILL, 1, 8, 23, 24);                // hills / highlands / dry_highlands
  set(PLAIN, 4, 20);                      // plains / savannah
  set(DESERT, 3, 7, 19);                  // desert / desert_low / coastal_desert
  set([64, 60, 74], 2);                   // desert_mountain (peak-ish, warm)
  set(PEAK, 6);                           // mountain
  set(SNOW, 16);                          // permanent snow
  set(MARSH, 9, 13);                      // marsh / shadow_swamp
  set(SCRUB, 22);                         // drylands
  set(JUNGLE, 254);                       // jungle

  // recolour the land categories from real Civ4 terrain art (hue only; theme kept)
  if (real) {
    const use = (terrain, ...ix) => {
      const c = real.get(terrain);
      if (c) ix.forEach(i => { t[i] = hueAtLuminance(t[i], c); });
    };
    use('TERRAIN_GRASSLAND', 0, 5, 10, 11, 12, 14, 255);
    use('TERRAIN_PLAINS', 4, 20);
    use('TERRAIN_DESERT', 3, 7, 19);
    use('TERRAIN_SCRUB', 22);
    use('TERRAIN_MARSH', 9, 13);
    use('TERRAIN_LUSH', 254);             // jungle
    use('TERRAIN_PERMAFROST', 16);        // permanent snow
    // the default land fill takes the grassland hue too
    const gl = real.get('TERRAIN_GRASSLAND');
    if (gl) for (let i = 0; i < 256; i++) if (t[i] === LAND) t[i] = hueAtLuminance(LAND, gl);
  }
  return t;
}

// rec.601 luminance of an [r,g,b] (function decl: hoisted, so the top-level bakeTerrain() call
// above it can reach it)
function luma(c) { return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; }

// `real`'s hue rescaled to `base`'s luminance — authentic colour, theme brightness
function hueAtLuminance(base, real) {
  const s = luma(base) / Math.max(1, luma(real));
  return [Math.min(255, real[0] * s) | 0, Math.min(255, real[1] * s) | 0, Math.min(255, real[2] * s) | 0];
}

// Real per-terrain colours from terrain-art.json + the Civ4 .dds textures (offline
// LFS source). Each terrain's colour is its base blend texture modulated by its
// detail texture (base*detail/255 — the Civ4 layering, which recovers the hue the
// near-neutral blend textures carry only via their detail). Returns a Map keyed by
// TERRAIN_*, or null if the manifest or textures are unavailable (LFS not pulled),
// so the bake degrades to the hand-tuned tints without failing.
function terrainRealColors() {
  const arr = bundleResourceOpt('/map/terrain-art.json');
  if (!arr.length) { console.log('  terrain-art: absent from the world bundle — using hand-tuned tints'); return null; }
  // The MEAN OF THE TILE THAT SHIPS, so a terrain's flat colour and its texture cannot drift apart:
  // same authoredGroundTile, same interior cell, same modulate2x. It used to average the WHOLE base
  // atlas — all 32 cells, blend shapes and shoreline wedges included — against the detail, and then
  // lift the result by 2.35. Both halves were wrong about what a plot of this terrain looks like.
  const map = new Map();
  for (const e of arr) {
    const tile = authoredGroundTile(e, 32);
    if (!tile) continue;                       // synthetic terrains keep their authored colour below
    let r = 0, g = 0, b = 0; const n = 32 * 32;
    for (let k = 0; k < n; k++) { r += tile[k * 3]; g += tile[k * 3 + 1]; b += tile[k * 3 + 2]; }
    map.set(e.terrain, [r / n | 0, g / n | 0, b / n | 0]);
  }
  if (!map.size) { console.log('  terrain-art: no textures decoded (LFS not pulled?) — using hand-tuned tints'); return null; }
  console.log(`  terrain-art: ${map.size} terrain colours from the authored base×detail composite`);
  return map;
}

// average RGB of a Civ4 .dds texture resolved via resolveArt (data/civ4/assets, case-insensitive);
// null if the file or its format can't be read (caller falls back)
function avgDds(artPath) {
  const file = resolveArt(artPath);
  if (!file) return null;
  let img;
  try { img = decodeDds(fs.readFileSync(file)); } catch { return null; }
  let r = 0, g = 0, b = 0; const n = img.width * img.height;
  for (let i = 0; i < n; i++) { r += img.rgba[i * 4]; g += img.rgba[i * 4 + 1]; b += img.rgba[i * 4 + 2]; }
  return [r / n | 0, g / n | 0, b / n | 0];
}

// resolve an "Art/Terrain/.../X.dds" path to a real file, case-insensitively (the XML paths and
// on-disk names differ in case); null if absent. The Civ4 terrain art is no longer vendored — it is
// fetched on demand from the C2C source (UnpackedArt/art) and cached; see civ4.mjs / docs/civ4-files.md.
// A function decl (hoisted) so the early module-load bakes (bakeTerrain) can call it before this line.
function resolveArt(artPath) { return civ4ResolveArt(artPath); }

// ---------------------------------------------------------------------------
// per-plot terrain zoom layer
// ---------------------------------------------------------------------------

// the terrain display colours the plot layer tints with — the same real Civ4
// blend×detail averages the background bake uses (terrainRealColors), as hex. The
// fallback (those averages, measured once) keeps the plot layer colourful even when
// the LFS textures aren't pulled, so terrain-art.json + textures are optional here.
// (The table is inside the function so this hoisted call at module load doesn't hit
// a const in its temporal dead zone.)
// TERRAIN_* -> Civ4 LayerOrder from terrain-art.json: higher layers paint over lower,
// so the plot renderer feathers a higher-layer terrain over its lower neighbours at
// shared edges (docs §6.1). Empty if the manifest is absent (renderer keeps hard edges).
function terrainLayerOrders() {
  try {
    const a = bundleResourceOpt('/map/terrain-art.json');
    const o = {};
    for (const e of a) o[e.terrain] = e.layerOrder;
    return o;
  } catch { return {}; }
}

// The WATER display colours, measured rather than chosen — the same two art sources the renderer
// already ramps between, now bound to the terrain keys so one number serves both the tile atlas and
// the shelf gradient.
//
//   COAST/LAKE_SHORE ← coastTiles[band].water — the mean of the painted coast atlas's own cold pixels
//   SEA/LAKE         ← seaBands[band]         — the open-sea gradient's colour for that band
//
// This is the whole reason the fix that put the shallow fill back works: the coast tile and the water
// under it come from one atlas, so they agree. Binding the terrain colours to the same numbers keeps
// that true when the tile atlas recolours a ground texture to them — the grain lands in the right hue
// instead of the old invented blues (#5c9cb2 and friends), which measured 88,144,160 on screen against
// the atlas's painted water at 43,71,101 and read as an overlay swamping the art.
//
// LAKES take the TEMPERATE water colours. There is no lake atlas to measure and no authored lake
// colour that would not be an invention; temperate water is also exactly what a lake renders as today
// (the old fill keyed on province latitude and had no lake case at all), so this changes no pixels
// while removing the last invented water number. What a lake gains is its own GRAIN — ShoreDetail on
// the rim, SeaDetail in the middle.
function waterColors(seaBands, coastTiles) {
  if (!seaBands || !coastTiles) return null;
  const coast = b => coastTiles[b] && coastTiles[b].water;
  const sea = b => seaBands[b] && seaBands[b].map(v => Math.round(v));
  if (!coast('temp') || !sea('temp')) return null;
  return {
    TERRAIN_COAST: coast('temp'), TERRAIN_COAST_POLAR: coast('polar'), TERRAIN_COAST_TROPICAL: coast('trop'),
    TERRAIN_SEA: sea('temp'), TERRAIN_SEA_POLAR: sea('polar'), TERRAIN_SEA_TROPICAL: sea('trop'),
    TERRAIN_LAKE_SHORE: coast('temp'), TERRAIN_LAKE: sea('temp'),
  };
}

function terrainDisplayColors(real, water) {
  const fallback = {
    TERRAIN_GRASSLAND: [81, 91, 33], TERRAIN_LUSH: [37, 74, 11], TERRAIN_PLAINS: [103, 88, 45],
    TERRAIN_SCRUB: [100, 91, 62], TERRAIN_MARSH: [65, 72, 36], TERRAIN_MUDDY: [90, 79, 51],
    TERRAIN_ROCKY: [68, 64, 62], TERRAIN_BADLAND: [89, 75, 55], TERRAIN_JAGGED: [110, 106, 100],
    TERRAIN_BARREN: [56, 48, 37], TERRAIN_DESERT: [126, 83, 40], TERRAIN_DUNES: [161, 119, 66],
    TERRAIN_SALT_FLATS: [129, 127, 123], TERRAIN_TAIGA: [101, 99, 49], TERRAIN_TUNDRA: [116, 102, 88],
    TERRAIN_PERMAFROST: [122, 132, 138],
    // authored (source-less) terrains: a dark warm cavern floor, plus the special Anbennar
    // surface terrains — fungal violet, deep old-growth, verdant/teal fey, crimson blood-grove,
    // shadowed marsh, pale glacier ice
    TERRAIN_CAVERN: [58, 45, 37], TERRAIN_MUSHROOM_FOREST: [84, 60, 98],
    TERRAIN_ANCIENT_FOREST: [30, 52, 22], TERRAIN_GLADEWAY: [56, 116, 52],
    TERRAIN_FEY_GLADEWAY: [42, 112, 98], TERRAIN_BLOODGROVES: [96, 36, 34],
    TERRAIN_SHADOW_SWAMP: [48, 46, 60], TERRAIN_GLACIER: [180, 198, 210],
    // built-up city ground — a concrete/pavement grey the city sprite stands on (docs/urban-plots.md)
    TERRAIN_URBAN: [120, 116, 110],
    // water (coastal-shelf plots only — deep ocean has no plots and stays the animated base
    // gradient). COAST is the shallow shelf, SEA the darker shelf edge, so the terrain key
    // alone gives a coast→sea depth ramp. These are the LAST-RESORT values, used only when the
    // coast/sea art fails to decode: waterColors() overrides all eight from the art below, and
    // these hand-picked blues are the invented ones the shallow-fill fix measured as wrong.
    TERRAIN_COAST: [43, 71, 101], TERRAIN_COAST_POLAR: [48, 70, 92], TERRAIN_COAST_TROPICAL: [40, 78, 106],
    TERRAIN_SEA: [30, 66, 96], TERRAIN_SEA_POLAR: [36, 62, 82], TERRAIN_SEA_TROPICAL: [38, 82, 108],
    TERRAIN_LAKE: [30, 66, 96], TERRAIN_LAKE_SHORE: [43, 71, 101],
  };
  // the synthetic terrains repurpose an existing ground texture (rocky/lush), so their
  // MEASURED average (via terrainRealColors) is the wrong hue — a cavern must read dark and
  // warm, not rocky grey. Force these to their authored colour, overriding the real average.
  const AUTHORED = ['TERRAIN_CAVERN', 'TERRAIN_MUSHROOM_FOREST', 'TERRAIN_ANCIENT_FOREST',
    'TERRAIN_GLADEWAY', 'TERRAIN_FEY_GLADEWAY', 'TERRAIN_BLOODGROVES', 'TERRAIN_SHADOW_SWAMP',
    'TERRAIN_GLACIER', 'TERRAIN_URBAN',
    'TERRAIN_COAST', 'TERRAIN_COAST_POLAR', 'TERRAIN_COAST_TROPICAL', 'TERRAIN_SEA',
    'TERRAIN_SEA_POLAR', 'TERRAIN_SEA_TROPICAL', 'TERRAIN_LAKE', 'TERRAIN_LAKE_SHORE'];
  const hex = c => '#' + [0, 1, 2].map(k => Math.max(0, Math.min(255, c[k] | 0)).toString(16).padStart(2, '0')).join('');
  // No lift. A terrain's colour is the mean of the tile that ships for it (terrainRealColors),
  // which is Civ4's own base×detail×modulate2x — so the flat fill and the texture are the same
  // article seen at two resolutions, rather than two numbers that have to be kept in step.
  const out = {};
  for (const k in fallback) out[k] = hex(fallback[k]);        // colourful default, when nothing decodes
  if (real) for (const [k, v] of real) out[k] = hex(v);       // the authored composite overrides it
  for (const k of AUTHORED) out[k] = hex(fallback[k]);        // …but authored terrains keep their hue
  // …and the eight water terrains take their colour from the coast/sea art (waterColors), which is
  // measured from the painted tile they sit under, so it outranks both. `real` now hands them the
  // mean of atlas cell 29 — the flat interior water — which is closer than the old whole-atlas
  // average but still the wrong article: what has to agree is the shallow fill and the coast TILE.
  if (water) for (const k in water) out[k] = hex(water[k]);
  return out;
}

// Slice B — bake the ground-texture atlas: for each curated terrain, Civ4's own composite of its
// authored interior cell and its authored detail grain (authoredGroundTile). The nine synthetic
// terrains, which have no Civ4 art define, keep the recolour that authors them.
// Packed as one horizontal strip the page draws per plot at deep zoom.
// Returns {src, tile, cols:{TERRAIN_*: column}}, or null if the manifest/textures are
// absent (the page then keeps the flat-colour plot tiles).
function bakeTerrainTiles(colorsHex) {
  const manifest = bundleResourceOpt('/map/terrain-art.json');
  if (!manifest.length) return null;
  const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  // Multi-LoD: one horizontal-strip atlas per tile size. Width = terrains × T must stay under WebP's
  // 16383px cap, so the tiers are small→deep [128, 256] (a bigger deep tier would need a 2D grid).
  // Source per terrain: the C2C detail texture — recoloured to the
  // terrain's display colour either way, so only the ground *pattern* changes, not the map's palette.
  const LODS = [128, 256];
  const cols = {};
  const lods = [];
  let c2cCount = 0, anyDecoded = false, authored = 0;
  for (const T of LODS) {
    const W = manifest.length * T, H = T;
    const rgb = Buffer.alloc(W * H * 3);
    let idx = 0, decoded = 0;
    for (const e of manifest) {
      // Civ4's composite where the terrain has an authored table; the authored recolour where it has
      // no art define at all. Nothing is recoloured to a display colour any more, so `colorsHex` is
      // read only on the synthetic path.
      let tile = authoredGroundTile(e, T);
      if (tile && T === LODS[0]) authored++;
      if (!tile) tile = detailTile(e.detail, hexRgb(colorsHex[e.terrain] || '#465046'), T);
      if (tile && T === LODS[0]) c2cCount++;
      if (tile) decoded++;
      const t = makeSeamless(tile || solidTile(target, T), T);   // wrap-feather so the repeat has no grid seam
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const s = (y * T + x) * 3, d = (y * W + idx * T + x) * 3;
          rgb[d] = t[s]; rgb[d + 1] = t[s + 1]; rgb[d + 2] = t[s + 2];
        }
      cols[e.terrain] = idx++;
    }
    if (decoded) anyDecoded = true;
    // 256px columns align to WebP's block grid, so per-terrain slicing (extractTiles) stays clean.
    const src = queueWebp(`terrain/terrain-tiles@${T}`, W, H, rgb, null, { quality: 82 });
    lods.push({ src, tile: T });
  }
  if (!anyDecoded) return null;   // no textures decoded → keep flat colours
  console.log(`  terrain tiles: ${c2cCount} C2C ground sources (${authored} authored base×detail×2, `
    + `${c2cCount - authored} recoloured synthetic); LoDs ${LODS.join('/')}px`);
  // src/tile default to the deep (largest) LoD so an un-migrated reader still works; `lods` is the tier list.
  const deep = lods[lods.length - 1];
  return { src: deep.src, tile: deep.tile, cols, lods };
}
// downsample a decoded image to a T×T RGB tile, then recolour so its mean = target.
// Alpha is ignored — a C2C detail texture carries the terrain in RGB and uses alpha as a mask.
function boxSample(img, T, sx = 0, sy = 0, sw = img.width, sh = img.height) {
  const bx = sw / T, by = sh / T;
  const out = new Float64Array(T * T * 3);
  for (let j = 0; j < T; j++)
    for (let i = 0; i < T; i++) {
      let r = 0, g = 0, b = 0, n = 0;
      // box-average the source region; clamp so an UPSCALE (source smaller than T — a 64px atlas
      // cell, Grass_Dark_B) still samples ≥1 pixel, else n=0 → NaN → a black tile.
      const y0 = Math.min(sy + sh - 1, sy + Math.floor(j * by)), y1 = Math.max(y0 + 1, sy + Math.floor((j + 1) * by));
      const x0 = Math.min(sx + sw - 1, sx + Math.floor(i * bx)), x1 = Math.max(x0 + 1, sx + Math.floor((i + 1) * bx));
      for (let y = y0; y < y1 && y < sy + sh && y < img.height; y++)
        for (let x = x0; x < x1 && x < sx + sw && x < img.width; x++) {
          const o = (y * img.width + x) * 4; r += img.rgba[o]; g += img.rgba[o + 1]; b += img.rgba[o + 2]; n++;
        }
      const o = (j * T + i) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  return out;
}

/**
 * The authored ground tile: this terrain's flat INTERIOR cell modulated by its DETAIL grain, at
 * Civ4's modulate2x. Both layers come from the art define; nothing here is fitted or recoloured.
 *
 * The two sheets are sampled to the same T, so the detail repeats once per interior cell. Civ4
 * samples the detail on its own UV scale — a higher frequency than the ground cell — but no scale
 * factor is carried in `CIV4ArtDefines_Terrain.xml`, and inventing one is the thing this change
 * exists to stop doing. 1:1 also keeps the grain at exactly the frequency the shipped tile already
 * had, since that tile WAS the detail sheet sampled to T; only the recolour and the lift change.
 *
 * The first interior variant is taken. The other 16 exist so Civ4's per-plot ground does not repeat,
 * which a single repeating pattern cannot express anyway — the pattern is anchored to the province
 * canvas, not to the plot grid, so it already breaks the per-plot rhythm the variants guard against.
 *
 * Null when the terrain has no authored table (the synthetic terrains) or its art will not decode.
 */
function authoredGroundTile(e, T) {
  const cells = interiorCells(e);
  if (!cells.length) return null;
  const baseFile = resolveArt(e.path), detFile = resolveArt(e.detail);
  if (!baseFile || !detFile) return null;
  const base = decodeCached(baseFile), det = decodeCached(detFile);
  if (!base || !det) return null;
  const C = base.width / ATLAS_COLS;                 // square cells, so the row pitch is the same
  const c = cells[0];
  const b = boxSample(base, T, ((c - 1) % ATLAS_COLS) * C, Math.floor((c - 1) / ATLAS_COLS) * C, C, C);
  const d = boxSample(det, T);
  const out = Buffer.alloc(T * T * 3);
  for (let k = 0; k < T * T * 3; k++) out[k] = Math.min(255, b[k] * d[k] / 255 * MODULATE2X) | 0;
  return out;
}

// as boxSample, but for the ALPHA channel — the land blend cells carry their corner mask there.
function boxSampleAlpha(img, T, sx = 0, sy = 0, sw = img.width, sh = img.height) {
  const bx = sw / T, by = sh / T;
  const out = new Float64Array(T * T);
  for (let j = 0; j < T; j++)
    for (let i = 0; i < T; i++) {
      let a = 0, n = 0;
      const y0 = Math.min(sy + sh - 1, sy + Math.floor(j * by)), y1 = Math.max(y0 + 1, sy + Math.floor((j + 1) * by));
      const x0 = Math.min(sx + sw - 1, sx + Math.floor(i * bx)), x1 = Math.max(x0 + 1, sx + Math.floor((i + 1) * bx));
      for (let y = y0; y < y1 && y < sy + sh && y < img.height; y++)
        for (let x = x0; x < x1 && x < sx + sw && x < img.width; x++) { a += img.rgba[(y * img.width + x) * 4 + 3]; n++; }
      out[j * T + i] = a / n;
    }
  return out;
}

/**
 * The land terrain's authored blend table: `{cfg: cell}` for configs 1–14, or null when this terrain
 * does not have the LAND table.
 *
 * Three tables exist across the 33 manifest entries, and this recognises the land one STRUCTURALLY
 * rather than by a terrain list: 14 configs, exactly one variant each, every rotation 0. The eight
 * water terrains carry the coast table (multi-variant and full of rotations — see bakeCoastTiles) and
 * the nine synthetic terrains carry no table at all, so both fall out here without being named.
 *
 * Config 15 (all four corners this terrain) is the flat interior and belongs to authoredGroundTile;
 * config 0 (no corner is) selects nothing and draws nothing.
 */
function landBlendTable(e) {
  if (!e.blend) return null;
  const table = {};
  for (let cfg = 1; cfg <= LAND_BLEND_CFGS; cfg++) {
    const m = /^(\d+),0$/.exec(String(e.blend[String(cfg).padStart(2, '0')] ?? '').trim());
    if (!m) return null;
    table[cfg] = +m[1];
  }
  return table;
}

/**
 * THE LAND BLEND CELLS — Civ4's hand-painted terrain transitions, and the authored table that picks
 * between them. docs/land-blend-plan.md phase 1; the coast half of the same idea is bakeCoastTiles.
 *
 * For every land terrain and every 4-bit corner configuration, `CIV4ArtDefines_Terrain.xml` names one
 * cell of that terrain's base atlas whose ALPHA is the mask for exactly those corners. So a boundary
 * between two terrains is drawn by stamping the higher terrain's cell for the corners it owns — no
 * procedural feather, no invented falloff. That the alpha really is the corner mask is not assumed:
 * this bake MEASURES it per cell (see the corner check below) and reports the tally.
 *
 * PER TERRAIN, NOT PER ATLAS. The 16 land terrains share 9 base atlases but have 16 DISTINCT detail
 * sheets — GRASSLAND, PLAINS and TAIGA all draw off PlainsBlend but grain with Grass/Plains/Taiga
 * detail respectively. Since a cell is composited base × detail × 2 (the ground's own rule, so a
 * blend cell cannot differ in palette from the ground it lands on), one cell per ATLAS would paint
 * TAIGA's transitions in PLAINS' colour. Hence 16 × 14 = 224 cells rather than 9 × 14.
 *
 * ONE TIER AT THE AUTHORED SIZE. Every land blend atlas is 256×512 of 64px cells and no hi-res
 * sibling exists in the tree, so 64 is the ceiling, not a choice. It is also more than the renderer
 * can use: the blend pass runs from ~12 px/plot and the deepest measured zoom is ~32, so the cell is
 * downscaled 2–5× even at the floor. Upscaling would only stair-step the mask — boxSample clamps to
 * nearest on an upscale — so the sheet ships single-tier, unlike the ground atlas's [128, 256].
 *
 * Returns {src, cell, cols, index:{TERRAIN_*: row}, cells:{cfg: atlas cell}} or null when the
 * manifest or the art is absent (the renderer then keeps its procedural blend).
 */
function bakeLandBlendCells() {
  const manifest = bundleResourceOpt('/map/terrain-art.json');
  if (!manifest.length) return null;
  const entries = manifest.map(e => [e, landBlendTable(e)]).filter(([, t]) => t);
  if (!entries.length) return null;
  const CELL = 64, COLS = LAND_BLEND_CFGS;
  // every land terrain names the same cell per config; ship one map, but verify rather than assume
  const table = entries[0][1];
  const shared = entries.every(([, t]) => Object.keys(table).every(k => t[k] === table[k]));

  const baked = [];
  let checked = 0, matched = 0;
  for (const [e] of entries) {
    const baseFile = resolveArt(e.path), detFile = resolveArt(e.detail);
    if (!baseFile || !detFile) continue;
    const base = decodeCached(baseFile), det = decodeCached(detFile);
    if (!base || !det) continue;
    const C = base.width / ATLAS_COLS;              // square cells, so the row pitch is the same
    const d = boxSample(det, CELL);                 // the grain, once per cell — authoredGroundTile's 1:1 rule
    const cells = [];
    for (let cfg = 1; cfg <= COLS; cfg++) {
      const c = table[cfg];
      const sx = ((c - 1) % ATLAS_COLS) * C, sy = Math.floor((c - 1) / ATLAS_COLS) * C;
      const b = boxSample(base, CELL, sx, sy, C, C);
      const a = boxSampleAlpha(base, CELL, sx, sy, C, C);
      const N = CELL * CELL;
      const rgba = Buffer.alloc(N * 4);
      // ALPHA BLEED, the same trap bakeCoastTiles documents: lossy WebP does not preserve colour
      // under alpha 0 and the cell is downscaled on screen, so whatever sits in the transparent
      // pixels is dragged back into the visible ones. Fill them with the cell's own opaque mean.
      let br = 0, bg = 0, bb = 0, bn = 0;
      for (let k = 0; k < N; k++) {
        if (a[k] < 200) continue;
        br += b[k * 3]; bg += b[k * 3 + 1]; bb += b[k * 3 + 2]; bn++;
      }
      for (let k = 0; k < N; k++) {
        const al = Math.round(a[k]);
        for (let ch = 0; ch < 3; ch++) {
          const v = al || !bn
            ? Math.min(255, b[k * 3 + ch] * d[k * 3 + ch] / 255 * MODULATE2X)
            : [br, bg, bb][ch] / bn * d[k * 3 + ch] / 255 * MODULATE2X;
          rgba[k * 4 + ch] = Math.min(255, v) | 0;
        }
        rgba[k * 4 + 3] = al;
      }
      // MEASURE the corner binding: mean alpha over the outer eighth of each corner must be set for
      // exactly the corners this config names, in the 1=NW 2=NE 4=SE 8=SW order water-terrain.mjs
      // proved for the coast. Measured over all 9 atlases this separates 240 (set) from 11 (clear),
      // so the threshold is nowhere near a boundary. Do NOT measure quadrant means instead — a
      // diagonal cell runs a soft band through its middle and quadrants read it as a set corner.
      const K = Math.max(1, CELL >> 3);
      const corner = (cx, cy) => {
        let s = 0;
        for (let y = 0; y < K; y++) for (let x = 0; x < K; x++) s += a[(cy + y) * CELL + cx + x];
        return s / (K * K);
      };
      const q = [corner(0, 0), corner(CELL - K, 0), corner(CELL - K, CELL - K), corner(0, CELL - K)];
      checked++;
      if (q.reduce((m, v, i) => m | (v > 128 ? 1 << i : 0), 0) === cfg) matched++;
      cells.push(rgba);
    }
    baked.push({ terrain: e.terrain, cells });
  }
  if (!baked.length) return null;

  const W = COLS * CELL, H = baked.length * CELL;
  const sheet = Buffer.alloc(W * H * 4);
  const index = {};
  baked.forEach(({ terrain, cells }, row) => {
    index[terrain] = row;
    cells.forEach((rgba, col) => {
      for (let y = 0; y < CELL; y++) {
        const dst = ((row * CELL + y) * W + col * CELL) * 4;
        rgba.copy(sheet, dst, y * CELL * 4, (y + 1) * CELL * 4);
      }
    });
  });
  // quality 92: the sheet is small enough that the headroom is free, and the alpha IS the artwork here
  const src = queueWebpRGBA('terrain/land-blend', W, H, sheet, { quality: 92 });
  console.log(`  land blend: ${baked.length} terrains × ${COLS} configs @${CELL}px (${W}×${H})`
    + `, corner check ${matched}/${checked}${shared ? '' : ' — WARNING: config→cell tables differ between terrains'}`);
  return { src, cell: CELL, cols: COLS, index, cells: table };
}

/**
 * Sample a texture to T and rescale it so its mean equals `target`.
 *
 * ONLY the nine SYNTHETIC terrains use this now, and for them the recolour IS the authorship rather
 * than a substitute for it: they have no Civ4 art define, so TerrainArtExporter points each at an
 * existing ground texture (cavern and urban at rocky, the forest family at lush, glacier at ice) and
 * the colour is what distinguishes them. Composite a cavern's borrowed rocky base against its rocky
 * detail and you get rocky ground, not a dark warm cavern floor. See TerrainArtExporter §SYNTHETIC.
 */
function recolorTile(img, target, T) {
  const tmp = boxSample(img, T);
  const N = T * T;
  let mr = 0, mg = 0, mb = 0;
  for (let k = 0; k < N; k++) { mr += tmp[k * 3]; mg += tmp[k * 3 + 1]; mb += tmp[k * 3 + 2]; }
  const sr = target[0] / Math.max(1, mr / N), sg = target[1] / Math.max(1, mg / N), sb = target[2] / Math.max(1, mb / N);
  const out = Buffer.alloc(N * 3);
  for (let k = 0; k < N; k++) {
    out[k * 3] = Math.min(255, tmp[k * 3] * sr) | 0;
    out[k * 3 + 1] = Math.min(255, tmp[k * 3 + 1] * sg) | 0;
    out[k * 3 + 2] = Math.min(255, tmp[k * 3 + 2] * sb) | 0;
  }
  return out;
}
// recolour a C2C detail texture (resolved via resolveArt, case-insensitive) to a T×T tile; null if unreadable.
function detailTile(artPath, target, T) {
  const file = resolveArt(artPath);
  if (!file) return null;
  const img = decodeCached(file);
  return img ? recolorTile(img, target, T) : null;
}

// a flat T×T RGB tile of one colour (fallback when a detail texture is unavailable)
function solidTile(rgbArr, T) {
  const out = Buffer.alloc(T * T * 3);
  for (let k = 0; k < T * T; k++) { out[k * 3] = rgbArr[0]; out[k * 3 + 1] = rgbArr[1]; out[k * 3 + 2] = rgbArr[2]; }
  return out;
}

// Make a T×T RGB tile tile SEAMLESSLY. The plot layer paints terrain by repeating one tile across a
// province (createPattern "repeat"), so any mismatch between a tile's opposite edges shows as a hard
// grid line every tile-period (≈8 plots) — very visible at deep zoom (the "square borders" report).
// Fix by wrap-feathering: over a thin edge margin, cross-fade each edge strip toward the copy shifted a
// half-tile, so column 0 lands on the content that sits a half-tile in (which is continuous with what
// the wrapped column T-1 lands on) — i.e. opposite edges meet. Two separable passes (x then y). Uniform
// (solid) tiles are unaffected. Stochastic ground (sand/grass/rock) hides the feather completely.
function makeSeamless(rgb, T) {
  const m = Math.max(6, T >> 4);   // feather margin (~T/16)
  const h = T >> 1;
  const blend = (src, shift) => {  // shift: (dx,dy) index offset applied with wrap at the seam
    const out = Buffer.alloc(T * T * 3);
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const edge = shift[0] ? Math.min(x, T - 1 - x) : Math.min(y, T - 1 - y);
        const w = edge < m ? 1 - edge / m : 0;          // 1 at the very edge → 0 by the margin
        const sx = (x + shift[0]) % T, sy = (y + shift[1]) % T;
        const o = (y * T + x) * 3, os = (sy * T + sx) * 3;
        for (let c = 0; c < 3; c++) out[o + c] = Math.round(src[o + c] * (1 - w) + src[os + c] * w);
      }
    return out;
  };
  return blend(blend(rgb, [h, 0]), [0, h]);   // horizontal wrap, then vertical
}

// Slice C — bake a small WATER tile from the Civ4 river texture (routes/rivers/
// allriverssmall.dds) for the plot river ribbon (docs/river-rendering.md §2, Phase 1B).
// Unlike the terrain tiles (recoloured to a flat mean), this preserves the texture's wavy
// water STRANDS — which live in the DXT5 *alpha* channel (the RGB is a near-flat water
// colour) — by modulating the map's river-blue by per-texel strand coverage: darker water
// between the strands, bright ripples on them. So the ribbon reads as flowing water rather
// than a flat fill. Returns {src, tile}, or null when the art is absent (LFS not pulled /
// file://) — the renderer then keeps the flat-fill fallback.
function bakeRiverTile() {
  const RIVER_RGB = [74, 124, 170];   // cohesive with the map's river blue
  const T = 64;
  // (An earlier cut preferred a Civ6 strategic-view water surface here; Civ6's own river tile,
  // TER_River_Water, is a strategic-view texture with baked-in flow ARROWS — ugly at full-tile fill; the
  // coast tile is clean tile-scale ripple.) recolorTile scales channels so the mean = river blue while
  // keeping the ripple.
  const artFile = resolveArt('Art/Terrain/Routes/Rivers/allriverssmall.dds');
  if (!artFile) return null;
  let img; try { img = decodeDds(fs.readFileSync(artFile)); } catch { return null; }
  const bx = img.width / T, by = img.height / T;
  const rgb = Buffer.alloc(T * T * 3);
  for (let j = 0; j < T; j++)
    for (let i = 0; i < T; i++) {
      let a = 0, n = 0;
      for (let y = Math.floor(j * by); y < Math.floor((j + 1) * by); y++)
        for (let x = Math.floor(i * bx); x < Math.floor((i + 1) * bx); x++) { a += img.rgba[(y * img.width + x) * 4 + 3]; n++; }
      const strand = a / n / 255;         // 0..1 ripple coverage, from the water texture's alpha
      const k = 0.6 + 1.5 * strand;       // dark water between strands → bright ripples on them
      const o = (j * T + i) * 3;
      rgb[o] = Math.min(255, RIVER_RGB[0] * k) | 0;
      rgb[o + 1] = Math.min(255, RIVER_RGB[1] * k) | 0;
      rgb[o + 2] = Math.min(255, RIVER_RGB[2] * k) | 0;
    }
  return { src: queueWebp('water/river', T, T, makeSeamless(rgb, T), null, { quality: 85 }), tile: T };
}

// Bake a seamless GREYSCALE ripple tile from the real Civ4 sea texture (textures/water/
// seadetail.dds) — the wave pattern only, centred on mid-grey (128). The ocean's COLOUR comes
// from the climate latitude gradient (bakeSeaBands / the web renderer); this tile is drawn over
// it with `soft-light`, so grey=128 leaves the colour untouched while darker/lighter texels
// deepen/brighten it into ripples. (seadetail carries its pattern in RGB, so we read luminance,
// unlike the river ribbon whose ripples are in the DXT5 alpha.) Returns {src, tile}, or null
// when the art is absent (LFS not pulled / file://) — the renderer then draws the flat gradient.
// CIV4-FIRST here, deliberately against the Civ6-first policy the rest of the water bakes follow
// (docs/civ6-art-replacement.md). `Art/Terrain/water/water2.dds` is a painted OCEAN SURFACE — an
// opaque blue sheet of real wave structure — whereas Civ6's SV_TerrainHexOcean is a flat strategic-
// view tile with a gentle surface. For the thing that fills most of the screen, the painted waves win.
// (This file sits in `terrain/water/`, which an earlier survey wrote off as redundant with
// `terrain/textures/water/`. It is not: that folder holds blend/detail maps, this one holds the
// surface itself, plus `ocean deep` and two bump maps.)
function bakeSeaTile() {
  const s = waterSrcImg(null, 'Art/Terrain/water/water2.dds')
    || waterSrcImg(null, 'Art/Terrain/textures/water/seadetail.dds');
  if (!s) return null;
  console.log('  sea ripple: C2C water2 (painted ocean surface)');
  return bakeRippleTile(s.img, `water/sea`, 1.6);
}

// The shore shallows carry the same treatment (docs/coastlines.md Phase D): a neutral-mean
// greyscale detail, drawn over the shallow band with `soft-light` so it grains the shore hue without
// recolouring it. A touch more contrast than the open sea so the near-shore chop reads. Null → flat
// shallows.
//
// The C2C source is `textures/coastdetail.dds`, not `water/shoredetail.dds` as it used to be. Neither
// is a wave texture — both are ground detail (coastdetail is grey shingle, shoredetail a yellow-green
// gravel), and either works as neutral grain — but `coastdetail` is the one every
// `ART_DEF_TERRAIN_*_COAST` actually binds, while `shoredetail` belongs to `ART_DEF_TERRAIN_LAKE_SHORE`.
// Our shallows are the sea shelf, so coastdetail is the correct binding. Visible only when the Civ6
// coast tile is absent, since that still wins (docs/civ6-art-replacement.md).
function bakeShoreTile() {
  const s = waterSrcImg(null, 'Art/Terrain/textures/coastdetail.dds');
  if (!s) return null;
  console.log('  shore grain: C2C coastdetail');
  return bakeRippleTile(s.img, `water/shore`, 1.3);
}

function bakeFoamStrip() {
  const file = resolveArt('Art/Terrain/waves/wave_crest.dds');
  const img = file && decodeCached(file);
  if (!img) return null;
  const W = img.width, H = Math.min(FOAM_ROWS, img.height);
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = ((y + 2) * img.width + x) * 4, d = (y * W + x) * 4;   // +2: skip the two blank rows
      out[d] = out[d + 1] = out[d + 2] = 255;                          // the art is white; keep it white
      out[d + 3] = img.rgba[s + 3];
    }
  console.log(`  foam strip: C2C wave_crest ${W}×${H}`);
  return { src: queueWebpRGBA('water/foam', W, H, out, { quality: 88 }), w: W, h: H };
}

// The COAST BLEND MASKS — Civ4's authored 16-way shoreline falloff (docs/civ4-texture-inventory.md
// §4 P3). `heightmap/coastblendmasks/coastscalemask00..15.tga` are sixteen 16×16 greyscale masks, one
// per 4-bit diagonal-sea configuration, and `ProvinceRaster.seaMask` was written to index them: its
// high nibble is NW/NE/SE/SW = the mask's TL/TR/BR/BL, so the tile index is `(plot.coast >> 4)`.
//
// POLARITY, established by measurement rather than by reading the format: white = LAND. Stitching the
// masks over a real province's plots reproduces that province's land footprint; the inverse gives its
// complement. So the emitted strip's ALPHA is the WATER coverage (255 − grey) and its RGB is black —
// the renderer uses it as a `destination-out` stencil to erase each coastal cell's sea corners.
//
// Indices 0 and 15 are both solid white in the source (Civ4's "uniform tile, nothing to blend" at
// both extremes), so both erase nothing. That is right for 0 (no diagonal sea) and wrong for 15 (all
// four diagonals sea) — but 15 is 0.9% of coastal plots and erasing it would eat a one-tile island,
// so leaving it square is the safe reading.
//
// These are palettised TGA, which web/tga.mjs only learned to read for this (see its header).
// Returns {src, cell, n} or null when the art is absent — the renderer then keeps square plots.
function bakeCoastMasks() {
  const N = 16, C = 16;                                  // 16 masks, 16×16 each
  const strip = Buffer.alloc(N * C * C * 4);
  for (let i = 0; i < N; i++) {
    const file = resolveArt(`Art/Terrain/heightmap/coastblendmasks/coastscalemask${String(i).padStart(2, '0')}.tga`);
    if (!file) return null;
    let m;
    try { m = decodeTga(fs.readFileSync(file)); } catch { return null; }
    if (m.width !== C || m.height !== C) return null;
    for (let y = 0; y < C; y++)
      for (let x = 0; x < C; x++) {
        const d = ((y * N * C) + i * C + x) * 4;         // one horizontal strip of 16 cells
        strip[d] = strip[d + 1] = strip[d + 2] = 0;
        strip[d + 3] = 255 - m.rgba[((y * C + x) << 2)]; // white = land → alpha = water coverage
      }
  }
  console.log(`  coast masks: C2C coastblendmasks ${N}×${C}²`);
  return { src: queueWebpRGBA('water/coastmask', N * C, C, strip, { quality: 100 }), cell: C, n: N };
}

function bakeCoastTiles() {
  let xml;
  // civ4Get returns the cached FILE PATH, not its contents — the same shape bakeBonusIcons consumes.
  try { xml = fs.readFileSync(civ4Get('CIV4ArtDefines_Terrain.xml'), 'utf8'); } catch { return null; }
  const out = { cell: 128, cols: 4, blend: null };
  for (const [band, [art, artDef]] of Object.entries(COAST_TILE_ATLASES)) {
    const file = resolveArt(art);
    const img = file && decodeCached(file);
    if (!img) return null;
    // THE CELL SHIPS WHOLE, WITH ITS OWN AUTHORED ALPHA. This used to keep only the sand: the alpha
    // was multiplied by a warmth ramp `(r-b)/40` so the painted water fell away. Two things were wrong
    // with that, and the second is the worse one:
    //
    //   1. It discarded half of what the art define binds. `ART_DEF_TERRAIN_COAST` binds `<Path>`
    //      (this atlas — the BASE: colour plus the painted transition) and `<Detail>` (CoastDetail —
    //      the grain). Keeping only the warm pixels throws the base's water away.
    //   2. **The alpha IS the authored shoreline shape**, and the warmth ramp overwrote it with a
    //      hand-rolled function. That is the thing §4 P3 is still listed as wanting to fix, being
    //      actively undone one stage earlier.
    //
    // The justification for it was explicit and has expired: "we have no base to replace: water plots
    // are drawn TRANSPARENT and the sea gradient behind is the ocean". Water plots carry real terrain
    // now (§6), so the cell has something coherent to sit on and its own water no longer lands on a
    // near-black gradient. That is what made shipping it whole read as dark SQUARES before: not the
    // painted water, but the absence of anything of that colour on the plots next to it.
    const n = img.width * img.height;
    const rgba = Buffer.alloc(n * 4);
    // The atlas's own painted WATER, taken from the one cell that is nothing else: cell 29 is what
    // TextureBlend15 (all four neighbours water) selects, and it measures a FLAT SOLID — alpha 255,
    // luma sd 0.0 — i.e. Civ4's interior water for this terrain, with no grain in it at all. That is
    // the colour the seabed under these tiles is painted (terrainColors via waterColors), so the tile
    // and the ground it sits on are the same number by construction rather than by a fitted mean.
    const C = out.cell, cols = out.cols, INTERIOR = 29;
    const sx0 = ((INTERIOR - 1) % cols) * C, sy0 = Math.floor((INTERIOR - 1) / cols) * C;
    let wr = 0, wg = 0, wb = 0, wn = 0;
    for (let y = 0; y < C; y++)
      for (let x = 0; x < C; x++) {
        const k = ((sy0 + y) * img.width + sx0 + x) * 4;
        wr += img.rgba[k]; wg += img.rgba[k + 1]; wb += img.rgba[k + 2]; wn++;
      }
    // ALPHA BLEED, kept: a transparent pixel's RGB is still averaged downstream — lossy WebP does not
    // preserve colour under alpha 0, and drawImage downscales a 128px cell to ~32px on screen — so
    // leaving anything dark there drags it back into the visible pixels (this is what painted a BLACK
    // band along every coastline once, bisected to exactly here). The bleed target is now the cell's
    // own OPAQUE mean rather than a global sand colour: with the authored alpha restored, what sits
    // next to a transparent pixel is whatever that cell is painted, not necessarily sand.
    let br = 0, bg = 0, bb = 0, bn = 0;
    for (let i = 0; i < n; i++) {
      if (img.rgba[i * 4 + 3] < 200) continue;
      br += img.rgba[i * 4]; bg += img.rgba[i * 4 + 1]; bb += img.rgba[i * 4 + 2]; bn++;
    }
    const bleed = bn ? [br / bn | 0, bg / bn | 0, bb / bn | 0] : [200, 185, 140];
    for (let i = 0; i < n; i++) {
      const a = img.rgba[i * 4 + 3];
      rgba[i * 4]     = a ? img.rgba[i * 4]     : bleed[0];
      rgba[i * 4 + 1] = a ? img.rgba[i * 4 + 1] : bleed[1];
      rgba[i * 4 + 2] = a ? img.rgba[i * 4 + 2] : bleed[2];
      rgba[i * 4 + 3] = a;
    }
    out[band] = {
      src: queueWebpRGBA(`water/coast-${band}`, img.width, img.height, rgba, { quality: 90 }),
      water: wn ? [wr / wn | 0, wg / wn | 0, wb / wn | 0] : null,
    };
    if (out.blend) continue;
    // parse the table off the TEMPERATE define; every coast variant carries the same 15-entry table
    const block = new RegExp(`<TerrainArtInfo>\\s*<Type>${artDef}</Type>[\\s\\S]*?</TerrainArtInfo>`).exec(xml);
    if (!block) return null;
    const blend = {};
    for (const m of block[0].matchAll(/<TextureBlend(\d+)>([\s\S]*?)<\/TextureBlend\d+>/g)) {
      const variants = m[2].trim().split(/\s+/).map(tok => tok.split(',').map(Number))
        .filter(v => v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]));
      if (variants.length) blend[+m[1]] = variants;
    }
    if (Object.keys(blend).length < 15) return null;   // a partial table would mis-tile every coast
    out.blend = blend;
  }
  const variants = Object.values(out.blend).reduce((n, v) => n + v.length, 0);
  console.log(`  coast tiles: C2C coast*blend 4x8@128 x3 bands · ${Object.keys(out.blend).length} configs, ${variants} variants`);
  return out;
}

// Bake a seamless COLOUR ice tile for the polar sea-ice floes (drawSeaIce). Civ6-first
// (docs/civ6-art-replacement.md §E): the Civ6 icecaps SV sprite, else the Civ4 pack-ice texture.
// Either way we crop a solidly-opaque cracked-ice region and downsample to a square colour tile so the
// web can texture the shelf floes with real art instead of flat white squares (docs/coastlines.md
// Phase G). Returns {src, tile} or null (no art → drawSeaIce keeps its procedural pale floes).
function bakeIceTile() {
  // Civ6-first: Features_Icecaps_Visible is a hex icecap — opaque cracked-ice centre, transparent
  // corners. Crop the central 40% (solidly-opaque ice, no transparent hex corners bleeding in), force
  // it opaque, and it tiles as a repeating pattern.
  const artFile = resolveArt('Art/Terrain/features/icepack/icepack_1024.dds');
  if (!artFile) return null;
  let img; try { img = decodeDds(fs.readFileSync(artFile)); } catch { return null; }
  const T = 256;
  const CROP = Math.floor(img.height * 0.64);   // clean cracked-ice region (skip the bottom fringe strip)
  const bx = CROP / T, by = CROP / T;           // sample a square crop of the clean region → square tile
  const rgb = Buffer.alloc(T * T * 3);
  for (let j = 0; j < T; j++)
    for (let i = 0; i < T; i++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.floor(j * by); y < Math.floor((j + 1) * by); y++)
        for (let x = Math.floor(i * bx); x < Math.floor((i + 1) * bx); x++) {
          const o = (y * img.width + x) * 4; r += img.rgba[o]; g += img.rgba[o + 1]; b += img.rgba[o + 2]; n++;
        }
      const d = j * T + i; rgb[d * 3] = r / n | 0; rgb[d * 3 + 1] = g / n | 0; rgb[d * 3 + 2] = b / n | 0;
    }
  const assets = path.join(WEB, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  return { src: queueWebp('water/ice', T, T, rgb, null, { quality: 85 }), tile: T };
}

// Bake real Civ4 foliage sprites so the plot layer can stamp actual trees/palms/reeds instead of the
// procedural blobs (docs/features-art.md). The Civ4 `trees_*.dds` files are irregular billboard sheets
// (individual cutouts on a transparent background, UV-mapped by their .nif). We extract the cutouts by
// CONNECTED-COMPONENT labelling of the alpha (no .nif needed): flood every opaque island, keep the
// tree-like ones (moderate size, foliage fill fraction, green-dominant so bark/snow/autumn variants are
// skipped), and pack the chosen cutouts into one horizontal RGBA strip. Returns {group:{src,w,h,sprites:
// [[x,y,w,h]...]}} keyed by feature group, or null when the art is absent (procedural blobs stay).
function bakeFeatureSprites() {
  // billboard-imposter (*_1024.dds) atlases the connected-component extractor handles
  const groups = {
    leafy:  'Art/Terrain/features/treeleafy/trees_1024.dds',   // FOREST / JUNGLE
    palm:   'Art/Terrain/features/savanna/palms_1024.dds',     // SAVANNA / OASIS
    swamp:  'Art/Terrain/features/swamp/trees1.dds',           // SWAMP
    bamboo: 'Art/Terrain/features/bamboo/bambooattachments.dds', // BAMBOO (leaf-cluster atlas)
  };
  const out = {};
  for (const [name, art] of Object.entries(groups)) {
    const g = bakeSpriteGroup(art, name);
    if (g) out[name] = g;
  }
  // Cactus and very-tall-grass are 3D-model-only (no billboard atlas), so render their
  // Civ4 .nif models to sprite sheets via tools/nifbake (see docs/features-art.md).
  const nif = (rel, tex, name, opts) => {
    const nifPath = resolveArt('Art/Terrain/features/' + rel), texPath = resolveArt('Art/Terrain/features/' + tex);
    if (!nifPath || !texPath) return;
    try {
      const g = bakeNifGroup([{ nif: nifPath, tex: texPath }], name, path.join(WEB, 'assets'), opts.size, opts);
      if (g) out[name] = g;
    } catch (e) { console.log(`  ${name}: nif render skipped (${e.message})`); }
  };
  // emit: route the nif atlas (interleaved RGBA) through the WebP queue as trees-<name>.webp, like
  // the billboard groups, so every foliage sprite ships WebP too
  const emit = (n, w, h, rgba) => queueWebpRGBA(`trees/trees-${n}`, w, h, rgba, { quality: 90 });
  nif('kaktus/kaktus2.nif', 'kaktus/cactus01.dds', 'cactus', { size: 220, emit });
  // PEAKS — Civ4's own mountain models, the 3D ground's relief props (docs/terrain-3d.md §Relief is props,
  // not displacement). The target screenshot keeps its terrain nearly flat and stands a mountain MODEL on
  // each peak tile; these are those models. Rendered larger than the foliage because a mountain occupies its
  // whole tile and then some, and three variants so a range is not one stencil repeated.
  //
  // THE ONLY BAKE THAT CANNOT RUN IN CI. Its input is the base game's Art0.FPK, extracted locally by
  // tools/fpk/unpack.mjs into the gitignored .civ4-fpk — C2C's UnpackedArt has no peak art at all, so the
  // on-demand GitHub fetch cannot see it either. So the atlas and its sprite record are COMMITTED by
  // tools/fpk/bake-peaks.mjs, and this reads that record when the extract is absent. Baking it here when the
  // art IS present keeps the two paths honest: same group, same renderer, same size, one definition.
  try {
    const variants = peakVariants();
    if (variants.length) {
      const g = bakeNifGroup(variants, PEAK_GROUP.name, path.join(WEB, 'assets'), PEAK_GROUP.size,
                             { size: PEAK_GROUP.size, baseFade: PEAK_GROUP.baseFade, emit });
      if (g) { out.peak = g; console.log(`  peak: ${variants.length} variant(s) baked from .civ4-fpk`); }
    } else if (fs.existsSync(PEAK_MANIFEST)) {
      out.peak = JSON.parse(fs.readFileSync(PEAK_MANIFEST, 'utf8'));
      console.log(`  peak: committed atlas (${out.peak.sprites.length} sprites) — no FPK extract here`);
    } else {
      console.log('  peak: no art and no committed atlas — PEAK plots will have no prop');
    }
  } catch (e) { console.log(`  peak: skipped (${e.message})`); }
  // (tall grass no longer bakes a billboard — it was a muddy wheat crop; the plot layer draws grass
  //  procedurally now, plots.mjs stampGrass)
  // the city sprite: a real Civ4 city model (a medieval European city cluster) baked and
  // stamped over TERRAIN_URBAN plots, sized by province development. Nested under the trees
  // group so it ships through the existing bundle plumbing. See docs/urban-plots.md.
  const cityNif = resolveArt('Art/Structures/Cities/med_europe.nif');
  const cityTex = resolveArt('Art/Structures/Cities/med_west_european_buildings.dds');
  if (cityNif && cityTex) {
    try {
      const g = bakeNifGroup([{ nif: cityNif, tex: cityTex }], 'city', path.join(WEB, 'assets'), 320, { size: 320, emit });
      if (g) out.city = g;
    } catch (e) { console.log(`  city: nif render skipped (${e.message})`); }
  } else {
    console.log('  city: nif/tex not resolved, skipped');
  }
  return Object.keys(out).length ? out : null;
}

// Every "Art/..." route path bakeRoutes touches — warmed by the top-of-file prefetch. (The
// ROUTE_TIERS / ROUTE_PIECES config it reads is declared up top, before the prefetch, to avoid a TDZ.)
function routeArtPaths() {
  const out = [];
  for (const t of ROUTE_TIERS) {
    out.push(t.tex);
    for (const p of ROUTE_PIECES) for (const s of p.stems)
      out.push(`Art/Terrain/Routes/${t.nifDir}/${t.prefix}${s}.nif`);
  }
  return out;
}

// Bake each tier's connection pieces to a horizontal-strip atlas + sprite rects, so the plot layer
// can auto-tile real Civ4 road/trail/rail art per plot. Every piece of a tier renders into the SAME
// registered `SIZE_ROUTE`×`SIZE_ROUTE` cell (world half-extent from the tier's straight piece), so
// the grid renderer stamps one cell per plot and rotates it 90°·n with no re-registration. Returns
// {trail,road,rail:{src,w,h,cellSize,cell:{piece:[x,y,w,h]},conn:{piece:connString}},
// byType:{ROUTE_*:tier}} or null when no art resolves.
function bakeRoutes() {
  const resolvePiece = (t, stems) => {   // first candidate stem that resolves → local nif path
    for (const s of stems) { const nif = resolveArt(`Art/Terrain/Routes/${t.nifDir}/${t.prefix}${s}.nif`); if (nif) return nif; }
    return null;
  };
  const tiers = {};
  for (const t of ROUTE_TIERS) {
    const texFile = resolveArt(t.tex);
    if (!texFile) { console.log(`  routes/${t.key}: texture ${t.tex} not resolved, skipped`); continue; }
    // the plot cell size: how far the tier's straight road reaches toward the plot edge
    const straightNif = resolvePiece(t, ROUTE_PIECES.find(p => p.name === 'straight').stems);
    const square = straightNif ? routeHalfExtent(straightNif) : null;
    if (!square) { console.log(`  routes/${t.key}: straight piece not resolvable, skipped`); continue; }
    const rendered = [];
    for (const p of ROUTE_PIECES) {
      const nif = resolvePiece(t, p.stems);
      if (!nif) continue;
      let img = null;
      try { img = renderRouteNif(nif, texFile, SIZE_ROUTE, { square }); } catch { img = null; }
      if (img) rendered.push({ name: p.name, conn: p.conn, img });
    }
    if (!rendered.length) { console.log(`  routes/${t.key}: no pieces rendered, skipped`); continue; }
    // pack the equal-size square cells into one RGBA strip
    const N = rendered.length, W = N * SIZE_ROUTE, H = SIZE_ROUTE;
    const rgba = Buffer.alloc(W * H * 4), cell = {}, conn = {};
    rendered.forEach((r, i) => {
      const ox = i * SIZE_ROUTE, src = r.img.rgba;
      for (let y = 0; y < SIZE_ROUTE; y++) for (let x = 0; x < SIZE_ROUTE; x++) {
        const so = (y * SIZE_ROUTE + x) * 4, d = (y * W + ox + x) * 4;
        rgba[d] = src[so]; rgba[d + 1] = src[so + 1]; rgba[d + 2] = src[so + 2]; rgba[d + 3] = src[so + 3];
      }
      cell[r.name] = [ox, 0, SIZE_ROUTE, SIZE_ROUTE]; conn[r.name] = r.conn;
    });
    const src = queueWebpRGBA(`routes/routes-${t.key}`, W, H, rgba, { quality: 90 });
    tiers[t.key] = { src, w: W, h: H, cellSize: SIZE_ROUTE, cell, conn };
    console.log(`  routes/${t.key}: ${N} pieces (${rendered.map(r => r.name).join(',')}) reach=${square.toFixed(0)} → ${W}×${H}`);
  }
  if (!Object.keys(tiers).length) return null;
  return { ...tiers, byType: ROUTE_BY_TYPE };
}
function bakeSpriteGroup(artPath, name) {
  const file = resolveArt(artPath);
  if (!file) return null;
  let img; try { img = decodeDds(fs.readFileSync(file)); } catch { return null; }
  const { width: W, height: H, rgba } = img;
  const A = 48;                                  // alpha threshold: a pixel is "solid" foliage
  const lab = new Uint8Array(W * H);             // visited flags
  const comps = [], stack = [];
  for (let y0 = 0; y0 < H; y0++) for (let x0 = 0; x0 < W; x0++) {
    const start = y0 * W + x0;
    if (lab[start] || rgba[start * 4 + 3] < A) continue;
    let minx = x0, maxx = x0, miny = y0, maxy = y0, cnt = 0, sr = 0, sg = 0, sb = 0;
    lab[start] = 1; stack.length = 0; stack.push(start);
    while (stack.length) {
      const p = stack.pop(), px = p % W, py = (p / W) | 0;
      cnt++; sr += rgba[p * 4]; sg += rgba[p * 4 + 1]; sb += rgba[p * 4 + 2];
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
      if (px > 0     && !lab[p - 1] && rgba[(p - 1) * 4 + 3] >= A) { lab[p - 1] = 1; stack.push(p - 1); }
      if (px < W - 1 && !lab[p + 1] && rgba[(p + 1) * 4 + 3] >= A) { lab[p + 1] = 1; stack.push(p + 1); }
      if (py > 0     && !lab[p - W] && rgba[(p - W) * 4 + 3] >= A) { lab[p - W] = 1; stack.push(p - W); }
      if (py < H - 1 && !lab[p + W] && rgba[(p + W) * 4 + 3] >= A) { lab[p + W] = 1; stack.push(p + W); }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    comps.push({ minx, miny, bw, bh, fill: cnt / (bw * bh), mr: sr / cnt, mg: sg / cnt, mb: sb / cnt, area: cnt });
  }
  const green = c => c.mg >= c.mr * 0.9 && c.mg >= c.mb * 0.95 && (c.mr + c.mg + c.mb) / 3 < 185;
  const shape = c => c.bw >= 22 && c.bw <= 190 && c.bh >= 22 && c.bh <= 210 && c.fill >= 0.1 && c.fill <= 0.85
    && c.bw / c.bh < 2.2 && c.bh / c.bw < 3.2;
  let cand = comps.filter(c => shape(c) && green(c));
  if (cand.length < 3) cand = comps.filter(shape);           // relax colour if the sheet isn't green-dominant
  cand.sort((a, b) => b.area - a.area);
  const chosen = cand.slice(0, 10);
  if (!chosen.length) return null;
  const GAP = 1, maxH = Math.max(...chosen.map(c => c.bh));
  let totW = 0; for (const c of chosen) totW += c.bw + GAP;
  const rgb = Buffer.alloc(totW * maxH * 3), alpha = Buffer.alloc(totW * maxH);
  const sprites = []; let ox = 0;
  for (const c of chosen) {
    for (let y = 0; y < c.bh; y++) for (let x = 0; x < c.bw; x++) {
      const so = ((c.miny + y) * W + (c.minx + x)) * 4, d = y * totW + (ox + x);
      rgb[d * 3] = rgba[so]; rgb[d * 3 + 1] = rgba[so + 1]; rgb[d * 3 + 2] = rgba[so + 2]; alpha[d] = rgba[so + 3];
    }
    sprites.push([ox, 0, c.bw, c.bh]);
    ox += c.bw + GAP;
  }
  const assets = path.join(WEB, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const src = queueWebp(`trees/trees-${name}`, totW, maxH, rgb, alpha, { quality: 90 });
  return { src, w: totW, h: maxH, sprites };
}

// Slice the real Civ4 resource icons out of GameFont_120.tga into one atlas + a {bonusType: cellIndex}
// manifest, so the web draws a true per-resource symbol on each resourced plot instead of the
// procedural category glyph (docs/bonus-sprite-bake.md). GameFont_120 is the higher-resolution font
// (25px cells vs the base GameFont.tga's 21px — crisper icons at deep zoom); its resource block is a
// fixed 25-column grid of 25px cells starting at (0,497); a bonus's cell is its FontButtonIndex
// (CIV4ArtDefines_Bonus.xml), reached through its ArtDefineTag (CIV4BonusInfos.xml). Returns null if
// any source is absent (the renderer keeps the procedural glyphs); a bonus with a negative index
// (no unique font icon) or an out-of-grid cell is left out and also falls back to the glyph.
// Bake the flat Civ6 strategic-view feature overlays (docs/civ6-art-replacement.md §D): one 128²
// RGBA tile per Civ6-covered feature (Features_<X>_Visible.dds — a top-down canopy on transparency),
// which the frontend blits to fill a featured plot instead of scattering C2C billboards. C2C-only
// flora (bamboo, cactus, tall-grass, savanna) is intentionally absent → keeps its billboard bake.
// Returns {FEATURE_*: {src,w,h}} or null (depot absent → frontend keeps all billboards).
// FEATURE OVERLAYS ARE GONE with the Civ6 depot, and nothing is lost. They were four flat
// strategic-view chips — marsh, oasis, floodplains, icecaps — and every one already had a C2C path
// that ran when Civ6 was absent: SWAMP and OASIS stamp real Civ4 billboards (docs/features-art.md),
// FLOOD_PLAINS is a ground quality that draws no foliage by design, and ICE has the icepack tile.
// featureSprite falls through to those on its own; the bundle key simply stops existing.

function bakeImprovementOverlays() {
  // Civ4's own improvement MODELS, rendered by tools/nifbake — the same offline renderer the cactus,
  // the peaks, the city and the route pieces go through. Replaces Civ6's three flat strategic-view
  // chips; Civ4 has far more improvements than that (cottage, hamlet, village, town, pasture,
  // plantation, lumbermill, fort, windmill, workshop …), so this is a table rather than a hardcoded three.
  //
  // VARIANTS, NOT DIRECTIONS. Civ4 ships no rotated copies — the engine rotates the model at draw
  // time — and this renderer does not need them either: improvementSprite blits a flat sprite and
  // already mirrors it per plot, the same convention the tree and peak billboards use. What Civ4 DOES
  // ship is variety (an_eu_farm01/02/03), and that is worth taking for the same reason the tree bake
  // keeps ten cutouts: one stamp repeated across every farm in a province reads as a pattern.
  //
  // The `_freeze0000..0003` files are NOT variants — they are animation freeze frames for Civ4's
  // animated improvements (swaying crops, a turning mine wheel). Baking them would stamp four nearly
  // identical sprites and call it variety. The `_modern` / `modern` models are ERA swaps, left for
  // whenever improvements gain an era axis.
  const IMPS = {
    IMPROVEMENT_FARM:   [['farm/an_eu_farm01.nif', 'farm/an_eu_farm02.nif', 'farm/an_eu_farm03.nif'], 'farm/farm_diff256.dds'],
    IMPROVEMENT_MINE:   [['mine/mine.nif'],                                                           'mine/mine.dds'],
    IMPROVEMENT_QUARRY: [['quarry/quarry.nif'],                                                       'quarry/quarry.dds'],
  };
  const T = 128, out = {};
  for (const [imp, [rels, tex]] of Object.entries(IMPS)) {
    const texFile = resolveArt('Art/Structures/Improvements/' + tex);
    if (!texFile) continue;
    const variants = rels.map(r => resolveArt('Art/Structures/Improvements/' + r))
      .filter(Boolean).map(nif => ({ nif, tex: texFile }));
    if (!variants.length) continue;
    const name = 'improvements/imp-' + imp.replace('IMPROVEMENT_', '').toLowerCase();
    try {
      const g = bakeNifGroup(variants, name, path.join(WEB, 'assets'), T,
        { size: T, emit: (n, w, h, rgba) => queueWebpRGBA(name, w, h, rgba, { quality: 88 }) });
      if (g) out[imp] = g;                 // {src, w, h, sprites:[[x,y,w,h]…]} — one cell per variant
    } catch (e) { console.log(`  ${imp}: nif render skipped (${e.message})`); }
  }
  if (!Object.keys(out).length) return null;
  const n = Object.values(out).reduce((a, g) => a + (g.sprites ? g.sprites.length : 1), 0);
  console.log(`  improvement overlays: ${Object.keys(out).length} Civ4 improvements, ${n} variant sprite(s) via nifbake; placement deferred`);
  return out;
}

// FEATURE OVERLAYS ARE GONE with the Civ6 depot, and nothing is lost. They were four flat
// strategic-view chips — marsh, oasis, floodplains, icecaps — and every one already had a C2C path
// that ran when Civ6 was absent: SWAMP and OASIS stamp real Civ4 billboards (docs/features-art.md),
// FLOOD_PLAINS is a ground quality that draws no foliage by design, and ICE has the icepack tile.
// featureSprite falls through to those on its own; the bundle key simply stops existing.


// DISTRICT TILES ARE GONE and there is NO Civ4 replacement, which is worth stating rather than
// papering over: districts are a Civ6 concept and Civ4 has no district-hex art of any kind. The
// nearest Civ4 things — the cottage/hamlet/village/town improvement models — are settlement-TIER art,
// not district art, and mapping CAMPUS or THEATER onto them would be invention, not a port. The
// district view keeps its C2C nifbake building sprites; only the coloured hex ground underneath is
// lost. See docs/district-buildout.md D4a.

// FOG OF WAR IS GONE and there is no Civ4 source: searched all six FPKs and Civ4 fogs through the
// engine (vertex alpha), not through a texture — the only "fog" assets in the archives are an
// explosion effect and some button icons. Nothing rendered these anyway: they were baked ahead of the
// RevealedMap that would consume them (docs/explorer-caravan.md §8), which is not built. When it is,
// the fog will need authoring or a procedural hatch rather than a port.


// desaturate + darken + mossy-tint an RGBA buffer in place-ish (returns a fresh buffer) so a district
// chip reads as an abandoned ruin. Alpha (the hex cutout) is preserved untouched.
function ruinRGBA(rgba) {
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // 85% toward luminance (near-grey), then 55% brightness, then a slight mossy-stone tint
    const mix = (c) => 0.15 * c + 0.85 * lum;
    out[i]     = Math.min(255, mix(r) * 0.58 + 12);  // faint warm/green stone cast
    out[i + 1] = Math.min(255, mix(g) * 0.58 + 14);
    out[i + 2] = Math.min(255, mix(b) * 0.54 + 8);
  }
  return out;
}

// Bake the per-plot resource icons: the C2C GameFont glyph composited on a class-coloured octagon,
// so the whole set reads as one backed style. Emitted as a @32/@64 LoD atlas.
// Returns {src, cell, cols, index, lods} or null.
function bakeBonusIcons() {
  const gf = loadGameFont(ROOT);
  let binfo = null, adef = null;
  try { binfo = civ4Get('CIV4BonusInfos.xml'); adef = civ4Get('CIV4ArtDefines_Bonus.xml'); } catch { /* C2C absent */ }
  const tagOf = {}, fbiOf = {};
  if (gf && binfo && adef) {
    for (const m of fs.readFileSync(binfo, 'utf8').matchAll(/<BonusInfo>[\s\S]*?<Type>(BONUS_[A-Z0-9_]+)<\/Type>[\s\S]*?<\/BonusInfo>/g)) {
      const a = m[0].match(/<ArtDefineTag>([^<]+)<\/ArtDefineTag>/); if (a) tagOf[m[1]] = a[1].trim();
    }
    for (const m of fs.readFileSync(adef, 'utf8').matchAll(/<BonusArtInfo>[\s\S]*?<Type>(ART_DEF_BONUS_[A-Z0-9_]+)<\/Type>[\s\S]*?<\/BonusArtInfo>/g)) {
      const f = m[0].match(/<FontButtonIndex>(-?\d+)<\/FontButtonIndex>/); if (f) fbiOf[m[1]] = +f[1];
    }
  }
  const bonuses = bundleResource('/bonuses.json');
  // C2C bonus class → which Civ6 class backing (yellow bonus / purple luxury / red strategic).
  // Local (not a module const) so this module-load-time bake doesn't hit its temporal dead zone.
  const CLASS_BACKING = {
    BONUSCLASS_LUXURY: 'luxury', BONUSCLASS_STRATEGIC: 'strategic',
    BONUSCLASS_CROP: 'bonus', BONUSCLASS_LIVESTOCK: 'bonus', BONUSCLASS_SEAFOOD: 'bonus',
    BONUSCLASS_PRODUCTION: 'bonus', BONUSCLASS_MISC: 'bonus',
  };
  const backing = CLASS_BACKING_RGB;

  const BASE = 64;                          // primary LoD cell; @32 is downscaled from it
  const picks = [];                         // [type, rgba(BASE²)]
  let c2cn = 0;
  for (const b of bonuses) {
    const bg = backing[CLASS_BACKING[b.bonusClass] || 'bonus'];
    // the C2C GameFont glyph on a matching class-coloured octagon. This used to be the FALLBACK under
    // a Civ6 Resources256 atlas cell; with Civ6 removed it is the only path, and it always covered the
    // whole set anyway — the Civ6 atlas only ever mapped a subset.
    const gcell = gf ? resourceCellRGBA(gf, fbiOf[tagOf[b.type]]) : null;
    if (!gcell) continue;                   // no glyph → skip (frontend keeps its procedural glyph)
    const cell = octagonBacking(BASE, bg);
    compositeCentered(cell, BASE, gcell, GF_CELL, GF_CELL, 0.78); c2cn++;
    picks.push([b.type, cell]);
  }
  if (!picks.length) return null;

  const cols = 16, index = {}, lods = [];
  for (const S of [32, BASE]) {
    const rows = Math.ceil(picks.length / cols), aw = cols * S, ah = rows * S;
    const rgba = Buffer.alloc(aw * ah * 4);
    picks.forEach(([type, base], i) => {
      if (S === BASE) index[type] = i;
      const src = S === BASE ? base : resampleRGBA(base, BASE, BASE, S, S);
      const dx = (i % cols) * S, dy = Math.floor(i / cols) * S;
      for (let y = 0; y < S; y++) { const so = y * S * 4, d = ((dy + y) * aw + dx) * 4; src.copy(rgba, d, so, so + S * 4); }
    });
    lods.push({ src: queueWebpRGBA(`icons/bonus-icons@${S}`, aw, ah, rgba, { quality: 90 }), cell: S, cols });
  }
  console.log(`  bonus icons: ${c2cn} C2C GameFont glyphs (class-backed), ${picks.length} total, LoDs 32/64`);
  const deep = lods[lods.length - 1];
  return { src: deep.src, cell: deep.cell, cols, count: picks.length, index, lods };
}

// Slice the per-province TRADE-GOOD icons out of Anbennar's gfx/interface/resources.dds strip into one
// atlas + a {goodKey: cellIndex} manifest — the province-level analogue of bakeBonusIcons (which is the
// per-PLOT bonus). The strip is a horizontal row of 64px cells; a good's cell index is its 0-based
// position in common/tradegoods/00_tradegoods.txt (the vanilla EU4 convention Anbennar extends). Both
// sources are fetched on demand (anbennar.mjs); returns null if either is absent so the caller can skip.
function bakeTradeGoodIcons() {
  const TG_CELL = 64;   // resources.dds is 2368×64 → 37 cells of 64×64
  const stripPath = anbGet('gfx/interface/resources.dds');
  const orderPath = anbGet('common/tradegoods/00_tradegoods.txt');
  if (!stripPath || !orderPath) return null;
  // strip index = order of the top-level `good = { ... }` blocks (depth 0), including `unknown`
  const order = topLevelBlockNames(fs.readFileSync(orderPath, 'latin1'));
  const indexOfGood = Object.fromEntries(order.map((k, i) => [k, i]));

  let strip;
  try { strip = decodeDds(fs.readFileSync(stripPath)); }   // {width,height,rgba}, DX10 uncompressed BGRA
  catch { return null; }
  if (strip.height < TG_CELL) return null;

  // bake every real good the reference layer knows (skips `unknown`, which the exporter drops too)
  const goods = bundleResource('/map/tradegoods.json');
  const picks = [];   // [key, srcCol]
  for (const g of goods) {
    const col = indexOfGood[g.key];
    if (col === undefined || (col + 1) * TG_CELL > strip.width) continue;   // not in the strip
    picks.push([g.key, col]);
  }
  if (!picks.length) return null;

  const cols = 12, rows = Math.ceil(picks.length / cols);
  const aw = cols * TG_CELL, ah = rows * TG_CELL;
  const rgba = Buffer.alloc(aw * ah * 4);
  const index = {};
  picks.forEach(([key, srcCol], i) => {
    index[key] = i;
    const sx = srcCol * TG_CELL, dx = (i % cols) * TG_CELL, dy = Math.floor(i / cols) * TG_CELL;
    for (let y = 0; y < TG_CELL; y++) {
      const so = (y * strip.width + sx) * 4, d = ((dy + y) * aw + dx) * 4;
      Buffer.from(strip.rgba.buffer, strip.rgba.byteOffset + so, TG_CELL * 4).copy(rgba, d);
    }
  });
  const src = queueWebpRGBA('icons/tradegood-icons', aw, ah, rgba, { quality: 90 });
  console.log(`  trade-good icons: ${src} (${picks.length} Anbennar resource symbols)`);
  return { src, cell: TG_CELL, cols, count: picks.length, index };
}

// The names of the top-level (brace-depth 0) `name = { ... }` blocks of a Clausewitz file, in order —
// used to recover the trade-good strip ordering from 00_tradegoods.txt.
function topLevelBlockNames(text) {
  const src = text.replace(/#.*$/gm, '');   // strip line comments
  const names = [];
  let depth = 0, i = 0;
  const re = /([A-Za-z_][\w]*)\s*=\s*\{|\{|\}/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === '}') { depth = Math.max(0, depth - 1); continue; }
    if (m[0] === '{') { depth++; continue; }
    // a `name = {` block opener
    if (depth === 0) names.push(m[1]);
    depth++;
  }
  return names;
}

// Bake a seamless GREYSCALE ripple tile from a Civ4 water detail texture — the wave pattern
// only, centred on mid-grey (128) so a `soft-light` overlay leaves the base colour untouched
// while darker/lighter texels deepen/brighten it. `contrast` scales the deviation from the
// mean. Returns {src, tile}, or null when the art is absent (LFS not pulled / file://).
// Decode a water source: the Civ6 texture (a resolved .dds path) if the depot is mounted, else the
// Civ4 art at c2cPath. Returns { img, civ6 } or null. Lets the water bakers stay Civ6-first/C2C-fallback.
function waterSrcImg(civ6Path, c2cPath) {
  if (civ6Path) { const img = decodeCached(civ6Path); if (img) return { img, civ6: true }; }
  const artFile = resolveArt(c2cPath);
  if (!artFile) return null;
  try { return { img: decodeDds(fs.readFileSync(artFile)), civ6: false }; } catch { return null; }
}

function bakeRippleTile(img, name, contrast) {
  const T = 128;   // larger tile → the repeat is far less obvious than the old 64px grid
  const bx = img.width / T, by = img.height / T;
  const lum = new Float64Array(T * T); let mean = 0;
  for (let j = 0; j < T; j++)
    for (let i = 0; i < T; i++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.floor(j * by); y < Math.floor((j + 1) * by); y++)
        for (let x = Math.floor(i * bx); x < Math.floor((i + 1) * bx); x++) {
          const o = (y * img.width + x) * 4; r += img.rgba[o]; g += img.rgba[o + 1]; b += img.rgba[o + 2]; n++;
        }
      const L = (0.299 * r + 0.587 * g + 0.114 * b) / n;
      lum[j * T + i] = L; mean += L;
    }
  mean /= T * T;
  const rgb = Buffer.alloc(T * T * 3);
  for (let k = 0; k < T * T; k++) {
    const g = Math.max(0, Math.min(255, 128 + (lum[k] - mean) * contrast)) | 0;   // soft neutral-mean ripple
    rgb[k * 3] = g; rgb[k * 3 + 1] = g; rgb[k * 3 + 2] = g;
  }
  return { src: queueWebp(name, T, T, makeSeamless(rgb, T), null, { quality: 85 }), tile: T };
}

// The ocean's climate band colours: tropical / temperate / polar sea, keyed by |latitude| in
// the web renderer's vertical gradient. Each takes the authentic HUE of the matching Civ4 sea
// blend texture (seatrop/sea/seapol) rescaled to a hand-tuned dark-theme LUMINANCE (tropical
// brightest/tealest, polar dimmest/greyest), mirroring how the land terrains are recoloured.
// Falls back to the dark anchors when the art is absent (LFS not pulled).
function bakeSeaBands() {
  // BASE × DETAIL, LIFTED — the identical rule terrainRealColors applies to all 16 land terrains
  // ("the Civ4 layering, which recovers the hue the near-neutral blend textures carry only via their
  // detail") followed by terrainDisplayColors' lift. The sea was the one terrain family off it: it
  // took the art's HUE but a hand-set LUMINANCE (`SEA_ANCHOR`), which is the last invented number in
  // the water pipeline and is now gone.
  //
  // WHAT THIS DOES NOT FIX: the coast/sea ordering. Civ4's coast-interior cell is darker than its sea
  // blend under every rule — raw 42 vs 91, ×detail×lift 51 vs 80, anchored 42 vs 58 — so the shelf
  // still brightens outward. That ordering is in the art, not in the anchor.
  const detail = avgDds('Art/Terrain/textures/water/seadetail.dds');
  const band = (art, fallback) => {
    const c = avgDds(art);
    if (!c) return fallback;
    const layered = detail ? [0, 1, 2].map(k => Math.min(255, c[k] * detail[k] / 255)) : c;
    return layered.map(v => Math.min(255, Math.round(v * MODULATE2X)));
  };
  return {
    trop:  band('Art/Terrain/textures/water/seatropblend.dds', SEA_FALLBACK.trop),
    temp:  band('Art/Terrain/textures/water/seablend.dds',     SEA_FALLBACK.temp),
    polar: band('Art/Terrain/textures/water/seapolblend.dds',  SEA_FALLBACK.polar),
    // The shallows tint. UNREAD — nothing in web/js consumes `seaBands.shore`; the shallow colour has
    // come from the coast atlas (coastTiles[band].water) since the seabed work. Kept as a key so the
    // bundle shape does not change, and put on the same rule rather than left as the one hand-picked
    // coastal teal it used to be.
    shore: band('Art/Terrain/textures/water/seatropblend.dds', SEA_FALLBACK.trop),
  };
}

// NO shelf-edge colour is baked, and that is a decision rather than an omission — see
// docs/civ4-texture-inventory.md §4 P2. `textures/CoastDeepBlend.dds` is what every
// `ART_DEF_TERRAIN_*_COAST_DEEP` binds and looks like the obvious source, but its opaque pixels
// average 104,103,104: a flat neutral grey with no hue to take, the same trap bakeSeaBands already
// documents for `shoreblend`. And even with a good colour (coastblend's painted water reads
// 84,102,112) the band it drove made the coast WORSE — a mid tone between bright shallows and dark
// open sea widens the pale halo instead of deepening it. The shallows' fade to transparent over dark
// water is already the better answer.

// The BEACH ramps — the real Civ4 sand, one per climate band (docs/civ4-texture-inventory.md §4).
// The rectification itself lives in web/beachramp.mjs (unit-tested there); this just resolves the
// three coast blend atlases and hands them over. Null when the art is absent — the renderer then
// keeps its hand-picked sand. The three climates genuinely differ: tropical sand is pale and barely
// warm, temperate the most golden, polar between them with a colder water tail.
function bakeBeachRamps() {
  const one = artPath => {
    const file = resolveArt(artPath);
    const img = file && decodeCached(file);
    return img ? beachRampFromAtlas(img) : null;
  };
  const temp = one('Art/Terrain/textures/coastblend.dds');
  if (!temp) return null;                                          // the temperate atlas is the anchor
  return {
    trop: one('Art/Terrain/textures/coasttropblend.dds') || temp,
    temp,
    polar: one('Art/Terrain/textures/coastpolarblend.dds') || temp,
  };
}

// The deep-ocean tint (for the depth-banding pass): the authentic hue of the Civ4 seadeep blend
// at a very dark theme luminance, so open water reads far darker than the shelf. Dark fallback.
// The deep-ocean tint the depth-banding pass darkens toward. Its hue comes from
// `Art/Terrain/water/ocean deep.dds` — Civ4's actual painted deep-water overlay, which is what that
// file is for — rather than the neutral `seadeepblend` MASK.
//
// This luminance is STILL hand-set, and it is now the only one left in the water pipeline: it used to
// be tuned "alongside SEA_ANCHOR" so the shelf-to-deep ramp stayed a gradient rather than a cliff into
// black, and that anchor is gone. The bands got brighter, so the ramp to this is steeper than it was —
// still a gradient (bands ~luma 80-104 down to ~33), but if it ever reads as a cliff, this is the
// number, and the honest fix is to put it on the layered rule too rather than to re-tune it by eye.
function seaDeepColor() {
  const c = avgDds('Art/Terrain/water/ocean deep.dds') || avgDds('Art/Terrain/textures/water/seadeepblend.dds');
  return c ? hueAtLuminance([18, 36, 54], c) : [18, 36, 54];
}

// Two-pass chamfer distance transform: for each ocean cell (`sea[k]===1`), the approximate
// Euclidean distance in pixels to the nearest non-ocean (land/coast) cell; 0 on land. Cheap
// (two linear sweeps), enough for a smooth shelf→deep ramp. No E-W wrap (a crop-edge effect
// only, where open ocean is deep anyway).
function distanceToLand(sea, w, h) {
  const INF = 1e9, d = new Float64Array(w * h);
  for (let k = 0; k < w * h; k++) d[k] = sea[k] ? INF : 0;
  const D = 1, Q = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x; let v = d[k];
      if (x > 0)          v = Math.min(v, d[k - 1] + D);
      if (y > 0)          v = Math.min(v, d[k - w] + D);
      if (x > 0 && y > 0) v = Math.min(v, d[k - w - 1] + Q);
      if (x < w - 1 && y > 0) v = Math.min(v, d[k - w + 1] + Q);
      d[k] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const k = y * w + x; let v = d[k];
      if (x < w - 1)              v = Math.min(v, d[k + 1] + D);
      if (y < h - 1)              v = Math.min(v, d[k + w] + D);
      if (x < w - 1 && y < h - 1) v = Math.min(v, d[k + w + 1] + Q);
      if (x > 0 && y < h - 1)     v = Math.min(v, d[k + w - 1] + Q);
      d[k] = v;
    }
  return d;
}

// Plot grids are no longer packed/shipped — the server generates + serves each province on demand
// (GET /api/plots/{id}, docs/plot-serving.md). This pass only reads the canonical grids
// (map/provinces/<id>.json.gz) to compute a plot-extent bbox for the ring-less (sea/lake) provinces,
// which have no polygon for provSrcBox to measure and so need one for viewport culling. Returns the
// count of provinces with a grid (for the build log).
function computeWaterBboxes(provs) {
  const srcDir = path.join(ROOT, 'civstudio-engine/src/main/resources/map/provinces');
  fs.rmSync(path.join(WEB, 'assets', 'plots'), { recursive: true, force: true });   // drop legacy layout
  fs.rmSync(path.join(WEB, 'assets', 'plots.pack'), { force: true });                // drop the retired pack
  let n = 0;
  for (const p of provs) {
    const gz = path.join(srcDir, `${p.id}.json.gz`);
    if (!fs.existsSync(gz)) continue;
    n++;
    if (!p.rings) p.bbox = plotBBox(fs.readFileSync(gz));   // ring-less cull extent (source px)
  }
  return n;
}

// the source-pixel bounding box [x0,y0,x1,y1] of a gzipped plot grid, or null if empty —
// the ring-less (sea/lake) provinces' cull extent, since they ship no outline
function plotBBox(gzBuf) {
  const arr = JSON.parse(zlib.gunzipSync(gzBuf).toString());
  if (!arr.length) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const q of arr) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  return [x0, y0, x1, y1];
}

