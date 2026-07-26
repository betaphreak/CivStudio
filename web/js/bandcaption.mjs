"use strict";
// The BAND CAPTION — the top bar's contextual readout. Where the Main Map sub-strip used to carry
// one frozen string ("Physical world · terrain & plots"), it now answers "what am I looking at?"
// for the band you're actually in: a continent at WORLD, a region at REGION, the majority terrain
// at TERRAIN, an address at PLOT. It is the prose counterpart to the band-name chip beside it —
// the chip names the RUNG, this names the THING.
//
// Two rules keep it honest:
//   1. One table, one row per band (mirroring the ADVISORS table in advisors.mjs) — adding a band
//      or retuning its text is a one-line edit, never a new branch in a switch.
//   2. Every row degrades to a truthful fallback. The data a caption wants is band-dependent and
//      streams in asynchronously (plots only exist once drawPlots has fetched them; owner/religion
//      only after ensurePolitical), so a row that can't answer says so rather than showing a stale
//      or invented value.
//
// See docs/zoom-bands.md §Band caption.
import { P, VIEW, TRADE_GOODS, provGeo, S, provOnScreen, pll } from "./core.mjs";
import { band, BAND, BAND_NAMES } from "./bands.mjs";
import { prettyKey } from "./plotlabel.mjs";
import { landPlots, plotsPending, majorityTerrain, urbanCount } from "./plotstats.mjs";
import { provinceAt, plotAt } from "./hittest.mjs";
import { liveColony } from "./overlays/live.mjs";

// ---- the viewport focus: the ONE province the captions speak for ----
// "What's in the viewport" is ambiguous once more than one province is on screen. We resolve it to
// the province under the CENTRE of the viewport — what you're literally looking at — because that
// is stable under zoom (dive into a province and it stays the subject) and cheap (one hit-test).
// Open ocean has no province under the crosshair, so we fall back to the largest visible landmass,
// which is what a reader would call "where I am" when the centre is empty sea.
//
// Cached on S.baseVersion (bumped by every real pan/zoom/resize), so a settled camera costs one
// lookup no matter how many captions ask. provinceAt scans P twice and is NOT cheap enough for a
// per-frame call — every caller must come through the debounced path in advisors.refreshBandCaption.
let _focus = null, _focusVersion = -1;
export function viewportFocus() {
  if (_focusVersion === S.baseVersion) return _focus;
  _focusVersion = S.baseVersion;
  _focus = provinceAt(VIEW.w / 2, VIEW.h / 2) || largestVisibleLand();
  return _focus;
}
// (There is no plane filter here any more: `P` holds only the active realm's provinces, so the
// caption can never name a cave on another map. docs/realms.md §The Serpentspine was never a plane.)
// fallback subject when the crosshair sits on open ocean: the biggest visible LANDmass. Water bodies
// are excluded by type as well as by weight — a lake or sea is never "where I am". (landPlots, not
// p.plots: the raw field counts water and would pick an ocean — see plotstats.mjs.)
function largestVisibleLand() {
  let best = null, bw = 0;
  for (const p of P) {
    if (p.type === "SEA" || p.type === "LAKE") continue;
    if (!provOnScreen(p)) continue;
    const w = landPlots(p);
    if (w > bw) { bw = w; best = p; }
  }
  return best;
}

// ---- helpers ----
// a geographic tier's display name off the focus province (provGeo returns [displayName, rawKey]
// per tier, or null). The raw key is a usable last resort — an unmapped key reads better prettified
// than as a blank caption.
function tierName(p, tier) {
  if (!p) return null;
  const t = provGeo(p)[tier];
  if (!t) return null;
  return t[0] || (t[1] ? prettyKey(t[1]) : null);
}
// a province's EU4 trade good display name (side table, eagerly loaded — free at any zoom)
function tradeGoodName(p) {
  if (!p || !TRADE_GOODS) return null;
  const key = TRADE_GOODS.prov && TRADE_GOODS.prov[p.id];
  const g = key && TRADE_GOODS.goods && TRADE_GOODS.goods[key];
  return (g && g.name) || (key ? prettyKey(key) : null);
}
// SettlementTier enum name -> display ("SMALLHOLDING" -> "Smallholding"). The live snapshot ships
// the raw enum (server ColonyView.tier); prettyKey Title Cases it without a second name table.
const tierLabel = t => (t ? prettyKey(t) : null);

// The POV colony IF it is actually where you are looking, else null.
//
// liveColony() is just snap.colonies[0] — the session's colony, with no relationship to the camera.
// Naming it unconditionally would make the Settlement caption claim a settlement is *here* while you
// are three continents away, which is exactly the kind of confident-and-wrong readout a contextual
// bar must never produce. So we gate on the colony projecting inside the viewport (it ships
// latitude/longitude). At band 7 the viewport is a few plots wide, so on-screen ≈ here.
//
// The map is a finite sheet, so the colony falls in exactly one world — no east-west wrap copies to
// test (docs/realms.md §Delete the wrap).
function colonyInView() {
  const c = liveColony();
  if (!c || !c.name || c.latitude == null || c.longitude == null) return null;
  const y = pll(c.longitude, c.latitude)[1];
  if (y < 0 || y > VIEW.h) return null;
  const x = pll(c.longitude, c.latitude)[0];
  return (x >= 0 && x <= VIEW.w) ? c : null;
}

// ---- the caption table: one row per band ----
// `text` returns the caption, or null to fall back to `fallback`. Index == the BAND value, so the
// table is addressed directly by band — keep it in BAND order.
const CAPTIONS = [
  { band: BAND.WORLD,      fallback: "Uncharted ocean",
    text: p => tierName(p, "continent") },
  { band: BAND.REALM,      fallback: "Beyond the known realms",
    text: p => tierName(p, "superRegion") },
  { band: BAND.REGION,     fallback: "Unmapped region",
    text: p => tierName(p, "region") },
  { band: BAND.PROVINCE,   fallback: "Open water",
    text: p => p && p.name },
  { band: BAND.TERRAIN,    fallback: "Surveying terrain…",
    text: p => majorityTerrain(p)
      // no plots and none coming: a plotless deep-ocean province. That IS the terrain, so say so
      // rather than surveying forever.
      || (plotsPending(p) ? null : "Open ocean") },
  // Locale answers "what is this place FOR". A city says so by its size; the countryside says so by
  // what it sells — and "not famous for anything" is a real answer, not a missing one.
  { band: BAND.LOCALE,     fallback: "Surveying the locale…",
    text: p => {
      const u = urbanCount(p);
      if (u > 0) return `${u} urban plot${u === 1 ? "" : "s"}`;
      if (plotsPending(p)) return null;                   // plots still streaming — don't guess
      const g = tradeGoodName(p);
      return g ? `Famous for ${g}` : "Not famous for anything";
    } },
  // an address, coarse-to-fine: the plot's real GeoNames name, then the province containing it
  { band: BAND.PLOT,       fallback: "Unexplored", text: p => address(p) },
  // The city view does not exist yet, so there is no "selected settlement" to name — the only
  // settlement the frontend knows about is the live session's colony. Name it when it is on screen
  // (colonyInView); otherwise fall through to the ADDRESS rather than announcing "No settlement
  // here". Both say the same true thing — there is no settlement — but one of them also tells you
  // where you are, and the chip is the only thing naming the ground at this zoom.
  { band: BAND.SETTLEMENT, fallback: "Unexplored",
    text: p => {
      const c = colonyInView();
      if (!c) return address(p);
      const t = tierLabel(c.tier);
      return t ? `${c.name} · ${t}` : c.name;
    } },
  // reserved for the city-builder micro view (docs/zoom-bands.md §Band 8). Nothing to name yet, so
  // it keeps naming the ground — a roadmap note ("coming soon") is for the changelog, not for the
  // chrome of every deep zoom.
  { band: BAND.BUILDING,   fallback: "Unexplored", text: p => address(p) },
];

// where the crosshair is, coarse-to-fine: the plot's real GeoNames place name, then the province
// containing it. Null when neither is known (the caller's fallback covers it).
function address(p) {
  const q = plotAt(VIEW.w / 2, VIEW.h / 2);
  const place = q && q.name;
  if (place && p) return `${place} · ${p.name}`;
  return place || (p && p.name) || null;
}

/**
 * Compute the caption for the CURRENT band: the nearest band's row, resolved against the viewport
 * focus. Always returns a non-empty string (every row carries a fallback).
 *
 * EXPENSIVE — it hit-tests and may tally a province's plots. Call it on a settled camera only; the
 * per-paint reader is currentCaption().
 */
export function bandCaption() {
  const i = Math.max(0, Math.min(CAPTIONS.length - 1, Math.round(band())));
  const row = CAPTIONS[i];
  let text = null;
  try { text = row.text(viewportFocus()); } catch { text = null; }   // a caption must never break the bar
  return text || row.fallback;
}

/** The band name + its caption — "Terrain · Sea Tropical". Exported for tests/tooling. */
export function bandCaptionLine() {
  const i = Math.max(0, Math.min(BAND_NAMES.length - 1, Math.round(band())));
  return `${BAND_NAMES[i]} · ${bandCaption()}`;
}

// ---- the debounced refresh: the ONLY path that recomputes ----
// The chip renders every paint, so it needs a caption it can read for free. bandCaption() is the
// opposite of free (provinceAt scans P twice), and during a pan baseVersion changes every frame, so
// the viewportFocus cache would miss every frame too. We therefore recompute only once the camera
// has SETTLED, exactly like political.scheduleLegendRefresh, and park the result here for the chip.
let _caption = "";
let _timer = 0, _captionVersion = -1;

/** The last computed caption — free to read, safe to call every frame. */
export const currentCaption = () => _caption;

/**
 * Recompute the caption a beat after the camera settles. Called from main.draw() on every paint;
 * the timer resets while panning so the (P-scanning) recompute runs once movement stops.
 *
 * Gated on S.baseVersion so a redraw that did NOT move the camera can't reschedule us — otherwise
 * onSettle→draw→schedule→onSettle is a runaway loop (the same trap documented on
 * scheduleLegendRefresh). onSettle(changed) fires once per settle: `changed` says whether the chip
 * needs a repaint, while the call itself is the "viewport settled" signal the top-bar segments
 * (advisors.mjs) also key off — they can change when the caption hasn't (a new nation under the
 * crosshair with the same plot name), so they must not be gated on `changed`.
 */
export function scheduleCaptionRefresh(onSettle) {
  if (S.baseVersion === _captionVersion) return;
  // Claim this version NOW, not when the timer fires. draw() runs for reasons that are not camera
  // movement — most importantly every plot slice that streams in after a zoom — and each of those
  // calls us again. If the guard above still saw a stale _captionVersion it would fall through and
  // clearTimeout the pending refresh every time, so a province streaming its plots for several
  // seconds would rearm the timer forever and the caption would never update. Claiming the version
  // up front means only a genuine camera change (a new baseVersion) resets the debounce.
  _captionVersion = S.baseVersion;
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    const next = bandCaption();
    const changed = next !== _caption;
    _caption = next;
    if (onSettle) onSettle(changed);
  }, 140);
}

/**
 * Recompute NOW, bypassing the debounce — for the non-camera inputs a caption also depends on: a
 * live snapshot (the colony's tier/name) or the political layer resolving. Returns true if the text
 * changed, so the caller can decide whether a repaint is warranted.
 */
export function refreshCaptionNow() {
  const next = bandCaption();
  if (next === _caption) return false;
  _caption = next;
  return true;
}
