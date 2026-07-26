"use strict";
// DEBUG: paint the provinces that silently do not render, in fuchsia.
//
// The map's failure mode for a broken province is INVISIBILITY — no polygon, no plots, just the sea
// gradient or the blurred raster where something should be. That reads as "there is nothing there",
// which is indistinguishable from open water, so a hole can sit on the map indefinitely without
// anyone noticing. (It did: province 6762 "Humacs Island" beside the Gulf of Ouord, found only
// because someone looked hard at that stretch of coast.)
//
// So this makes the holes LOUD. Fuchsia because nothing in the Anbennar palette is anywhere near it
// — terrain, political fills, culture and religion colours are all earthy or muted, so a magenta
// blob can only ever mean "this is broken", never "this is a nation you haven't seen before".
//
// OFF unless `?debug=holes`, and deliberately additive: it reads window.BUNDLE.provinces rather than
// core's P, so it can see provinces the realm filter has already dropped WITHOUT changing what P
// contains. Nothing else in the app sees a different world because this is on.

import { BUNDLE, ACTIVE_REALM, ctx, provPath, provOnScreen, pll, LABEL_FONT } from "./core.mjs";

/** `?debug=holes` — a comma-list, so `?debug=holes,foo` keeps working as more debug layers land. */
export const DEBUG_HOLES = (() => {
  try {
    const v = new URLSearchParams(location.search).get("debug") || "";
    return v.split(",").map(s => s.trim()).includes("holes");
  } catch { return false; }
})();

const FUCHSIA = "#ff00ff";

// THE MISSING-TEXTURE CHECKERBOARD — magenta and black, the convention every engine since Quake has
// used for "this asset failed to load". Borrowing the visual language means nobody has to be told
// what it signifies.
//
// GENERATED, not downloaded. The famous version is Valve's shipped asset, and vendoring a game's art
// for a debug marker is both a licensing question and a new dependency; a two-colour checker is six
// lines of canvas and exactly reproduces the look. It also keeps the offline dev loop offline
// (tools/dev-local.ps1 runs with no network at all), which fetching anything would break.
//
// SCREEN-ANCHORED, so the checks stay a constant 8px and read the same at world zoom and at plot
// zoom. A map-anchored pattern would smear into flat magenta as you zoomed out — the opposite of
// what a debug marker is for.
const CHECK = 8;
let _checker = null;
function checker() {
  if (_checker) return _checker;
  const c = document.createElement("canvas");
  c.width = c.height = CHECK * 2;
  const x = c.getContext("2d");
  x.fillStyle = FUCHSIA; x.fillRect(0, 0, CHECK * 2, CHECK * 2);
  x.fillStyle = "#000";
  x.fillRect(0, 0, CHECK, CHECK); x.fillRect(CHECK, CHECK, CHECK, CHECK);
  _checker = ctx.createPattern(c, "repeat");
  return _checker;
}

/**
 * Why this province is invisible, or null when it is fine.
 *
 * Two classes, and they are independent — 6762 had both, which is why it vanished so completely:
 *
 *   no-realm    — `Province.realm` is unset, so core's `P` filter (`p.realm === ACTIVE_REALM`) drops
 *                 it from every realm view. 102 provinces are in this state; for the 91 deep-ocean
 *                 SEAs it is deliberate (Realm.NONE) and they carry ~2.7M plots nobody wants drawn,
 *                 so those are NOT flagged — only land, lakes and impassables, which have no business
 *                 being realm-less and leave a real hole in the map when they are.
 *   no-plots    — the province declares plots but the server served an empty array. Only detectable
 *                 after a load has been attempted, so this one lights up as you pan onto it.
 *
 * A WRINKLE on that second class, deliberately not fixed here: `plotfetch.loadPlots` calls `draw()`
 * only `if (p._plots.length)`, so a province that serves NOTHING never triggers the repaint that
 * would run this layer. The flag is therefore correct but late — it appears on the next pan or zoom,
 * not the moment the empty response lands. Forcing a redraw on every empty load would also repaint
 * for the ~176 deep-ocean provinces that are legitimately empty, which is a real cost for a debug
 * affordance, so the lateness is accepted and recorded instead.
 */
export function holeReason(p) {
  if (QUIRKS.has(p.id)) return null;
  if (!p.realm && ACTIVE_REALM && p.type !== "SEA") return "no realm";
  if (p._plots && p._plots.length === 0 && p.plots > 0) return "no plots";
  return null;
}

/**
 * The three provinces RealmExporter drops from their realm ON PURPOSE (its own `QUIRKS` set): the two
 * antimeridian projection artifacts and the Antarctic ice shelf. They are realm-less by design, so
 * flagging them would leave this tool permanently crying wolf over three provinces that are working
 * as intended — and a debug marker that is always on is a debug marker nobody reads.
 */
const QUIRKS = new Set([6237, 6238, 1808]);

let lastKey = null;
export function drawDebugHoles() {
  if (!DEBUG_HOLES) return;
  const all = (BUNDLE && BUNDLE.provinces) || [];
  // Log whenever the SET changes, not once. "no plots" is only knowable after a load has been
  // attempted, so a one-shot log fires before the interesting cases exist and reports a clean map.
  const found = all.filter(holeReason);
  const key = found.map(p => p.id + holeReason(p)).join(",");
  if (key !== lastKey) {
    lastKey = key;
    console.warn(`[debug=holes] ${found.length} province(s) flagged:`,
      found.map(p => `${p.id} ${p.name} (${p.type}, ${holeReason(p)})`));
  }
  ctx.save();
  for (const p of all) {
    const why = holeReason(p);
    if (!why || !p.rings || !provOnScreen(p)) continue;
    const path = provPath(p);
    ctx.globalAlpha = 0.85; ctx.fillStyle = checker(); ctx.fill(path);
    ctx.globalAlpha = 1; ctx.strokeStyle = FUCHSIA; ctx.lineWidth = 2; ctx.stroke(path);
    // the id and the reason, so the console warning above is not the only way to identify it
    const [x, y] = pll(p.lon, p.lat);
    ctx.font = "600 12px " + LABEL_FONT;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.8)";
    ctx.strokeText(`${p.id} · ${why}`, x, y);
    ctx.fillStyle = "#fff"; ctx.fillText(`${p.id} · ${why}`, x, y);
  }
  ctx.restore();
}
