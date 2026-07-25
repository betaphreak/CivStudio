"use strict";
// The band spine's MATH — pure, and therefore testable (band-math.test.mjs).
//
// This is the most-reused logic in the frontend: every layer that fades, gates or names itself goes
// through bandAlpha, and the regime hysteresis below decides the cursor, the mode chip and the
// transition pulse. All of it was untested, because it lived in a module that reads `cam` — and
// anything importing core.mjs cannot load under node (core reads window.BUNDLE at module-eval).
//
// So the split is the same one route-tiling.mjs / routes.mjs and river-geom.mjs / plots.mjs use:
// the arithmetic here takes the band position as an ARGUMENT and imports nothing; bands.mjs keeps
// the thin wrappers that read cam.k and the one piece of latched state (see regimeAt's note).
// See docs/zoom-bands.md.

// ---- named bands ----
// cam.k (1…512) is divided into nine logical bands on the powers of two: band b = log2(cam.k) ∈
// [0, 8]; the deepest, Building, holds from b=8 (256×) up to the 512× cap (b=9, clamped below).
export const BAND = {
  WORLD: 0, REALM: 1, REGION: 2,          // 🌍 Atlas    — EU4 grand strategy
  PROVINCE: 3, TERRAIN: 4, LOCALE: 5,     // 🐫 Overland — caravan / operational
  PLOT: 6, SETTLEMENT: 7, BUILDING: 8,    // 🏘️ Ground   — city-builder micro
};
// band index → display name (index = the BAND value)
export const BAND_NAMES = ["World", "Realm", "Region", "Province", "Terrain", "Locale", "Plot", "Settlement", "Building"];

/** The nearest band's display name at band position `b` — what the top-bar readout shows in place
 *  of a raw zoom number. Clamped, so the 512× cap (b=9) still reads "Building". */
export const bandNameAt = b => BAND_NAMES[Math.max(0, Math.min(8, Math.round(b)))];

/**
 * Trapezoidal visibility envelope in BAND units [in0, in1, out0, out1] evaluated at band `b`:
 * 0 outside [in0, out1]; ramp up over [in0, in1]; hold at 1 through out0; ramp down to out1.
 * Omit out0/out1 (they default to Infinity) to "fade in and stay" — e.g. terrain textures that
 * never fade back out.
 */
export function bandAlphaAt([in0, in1, out0 = Infinity, out1 = Infinity], b) {
  if (b <= in0 || b >= out1) return 0;
  if (b < in1) return (b - in0) / (in1 - in0);
  if (b <= out0) return 1;
  return (out1 - b) / (out1 - out0);
}

// Legacy helper: convert a trapezoid written in cam.k units to band units, so the readable cam.k
// thresholds carried over from the pre-band code stay legible at the call site — e.g.
// kBand([3.6,4.7,7,9.5]). The fade ENDPOINTS are preserved exactly (log2 is monotonic); only the
// mid-fade opacity ramp becomes linear-in-band rather than linear-in-k, a sub-perceptual difference
// for a cross-fading label. New envelopes should be written directly in band units.
export const kBand = ks => ks.map(k => Math.log2(k));

// The geographic-tier envelopes — ONE declarative source for the three coarse tiers, shared by the
// tier LABELS (labels.drawGeoLabels), the tier BOUNDARIES (overlays/tiers.drawTiers) and the top-bar
// band CAPTION (bandcaption.mjs). These three must agree: the caption naming a region while the
// region label/outline has already faded out reads as a bug.
export const GEO_TIER_ENV = {
  continents:   kBand([0.9, 1.0, 1.5, 2.3]),
  superRegions: kBand([1.7, 2.2, 3.4, 4.7]),
  regions:      kBand([3.6, 4.7, 7.0, 9.5]),
};

// ---- the camera's TILT (docs/terrain-3d.md §The plan → P2) ----
// The 3D ground engages at band 5 looking straight DOWN, so the handover from the canvas-2D ground is
// invisible, and pitches over to an oblique view as you descend into Ground. Tying the tilt to the band
// rather than to a user control is deliberate: the Overland→Ground regime seam (regimeAt, b=6) sits inside
// this ramp, so the camera pitching over IS the transition between playing a map and playing a place.
// TILT_MAX comes from CIV4'S OWN DATA, not from measuring a screenshot. `Assets/XML/GlobalDefines.xml`:
//   CAMERA_UPPER_PITCH = -90   fully zoomed out — straight down
//   CAMERA_LOWER_PITCH = -32   fully zoomed in  — 32° above the horizon, i.e. 58° FROM VERTICAL
// so Civ4's camera sweeps 0 → 58° from vertical as you descend, which is exactly the shape of this ramp.
//
// It was 34, taken from measuring the tile aspect in tools/samples/test2.png. That measurement was sound and
// the conclusion was wrong: test2.png is a STRATEGIC-zoom screenshot, near Civ4's zoomed-OUT end where the
// camera is almost straight down — so ~0.89 aspect was the right reading of the wrong reference, and it got
// applied as the FULL-tilt angle. At 34° the ground only foreshortens to cos(34°) = 0.83, a 17% squash that
// does not read as oblique at all; 58° gives 0.53. (test.png, the other sample, is the CITY SCREEN, which
// Civ4 renders with no pitch whatsoever — CAMERA_CITY_NO_PITCH = 1 — so it is not a reference for this.)
export const TILT_MAX = 58;        // degrees from vertical at full tilt — Civ4's CAMERA_LOWER_PITCH
export const TILT_IN = 5;          // band where the pitch starts (BAND.LOCALE, where 3D takes the ground)
export const TILT_FULL = 6.5;      // band where it reaches TILT_MAX (half way through PLOT)

/**
 * Camera pitch in DEGREES from straight-down at band `b`: 0 below TILT_IN, TILT_MAX above TILT_FULL, and
 * a smoothstep between them.
 *
 * Smoothstep rather than linear because the ramp's ENDS are what you feel. A linear pitch starts and stops
 * abruptly, which reads as the camera being yanked at exactly the two zoom levels a player crosses most
 * often; easing both ends means the horizon rolls in. It also matters for correctness at the bottom end:
 * tiltAt is what decides whether the 3D projector is installed at all, and a zero derivative at TILT_IN
 * keeps the first frames of tilt sub-pixel, so the 2D layers do not visibly jump as they hand over from
 * the separable fast path to the projected one.
 */
export function tiltAt(b) {
  if (b <= TILT_IN) return 0;
  if (b >= TILT_FULL) return TILT_MAX;
  const t = (b - TILT_IN) / (TILT_FULL - TILT_IN);
  return TILT_MAX * t * t * (3 - 2 * t);
}

/**
 * VERTICAL EXAGGERATION at band `b` — a multiplier on terrain height, 1.0 at the band the height model was
 * tuned for and falling as you zoom in.
 *
 * Why this has to exist. Terrain height is fixed in world units (PEAK = 3.4 plot-widths), so a peak's screen
 * height grows with zoom exactly as a plot's screen width does — the RATIO is constant. That sounds like it
 * should look right at every zoom, and it does not: the spike tuned 3.4 while looking at a whole 45×45
 * province, where it reads as a mountain range. Four bands deeper the viewport holds ~23 plots, the same
 * ratio puts a 180-pixel cliff across a 52-pixel plot, and the terrain reads as stacked slabs rather than as
 * landscape. The eye judges relief against the FRAME, not against a plot.
 *
 * Halving every two bands is the compromise: a landform keeps growing as you approach it — so descending
 * still feels like descending — but at roughly half the rate, so it never becomes a wall. Clamped so the deep
 * end keeps real relief instead of flattening back to a map.
 *
 * Applied as a per-mesh Y SCALE rather than baked into the geometry, so it costs one transform per province
 * per frame and no rebuild (terrain3d.syncMeshes).
 */
export function heightScaleAt(b) {
  return Math.max(0.3, Math.min(1, Math.pow(2, -(b - TILT_IN) / 2)));
}

// ---- the three interaction regimes ----
export const REGIME = { ATLAS: "atlas", OVERLAND: "overland", GROUND: "ground" };
// display metadata for the mode chip / signal (the accent colour + cursor live in CSS, keyed by the
// same regime slug via [data-regime]); name + icon are the semantic bits, so they live here.
export const REGIME_INFO = {
  atlas:    { name: "Atlas",    icon: "🌍" },   // EU4 grand strategy
  overland: { name: "Overland", icon: "🐫" },   // caravan / operational
  ground:   { name: "Ground",   icon: "🏘️" },   // city-builder micro
};
export const DEADBAND = 0.15;

/**
 * The interaction regime at band `b`, given the PREVIOUSLY latched regime — HYSTERETIC: each seam
 * (b=3, b=6) carries a ±DEADBAND deadband, so a scroll-tick landing exactly on a boundary cannot
 * strobe the mode chip / cursor / transition pulse.
 *
 * Pure: the latch is the caller's (bands.regime holds it). Passing `prev` in rather than keeping it
 * here is what makes the hysteresis testable — you can assert a seam from both directions.
 */
export function regimeAt(b, prev) {
  const up = prev === REGIME.ATLAS ? 3 : 3 - DEADBAND;   // fall back to Atlas only past the deadband
  const dn = prev === REGIME.GROUND ? 6 : 6 + DEADBAND;  // rise to Ground only past the deadband
  return b < up ? REGIME.ATLAS : b < dn ? REGIME.OVERLAND : REGIME.GROUND;
}
