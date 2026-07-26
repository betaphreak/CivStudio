"use strict";
// Lazy-loading a province's plot grid from the server. Split out of plots.mjs: this is pure-ish data
// plumbing (fetch, gunzip, guard, announce) with no drawing in it, so it can be reasoned about — and
// tested — on its own, the way plotstats.mjs is.
//
// loadPlots fetches GET /api/plots/{id}, which generates the canonical field on demand and caches it
// (docs/plot-serving.md); the body is the province's gzipped JSON, gunzipped here. Then it redraws. An
// empty array (the ~176 deep-ocean provinces with no shelf) or any failure leaves the province as the
// blurred raster / open sea.
//
// Fail-fast loading so a slow/overloaded server never freezes pan/zoom. Two guards:
//  • a per-fetch TIMEOUT (AbortController) — a slow request is dropped, not left hanging, and the
//    province is left retryable after a backoff so a momentarily-slow server fills it in later;
//  • a CONCURRENCY CAP — only a few plot fetches are ever in flight, so a fast pan can't launch
//    hundreds. drawPlots calls loadPlots every frame for each visible unloaded province, so the
//    naturally re-requested set is always the CURRENTLY-visible provinces: panned-away ones are
//    simply never retried, and the visible ones win the freed slots. The map keeps its blurred
//    raster (the existing fallback) for anything not yet loaded.
import { BUNDLE, apiUrl, S } from "./core.mjs";
import { draw } from "./repaint.mjs";
import { renderRail } from "./rail.mjs";
import { indexLand } from "./shore-index.mjs";
import { indexTerrain } from "./terrain-corners.mjs";
import { shelf } from "./water-terrain.mjs";

// ---- the shore index (js/shore-index.mjs) ----
// Built HERE because this is the one place plots arrive, so it fills in load order rather than draw
// order and no drawing module has to remember to feed it. It answers "which land terrain does this
// water plot's beach stand on" across province boundaries, which is what stops the painted coast
// tile's transparent landward half revealing blue water.
// There is deliberately NO version counter here. One was tried, and dropping every water canvas
// whenever any land province was indexed thrashed the sea for as long as the camera kept moving.
// Staleness is tracked per province instead, against the specific pixels a bake could not resolve —
// see plots.mjs `_tshoreGaps`.
const LAND = new Map();
/** The shore index: source pixel → land terrain key. Read-only to consumers. */
export const shoreIndex = () => LAND;

// The TERRAIN index — source pixel → the plot's effective blend layer, for corner ownership
// (js/terrain-corners.mjs, docs/land-blend-plan.md). Separate from LAND above because it answers a
// different question and keeps every terrain, water included; the same "no version counter" argument
// applies, and staleness is tracked per province against `_tblendGaps`.
const TERRAIN = new Map();
/** The corner-ownership index: source pixel → effective layer key. Read-only to consumers. */
export const terrainIndex = () => TERRAIN;
/**
 * A plot's EFFECTIVE blend layer. Normally its terrain — but a PEAK plot is Civ4's top layer
 * (LayerOrder 100, above even water), and its authored art REPLACES the ground rather than tinting
 * it, so a peak contributes `PEAK` and not the terrain underneath. HILL does not appear here: its
 * art is a translucent wash over whatever terrain the plot already has, so a hill still contributes
 * its terrain (docs/land-blend-plan.md §5.3).
 */
const layerOf = q => (q.plotType === "PEAK" ? "PEAK" : q.terrain);

const PLOT_FETCH_TIMEOUT = 6000;    // ms — drop a plot fetch that takes longer than this
const PLOT_RETRY_BACKOFF = 12000;   // ms — after a timeout, wait this long before retrying a province
const MAX_INFLIGHT_PLOTS = 6;       // most concurrent /api/plots fetches
let inFlightPlots = 0;

export async function loadPlots(p) {
  if (p._loading || p._plots) return;
  if (p._retryAt && performance.now() < p._retryAt) return;   // cooling down after a slow-fetch drop
  if (inFlightPlots >= MAX_INFLIGHT_PLOTS) return;             // at capacity — drawPlots retries next frame
  p._loading = true;
  inFlightPlots++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PLOT_FETCH_TIMEOUT);
  try {
    // ?v=<mapVersion> versions the immutable cache: a generation change (server bumps
    // ProvincePlotStore.MAP_VERSION, shipped as BUNDLE.mapVersion) changes the URL, so the browser
    // fetches the fresh grid instead of a stale cached one. See docs/plot-serving.md.
    const res = await fetch(apiUrl("/api/plots/" + p.id) + "?v=" + (BUNDLE.mapVersion || 0), { signal: ctl.signal });
    if (!res.ok) throw new Error("plots " + res.status);   // 404 off-map, 5xx, …
    const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
    const arr = JSON.parse(await new Response(stream).text());
    // mark as loaded even when empty (deep ocean), so the draw loop and panel stop re-requesting
    p._plots = arr || [];
    p._retryAt = 0;
    // Index this province's LAND before anything draws, so a water province baked in the same frame
    // already sees it. `shelf(t)` is the water test — the eight water keys and nothing else.
    if (p._plots.length) indexLand(LAND, p._plots, t => !!shelf(t));
    if (p._plots.length) indexTerrain(TERRAIN, p._plots.map(q => ({ x: q.x, y: q.y, terrain: layerOf(q) })));
    if (p._plots.length) draw();
    if (S.selectedProv === p) renderRail();
    // A province's plots just landed. Readouts derived from them (the top bar's Terrain/Locale/Plot
    // captions) computed BEFORE this and settled on a provisional "Surveying…" string — and they key
    // off camera movement, which this isn't, so nothing else would ever invite them to look again.
    // Announce the arrival instead of having them poll. See js/bandcaption.mjs.
    window.dispatchEvent(new CustomEvent("civstudio:plots", { detail: { id: p.id } }));
  } catch (e) {
    if (e.name === "AbortError")
      // too slow — drop it (keeping pan/zoom smooth) but leave it retryable after a backoff so a
      // recovered server fills it in, without a re-request storm while it's still slow.
      p._retryAt = performance.now() + PLOT_RETRY_BACKOFF;
    else
      // a real error (404 off-map, 5xx) — mark loaded-empty so the draw loop stops re-requesting. Do
      // NOT tear down the session: one province's plots failing is not a dead server.
      p._plots = [];
  } finally {
    clearTimeout(timer);
    inFlightPlots--;
    p._loading = false;
  }
}
