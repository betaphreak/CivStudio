"use strict";
// The plot layer: the Civ4 ground-texture art, the per-province offscreen canvases built from it, and
// the draw pass that blits them. What used to also live here now has its own module — the shoreline
// (coast.mjs), the plot fetch (plotfetch.mjs), the resource icons (bonusicons.mjs), the movement-cost
// heat (cost.mjs), and the offscreen primitives all three share (plotcanvas.mjs).
import { P, terrainRgb, provSrcBox, provOnScreen, latAtSourceY, K_PLOT, TT, TCOL, RIVER, TREES, IMPROVEMENT_OVERLAYS, SEA_BANDS, COAST_TILES, HILL_WASH, LY, NB4, cam, VIEW, ctx, pll, S } from "./core.mjs";
import { shelfColor } from "./water-terrain.mjs";
import { draw } from "./repaint.mjs";
import { bandAlpha, kBand, atLeast, BAND, ground3D, props3D } from "./bands.mjs";
import { loadArt, plotBounds, buildPixelCanvas, blitProvinceCanvas } from "./plotcanvas.mjs";
import { riverClass, riverLinks, cellStrokes, ribbonWidth } from "./river-geom.mjs";
import { drawSeaIce, extendCoastIntoWater } from "./coast.mjs";
import { drawBonusOverlay } from "./bonusicons.mjs";
import { loadPlots, shoreIndex } from "./plotfetch.mjs";
import { shoreTerrain } from "./shore-index.mjs";
import { placeFoliage, foliageGroup, isGrassFeature, mkRng, foliageSeed } from "./foliage.mjs";

// the Civ4 ground-texture atlas (sliced per-terrain into repeating tiles by extractTiles); null →
// drawPlots stays on the flat 1px/plot colour offscreen
let ttReady = false, ttTiles = null;
const ttImg = loadArt(TT, () => { extractTiles(); ttReady = true; });
// Civ4's HILL overlay — a translucent wash over the plot's own ground, in TWO authored variants so a
// range of hills does not stamp one cell repeatedly (build.mjs bakeHillWash). A hill is not a blend
// layer: its interior cell measures alpha ~0.39, i.e. the art is authored to let the terrain beneath
// show through. Null → buildPlotTexCanvas stamps nothing and the ground is bare, as it was before.
let hwReady = false, hwCells = null;
const hwImg = loadArt(HILL_WASH, () => {
  hwCells = [];
  for (let i = 0; i < HILL_WASH.variants; i++) {
    const c = document.createElement("canvas"); c.width = c.height = HILL_WASH.cell;
    c.getContext("2d").drawImage(hwImg, i * HILL_WASH.cell, 0, HILL_WASH.cell, HILL_WASH.cell, 0, 0, HILL_WASH.cell, HILL_WASH.cell);
    hwCells.push(c);
  }
  hwReady = true;
  for (const p of P) p._tcanvas = null;   // canvases baked before the wash arrived have bare hills
});
// the baked water tile for the river ribbon (docs/river-rendering.md §2); null → drawRivers falls back to flat blue
let rvReady = false;
const rvImg = loadArt(RIVER, () => { rvReady = true; });
// the real Civ4 foliage sprite atlases (docs/features-art.md): {leafy,palm,swamp,…} strips of tree
// cutouts, one Image + ready flag per group; null → featureSprite keeps the procedural blobs. A
// late-loading atlas invalidates the cached province texture canvases (they baked procedural blobs
// before the art arrived) so they rebuild with the real foliage.
const treeImg = {}, treeReady = {};
if (TREES) for (const k of Object.keys(TREES))
  treeImg[k] = loadArt(TREES[k], () => { treeReady[k] = true; for (const p of P) p._tcanvas = null; });
// Civ4 improvement sprites (build.mjs bakeImprovementOverlays): one sheet per improvement, carrying
// VARIANT cells — an_eu_farm01/02/03 and friends — so a province of farms is not one stamp repeated.
// Placement is DEFERRED: nothing carries an `improvement` yet, so this is wired but draws nothing.
const impImg = {}, impReady = {};
if (IMPROVEMENT_OVERLAYS) {
  for (const k of Object.keys(IMPROVEMENT_OVERLAYS)) {
    impImg[k] = loadArt(IMPROVEMENT_OVERLAYS[k], () => { impReady[k] = true; for (const p of P) p._tcanvas = null; });
  }
}
// split the atlas strip into a per-terrain tile canvas, so each can be a repeating
// pattern (continuous ground texture across plots, no per-plot tile seam)
function extractTiles() {
  ttTiles = {};
  for (const terr in TT.cols) {
    const tc = document.createElement("canvas"); tc.width = TT.tile; tc.height = TT.tile;
    tc.getContext("2d").drawImage(ttImg, TT.cols[terr] * TT.tile, 0, TT.tile, TT.tile, 0, 0, TT.tile, TT.tile);
    ttTiles[terr] = tc;
  }
}
// Per-paint wall-clock budget for the heavy offscreen rasterisation (buildPlotTexCanvas /
// buildPlotCanvas). Those run once per province in the draw loop; when several fetches resolve in one
// batch (common after a slow load) building them all in a single frame froze the UI. Build until the
// budget is spent, then defer the rest to later frames (drawPlots reschedules a paint). At least one
// province always builds per frame, so it still converges quickly.
const PLOT_FRAME_BUDGET_MS = 6;
// (There is no plot-count cap on the textured build any more. There was — MAX_TEX_PLOTS = 20000, to
// bound a single giant province's build, which the per-frame budget cannot interrupt mid-build. It cost
// more than it saved once the coast art landed: `extendCoastIntoWater` runs only inside the textured
// build, so every province over the cap drew NO coast tile at all, and 15 of the 365 coastal water
// provinces are over it — whole shorelines where the sea ran straight into the land. Only 11 of 4,804
// land provinces are over it either way. The budget still defers the build to a later frame; dropping
// the cap means a huge province now takes its turn late rather than never being textured at all.)

// Urban plots (docs/urban-plots.md): a city is now an OVERLAY on natural terrain, not a synthetic
// terrain — the plot cache (MAP_VERSION 8+) carries the generated ground plus a `urban` flag, so an
// urban plot renders as its real terrain and the `q.urban` flag (straight off the plot JSON) locates
// the city for the district layer (districts.mjs), routes (urban→trail) and the info panel. No client
// re-terraining is needed any more; the old TERRAIN_URBAN grey-ground substrate was retired engine-side.

// the colour a river cell tints toward on the 1px/plot canvas — the hue the old flat blend
// (r*0.55+42, g*0.55+60, b*0.55+76) resolved to, kept so only the STRENGTH now varies
const RIVER_TINT = [93, 133, 169];

/** Sea/lake province — its plots are all water, which changes how they are sampled and coloured. */
const isWater = p => p.type === "SEA" || p.type === "LAKE";

// The shallow-water fill, taken from the ART. Removing the invented TERRAIN_COAST blue was right —
// it swamped the painted coast tiles — but removing it outright left the shelf showing the open-sea
// gradient, which near a coast is nearly black: measured, near-black pixels went 293k → 1,043k the
// moment the fill went, and that is the "black squares" along every shoreline.
//
// So the fill is back, but nothing about it is chosen: COAST_TILES[band].water is the mean of the
// painted coast atlas's own cold pixels (43,71,101 temperate). The tile and the water it sits on come
// from the same Civ4 art, which is why they agree; the old #5c9cb2 came from nowhere.
//
// The ramp's endpoints now come from the PLOT'S OWN TERRAIN KEY (js/water-terrain.mjs) rather than
// from the province's latitude, so a tropical shelf ramps to tropical open water instead of to the
// temperate colour every province used to share, and a lake is its own pair. The art-derived values
// below stay as the FALLBACK for a page served an older bundle, whose colour table has no water keys.
const bandOf = lat => { const a = Math.abs(lat); return a <= 23 ? "trop" : a >= 60 ? "polar" : "temp"; };
const tcol = k => { const h = TCOL[k]; return h ? [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] : null; };
function fallbackPair(p) {
  const box = provSrcBox(p);
  const band = bandOf(box ? latAtSourceY((box.y0 + box.y1) / 2) : 45);
  const shallow = (COAST_TILES && COAST_TILES[band] && COAST_TILES[band].water) || null;
  return shallow ? { shallow, deep: (SEA_BANDS && SEA_BANDS.temp) || [38, 62, 91] } : null;
}
const shelfRgb = (q, fb) => shelfColor(q.terrain, q.landDist, tcol, fb);

// (kept for the record) Water plots used to be painted from
// `terrainColors.TERRAIN_COAST` / `TERRAIN_SEA` — #5c9cb2 and friends, display colours invented for a
// flat map that had no shore art. Once Civ4's painted coast tiles were stamped on top, that bright
// blue read as an overlay swamping them (measured on screen at 88,144,160 against the atlas's own
// painted water at 43,71,101).
//
// So water plots are now left TRANSPARENT in both province canvases. What shows through is the real
// sea: the screen-space latitude gradient with its depth band (sea.mjs drawSeaBase), which is the
// layer that was always meant to be the ocean. On top of it, on the plots that touch land, sits
// Civ4's painted coast tile (coast.mjs extendCoastIntoWater). Nothing invents a water colour anywhere.

// rasterise a province's plots to a 1px/plot offscreen canvas: terrain colour, relief
// shading (hill lighter, peak toward rock-grey), a light feature tint, and river blend
function buildPlotCanvas(p, plots) {
  // a sea/lake province's shelf plots render as flat water terrain (coast→sea depth ramp from the
  // terrain key); the land-only relief/feature/river tints below are skipped for them
  const water = p.type === "SEA" || p.type === "LAKE";
  const fb = water ? fallbackPair(p) : null;
  const { canvas, box } = buildPixelCanvas(plots, (q, d, o) => {
    if (water) {
      const g = q.landDist && shelfRgb(q, fb);
      if (!g) return;                      // no colour for this key → transparent, the sea gradient shows
      d[o] = g[0]; d[o + 1] = g[1]; d[o + 2] = g[2]; d[o + 3] = 255;
      return;
    }
    const c = terrainRgb(q.terrain); let r = c[0], g = c[1], b = c[2];
    if (!water) {
      const f = q.feature;
      if (f) {
        if (/FOREST|JUNGLE|WOOD/.test(f)) { r = r * 0.7 | 0; g = g * 0.82 + 16 | 0; b = b * 0.6 | 0; }
        else if (/SWAMP|MARSH|BOG/.test(f)) { r = r * 0.82 | 0; g = g * 0.86 | 0; b = b * 0.82 | 0; }
      }
      // A hill at 1px/plot is a colour shift — there is no room for a texture — but the shift itself
      // comes from the art: HILL_WASH.tint is the alpha-weighted mean of Civ4's own hill overlay, so
      // this composites exactly what the textured canvas stamps, at one pixel. It replaces an
      // invented `r*1.14 + 8` brightening; the authored wash is a desaturating warm grey, not a lift.
      if (q.plotType === "HILL" && HILL_WASH) {
        const [wr, wg, wb] = HILL_WASH.tint.rgb, a = HILL_WASH.tint.a;
        r = r * (1 - a) + wr * a | 0; g = g * (1 - a) + wg * a | 0; b = b * (1 - a) + wb * a | 0;
      } else if (q.plotType === "HILL") { r = Math.min(255, r * 1.14 + 8) | 0; g = Math.min(255, g * 1.14 + 8) | 0; b = Math.min(255, b * 1.14 + 8) | 0; }
      else if (q.plotType === "PEAK") { r = (r + 150) / 2 | 0; g = (g + 152) / 2 | 0; b = (b + 158) / 2 | 0; }
      // A ribbon is meaningless at 1px/plot, so a river reads here as a TINT toward a muted
      // blue-grey (not vivid cyan). Its strength rides the width class, so the Ostmark trunk still
      // carries the eye at continent zoom while a headwater thread fades into the ground — the same
      // taper the ribbon draws further in, which keeps a river's weight continuous across the zoom
      // where the two representations swap. Class 5 lands on the old flat 0.45 blend.
      if (q.river) {
        const t = 0.18 + 0.06 * riverClass(q.river);
        r = r * (1 - t) + RIVER_TINT[0] * t | 0;
        g = g * (1 - t) + RIVER_TINT[1] * t | 0;
        b = b * (1 - t) + RIVER_TINT[2] * t | 0;
      }
    }
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  });
  p._pcanvas = canvas; p._pbox = box;
}
// draw the plot layer for the provinces in view, fading in just past K_PLOT. Below
// K_TEX each province blits its flat-colour 1px/plot offscreen (cheap overview); past
// K_TEX (and not mid-pan) it draws real ground-texture tiles per plot.
// `only` (optional): a province predicate — draw just the provinces it accepts. The
// Underworld plane uses it to relight the cavern provinces' plots over its surface veil
// (see main.drawUnderworld); called with no argument it draws the whole world.
function drawPlots(only) {
  if (cam.k < K_PLOT) return;
  // WHO IS THIS PASS DRAWING FOR? Two callers, and only one of them puts pixels on the 2D canvas.
  //
  // The SURFACE is 3D-only now: layers.mjs gates `plots` on ground3D, so this runs only when the 3D
  // ground exists to drape the offscreens over (js/terrain3d.mjs §3) and the blits below are dead
  // for it. Everything else still has to run, and that is the point — the viewport cull, the lazy
  // loadPlots, the per-frame build budget and the bonus overlay are all machinery terrain3d would
  // otherwise have to reimplement; it reads `p._tcanvas`/`_tbox` straight off what this pass keeps.
  //
  // The UNDERWORLD is the one that still blits. z=−1 has no mesh (terrain3d builds none), so ground3D
  // is false there at every band and the 2D ground below is the only Serpentspine there is.
  const blit = !ground3D();
  // Real textures from band 4 (16×). Flat tiles while panning — but ONLY in 2D, where the flat
  // 1px/plot offscreen is a real stand-in that keeps a pan cheap. Under the 3D ground there is no
  // stand-in: an unbuilt province is an untextured mesh, which for a sea province is the bare sea
  // plane, i.e. the texture visibly replaced by a solid fill for as long as the drag lasts. Measured
  // mid-pan: 5 of 8 sea provinces in view had their plots and no canvas. The 6 ms build budget below
  // is what keeps the pan smooth; suppressing the builds outright on top of it just empties the map.
  const textured = atLeast(BAND.TERRAIN) && ttReady && (!S.dragging || ground3D());
  const a = bandAlpha(kBand([K_PLOT, 6.5]));   // fade in over the plots band
  const smooth = ctx.imageSmoothingEnabled;
  ctx.globalAlpha = a;
  const vis = [];   // in-view provinces with plots loaded — reused by the bonus overlay (no 2nd P scan)
  const buildDeadline = performance.now() + PLOT_FRAME_BUDGET_MS;   // stop starting builds past this
  let deferred = false;
  for (const p of P) {
    if (only && !only(p)) continue;
    // Cull to the viewport through the PROJECTOR, so this stays correct once the camera tilts — and it
    // must, because this is also the pass that decides which provinces get their plots fetched at all.
    if (provSrcBox(p)) { if (!provOnScreen(p)) continue; }
    else { const [x, y] = pll(p.lon, p.lat);                    // ring-less: a 40px box round its anchor
           if (x + 20 < 0 || y + 20 < 0 || x - 20 > VIEW.w || y - 20 > VIEW.h) continue; }
    if (!p._plots) { loadPlots(p); continue; }   // request the server-generated grid on first sight
    if (!p._plots.length) continue;              // loaded-empty (deep ocean): nothing to draw
    vis.push(p);
    if (textured) {
      // The cached canvas was baked either WITH foliage (2D owns the ground) or without it (3D stands the
      // trees up instead). If the mode has flipped since, it is the wrong canvas — drop it and let the budget
      // below rebuild it. Lazy by construction: a province off screen is never touched, and rebuilds the first
      // time it is drawn.
      if (p._tcanvas && p._tfoliage !== !props3D()) p._tcanvas = null;
      // A WATER province's beaches stand on the LAND next door (coast.mjs), and land arrives on its
      // own schedule — so a sea baked before its coastline landed has ring plots that fell back to
      // bare water. Re-bake it when one of THOSE plots can now see land, and only then: the bake
      // hands back exactly the pixels it could not resolve, an already-complete coast hands back an
      // empty list, and a province in the steady state is therefore never invalidated at all. (A
      // global "land changed" counter was tried here and thrashed every sea in view while panning.)
      //
      // STALE, NOT DROPPED. Nulling the canvas here would be the obvious way to force the re-bake,
      // and it is wrong: the rebuild has to win a slice of the 6 ms budget below, and until it does
      // the province has no texture at all — under the 3D ground that is the bare sea plane. So the
      // old canvas keeps being used (it is merely missing a beach) and buildPlotTexCanvas swaps the
      // new one in atomically when its turn comes.
      let staleShore = false;
      const gaps = p._tshoreGaps;
      if (p._tcanvas && gaps && gaps.length) {
        for (let i = 0; i < gaps.length; i += 2)
          if (shoreTerrain(shoreIndex(), gaps[i], gaps[i + 1])) { staleShore = true; break; }
      }
      if (!p._tcanvas || staleShore) {
        if (performance.now() >= buildDeadline) {   // out of frame budget — keep what we have, rebuild next frame
          deferred = true;
          // Prefer the stale TEXTURED canvas over the flat one: it is the right picture a beach late,
          // where the flat offscreen is a visible drop in fidelity.
          if (blit && p._tcanvas) { ctx.imageSmoothingEnabled = true; blitProvinceCanvas(p._tcanvas, p._tbox); }
          else if (blit && p._pcanvas) { ctx.imageSmoothingEnabled = isWater(p); blitProvinceCanvas(p._pcanvas, p._pbox); }
          continue;
        }
        buildPlotTexCanvas(p);                       // textured offscreen, built once
      }
      if (!blit) continue;
      // the textured offscreen is real ground art being scaled up → SMOOTH sampling
      ctx.imageSmoothingEnabled = true;
      blitProvinceCanvas(p._tcanvas, p._tbox);
      continue;
    }
    if (!p._pcanvas) {
      if (performance.now() >= buildDeadline) { deferred = true; continue; }   // out of budget — build next frame
      buildPlotCanvas(p, p._plots);                  // flat-colour offscreen, built once
    }
    if (!blit) continue;
    // The flat offscreen is one pixel PER PLOT, so LAND takes NEAREST sampling — smoothing would
    // smear its real ground texture to mush.
    //
    // WATER takes the opposite, and this is the coastline staircase in one line. A water plot has no
    // texture to protect, so nearest-sampling it blows every plot up into a hard square and a run of
    // them along a diagonal coast IS the staircase — which is why nothing done inside the canvases
    // ever moved it. Smoothing interpolates between plot centres instead — which still matters for
    // the ice and the coast tiles that sit on the water canvas.
    ctx.imageSmoothingEnabled = isWater(p);
    blitProvinceCanvas(p._pcanvas, p._pbox);
  }
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = smooth;
  drawBonusOverlay(vis);   // resource icons: screen-space overlay over the in-view provinces only
  if (deferred) draw();    // keep each paint under budget — finish the remaining builds over the next frames
}
// A smooth grayscale noise tile (deterministic, built once): black RGB with a soft-blob ALPHA
// channel in ~[0.25,1]. Used to make the terrain edge/corner blend IRREGULAR instead of a clean
// linear ramp — multiplied into the blend mask so boundaries interleave organically, which is what
// kills the square-tile look at deep zoom (Civ4's alpha blend masks do the same). Low-res hash noise
// upscaled with smoothing → cloudy blobs; each plot samples a different sub-region so neighbours differ.
const BLEND_NOISE = (() => {
  const LO = 32, HI = 128;
  const lo = document.createElement("canvas"); lo.width = lo.height = LO;
  const lx = lo.getContext("2d"), im = lx.createImageData(LO, LO), d = im.data;
  for (let y = 0; y < LO; y++) for (let x = 0; x < LO; x++) {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453, v = s - Math.floor(s);   // deterministic hash [0,1)
    const i = (y * LO + x) * 4;
    // alpha kept in a HIGH band [0.55,1]: the noise only nibbles the feather edge irregular, it must
    // not gut the neighbour's coverage (a low floor made lone tiles read MORE square, not less)
    d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = Math.round((0.55 + 0.45 * v) * 255);
  }
  lx.putImageData(im, 0, 0);
  const hi = document.createElement("canvas"); hi.width = hi.height = HI;
  const hx = hi.getContext("2d"); hx.imageSmoothingEnabled = true;
  hx.drawImage(lo, 0, 0, LO, LO, 0, 0, HI, HI);   // upscale → smooth blobs
  return hi;
})();
const NOISE_SUB = 40, NOISE_RANGE = 128 - NOISE_SUB;   // per-plot sample window into BLEND_NOISE
// a per-plot/edge offset into the noise so adjacent blends don't share the same irregular edge
const noiseOff = (qx, qy, d) => {
  const h = ((qx * 73856093) ^ (qy * 19349663) ^ ((d[0] + 2) * 10007) ^ ((d[1] + 2) * 20011)) >>> 0;
  return [h % NOISE_RANGE, (h >> 8) % NOISE_RANGE];
};

// rasterise a province's plots to a textured offscreen — each plot drawn as its Civ4
// ground-texture tile (from the atlas) at TPP px, plus relief/river overlays — built
// once and blitted scaled (so hover/pan redraws stay a single drawImage per province).
// TPP drops for very large provinces to bound the offscreen size.
function buildPlotTexCanvas(p) {
  // FOLIAGE, unless the 3D ground is going to stand it up instead (docs/terrain-3d.md §The plan → P3). A tree
  // baked into this canvas is a top-down stamp lying on the ground; the 3D path draws the same trees — same
  // placement, from js/foliage.mjs — as upright billboards, and drawing both would show every forest twice.
  //
  // The canvas is CACHED, so which way it was baked is recorded on the province (`_tfoliage`, at the foot of
  // this function) and drawPlots invalidates it when the mode flips. That costs one rebuild per province on the
  // first crossing of band 5, spread over frames by the existing 6 ms budget, and nothing thereafter.
  const bakeFoliage = !props3D();
  let { x0, y0, x1, y1 } = plotBounds(p._plots);
  // pad the offscreen two cells beyond the land so the coastline can bleed OUTWARD into the
  // adjacent sea (which is not a plot of this province) — wide enough for the >1-cell shallows +
  // beach reach (Lever A). The coord/size/blit all follow x0..y1; the margin is transparent sea.
  const PAD = 2;
  x0 -= PAD; y0 -= PAD; x1 += PAD; y1 += PAD;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  let tpp = 32; while (tpp > 4 && Math.max(w, h) * tpp > 2600) tpp = Math.max(4, tpp - 4);
  const oc = document.createElement("canvas"); oc.width = w * tpp; oc.height = h * tpp;
  const o = oc.getContext("2d"); o.imageSmoothingEnabled = true;
  const grid = new Map();
  for (const q of p._plots) grid.set(q.x * 1e5 + q.y, q);
  const riverPat = rvReady && rvImg ? o.createPattern(rvImg, "repeat") : null;   // water texture, or null
  // a sea/lake province's plots are all water: they still get the flat terrain fill (stage 1) and
  // the soft same-layer edge blend (stage 2) — softening the coast→sea shelf ramp — but skip the
  // land-only snow/coast-shallows/feature/river stages (3-4). LAND and wasteland build the full ground.
  const water = p.type === "SEA" || p.type === "LAKE";
  // 1) base terrain as continuous repeating patterns (no per-plot tile seam)
  //
  // 1) base terrain. Land tiles its ground texture per plot, and SO DOES WATER NOW: CoastDetail /
  // SeaDetail / ShoreDetail, recoloured in the bake to each water terrain's display colour, tiled as a
  // repeating pattern anchored to the canvas — continuous across plots exactly as land ground is.
  // Until the seabed bake there was nothing to tile: the terrain atlas was baked from land terrains
  // only, so the eight water keys had no column and the shelf was flat colour by construction.
  //
  // THE FLAT DEPTH RAMP IS NOT DRAWN OVER THE TEXTURE. It was, at 62% — and 62% of a flat fill over
  // real grain is mostly flat fill: it washed the art back out, which is the same mistake in a
  // different key as the invented blue that swamped the coast tiles. The texture is the article; it
  // is already in the right hue, because the colour it was recoloured to is the ramp's own endpoint
  // for that terrain.
  //
  // What that costs is the SMOOTH shallow→deep gradient. The ramp is rasterised at 1px/plot and blitted
  // upscaled, and that bilinear interpolation was the only thing spreading the coast→sea transition
  // across the shelf (water has no edge-blend pass — see stage 2). Textured, the shelf steps once,
  // where the terrain key itself flips COAST→SEA at landDist 2. That is the real data boundary rather
  // than a smoothing artefact, but it is a step, and if it reads as a ring along the coast the fix is
  // to bring the ramp back as a light multiply rather than to re-cover the art.
  //
  // The ramp still paints where texture cannot: an older bundle with no water columns, or a plot whose
  // key has no tile. Those plots keep exactly the flat shelf that shipped before.
  if (water) {
    const fb = fallbackPair(p);
    const flat = [];                          // plots the seabed texture did not cover
    const wpat = {};
    for (const q of p._plots) {
      if (!q.landDist) continue;
      let pp = wpat[q.terrain];
      if (pp === undefined) { const tc = ttTiles && ttTiles[q.terrain]; pp = wpat[q.terrain] = tc ? o.createPattern(tc, "repeat") : null; }
      if (pp) { o.fillStyle = pp; o.fillRect((q.x - x0) * tpp, (q.y - y0) * tpp, tpp, tpp); }
      else flat.push(q);
    }
    if (flat.length) {
      const wc = document.createElement("canvas"); wc.width = w; wc.height = h;
      const wx = wc.getContext("2d"), im = wx.createImageData(w, h);
      let any = false;
      for (const q of flat) {
        const g = shelfRgb(q, fb);
        if (!g) continue;
        const k = ((q.y - y0) * w + (q.x - x0)) * 4;
        im.data[k] = g[0]; im.data[k + 1] = g[1]; im.data[k + 2] = g[2]; im.data[k + 3] = 255;
        any = true;
      }
      if (any) {
        wx.putImageData(im, 0, 0);
        o.imageSmoothingEnabled = true;
        o.drawImage(wc, 0, 0, w, h, 0, 0, w * tpp, h * tpp);
      }
    }
  }
  const pat = {};
  if (!water) for (const q of p._plots) {
    const cx = (q.x - x0) * tpp, cy = (q.y - y0) * tpp;
    let pp = pat[q.terrain];
    if (pp === undefined) { const tc = ttTiles && ttTiles[q.terrain]; pp = pat[q.terrain] = tc ? o.createPattern(tc, "repeat") : null; }
    if (pp) { o.fillStyle = pp; o.fillRect(cx, cy, tpp, tpp); }
    else { const g = terrainRgb(q.terrain); o.fillStyle = `rgb(${g[0]},${g[1]},${g[2]})`; o.fillRect(cx, cy, tpp, tpp); }
  }
  // 1b) the HILL WASH — Civ4's hill overlay stamped over the ground it shades, at its own authored
  // alpha (~0.39). It sits here, between the ground and the edge blend, because a hill is not a blend
  // LAYER: the plot's terrain is unchanged and the wash only shades it, so a higher-layer neighbour's
  // blend must still feather over the top. One of two authored variants per plot, picked by a
  // position hash so a range of hills does not stamp the same cell across every plot.
  if (!water && hwReady) for (const q of p._plots) {
    if (q.plotType !== "HILL") continue;
    const v = hwCells[(((q.x * 73856093) ^ (q.y * 19349663)) >>> 0) % hwCells.length];
    o.drawImage(v, 0, 0, HILL_WASH.cell, HILL_WASH.cell, (q.x - x0) * tpp, (q.y - y0) * tpp, tpp, tpp);
  }
  // 2) edge blend — LAND ONLY. This is THE coastline staircase, and it hid behind every other
  // suspect: it feathers a neighbour's terrain colour across each shared edge by drawing per-plot
  // RECTS (plus a diagonal corner pass), so on a water province it repainted hard plot squares
  // straight over the smooth rasterised water underneath. Every fix aimed at the water fill was
  // therefore invisible — the fill was correct, and this drew on top of it. Water needs no edge
  // blend at all: its 1px/plot rasterisation IS the blend, interpolated by the bilinear upscale.
  // Found by painting the water fill magenta and seeing the blue squares survive on top of it.
  //
  // (original note) a neighbour's colour feathers over this plot across the shared edge (Civ4 §6.1,
  // adapted to the raster — a colour bleed, not a tile swap). A HIGHER-LayerOrder neighbour bleeds
  // strongly; EQUAL-order neighbours bleed mutually at half strength (each side blends the other) so
  // same-layer terrain boundaries — grass/plains/tundra etc. — soften instead of meeting at a hard
  // seam; a LOWER neighbour is skipped here and handled when ITS cell bleeds this one back.
  const f = tpp * 0.85;
  if (!water) {
  // When a plot is big enough to read its texture (deep/city zoom), feather the neighbour's REAL
  // terrain tile across the edge instead of a flat colour: draw the tile into a per-plot temp,
  // mask it to a soft edge ramp with `destination-in`, and composite it over this plot's base. That
  // dissolves grass/plains/tundra boundaries the way Civ4's blend tiles do. At small tpp (a huge
  // province zoomed out) the seam is sub-pixel, so keep the cheap flat-colour feather there.
  const textured = tpp >= 12 && ttTiles;
  let eb = null, ebx = null;
  if (textured) { eb = document.createElement("canvas"); eb.width = tpp; eb.height = tpp; ebx = eb.getContext("2d"); }
  for (const q of p._plots) {
    const ql = LY[q.terrain] || 0, cx = (q.x - x0) * tpp, cy = (q.y - y0) * tpp;
    for (const d of NB4) {
      const n = grid.get((q.x + d[0]) * 1e5 + (q.y + d[1]));
      if (!n || n.terrain === q.terrain) continue;
      const nl = LY[n.terrain] || 0;
      // blend BOTH sides of every boundary so neither edge stays a hard line (Civ4 mutual blend):
      // a higher-layer neighbour bleeds strongly onto this lower plot, a lower one bleeds back strongly
      // enough to actually soften this higher plot's edge, equal layers meet in the middle.
      const a = nl > ql ? 0.95 : nl < ql ? 0.55 : 0.7;
      const tile = textured ? ttTiles[n.terrain] : null;
      if (tile) {
        // paint the neighbour's tile, mask it to a feather along the shared edge, blit over the plot
        ebx.globalCompositeOperation = "source-over"; ebx.clearRect(0, 0, tpp, tpp);
        ebx.drawImage(tile, 0, 0, tile.width, tile.height, 0, 0, tpp, tpp);
        let gm;
        if (d[0] === 1)       gm = ebx.createLinearGradient(tpp, 0, tpp - f, 0);
        else if (d[0] === -1) gm = ebx.createLinearGradient(0, 0, f, 0);
        else if (d[1] === 1)  gm = ebx.createLinearGradient(0, tpp, 0, tpp - f);
        else                  gm = ebx.createLinearGradient(0, 0, 0, f);
        gm.addColorStop(0, `rgba(0,0,0,${a})`); gm.addColorStop(1, "rgba(0,0,0,0)");
        ebx.globalCompositeOperation = "destination-in";
        ebx.fillStyle = gm; ebx.fillRect(0, 0, tpp, tpp);
        const [nx, ny] = noiseOff(q.x, q.y, d);      // multiply by smooth noise → irregular, non-square edge
        ebx.drawImage(BLEND_NOISE, nx, ny, NOISE_SUB, NOISE_SUB, 0, 0, tpp, tpp);
        o.drawImage(eb, cx, cy);
        continue;
      }
      const g = terrainRgb(n.terrain);            // fallback: flat-colour feather (small tpp / missing tile)
      const c0 = `rgba(${g[0]},${g[1]},${g[2]},${a})`, c1 = `rgba(${g[0]},${g[1]},${g[2]},0)`;
      let gr, rx, ry, rw, rh;
      if (d[0] === 1) { gr = o.createLinearGradient(cx + tpp, 0, cx + tpp - f, 0); rx = cx + tpp - f; ry = cy; rw = f; rh = tpp; }
      else if (d[0] === -1) { gr = o.createLinearGradient(cx, 0, cx + f, 0); rx = cx; ry = cy; rw = f; rh = tpp; }
      else if (d[1] === 1) { gr = o.createLinearGradient(0, cy + tpp, 0, cy + tpp - f); rx = cx; ry = cy + tpp - f; rw = tpp; rh = f; }
      else { gr = o.createLinearGradient(0, cy, 0, cy + f); rx = cx; ry = cy; rw = tpp; rh = f; }
      gr.addColorStop(0, c0); gr.addColorStop(1, c1);
      o.fillStyle = gr; o.fillRect(rx, ry, rw, rh);
    }
  }
  // 2b) corner blend: the 4-edge pass leaves the diagonal gaps — where a plot's DIAGONAL neighbour
  // differs but both flanking orthogonal neighbours match, that corner stays a hard square notch.
  // Feather the diagonal neighbour's tile into the corner with a radial mask. Skipped when a flanking
  // orthogonal neighbour already shares that terrain (its edge blend covers the corner), and only when
  // the texture is big enough to read (same tpp gate + temp canvas as the edge pass).
  if (textured) {
    const NB4D = [[1, -1], [-1, -1], [1, 1], [-1, 1]];   // NE, NW, SE, SW
    const fc = tpp * 0.6;
    for (const q of p._plots) {
      const ql = LY[q.terrain] || 0, cx = (q.x - x0) * tpp, cy = (q.y - y0) * tpp;
      for (const d of NB4D) {
        const n = grid.get((q.x + d[0]) * 1e5 + (q.y + d[1]));
        if (!n || n.terrain === q.terrain) continue;
        const nl = LY[n.terrain] || 0;
        const e1 = grid.get((q.x + d[0]) * 1e5 + q.y);   // the two orthogonal neighbours flanking this corner
        const e2 = grid.get(q.x * 1e5 + (q.y + d[1]));
        if ((e1 && e1.terrain === n.terrain) || (e2 && e2.terrain === n.terrain)) continue;   // edge blend already covers it
        const tile = ttTiles[n.terrain];
        if (!tile) continue;
        const a = nl > ql ? 0.95 : nl < ql ? 0.55 : 0.7;   // mutual: soften both sides of the corner
        ebx.globalCompositeOperation = "source-over"; ebx.clearRect(0, 0, tpp, tpp);
        ebx.drawImage(tile, 0, 0, tile.width, tile.height, 0, 0, tpp, tpp);
        const vx = d[0] === 1 ? tpp : 0, vy = d[1] === 1 ? tpp : 0;
        const gm = ebx.createRadialGradient(vx, vy, 0, vx, vy, fc);
        gm.addColorStop(0, `rgba(0,0,0,${a})`); gm.addColorStop(1, "rgba(0,0,0,0)");
        ebx.globalCompositeOperation = "destination-in";
        ebx.fillStyle = gm; ebx.fillRect(0, 0, tpp, tpp);
        const [nx, ny] = noiseOff(q.x, q.y, d);      // irregular corner, same noise mask as the edges
        ebx.drawImage(BLEND_NOISE, nx, ny, NOISE_SUB, NOISE_SUB, 0, 0, tpp, tpp);
        o.drawImage(eb, cx, cy);
      }
    }
  }
  }   // end land-only edge/corner blend
  if (!water) {
  // 3) snow on the highest ground. (The elevation-normal hillshade that used to sit here was
  // removed: with EXAG amplifying the gentle continental heightmap, near-flat provinces — most of
  // the map — picked up a strong per-plot bright/dark checker that just read as square tiles. The
  // ground is now the flat Civ4 terrain texture; relief reads from the terrain/feature mix instead.)
  // built at 1px/plot then blitted UPSCALED with smoothing, so the white feathers between snowy and
  // bare plots (bilinear alpha ramp) instead of stamping a hard square on each high plot.
  {
    const sc = document.createElement("canvas"); sc.width = w; sc.height = h;
    const sxc = sc.getContext("2d"), sim = sxc.createImageData(w, h), sd = sim.data;
    let anySnow = false;
    for (let i = 0; i < w * h; i++) { sd[i * 4] = 232; sd[i * 4 + 1] = 238; sd[i * 4 + 2] = 247; }   // white; alpha 0 (RGB set so upscale has no dark halo)
    for (const q of p._plots) {
      const e = q.elevation | 0;
      if (e < 165) continue;
      anySnow = true;
      const oi = ((q.y - y0) * w + (q.x - x0)) * 4;
      sd[oi + 3] = Math.round(Math.min(0.6, (e - 165) / 50) * 255);
    }
    if (anySnow) { sxc.putImageData(sim, 0, 0); o.imageSmoothingEnabled = true; o.drawImage(sc, 0, 0, w, h, 0, 0, w * tpp, h * tpp); }
  }
  // (No land-side coast pass any more. The shoreline is Civ4's painted coast tiles, stamped on the
  // WATER plots below — sand is a coast feature, not a land one. See coast.mjs.)
  // desaturate the river ribbon so water recedes into the landscape instead of gridding vivid cyan
  // over it — baked once into the cached province canvas, so it costs nothing per frame
  o.filter = "saturate(0.7) brightness(0.94)";
  drawRivers(o, p._plots, x0, y0, tpp, grid, riverPat);
  o.filter = "none";
  // NO RELIEF PROPS HERE, and it is a decision rather than an omission — see terrain3d.mjs §relief props.
  // The mountain a PEAK plot gets is a 3D-ground prop that fades in WITH THE TILT, so this canvas (which is
  // the whole ground below band 5, and the tilt-0 picture the 3D path has to match at the seam) is exactly
  // as it was. Two reasons, either sufficient: the sprite is a FRONT elevation rendered by tools/nifbake, and
  // a front elevation laid flat on a top-down map is the wrong drawing of a mountain; and stamping it here
  // would put mountains in the tilt-0 frame that the 3D path must then reproduce through GPU minification of
  // a 280 px sprite at 22 screen px, which measurably widens the seam diff (85.9% within 16 against a 90%
  // gate) for a view no one looks at mountains from.
  if (bakeFoliage) for (const q of p._plots) {
    if (q.feature) { const cx = (q.x - x0) * tpp, cy = (q.y - y0) * tpp; featureSprite(o, cx, cy, tpp, q.feature, q.x, q.y); }
  }
  // improvements: a flat Civ6 SV overlay (farm/mine/quarry) over each improved plot, on top of the
  // ground + feature. No-op today — nothing carries an `improvement` yet (placement deferred).
  for (const q of p._plots) {
    if (q.improvement) { const cx = (q.x - x0) * tpp, cy = (q.y - y0) * tpp; improvementSprite(o, cx, cy, tpp, q.improvement, q.x, q.y); }
  }
  // (city cores are re-terrained to their countryside in markUrbanPlots; a subtle screen-space
  // marker in city.mjs keeps them locatable — the old Civ4 city sprite was pulled, see there.)
  } // end land-only ground stages
  // The coast reaches OUT into the shallow water tiles along Civ4's blend curve (coast.mjs). On the
  // WATER province, never the land one: painting the mask on a land plot puts sea inside it, which is
  // backwards and visibly wrong on a tile whose only water contact is a diagonal corner.
  // `tileOf` lets the coast lay the neighbouring LAND terrain's ground under the painted cell, so the
  // cell's transparent landward half reveals beach instead of the blue water beneath (see coast.mjs).
  // The resolver is passed in rather than imported there because ttTiles is this module's state.
  // …and the ring plots whose land neighbour had not loaded when this baked, so drawPlots can re-bake
  // the province the moment one of them resolves (and never otherwise — see coast.mjs).
  if (water) p._tshoreGaps = extendCoastIntoWater(o, p._plots, x0, y0, tpp,
    provSrcBox(p) ? latAtSourceY((provSrcBox(p).y0 + provSrcBox(p).y1) / 2) : 45,
    t => ttTiles && ttTiles[t]);
  if (water) drawSeaIce(o, p._plots, x0, y0, tpp);   // polar sea ice on the shelf water plots
  // (No shelf-edge fade any more. From MAP_VERSION 13 a sea province draws EVERY water cell it owns,
  // so there is no shelf boundary left to dissolve. fadeShelfEdge existed to feather an edge that no
  // longer exists, and there is no water fill left for it to feather either.)
  p._tcanvas = oc; p._tbox = { x0, y0, w, h }; p._grid = grid;   // grid: q.x*1e5+q.y → plot, for the resource tooltip
  p._tfoliage = bakeFoliage;   // which way this canvas was baked — drawPlots invalidates it when that flips
}
// The river ribbon: a water-textured centre line running through each river cell, its width set by the
// plot's render width class — one class per octave of drainage, so a headwater reads as a thread and a
// trunk as a highway of water (docs/river-rendering.md §4). Drawn as ONE province-wide pass rather than
// per cell, so the whole network is stroked as a handful of paths — one per width class present.
//
// This replaced a full-cell fillRect, which flooded every river plot's entire square with the water
// texture: blocky, opaque over the terrain, and blind to width. The three passes below (bank, shallow,
// water) are stroked along the ribbon, so the banks now follow the WATER rather than outlining the plot
// grid — which is what made the old rivers read as tiles instead of rivers.
function drawRivers(o, plots, x0, y0, tpp, grid, pat) {
  // bucket every cell's centre-line geometry by width class: cells of one class share a stroke width,
  // so each class needs exactly one path. Adjacent cells of DIFFERENT classes still meet exactly at
  // their shared edge midpoint, and the round cap hides the width step — which is why the ribbon can
  // taper at all without offsetting a variable-width polygon.
  const byClass = new Map();
  for (const q of plots) {
    if (!q.river) continue;
    const cls = riverClass(q.river);
    const links = riverLinks(q.river, (dx, dy) => {
      const n = grid.get((q.x + dx) * 1e5 + (q.y + dy));
      return !!(n && n.river);
    });
    let path = byClass.get(cls);
    if (!path) byClass.set(cls, path = new Path2D());
    for (const sp of cellStrokes(links, (q.x - x0) * tpp, (q.y - y0) * tpp, tpp)) {
      path.moveTo(sp.from[0], sp.from[1]);
      if (sp.kind === "curve") path.quadraticCurveTo(sp.ctrl[0], sp.ctrl[1], sp.to[0], sp.to[1]);
      else path.lineTo(sp.to[0], sp.to[1]);
    }
  }
  if (!byClass.size) return;
  o.save();
  o.lineCap = "round"; o.lineJoin = "round";
  const bank = Math.max(1, tpp * 0.07);
  // Three passes over every class, widest ring first, so a narrow tributary's bank can never cut a
  // dark line across the trunk it joins — every bank is under every ribbon.
  const pass = (grow, style, alpha) => {
    o.strokeStyle = style; o.globalAlpha = alpha;
    for (const [cls, path] of byClass) {
      o.lineWidth = ribbonWidth(cls, tpp) + grow;
      o.stroke(path);
    }
  };
  pass(bank * 2, "rgba(30,50,44,1)", 0.4);                 // wet bank — the dark line where water meets land
  pass(bank, "rgba(150,198,224,1)", 0.55);                 // shallows — a light rim inside the bank, as the sea coast has
  pass(0, pat || "rgba(74,124,170,1)", pat ? 0.95 : 0.6);  // the water itself (flat blue if the tile is absent)
  o.restore();
}
// Stamp real Civ4 tree cutouts into a plot, from the SHARED placement (js/foliage.mjs — which is also what
// the 3D prop layer builds its billboards from, so the two agree tree for tree). Returns false when the
// group's atlas isn't loaded, so the caller can fall back.
function stampTrees(o, cx, cy, s, feature, sx, sy) {
  const g = foliageGroup(feature);
  const meta = g && TREES && TREES[g.key];
  if (!meta) return false;
  const pl = placeFoliage(feature, sx, sy, meta.sprites);
  if (!pl || !treeReady[pl.key]) return false;
  const img = treeImg[pl.key];
  // back-to-front already (placeFoliage sorts by y), so nearer trees overlap the ones behind
  for (const it of pl.items)
    o.drawImage(img, it.sp[0], it.sp[1], it.sp[2], it.sp[3],
      cx + s * (it.x - it.w / 2), cy + s * (it.y - it.h / 2), s * it.w, s * it.h);
  return true;
}
function featureSprite(o, cx, cy, s, feature, sx, sy) {
  // Every feature draws as scattered Civ4 billboards (docs/features-art.md). The flat Civ6
  // strategic-view overlays that used to short-circuit SWAMP and OASIS are gone with the depot; both
  // always had a billboard group underneath, so nothing is lost. FLOOD_PLAINS draws nothing by design.
  // tall grass has no good billboard (the C2C sword-grass sprite was a muddy wheat crop), so draw it
  // procedurally: a few clumps of thin curved blades. Clean, varied, no ugly texture.
  if (isGrassFeature(feature)) { stampGrass(o, cx, cy, s, mkRng(foliageSeed(sx, sy))); return; }
  if (!foliageGroup(feature)) return;
  stampTrees(o, cx, cy, s, feature, sx, sy);     // real foliage sprites; nothing if not yet loaded
}
// Procedural tall-grass: N clumps of a few thin, curved, tapering blades in varied greens — a clean
// savanna tuft in place of the muddy sword-grass billboard. Deterministic via the plot rng.
function stampGrass(o, cx, cy, s, rng) {
  const clumps = 3 + (rng() * 3 | 0);            // 3–5 clumps per plot
  o.save();
  o.lineCap = "round";
  for (let c = 0; c < clumps; c++) {
    const bx = cx + s * (0.12 + 0.76 * rng()), by = cy + s * (0.5 + 0.45 * rng());   // clump base
    const h = s * (0.15 + 0.13 * rng());          // clump height (shorter than before)
    const g = 108 + (rng() * 46 | 0);             // muted green value 108–154
    o.strokeStyle = `rgb(${(g * 0.52) | 0},${(g * 0.82) | 0},${(g * 0.34) | 0})`;   // olive / forest, not lime
    o.lineWidth = Math.max(0.5, s * 0.02);
    const blades = 3 + (rng() * 3 | 0);
    for (let b = 0; b < blades; b++) {
      const bx0 = bx + (blades > 1 ? b / (blades - 1) - 0.5 : 0) * s * 0.13;   // spread the bases
      const lean = (rng() - 0.5) * s * 0.13;                                    // each blade leans its own way
      o.beginPath();
      o.moveTo(bx0, by);
      o.quadraticCurveTo(bx0 + lean * 0.5, by - h * 0.55, bx0 + lean, by - h * (0.8 + 0.4 * rng()));
      o.stroke();
    }
  }
  o.restore();
}
// A flat Civ6 SV improvement overlay (farm/mine/quarry) centred on an improved plot. A 128² alpha sprite
// blitted to fill the plot; per-plot horizontal flip breaks the tiling like the feature overlays. Nothing
// draws if the art isn't loaded, the improvement is uncovered by Civ6, or (today) the plot has no
// improvement at all — placement is deferred (docs/civ6-art-replacement.md §F).
function improvementSprite(o, cx, cy, s, improvement, sx, sy) {
  const sheet = IMPROVEMENT_OVERLAYS && IMPROVEMENT_OVERLAYS[improvement];
  if (!sheet || !impImg[improvement] || !impReady[improvement]) return;
  // pick a VARIANT per plot, the way the tree billboards do — the sheet carries Civ4's own
  // an_eu_farm01/02/03 rather than one model, and stamping the first everywhere reads as a pattern
  const cells = sheet.sprites && sheet.sprites.length ? sheet.sprites : null;
  const r = cells ? cells[Math.floor(mkRng(foliageSeed(sx, sy))() * cells.length) % cells.length] : null;
  const flip = (sx ^ sy) & 1;               // per-plot mirror, so even one variant is not uniform
  o.save();
  if (flip) { o.translate(cx + s, cy); o.scale(-1, 1); } else o.translate(cx, cy);
  if (r) {
    const k = Math.min(s / r[2], s / r[3]);  // fit the cell in the plot, keeping its aspect
    o.drawImage(impImg[improvement], r[0], r[1], r[2], r[3], (s - r[2] * k) / 2, (s - r[3] * k) / 2, r[2] * k, r[3] * k);
  } else o.drawImage(impImg[improvement], 0, 0, s, s);
  o.restore();
}
export { drawPlots };
