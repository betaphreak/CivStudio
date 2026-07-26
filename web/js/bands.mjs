"use strict";
// The continuous-zoom spine — the LIVE half: the thin wrappers that read cam.k, plus the one piece
// of latched state (the regime). Everything that draws or takes input declares a band ENVELOPE and
// reads its cross-fade alpha from here, instead of hand-rolling (cam.k - X)/Y ramps.
//
// The arithmetic itself lives in band-math.mjs — pure, zero-import, unit-tested. This module is the
// seam that binds it to the camera; the constants (BAND, BAND_NAMES, REGIME, REGIME_INFO,
// GEO_TIER_ENV, kBand) are re-exported below so every caller still imports them from "./bands.mjs"
// and nothing outside needs to know about the split. See docs/zoom-bands.md.
import { cam, S, isPolitical } from "./core.mjs";
import { bandAlphaAt, bandNameAt, regimeAt, REGIME, BAND } from "./band-math.mjs";

export { BAND, BAND_NAMES, REGIME, REGIME_INFO, GEO_TIER_ENV, kBand } from "./band-math.mjs";

// canonical continuous band position. cam.k ≥ 1 always (the fitView world-fit floor), so b ≥ 0.
export const band = () => Math.log2(cam.k);

/** This envelope's cross-fade alpha at the current zoom. See band-math.bandAlphaAt. */
export const bandAlpha = env => bandAlphaAt(env, band());

// hard gate for when a fade is the wrong affordance (a line/icon that should just appear)
export const atLeast = n => band() >= n;

/** The nearest band's display name at the current zoom. */
export const bandName = () => bandNameAt(band());

// The current interaction regime. STATEFUL by design: the hysteresis needs the previously-latched
// regime to pick its asymmetric threshold, so the latch lives here and the decision lives in the
// pure regimeAt (which is why the deadband is testable from both directions).
let _regime = REGIME.ATLAS;
export function regime() {
  _regime = regimeAt(band(), _regime);
  return _regime;
}

// ---- who owns the ground (docs/terrain-3d.md §The plan) ----
// From band 5 (LOCALE, 32×) the ground — the sea base, the baked raster and the plot layer — is drawn
// by the 3D renderer instead of canvas 2D. Below it, nothing changes at all; that boundary is the whole
// reason the phase can be verified rather than argued about.
//
// The predicate lives HERE, not in terrain3d.mjs, because sea.mjs and plots.mjs have to consult it and
// must not import the renderer (terrain3d imports both — sea for the climate gradient, plots for the
// baked province canvases). It is a question about the zoom band, so the band module is its home.
//
// ?terrain3d=0 forces the 2D ground back on, ?terrain3d=1 forces 3D from band 0 — the flags the
// verifier flips to shoot the same camera both ways.
const _force3D = typeof location !== "undefined"
  ? new URLSearchParams(location.search).get("terrain3d") : null;
// Set false by terrain3d.mjs when WebGL is missing or three fails to load: the 2D path below band 5 is
// then also the fallback ABOVE it, which is why this phase needs no separate degraded mode.
let _has3D = _force3D !== "0";
export function set3DAvailable(ok) { _has3D = ok; }
// Whether foliage STANDS UP as 3D props (P3) rather than being baked flat into each province's texture.
// Rides ground3D — there is nowhere to stand a billboard without the mesh — and can be turned off on its own
// with ?props=0, which puts the trees back in the texture.
//
// That flag is not only a safety valve. It is what lets the GROUND gate stay strict: props change foliage from
// a stamp baked at 32px-per-plot and then minified with the whole canvas, into a quad sampled once at screen
// scale, so a few percent of pixels differ by construction and no threshold can tell that from a real fault.
// With ?props=0 the frame diff compares grounds alone, and the props are checked by geometry instead
// (terrain3d.propPlacementError). See tools/webverify/terrain3d-verify.mjs.
const _forceProps = typeof location !== "undefined"
  ? new URLSearchParams(location.search).get("props") : null;
export const props3D = () => _forceProps !== "0" && ground3D();

export const ground3D = () =>
  // The UNDERWORLD keeps the 2D ground at every band. Its plots come through the same drawPlots (called
  // as drawPlots(isUnderground) by main.drawCavernPlots), so suppressing the blits there without a mesh to
  // replace them would leave the Serpentspine empty at band 5 — and terrain3d deliberately builds no
  // meshes for z=-1, which is a second plane with its own veil and rims (docs/underworld.md). z-levels are
  // P2 territory; until then the plane toggle is also the 3D toggle.
  S.plane !== "underworld"
  && _has3D && (_force3D === "1" || atLeast(BAND.LOCALE));
// POLITICAL NO LONGER BLOCKS THE 3D GROUND, and that inversion is the whole shape of the current
// design. It used to: the plot layer was gated `notPolitical`, so in nation/culture/faith mode no
// province built a texture and a 3D ground would have draped nothing. Now the two are the two ENDS
// of one zoom — 2D out here is the political map, 3D up close is the terrain — so instead of
// political suppressing 3D, crossing into 3D releases political (releasePoliticalForZoom below).

// ---- political is the 2D affordance; the zoom, not a button, hands over to the terrain ----
//
// Crossing band 5 puts the ground in the hands of the 3D renderer, and an opaque ownership wash over
// a terrain mesh is neither map: so the overlay is set aside on the way in and PUT BACK on the way
// out. Restoring it is what makes zoom the single control rather than a one-way trapdoor — zoom in
// to read the land, zoom out to read the borders, with nothing to click either way.
//
// The setter is INJECTED rather than imported: it is panel.setOverlay, which carries all the side
// effects an overlay change owes (legend, rail, search context, the lazy political.js fetch), and
// panel.mjs sits far above this module in the import graph. bands.mjs imports core and band-math and
// nothing else, which is why every drawing module can import it.
let _setOverlay = null;
/** Register the overlay setter (panel.setOverlay). Called once, at boot. */
export function bindOverlaySetter(fn) { _setOverlay = fn; }

// The overlay the zoom took away, or null when it has taken nothing. Also the latch that stops this
// from fighting the user: an overlay chosen WHILE deep (the hash deep-link, or the advisor buttons)
// is not ours to restore, so we only ever put back what we ourselves removed.
let _released = null;
// Asymmetric thresholds, the same deadband idea as the regime latch: release at band 5, restore only
// once back below 4.65. A camera resting exactly on the boundary would otherwise flap the overlay —
// and each flap costs a legend rebuild and a rail render, so this is a visible flicker, not a
// theoretical one.
const RELEASE_AT = BAND.LOCALE, RESTORE_BELOW = BAND.LOCALE - 0.35;

/**
 * Reconcile the overlay with the zoom. Called once per frame, from the frame body — draw() is
 * rAF-coalesced and idempotent, so the setOverlay inside simply schedules the next frame.
 *
 * The UNDERWORLD is exempt at every band: it has no 3D ground to hand over to, so its political
 * overlay stays whatever the user chose.
 */
export function syncOverlayToZoom() {
  if (!_setOverlay || S.plane === "underworld") return;
  const b = band();
  if (_released === null && b >= RELEASE_AT && isPolitical()) {
    _released = S.overlay;
    _setOverlay("none", { keepSelection: true });
  } else if (_released !== null && b < RESTORE_BELOW) {
    const back = _released;
    _released = null;
    // the user picked something else while deep — that choice is theirs, so leave it alone
    if (S.overlay === "none") _setOverlay(back, { keepSelection: true });
  }
}
