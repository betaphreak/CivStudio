"use strict";
// The LAYER REGISTRY — the single source of truth for the scene's draw ORDER (array order =
// back-to-front paint order), per-layer GATING, and a band annotation. main.renderScene() runs
// renderLayers() once per on-screen world copy. To reorder a layer, move its line; to change when
// it appears, edit its `gate`; the actual band fade is single-sourced inside each draw fn (Phase 2)
// and summarised here in `band`. This is the "draw order + band mapping in one place" seam —
// see docs/zoom-bands.md §Layer registry.
//
// The draw fns live in the modules that own their state (main.mjs closes over the raster/camera and
// the province-polygon helpers; the overlays own their own); this module only orders and gates them.
import { isPolitical, activeZ, S } from "./core.mjs";
import { drawRaster, drawLakes, drawSeaCells, drawImpassable, drawSurfacePlots,
         drawProvinceBorders, drawUnderworldVeil, drawCavernFloors, drawCavernPlots, drawCavernRims,
         drawCaveEntrances, drawAdjacencies, drawRealmArrows, drawHoverHighlight, drawSelectedHighlight } from "./main.mjs";
import { drawSeaBase } from "./sea.mjs";
import { drawCostOverlay } from "./cost.mjs";
import { drawTradeGoodIcons } from "./bonusicons.mjs";
import { drawRoutes } from "./routes.mjs";
import { drawTiers } from "./overlays/tiers.mjs";
import { drawPolitical } from "./overlays/political.mjs";
import { drawLive } from "./overlays/live.mjs";
import { drawLabels } from "./labels.mjs";
import { drawCity } from "./city.mjs";
import { drawDistricts } from "./districts.mjs";

const notPolitical = () => !isPolitical();

// ---- the SCREEN-SPACE stack: drawn ONCE per frame, beneath everything ----
// This fills the viewport from the latitude at each screen row and knows nothing about the
// cylindrical wrap, so — unlike LAYERS — it must NOT run per world copy: re-filling would composite
// the sea's soft-light ripple over itself once per copy, darkening it. main.paint() runs this stack
// before the wrap loop. The land raster's ocean pixels are transparent, so this shows through
// exactly where there is sea. See js/sea.mjs for why it lives outside LAYERS.
//
// A one-entry registry looks like overkill, but the stack is the seam: the polar ice cap lived here
// until it was cut for cost (see sea.mjs), and fog of war will land here when the RevealedMap exists.
export const SCREEN_LAYERS = [
  { id: "seaBase", band: "all", draw: drawSeaBase },
];

/** Paint the screen-space stack (once per frame, before any world copy is rendered). */
export function renderScreenLayers() {
  for (const L of SCREEN_LAYERS) {
    if (L.gate && !L.gate()) continue;
    L.draw();
  }
}

// Back-to-front. `band` documents where the layer lives on the zoom spine (self-fading layers carry
// their own bandAlpha inside `draw`); `gate` is a cheap predicate that skips the layer; `z` limits
// the layer to a set of z-levels (omitted = drawn on every level — the surface stack shows on z=−1
// too, veiled to a ghost under underworldVeil). The z=−1 block is the old monolithic drawUnderworld
// folded into first-class entries — see docs/zoom-bands.md §Z-levels.
export const LAYERS = [
  { id: "raster",         band: "all",                     draw: drawRaster },
  { id: "lakes",          band: "all",                     draw: drawLakes },
  { id: "seaCells",       band: "all",  gate: notPolitical, draw: drawSeaCells },
  { id: "plots",          band: "≥REGION→, self-fade", gate: notPolitical, draw: drawSurfacePlots },
  { id: "cost",           band: "≥REGION→, toggle",        draw: drawCostOverlay },
  { id: "impassable",     band: "all",  gate: notPolitical, draw: drawImpassable },
  { id: "political",      band: "self-fade", gate: isPolitical, draw: drawPolitical },
  { id: "tiers",          band: "WORLD–PROVINCE, self-fade", draw: drawTiers },
  { id: "provBorders",    band: "PROVINCE (7.5→10×)",      draw: drawProvinceBorders },
  // z=−1 Underworld (Serpentspine): veil the surface above → cave floors → per-plot cave terrain → rims
  { id: "underworldVeil", z: [-1], band: "all",            draw: drawUnderworldVeil },
  { id: "cavernFloors",   z: [-1], band: "all",            draw: drawCavernFloors },
  { id: "cavernPlots",    z: [-1], band: "≥REGION→",       draw: drawCavernPlots },
  { id: "cavernRims",     z: [-1], band: "all",            draw: drawCavernRims },
  { id: "caveEntrances",  z: [0],  band: "all",            draw: drawCaveEntrances },
  { id: "adjacencies",    band: "≥3.3 (10×)",              draw: drawAdjacencies },
  { id: "realmArrows",    z: [0],  band: "all",            draw: drawRealmArrows },   // cross-realm teleporter → "to <Realm>" arrow (self-gates on ?realm=)
  { id: "hover",          band: "all",                     draw: drawHoverHighlight },
  { id: "selected",       band: "all",                     draw: drawSelectedHighlight },
  { id: "live",           band: "all",  gate: () => S.overlay === "live", draw: drawLive },
  { id: "tradeGoods",     z: [0],  band: "TERRAIN→PLOT, self-fade", gate: notPolitical, draw: drawTradeGoodIcons },
  { id: "routes",         z: [0],  band: "≥TERRAIN, self-fade", gate: notPolitical, draw: drawRoutes },
  { id: "city",           z: [0],  band: "≥PROVINCE, self-fade", gate: notPolitical, draw: drawCity },
  { id: "districts",      z: [0],  band: "deep (≥~23×), self-fade", gate: notPolitical, draw: drawDistricts },
  { id: "labels",         band: "≥PROVINCE, self-fade",    draw: drawLabels },
];

/** Paint the registry in order for the current world copy — skipping any layer off the active
 *  z-level (activeZ, today from the plane toggle) or turned off by its gate. */
export function renderLayers() {
  const z = activeZ();
  for (const L of LAYERS) {
    if (L.z && !L.z.includes(z)) continue;
    if (L.gate && !L.gate()) continue;
    L.draw();
  }
}
