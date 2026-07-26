"use strict";
// The shoreline: shallows, sand beach, foam lap, and polar sea ice. Split out of plots.mjs — this is
// a self-contained renderer that paints into a province's offscreen canvas (buildPlotTexCanvas calls
// paintCoast for land, drawSeaIce for water) and owns the two art atlases only it uses.
//
// Coast rendering reads each land plot's 8-bit sea mask (q.coast — see docs/coastlines.md): 1=E,2=W,
// 4=S,8=N edges (low nibble), 16=NW,32=NE,64=SE,128=SW diagonal sea corners (high nibble). Two things
// make the shore: (1) a wavy shallow band that both reaches OUTWARD from the shoreline into the sea AND
// recedes INWARD into the land — the inward part is carved with a CORNER-CONTINUOUS erosion so the
// coast is a smooth wavy line across cells, not a grid staircase; (2) the real Civ4 shoredetail ripple
// clipped to that shallow shape. (Earlier per-cell rectangular bites read as blue blotches on the land,
// and the wave-crest foam lapped onto land — both dropped for this continuous shallows.)
import { SHORE, ICE_ART, SEA_BANDS, BEACH, FOAM, COAST_MASK, COAST_TILES } from "./core.mjs";
import { loadArt } from "./plotcanvas.mjs";

// the baked greyscale shore-wave tile for the coast shallows (docs/coastlines.md Phase D); null →
// the shallows stay flat-tinted, no ripple
let shoreReady = false;
const shoreImg = loadArt(SHORE, () => { shoreReady = true; });
// the real Civ4 pack-ice tile (docs/coastlines.md Phase G), features/icepack; null → drawSeaIce
// falls back to flat pale floes
let iceReady = false, icePat = null;
const iceImg = loadArt(ICE_ART, () => { iceReady = true; });
// the real Civ4 wave-crest strip for the surf (docs/civ4-texture-inventory.md §4 P2); null → drawFoam
// keeps its procedural white feather
let foamReady = false;
const foamImg = loadArt(FOAM, () => { foamReady = true; });
// Civ4's 16-way shoreline stencil (§4 P3); null → coastal plots stay square
let cmReady = false;
const cmImg = loadArt(COAST_MASK, () => { cmReady = true; });
// Civ4's painted coast tiles, one atlas per climate band (§4 P3); null → no coast tile is drawn
const ctImg = {}, ctReady = {};
if (COAST_TILES) for (const b of ["trop", "temp", "polar"])
  ctImg[b] = loadArt(COAST_TILES[b], () => { ctReady[b] = true; });
/** Which climate atlas a latitude takes — the same bands the sea gradient and the beach ramp use. */
const bandOf = lat => { const a = Math.abs(lat); return a <= 23 ? "trop" : a >= 60 ? "polar" : "temp"; };

// fadeShelfEdge lived here and is GONE. It feathered the coastal shelf's outer edge, because the
// shelf stopped at an arbitrary 3px band whose boundary against the open-sea gradient stepped with
// every plot square. From MAP_VERSION 13 a sea province draws every water cell it owns, so there is
// no such boundary — the artefact was the band, not the edge treatment. plots.mjs `shelfRgb` carries
// the water from shallow to deep on its own.

/**
 * Draw Civ4's painted COAST TILE on each shallow water plot.
 *
 * This is the authored article rather than an approximation of it: `coast*blend.dds` is a 4x8 atlas of
 * 32 hand-painted 128px tiles — sand, shallows and deep water, shoreline in the alpha — and
 * `CIV4ArtDefines_Terrain.xml` says which cell and rotation each 4-bit diagonal configuration takes.
 * Both ship in the bundle (build.mjs bakeCoastTiles).
 *
 * ON THE WATER PLOT, NEVER THE LAND ONE, and that is the whole point. An earlier cut stamped the mask
 * on the land plot, which paints sea INWARD: Gadhinglaj (province 4367) has `coast = 32`, one NE
 * diagonal bit and no edge bits at all, so the only thing that happened to it was a bite of water
 * appearing inside a tile whose four orthogonal neighbours are all land. Civ4 draws the coast tile on
 * the water and lets it blend toward the shore, so the coast reaches OUT.
 *
 * Keyed on the WATER tile's own adjacency, which is what makes an inlet read right: the tile NE of
 * Gadhinglaj has `coast = 24` — only N and NW are water, six of its eight neighbours are land — so it
 * takes a config whose painted tile is nearly all shore, while a tile facing open sea takes a thin rim.
 *
 * VARIANTS are per plot, from the plot hash. The table offers several cells per configuration
 * precisely so a long coastline does not repeat one painted curve; picking the first would throw that
 * away and stamp a visible rhythm along every shore.
 */
export function extendCoastIntoWater(o, plots, x0, y0, tpp, lat = 45) {
  const A = COAST_TILES && ctImg[bandOf(lat)];
  if (!A || !ctReady[bandOf(lat)]) return;
  const C = COAST_TILES.cell, cols = COAST_TILES.cols, blend = COAST_TILES.blend;
  o.save();
  o.imageSmoothingEnabled = true;
  for (const q of plots) {
    if (q.landDist !== 1) continue;                       // only the ring that touches land
    const cfg = (q.coast >> 4) & 15;
    const variants = blend[cfg];
    if (!variants || !variants.length) continue;          // config 0 has no entry — nothing to blend
    const [cell, rot] = variants[Math.floor(chash(q.x * 31 + cfg, q.y * 17) * variants.length) % variants.length];
    const sx = ((cell - 1) % cols) * C, sy = Math.floor((cell - 1) / cols) * C;
    const cx = (q.x - x0) * tpp, cy = (q.y - y0) * tpp;
    if (rot) {                                            // authored rotations are 0/90/180/270
      o.save();
      o.translate(cx + tpp / 2, cy + tpp / 2);
      o.rotate(rot * Math.PI / 180);
      o.drawImage(A, sx, sy, C, C, -tpp / 2, -tpp / 2, tpp, tpp);
      o.restore();
    } else o.drawImage(A, sx, sy, C, C, cx, cy, tpp, tpp);
  }
  o.restore();
}

// the shallows tint — the Civ4 shoreblend hue baked into the bundle, or the old teal fallback
const SHORE_COL = (SEA_BANDS && SEA_BANDS.shore) ? SEA_BANDS.shore.join(",") : "116,178,196";
// beach sand — the hand-picked pair this used before the real art arrived. Still the fallback when
// BEACH is null (the coast blend atlases were absent at bake time).
const SAND = "226,208,164", WET_SAND = "200,182,140";

// ---------------------------------------------------------------------------
// the real Civ4 sand (docs/civ4-texture-inventory.md §4)
// ---------------------------------------------------------------------------
// BEACH is {trop,temp,polar}, each a 9-stop RGB ramp rectified out of coast*blend.dds at bake time.
// Index 0 is the LAND edge (Civ4 paints a darker damp line there), ~2 the bright dry-sand body, ~6
// the seaward edge of the sand, 7–8 already the shallows. So the ramp spans exactly the two things
// this file draws: the apron feathering back onto the land, and the wet sand jutting into the water.
const SAND_DRY = 2, SAND_WET = 6;
// Same climate bands as the sea gradient (sea.mjs seaColorAt), so a beach and the water off it agree:
// tropical ≤23°, polar ≥60°, mixed between. Ramps interpolate stop-by-stop.
function beachRamp(lat) {
  if (!BEACH) return null;
  const a = Math.abs(lat), B = BEACH;
  if (a <= 23) return B.trop;
  if (a >= 60) return B.polar;
  const [lo, hi, t] = a <= 40 ? [B.trop, B.temp, (a - 23) / 17] : [B.temp, B.polar, (a - 40) / 20];
  return lo.map((c, i) => [0, 1, 2].map(k => Math.round(c[k] + (hi[i][k] - c[k]) * t)));
}
const rgbOf = (ramp, i, fallback) => ramp ? ramp[i].join(",") : fallback;

const COAST_EDGES = [[1, 1, 0], [2, -1, 0], [4, 0, 1], [8, 0, -1]];   // bit, dx, dy (E,W,S,N)
const COAST_CORNERS = [[16, 0, 0], [32, 1, 0], [64, 1, 1], [128, 0, 1]];   // bit, cell-corner ux,uy (NW,NE,SE,SW)

export function paintCoast(o, W, H, plots, x0, y0, tpp, lat = 45) {
  const coastal = plots.filter(q => q.coast);
  if (!coastal.length) return;
  const ramp = beachRamp(lat);          // this province's sand, once (9 lerps, not per plot)
  // `detail` fades the land-extension detail out at low offscreen resolution (tpp), where a per-plot
  // bump would be a pixel or two of mush. Tracks offscreen resolution, NOT the on-screen zoom.
  const detail = Math.max(0, Math.min(1, (tpp - 8) / 12));
  const bands = ctx2 => { for (const q of coastal) drawCoastBands(ctx2, (q.x - x0) * tpp, (q.y - y0) * tpp, tpp, q.coast); };
  // The coast is WATER (the shelf tile), so we don't touch the land — the coastal LAND cells grow a
  // SAND BEACH that protrudes into the shallows by a corner-continuous jittered depth (a smooth wavy
  // sand line across cells, not a grid staircase) and feathers back onto the land. Shallows are painted
  // first (in the water), then the beach on top: land → dry sand → wet sand → shallows → sea.
  const beach = () => { if (detail > 0) for (const q of coastal) drawBeach(o, (q.x - x0) * tpp, (q.y - y0) * tpp, tpp, q, ramp); };
  // a soft foam lap just seaward of the sand (repurposes the retired foam crest)
  const foam = () => { if (detail > 0) for (const q of coastal) drawFoam(o, (q.x - x0) * tpp, (q.y - y0) * tpp, tpp, q.coast, q.x, q.y, detail); };
  if (!shoreReady) { bands(o); beach(); foam(); return; }   // no ripple art → flat shore-hue bands
  // 1) shore-hue bands on a scratch layer (its alpha = the shallow-water shape)
  const cc = document.createElement("canvas"); cc.width = W; cc.height = H;
  bands(cc.getContext("2d"));
  // 2) the shore ripple, clipped to that shape — 8 plots per 128px tile → fine near-shore chop
  const rc = document.createElement("canvas"); rc.width = W; rc.height = H;
  const r = rc.getContext("2d"), pat = r.createPattern(shoreImg, "repeat");
  const sc = Math.max(0.25, tpp / 16);
  pat.setTransform(new DOMMatrix([sc, 0, 0, sc, 0, 0]));
  r.fillStyle = pat; r.fillRect(0, 0, W, H);
  r.globalCompositeOperation = "destination-in"; r.drawImage(cc, 0, 0);
  // 3) composite: shallows colour, ripple soft-light over it, then the sand beach ON TOP
  o.drawImage(cc, 0, 0);
  o.save(); o.globalCompositeOperation = "soft-light"; o.globalAlpha = 0.9; o.drawImage(rc, 0, 0); o.restore();
  beach();
  foam();
}
// deterministic 0..1 hash — the same integer-mix idiom drawSeaIce uses, for jitter that is
// stable across redraws and seed-reproducible (no Math.random)
const chash = (a, b) => ((Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 40503)) >>> 0) / 4294967295;
// How far the LAND protrudes into the coast water at a GLOBAL plot corner (0.05..0.42 cell). Keyed on
// the shared corner coords, so adjacent coastal cells read the SAME depth there — the extended outer
// edge is a continuous polyline across cells (a wavy shore), not per-cell rectangles.
function coastDepth(gx, gy, s) { return s * (0.18 + 0.45 * chash(gx, gy)); }
// The extension quads for a coastal cell — one per water edge, from the grid shoreline OUTWARD into the
// coast water, the two ends reaching by the shared corner depths. Filled by drawBeach as wet sand.
// Each carries its outward axis `[ax0, ay0, ax1, ay1]` so the caller can run a SEAWARD gradient across
// it (dry sand at the grid line → wet at the tip) instead of one flat fill for the whole cell.
function coastExtendPolys(q, cx, cy, s) {
  const m = q.coast, out = [], r = s * 0.45;   // gradient reach ≈ the max coastDepth, so the ramp spans the quad
  if (m & 1) { const a = coastDepth(q.x + 1, q.y, s), b = coastDepth(q.x + 1, q.y + 1, s);   // E → +x
    out.push({ p: [[cx + s, cy], [cx + s + a, cy], [cx + s + b, cy + s], [cx + s, cy + s]], ax: [cx + s, cy, cx + s + r, cy] }); }
  if (m & 2) { const a = coastDepth(q.x, q.y, s), b = coastDepth(q.x, q.y + 1, s);           // W → -x
    out.push({ p: [[cx, cy], [cx - a, cy], [cx - b, cy + s], [cx, cy + s]], ax: [cx, cy, cx - r, cy] }); }
  if (m & 4) { const a = coastDepth(q.x, q.y + 1, s), b = coastDepth(q.x + 1, q.y + 1, s);   // S → +y
    out.push({ p: [[cx, cy + s], [cx, cy + s + a], [cx + s, cy + s + b], [cx + s, cy + s]], ax: [cx, cy + s, cx, cy + s + r] }); }
  if (m & 8) { const a = coastDepth(q.x, q.y, s), b = coastDepth(q.x + 1, q.y, s);           // N → -y
    out.push({ p: [[cx, cy], [cx, cy - a], [cx + s, cy - b], [cx + s, cy]], ax: [cx, cy, cx, cy - r] }); }
  return out;
}
function fillPoly(o, p) {
  o.beginPath(); o.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < p.length; i++) o.lineTo(p[i][0], p[i][1]);
  o.closePath(); o.fill();
}
// an outward fade of `col` from the shoreline into the sea — edges as linear ramps, diagonal
// corners as radial ones — reaching `f` px with peak alpha `a0`. Shared by the shallows and beach.
function outwardBands(o, cx, cy, s, mask, col, f, a0) {
  for (const [bit, dx, dy] of COAST_EDGES) {
    if (!(mask & bit)) continue;
    let gr, rx, ry, rw, rh;
    if (dx === 1)      { gr = o.createLinearGradient(cx + s, 0, cx + s + f, 0); rx = cx + s; ry = cy;     rw = f; rh = s; }  // E
    else if (dx === -1){ gr = o.createLinearGradient(cx, 0, cx - f, 0);         rx = cx - f; ry = cy;     rw = f; rh = s; }  // W
    else if (dy === 1) { gr = o.createLinearGradient(0, cy + s, 0, cy + s + f); rx = cx;     ry = cy + s; rw = s; rh = f; }  // S
    else               { gr = o.createLinearGradient(0, cy, 0, cy - f);         rx = cx;     ry = cy - f; rw = s; rh = f; }  // N
    gr.addColorStop(0, `rgba(${col},${a0})`); gr.addColorStop(1, `rgba(${col},0)`);
    o.fillStyle = gr; o.fillRect(rx, ry, rw, rh);
  }
  for (const [bit, ux, uy] of COAST_CORNERS) {
    if (!(mask & bit)) continue;
    const px = cx + ux * s, py = cy + uy * s;            // the plot's corner point
    const gr = o.createRadialGradient(px, py, 0, px, py, f);
    gr.addColorStop(0, `rgba(${col},${a0})`); gr.addColorStop(1, `rgba(${col},0)`);
    o.fillStyle = gr; o.fillRect(px - (ux ? 0 : f), py - (uy ? 0 : f), f, f);
  }
}
// the shallow-water band: the Civ4 shoreblend hue reaching ~1 cell out from the shoreline into the
// sea (its alpha is the shape the shore ripple is clipped to). The sand beach is drawn OVER this
// afterward, so the visible shallows ring sits just beyond the wavy shore.
//
// A shelf-edge band was TRIED here and removed — see docs/civ4-texture-inventory.md §4 P2. The idea
// was that the shallows should ramp to a dimmer shelf tone instead of fading out. It fails twice:
// coastdeepblend carries no hue to ramp TO (its opaque pixels are flat grey), and any mid-tone ring
// between bright shallows and the dark open sea just makes the pale halo WIDER — the fade to
// transparent over dark water already reads as deepening. Left as one band deliberately.
function drawCoastBands(o, cx, cy, s, mask) {
  outwardBands(o, cx, cy, s, mask, SHORE_COL, s * 1.35, ".85");
}
// an INWARD fade of `col` from the shoreline back into the LAND cell — the mirror of
// outwardBands. Used for the dry-sand beach apron feathering off the water's edge onto land.
function inwardBands(o, cx, cy, s, mask, col, f, a0) {
  for (const [bit, dx, dy] of COAST_EDGES) {
    if (!(mask & bit)) continue;
    let gr, rx, ry, rw, rh;
    if (dx === 1)      { gr = o.createLinearGradient(cx + s, 0, cx + s - f, 0); rx = cx + s - f; ry = cy;         rw = f; rh = s; }  // sea E → sand on the land's east strip
    else if (dx === -1){ gr = o.createLinearGradient(cx, 0, cx + f, 0);         rx = cx;         ry = cy;         rw = f; rh = s; }  // W
    else if (dy === 1) { gr = o.createLinearGradient(0, cy + s, 0, cy + s - f); rx = cx;         ry = cy + s - f; rw = s; rh = f; }  // S
    else               { gr = o.createLinearGradient(0, cy, 0, cy + f);         rx = cx;         ry = cy;         rw = s; rh = f; }  // N
    gr.addColorStop(0, `rgba(${col},${a0})`); gr.addColorStop(1, `rgba(${col},0)`);
    o.fillStyle = gr; o.fillRect(rx, ry, rw, rh);
  }
  for (const [bit, ux, uy] of COAST_CORNERS) {                 // round the sand into the cell at outer corners
    if (!(mask & bit)) continue;
    const px = cx + ux * s, py = cy + uy * s;
    const gr = o.createRadialGradient(px, py, 0, px, py, f);
    gr.addColorStop(0, `rgba(${col},${a0})`); gr.addColorStop(1, `rgba(${col},0)`);
    o.fillStyle = gr; o.fillRect(px - ux * f, py - uy * f, f, f);
  }
}
// The beach on a coastal LAND cell: wet-sand bumps protruding into the shallows (the same
// corner-continuous outline the land used, so the sand edge is a smooth wavy polyline across
// cells, not a staircase), then dry sand feathered back onto the land. Replaces the old
// terrain-coloured land bumps — the Civ4 sandy shore. See docs/coastlines.md.
function drawBeach(o, cx, cy, s, q, ramp) {
  // wet sand jutting into the water: a seaward gradient across each quad, running the dry-sand body
  // at the grid shoreline to the wet seaward edge — the cross-shore ramp Civ4 paints into the atlas,
  // laid along the one axis this geometry already has. Flat WET_SAND when there is no baked ramp.
  for (const { p, ax } of coastExtendPolys(q, cx, cy, s)) {
    if (ramp) {
      const g = o.createLinearGradient(ax[0], ax[1], ax[2], ax[3]);
      for (let i = SAND_DRY; i <= SAND_WET; i++)
        g.addColorStop((i - SAND_DRY) / (SAND_WET - SAND_DRY), `rgb(${ramp[i].join(",")})`);
      o.fillStyle = g;
    } else o.fillStyle = `rgb(${WET_SAND})`;
    fillPoly(o, p);
  }
  // dry sand feathering back onto the land — the bright body of the beach, fading inland
  inwardBands(o, cx, cy, s, q.coast, rgbOf(ramp, SAND_DRY, SAND), s * 0.62, ".95");
}
// The surf: the real Civ4 wave-crest strip stamped along each water edge, just seaward of the sand.
//
// The art is one scalloped foam band that tiles along its long axis, so a naive stamp would repeat
// the SAME scallop in every coastal cell — a visible rhythm along the whole coastline. Procedural
// variation is what stops that: each cell picks its own window into the strip and its own flip from
// the plot hash, so the crest phase wanders the way a real shoreline does. Real art for the material,
// a hash for the variety — neither does the other's job well.
//
// Corners keep the procedural radial feather: the art has no corner piece, and a strip stamped across
// a diagonal reads as a seam.
// A lap, not a band: 0.18 cells of reach at low opacity, faded by the same `detail` ramp the beach
// uses. Wider or brighter than this and it stops reading as surf and starts reading as haze around
// the whole coastline — the failure the first cut of this shipped, and the reason the crest is
// cropped to its dense rows at bake time.
const FOAM_REACH = 0.18;
// local (x along shore, y seaward) → world, per edge. Canvas transform(a,b,c,d,e,f):
// x' = a·x + c·y + e, y' = b·x + d·y + f.
const FOAM_TX = {
  1: (cx, cy, s) => [0, 1, 1, 0, cx + s, cy],       // E: seaward +x, shore runs +y
  2: (cx, cy, s) => [0, 1, -1, 0, cx, cy],          // W: seaward -x
  4: (cx, cy, s) => [1, 0, 0, 1, cx, cy + s],       // S: seaward +y, shore runs +x
  8: (cx, cy, s) => [1, 0, 0, -1, cx, cy],          // N: seaward -y
};
function drawFoam(o, cx, cy, s, mask, gx, gy, detail) {
  if (!foamReady) { outwardBands(o, cx, cy, s, mask, "255,255,255", s * 0.3, ".5"); return; }
  const f = s * FOAM_REACH, win = Math.max(8, Math.min(FOAM.w, Math.round(FOAM.w / 4)));
  for (const [bit] of COAST_EDGES) {
    if (!(mask & bit)) continue;
    // per-edge window + flip, so neighbouring cells never stamp the same crest
    const h = chash(gx * 3 + bit, gy * 5 + bit);
    const sx = Math.floor(h * (FOAM.w - win));
    o.save();
    o.transform(...FOAM_TX[bit](cx, cy, s));
    if (chash(gx * 7 + bit, gy * 11) > 0.5) { o.translate(s, 0); o.scale(-1, 1); }   // mirror along the shore
    o.globalAlpha = 0.34 * detail;
    o.drawImage(foamImg, sx, 0, win, FOAM.h, 0, 0, s, f);
    o.restore();
  }
  // diagonal sea corners: the soft feather, at the same weight the edges now carry
  const a = (0.2 * detail).toFixed(2);
  for (const [bit, ux, uy] of COAST_CORNERS) {
    if (!(mask & bit)) continue;
    const px = cx + ux * s, py = cy + uy * s;
    const gr = o.createRadialGradient(px, py, 0, px, py, f);
    gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(1, "rgba(255,255,255,0)");
    o.fillStyle = gr; o.fillRect(px - (ux ? 0 : f), py - (uy ? 0 : f), f, f);
  }
}
// Polar sea ice on a water province's shelf (docs/coastlines.md Phase E/G). Coverage is per-cell
// (sparse at sub-polar latitudes, near-solid by the pole), so drawing cells as SQUARES read as a
// blocky checkerboard. Instead each ice cell is a slightly-oversized ROUNDED FLOE blob unioned into
// one field: isolated cells become round pancake floes (natural drift ice), and where cells crowd
// together the blobs overlap into a solid sheet with a rounded, ragged margin. A cool rim shows only
// on the outer boundary (an expanded field drawn under the floes). Degrades to a flat pale sheet
// when the ice tile isn't loaded.
export function drawSeaIce(o, plots, x0, y0, tpp) {
  const ice = plots.filter(q => q.feature === "FEATURE_ICE");
  if (!ice.length) return;
  const hash = (x, y) => ((Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0) / 4294967295;
  if (iceReady) { icePat = icePat || o.createPattern(iceImg, "repeat");
    const s = Math.max(0.25, tpp * 4 / ICE_ART.tile); icePat.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0])); }
  const rw = tpp * 0.05;                                // rim width (the cool floe edge)
  const rim = new Path2D(), field = new Path2D();
  for (const q of ice) {
    const cx = (q.x - x0) * tpp + tpp / 2, cy = (q.y - y0) * tpp + tpp / 2;
    // radius < 0.5·tpp so floes stay discrete islands with open water between them (rather than
    // overlapping into a solid sheet of big white discs); jittered per-cell so outlines vary
    const r = tpp * (0.34 + 0.12 * hash(q.x * 7 + 1, q.y * 7 + 3));
    rim.moveTo(cx + r + rw, cy); rim.arc(cx, cy, r + rw, 0, Math.PI * 2);
    field.moveTo(cx + r, cy); field.arc(cx, cy, r, 0, Math.PI * 2);
  }
  o.save();
  o.fillStyle = "rgba(150,178,198,0.12)"; o.fill(rim);       // cool rim shows only past the floe edge
  o.globalAlpha = 0.2; o.fillStyle = icePat || "rgb(226,236,245)"; o.fill(field);   // ~80% transparent — the sea reads through the floes
  o.restore();
}
