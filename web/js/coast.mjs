"use strict";
// The shoreline and the polar sea ice. A self-contained renderer that paints into a province's
// offscreen canvas (buildPlotTexCanvas calls extendCoastIntoWater + drawSeaIce for WATER provinces)
// and owns the art atlases only it uses.
//
// THERE IS NO LONGER ANY LAND-SIDE COAST RENDERING, and that is the point. This file used to draw a
// procedural shoreline from each coastal LAND plot — a shallow band reaching outward, hash-shaped
// sand quads jutting into the sea (coastDepth / coastExtendPolys), a sand apron feathering inland
// (inwardBands), and a foam lap (drawFoam). Every one of those predates there being any shore art,
// and together they drew a second shoreline, by different rules, in the same place Civ4's painted
// coast tiles occupy. The band was literally covering the art.
//
// Sand is a COAST feature: it belongs to the water tile that meets the land, not to the land tile.
// So the whole shoreline is now one thing — Civ4's painted coast tiles, stamped on the WATER plots by
// their own adjacency (extendCoastIntoWater). See docs/civ4-texture-inventory.md §4 P3.
//
// The bundle still carries `beach` (the rectified sand ramps) and `foam` (the wave-crest strip); both
// are superseded by the painted tiles and simply go unread. The bakes are left in place rather than
// ripped out, so nothing has to be re-derived if a future layer wants a sand colour or a surf strip.
import { ICE_ART, COAST_TILES, SHORE } from "./core.mjs";
import { loadArt } from "./plotcanvas.mjs";
import { waterBand, coastConfig } from "./water-terrain.mjs";
import { shoreTerrain } from "./shore-index.mjs";
import { shoreIndex } from "./plotfetch.mjs";

// the real Civ4 pack-ice tile (docs/coastlines.md Phase G), features/icepack; null → drawSeaIce
// falls back to flat pale floes
let iceReady = false, icePat = null;
const iceImg = loadArt(ICE_ART, () => { iceReady = true; });
// Civ4's painted coast tiles, one atlas per climate band (§4 P3); null → no coast tile is drawn
const ctImg = {}, ctReady = {};
if (COAST_TILES) for (const b of ["trop", "temp", "polar"])
  ctImg[b] = loadArt(COAST_TILES[b], () => { ctReady[b] = true; });
/** Which climate atlas a latitude takes — the FALLBACK band, for a plot with no terrain key. */
const bandOf = lat => { const a = Math.abs(lat); return a <= 23 ? "trop" : a >= 60 ? "polar" : "temp"; };

// THE DETAIL HALF of ART_DEF_TERRAIN_COAST. The art define binds two textures and Civ4 composites
// them: `<Path>` (coast*blend.dds — the base: colour and the painted shoreline) MODULATED BY
// `<Detail>` (coastdetail.dds — all the grain). We drew only the base, so a coast plot was flat
// painted art with no texture in it, while the terrain beneath supplied grain the tile then covered.
//
// The detail layer needs no new bake: `bakeShoreTile` already renders coastdetail.dds to a
// neutral-mean greyscale tile (mean 128, contrast 1.3, seamless) and ships it as `shore` — where it
// sat UNREAD, orphaned when the shallow band it was written for was deleted. Its own comment says
// what it is for: "a neutral-mean greyscale detail, drawn over … so it grains the shore hue without
// recolouring it".
let shReady = false, shPat = null;
const shImg = SHORE ? loadArt(SHORE, () => { shReady = true; }) : null;

// deterministic 0..1 hash — the same integer-mix idiom drawSeaIce uses, for jitter that is
// stable across redraws and seed-reproducible (no Math.random)
const chash = (a, b) => ((Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 40503)) >>> 0) / 4294967295;

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
export function extendCoastIntoWater(o, plots, x0, y0, tpp, lat = 45, tileOf = null) {
  if (!COAST_TILES) return [];
  const provBand = bandOf(lat);
  const C = COAST_TILES.cell, cols = COAST_TILES.cols, blend = COAST_TILES.blend;
  const LAND = shoreIndex();
  // Ring plots whose land neighbour had not loaded, as a flat [x,y,x,y,…]. Returned so the caller can
  // re-bake this province EXACTLY when one of them resolves.
  //
  // The first cut of this used a global "land index version" counter and dropped every water canvas
  // whenever any land province was indexed. That is correct and useless: panning streams land in
  // continuously, so every sea in view was invalidated several times a second, none of them ever
  // finished re-baking inside the 6 ms frame budget, and the sea fell back to the flat 3D plane for as
  // long as the camera kept moving — the texture "covered by a solid fill". Precision matters here
  // because the invalidation competes with a frame budget: a coast that is fully resolved returns an
  // EMPTY list and is never invalidated again, which is the steady state for everything on screen.
  const unresolved = [];
  o.save();
  o.imageSmoothingEnabled = true;
  const stamped = [];                                     // plot rects that took a cell (the detail pass below)
  for (const q of plots) {
    if (q.landDist !== 1) continue;                       // only the ring that touches land
    // THE LAND UNDER THE BEACH, and without it the authored alpha has nothing to reveal.
    //
    // A coast cell is a transition: opaque surf on its water corners, alpha ~10..38 on its land ones
    // (measured on coastblend.dds cell 3 — see js/shore-index.mjs). That low alpha means "show the
    // terrain beneath", and on Civ4's mesh the terrain beneath a shore is the LAND. Ours was the
    // interior water texture, a flat 21,45,82, so every shoreline drew a dark blue band between the
    // sand and the grass — the art asking for ground and being handed ocean.
    //
    // So paint the neighbouring land terrain's own ground tile across the plot first, and let the cell
    // composite over it exactly as authored: pure surf where alpha is high, beach where it is low, and
    // the ~20% of land that shows through the surf is the transition the artist drew, not a leak.
    //
    // Skipped when the land next door has not loaded (shoreTerrain → null) or its tile is missing:
    // the alternative is baking a guessed colour into a cached canvas. Those plots are returned as
    // `unresolved`, and plots.mjs re-bakes the province once one of them can see land — so the beach
    // fills itself in as soon as the coastline next door arrives.
    if (tileOf) {
      const lt = shoreTerrain(LAND, q.x, q.y);
      const ltile = lt && tileOf(lt);
      if (ltile) {
        const lp = o.createPattern(ltile, "repeat");
        if (lp) {
          o.fillStyle = lp;
          o.fillRect((q.x - x0) * tpp, (q.y - y0) * tpp, tpp, tpp);
        }
      } else if (!lt) unresolved.push(q.x, q.y);   // land not loaded yet — see the return value
    }
    // The atlas is picked PER PLOT, from its own terrain key, falling back to the province latitude
    // for a plot whose key is missing. Latitude was the only input before, and on this map it is the
    // wrong one: the engine bands water by temperature precisely because the EU4 projection's
    // inverse-Mercator latitudes put temperate Cannor at 60–75°, which the |lat| ≥ 60 rule calls
    // polar. The shallow water under these tiles reads the same key (js/water-terrain.mjs), so tile
    // and water still come from one atlas — which is the entire point of the fill.
    const band = waterBand(q.terrain) || provBand;
    const A = ctImg[band];
    if (!A || !ctReady[band]) continue;
    // The plot's DIAGONAL-CORNER adjacency — our high nibble, which is already Civ4's bit order
    // (js/water-terrain.mjs coastConfig, where the quadrant measurement that proves it is recorded).
    // This was briefly "fixed" to the edge nibble, which rotated every shoreline off its corner.
    const cfg = coastConfig(q.coast);
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
    stamped.push([cx, cy]);
  }
  // …then MODULATE the base by its detail — the second half of the art define, in a second pass so
  // the composite mode is set once rather than per plot.
  //
  // `hard-light` with the DETAIL on top is the canvas operator that matches Civ4's modulate2x: it is
  // neutral where the top layer is grey 128 (which is exactly what bakeShoreTile normalises to), and
  // modulates in both directions from there. `multiply` would be wrong — a mean-128 layer would halve
  // the whole coast. `soft-light` is the gentler alternative, and is what the sea ripple uses; swap to
  // it if this reads too strong at deep zoom.
  //
  // ONLY over the plots that took a cell. Every other water plot already carries this grain: its
  // ground tile IS the recoloured detail texture, so modulating it again would double the contrast.
  // The pattern is left at native scale and anchored to the canvas, like the seabed's own tiling, so
  // the grain runs continuously from the painted coast into the open water beside it.
  if (stamped.length && shReady && shImg) {
    shPat = shPat || o.createPattern(shImg, "repeat");
    if (shPat) {
      o.globalCompositeOperation = "hard-light";
      o.fillStyle = shPat;
      for (const [cx, cy] of stamped) o.fillRect(cx, cy, tpp, tpp);
    }
  }
  o.restore();
  return unresolved;
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
