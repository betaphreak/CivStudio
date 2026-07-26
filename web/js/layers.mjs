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
import { isPolitical, S } from "./core.mjs";
import { ground3D } from "./bands.mjs";
import { drawRaster, drawLakes, drawSeaCells, drawImpassable, drawSurfacePlots,
         drawProvinceBorders, drawCaveEntrances, drawAdjacencies, drawRealmArrows,
         drawHoverHighlight, drawSelectedHighlight } from "./main.mjs";
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
import { drawDebugHoles, DEBUG_HOLES } from "./debug-holes.mjs";

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
// their own bandAlpha inside `draw`); `gate` is a cheap predicate that skips the layer.
//
// THERE IS NO `z`. The registry used to carry a z-set per layer, filtered by an active z-level that
// the Overworld/Underworld toggle drove — a whole second axis whose only inhabitant was the
// Serpentspine. The Dwarovar provinces have their own pixels, so they were never a plane over this
// one; they are a REALM, and `P` is already filtered to the active realm before any layer runs.
// See docs/realms.md §The Serpentspine was never a plane.
export const LAYERS = [
  { id: "raster",         band: "all",                     draw: drawRaster },
  { id: "lakes",          band: "all",                     draw: drawLakes },
  { id: "seaCells",       band: "all",  gate: notPolitical, draw: drawSeaCells },
  // PLOT DETAIL IS 3D-ONLY, so this layer's gate is the 3D ground itself. It is no longer a 2D
  // drawer that 3D happens to reuse — it is the pass that maintains the per-province canvases
  // terrain3d drapes, and outside 3D there is nobody to draw for. Gating it here rather than inside
  // drawPlots is what makes the saving real: no viewport cull, no lazy /api/plots fetch and no
  // offscreen bake at all while 2D owns the view.
  { id: "plots",          band: "≥LOCALE (3D only), self-fade", gate: ground3D, draw: drawSurfacePlots },
  { id: "cost",           band: "≥REGION→, toggle",        draw: drawCostOverlay },
  { id: "impassable",     band: "all",  gate: notPolitical, draw: drawImpassable },
  { id: "political",      band: "self-fade", gate: isPolitical, draw: drawPolitical },
  { id: "tiers",          band: "WORLD–PROVINCE, self-fade", draw: drawTiers },
  { id: "provBorders",    band: "PROVINCE (7.5→10×)",      draw: drawProvinceBorders },
  // the way into the Serpentspine: an amber cave-mouth glyph where a surface province borders one of
  // the realm's provinces. Self-gates — on a surface realm it marks the doors, in the Serpentspine it
  // marks the way out. docs/realms.md §A cave mouth is not an arrow.
  { id: "caveEntrances",  band: "all",                     draw: drawCaveEntrances },
  { id: "adjacencies",    band: "≥3.3 (10×)",              draw: drawAdjacencies },
  { id: "realmArrows",    band: "all",                     draw: drawRealmArrows },   // cross-realm teleporter → "to <Realm>" arrow (self-gates on ?realm=)
  // DEBUG ONLY (?debug=holes): fuchsia over provinces that silently fail to render. Late in the
  // stack so nothing paints over it — the whole point is that it cannot be missed.
  { id: "debugHoles",     band: "all",  gate: () => DEBUG_HOLES, draw: drawDebugHoles },
  { id: "hover",          band: "all",                     draw: drawHoverHighlight },
  { id: "selected",       band: "all",                     draw: drawSelectedHighlight },
  { id: "live",           band: "all",  gate: () => S.overlay === "live", draw: drawLive },
  { id: "tradeGoods",     band: "TERRAIN→PLOT, self-fade", gate: notPolitical, draw: drawTradeGoodIcons },
  { id: "routes",         band: "≥TERRAIN, self-fade", gate: notPolitical, draw: drawRoutes },
  { id: "city",           band: "≥PROVINCE, self-fade", gate: notPolitical, draw: drawCity },
  { id: "districts",      band: "deep (≥~23×), self-fade", gate: notPolitical, draw: drawDistricts },
  { id: "labels",         band: "≥PROVINCE, self-fade",    draw: drawLabels },
];

/** Paint the registry in order — skipping any layer turned off by its gate. */
export function renderLayers() {
  for (const L of LAYERS) {
    if (L.gate && !L.gate()) continue;
    L.draw();
  }
}
