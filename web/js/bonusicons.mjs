"use strict";
// Resource iconography, both scales: the per-PLOT bonus glyphs (drawn as a screen-space overlay over
// the province grids drawPlots just painted) and the per-PROVINCE trade-good icon (one per province,
// its own layer). Split out of plots.mjs — they share the two GameFont-style atlases and nothing else.
import { P, BONUS_ICONS, TRADE_GOODS, cam, ctx, px, py, pxr, pyr, plotPxAt, provSrcBox, provOnScreen } from "./core.mjs";
import { bandAlpha, kBand, atLeast, BAND } from "./bands.mjs";
import { loadArt } from "./plotcanvas.mjs";

// the real Civ4 resource-icon atlas (docs/bonus-sprite-bake.md), sliced from GameFont.tga; null →
// drawBonusOverlay keeps the procedural category glyphs
let biReady = false;
const biImg = loadArt(BONUS_ICONS, () => { biReady = true; });
// the Anbennar trade-good icon atlas (docs/trade-goods.md): ONE icon per PROVINCE (the province-level
// resource), distinct from the per-PLOT bonus atlas above. null → no province good icons.
let tgReady = false;
const tgImg = loadArt(TRADE_GOODS && TRADE_GOODS.icons, () => { tgReady = true; });

// Resource icons are a SCREEN-SPACE overlay (not baked into the province texture), shown only at the
// deepest plot zooms (cam.k ≥ BONUS_ZOOM_MIN → the 64/128/256 steps). Each resourced plot — land or
// coastal-shelf water — gets its real Civ4 symbol (from the GameFont atlas), or the procedural
// category glyph fallback, anchored in the plot's BOTTOM-LEFT corner and sized to native px at
// BONUS_FULL_K (holding there deeper), scaling down proportionally as you zoom out. Cheap: at this
// depth only a handful of provinces are in view. Categories (colour + shape): sea food, gems/luxuries,
// energy, metals, farm/trade crops, livestock.
const BONUS_HIDE_AT = 16;       // no resource icons at this zoom or below (textures only just appear)
export function drawBonusOverlay(vis) {
  if (cam.k <= BONUS_HIDE_AT || !vis.length) return;
  const plotPx = plotPxAt();                           // one plot's on-screen size (tracks zoom AND viewport)
  const size = bonusIconSize();
  const inset = Math.max(0.5, plotPx * 0.06);          // nudge off the very corner (frac of a plot)
  const useIcons = BONUS_ICONS && biReady;
  ctx.save();
  // de-emphasise the dark resource badges: faint as terrain first appears, full only deep in — so
  // the mid zoom reads as land + borders, not a field of icons (the province trade-good icon carries
  // the resource story at mid zoom; these per-plot bonuses are the close-in detail)
  ctx.globalAlpha = 0.5 + 0.5 * bandAlpha([4.3, 5.5]);
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.strokeStyle = "rgba(8,12,20,.85)";               // dark keyline so glyphs read on any ground
  for (const p of vis) {                               // already culled to the viewport by drawPlots
    for (const q of p._plots) {
      if (!q.bonus) continue;
      const x = pxr(q.x) + inset, y = pyr(q.y + 1) - inset - size;      // plot bottom-left corner
      const idx = useIcons ? BONUS_ICONS.index[q.bonus] : undefined;
      if (idx !== undefined) {                          // real Civ4 GameFont symbol
        const cell = BONUS_ICONS.cell, cols = BONUS_ICONS.cols;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(biImg, (idx % cols) * cell, Math.floor(idx / cols) * cell, cell, cell, x, y, size, size);
      } else {                                          // fallback: procedural category glyph
        const r = size / 2;
        glyphPath(ctx, bonusGlyph(q.bonus).s, x + r, y + r, r);
        ctx.fillStyle = bonusGlyph(q.bonus).c; ctx.fill(); ctx.stroke();
      }
    }
  }
  ctx.restore();
}
// the on-screen rect [x0,y0,x1,y1] of a plot's resource icon (primary world copy), or null when icons
// are hidden or the plot has no bonus — MUST match drawBonusOverlay's geometry. Used by the hover
// tooltip so pointing at the big bottom-left-anchored glyph hits its owning plot, not the cell under it.
export function bonusIconRect(q) {
  if (cam.k <= BONUS_HIDE_AT || !q || !q.bonus) return null;
  // plotPxAt() with no arguments — an ORIGIN probe, matching drawBonusOverlay, which hoists one probe
  // out of its plot loop. The two must agree or the tooltip target drifts off the glyph it belongs to,
  // so when a tilted projector makes plot size vary with position (docs/terrain-3d.md §P2) these two
  // move to a per-plot probe TOGETHER — converting either one alone is the silent-drift bug.
  const plotPx = plotPxAt(), size = bonusIconSize(), inset = Math.max(0.5, plotPx * 0.06);
  const x = pxr(q.x) + inset, y = pyr(q.y + 1) - inset - size;
  return [x, y, x + size, y + size];
}

// bonus-icon on-screen size: the atlas cell reaches 100% (native px) at BONUS_FULL_K and HOLDS there
// deeper — so a resource icon reads at a fixed, readable size instead of ballooning with the plot as you
// zoom in. Pinned to a fixed reference (not K_MAX) so raising the zoom cap doesn't shrink icons: past
// BONUS_FULL_K the icon stays native size rather than continuing to grow. ctx is dpr-scaled → cell px == CSS px.
const BONUS_FULL_K = 256;        // zoom at which a resource icon hits native size (independent of the K_MAX cap)
function bonusIconSize() {
  // 0.72: a touch smaller than native so the badges sit quietly on the plot instead of dominating it
  return (BONUS_ICONS ? BONUS_ICONS.cell : 24) * Math.min(cam.k, BONUS_FULL_K) / BONUS_FULL_K * 0.72;
}
// the glyph outline for a category shape, centred at (cx,cy) with radius r
function glyphPath(o, shape, cx, cy, r) {
  o.beginPath();
  if (shape === "circle") o.arc(cx, cy, r, 0, Math.PI * 2);
  else if (shape === "diamond") { o.moveTo(cx, cy - r); o.lineTo(cx + r, cy); o.lineTo(cx, cy + r); o.lineTo(cx - r, cy); o.closePath(); }
  else if (shape === "square") o.rect(cx - r * 0.82, cy - r * 0.82, r * 1.64, r * 1.64);
  else { o.moveTo(cx, cy - r); o.lineTo(cx + r * 0.9, cy + r * 0.72); o.lineTo(cx - r * 0.9, cy + r * 0.72); o.closePath(); }   // triangle
}
// bonus type -> {colour, shape} by category (first keyword match wins); pale dot for the rest
const BONUS_CATEGORIES = [
  [/FISH|CRAB|CLAM|SHRIMP|LOBSTER|WHALE|OYSTER|SEAWEED|KELP/, { c: "#5fe3d0", s: "circle" }],       // sea food — teal circle
  [/PEARL|GEM|GOLD|SILVER|DIAMOND|AMBER|JADE|CORAL|OPAL/,     { c: "#e879f9", s: "diamond" }],       // gems/luxury — magenta diamond
  [/OIL|GAS|COAL|URANIUM|METHANE|HYDROTHERMAL|VENT|PEAT|TAR/, { c: "#f59e0b", s: "triangle" }],      // energy — amber triangle
  [/IRON|COPPER|TIN|ALUMIN|LEAD|ZINC|NICKEL|TITAN|MITHRIL|ORE|MARBLE|STONE/, { c: "#9fb0c0", s: "square" }], // metal/stone — steel square
  [/WHEAT|CORN|MAIZE|RICE|BANANA|POTATO|SUGAR|WINE|SPICE|COFFEE|TEA|TOBACCO|COTTON|SILK|DYE|INCENSE|OLIVE|CITRUS|WHEAT/, { c: "#84cc16", s: "circle" }], // farm/trade crop — green circle
  [/COW|CATTLE|SHEEP|PIG|HORSE|DEER|BISON|CAMEL|ELEPHANT|GOAT|REINDEER|FUR|IVORY/, { c: "#d6a06a", s: "circle" }], // livestock/game — tan circle
];
function bonusGlyph(type) {
  for (const [re, style] of BONUS_CATEGORIES) if (re.test(type)) return style;
  return { c: "#c8d2e0", s: "circle" };                // uncategorised — pale dot
}

// Stamp each in-view province's TRADE-GOOD icon at its centroid — the province-level resource, drawn
// like the per-plot bonuses are but one per province (docs/trade-goods.md). Lives in a zoom BAND: it
// appears at the terrain-texture zoom (K_TEX, 16×) — the overview and mid zoom stay clean — and fades
// out as you dive toward plot detail, where the finer per-plot bonus icons take over the resource
// story. Overworld physical view only (gated by the caller in main.renderScene).
const TG_MIN_PROV_PX = 16;    // skip only tiny slivers (at 16×+ most provinces are well above this)
const TG_ICON_PX = 26;        // on-screen icon size, in CSS px (ctx is dpr-scaled)
const TG_FADE_START = 48, TG_FADE_END = 64;   // fade out over this zoom range as plot bonuses take over
export function drawTradeGoodIcons() {
  if (!TRADE_GOODS || !TRADE_GOODS.icons || !tgReady) return;
  if (!atLeast(BAND.TERRAIN)) return;            // only from the terrain-texture band (4, 16×) upward
  // fade out as you approach plot-detail zoom, where the per-plot bonus icons carry the resources
  const fade = 1 - bandAlpha(kBand([TG_FADE_START, TG_FADE_END]));
  if (fade <= 0.01) return;
  const { cell, cols, index } = TRADE_GOODS.icons, prov = TRADE_GOODS.prov;
  const size = TG_ICON_PX, r = size / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = fade;
  for (const p of P) {
    if (!p.rings) continue;
    const key = prov[p.id];
    if (!key) continue;
    const idx = index[key];
    if (idx === undefined || !provOnScreen(p)) continue;
    const box = provSrcBox(p);
    if (!box) continue;
    const w = Math.abs(pxr(box.x1) - pxr(box.x0)), h = Math.abs(pyr(box.y1) - pyr(box.y0));
    if (Math.min(w, h) < TG_MIN_PROV_PX) continue;          // too small on screen → skip (declutter)
    const cx = px(p.lon), cy = py(p.lat);
    // a soft dark disc so the icon reads on any terrain/colour
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.92, 0, 7);
    ctx.fillStyle = "rgba(10,14,22,0.5)";
    ctx.fill();
    ctx.drawImage(tgImg, (idx % cols) * cell, Math.floor(idx / cols) * cell, cell, cell,
      cx - r, cy - r, size, size);
  }
  ctx.restore();
}
