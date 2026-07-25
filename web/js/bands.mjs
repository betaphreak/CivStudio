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
export const ground3D = () =>
  // The UNDERWORLD keeps the 2D ground at every band. Its plots come through the same drawPlots (called
  // as drawPlots(isUnderground) by main.drawCavernPlots), so suppressing the blits there without a mesh to
  // replace them would leave the Serpentspine empty at band 5 — and terrain3d deliberately builds no
  // meshes for z=-1, which is a second plane with its own veil and rims (docs/underworld.md). z-levels are
  // P2 territory; until then the plane toggle is also the 3D toggle.
  S.plane !== "underworld"
  // POLITICAL overlays keep the 2D ground too, and for a sharper reason: the plot layer is gated
  // `notPolitical`, so in nation/culture/faith mode no province ever builds a texture — the 3D ground would
  // have nothing to drape and would render bare sea. Nor is anything lost: a political map is an opaque wash
  // of ownership colour, with no relief to see underneath it.
  && !isPolitical()
  && _has3D && (_force3D === "1" || atLeast(BAND.LOCALE));
