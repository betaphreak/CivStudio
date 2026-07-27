"use strict";
// The town layer's PURE parts — colours, widths and the band envelope (docs/towngen-port.md T7).
// Zero imports, so it unit-tests under node (town-style.test.mjs), the same split as
// river-geom.mjs / plots.mjs and band-math.mjs / bands.mjs.
//
// WHY THE WALL IS COLOURED BY KIND. A wall in this model is not a ring but one piece of
// fortification per plot edge, typed by what lies beyond it (docs/towngen-port.md §1 Wall model).
// That types the DRAWING too, and it is the whole tell that the generator is reading real terrain:
// Nathalaire comes out 20 quay to 5 curtain because its plots say they front water, and a glance at
// the map should show that without anyone having to be told.

/** The fortification kinds, and how each reads. Widths are fractions of a plot. */
export const WALL_STYLE = {
  CURTAIN:    { stroke: "#f2e8d0", width: 0.13, label: "wall" },
  QUAY:       { stroke: "#6fc4ea", width: 0.11, label: "quay" },
  ROAD_GATE:  { stroke: "#ffcf5c", width: 0.20, label: "gate" },
  RIVER_GATE: { stroke: "#79e3cf", width: 0.17, label: "water gate" },
};

/**
 * The dark casing drawn under every wall segment, a little wider than the segment itself.
 * <p>
 * A single stroke has to read against pale sand, dark forest and open water, and no one colour
 * does. Casing it in near-black first gives every kind its own edge and lets the colour stay bright
 * — the same trick a road atlas uses, and the difference between a wall you can see and a wall you
 * have to look for.
 */
export const WALL_CASING = "rgba(24, 20, 14, 0.85)";
export const CASING_EXTRA = 0.055;   // plot-fractions added to the segment's width

/** The narrowest a wall may draw, in screen px, so it survives being zoomed away from. */
export const MIN_WALL_PX = 2.5;

const FALLBACK = WALL_STYLE.CURTAIN;

/**
 * The style for a wall segment kind. An unknown kind — an older client against a newer server —
 * falls back to curtain rather than vanishing: a wall drawn in the wrong colour is a far better
 * failure than a hole in the line.
 *
 * @param {string} kind the segment's kind
 * @returns {{stroke: string, width: number, label: string}} its style
 */
export function wallStyle(kind) {
  return WALL_STYLE[kind] || FALLBACK;
}

/**
 * A patch's fill. Extramural patches (suburbs outside the wall — §2b) read thinner and cooler than
 * the walled core, which is what makes the wall legible as an enclosure rather than a decoration.
 *
 * @param {boolean} walled whether the patch is inside the wall
 * @param {number} alpha the layer's band alpha
 * @returns {string} an rgba fill
 */
export function patchFill(walled, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  return walled ? `rgba(214, 198, 168, ${0.20 * a})` : `rgba(180, 186, 170, ${0.11 * a})`;
}

/**
 * A patch's edge — the ward boundary. Faint: the wards are ground, not a diagram, and the wall is
 * what should carry the eye.
 *
 * @param {number} alpha the layer's band alpha
 * @returns {string} an rgba stroke
 */
export function patchStroke(alpha) {
  return `rgba(90, 78, 60, ${0.35 * Math.max(0, Math.min(1, alpha))})`;
}

/**
 * The town layer's band ENVELOPE — `[fade-in, full]`, the shape bands.bandAlpha takes. Below the
 * fade-in there is no room to draw a ward and the district chips carry the settlement instead
 * (docs/towngen-port.md §8a — the handover is by band, not by deleting either layer).
 */
export const BAND_IN = 5.5;
export const BAND_FULL = 6.5;
export const TOWN_ENV = [BAND_IN, BAND_FULL];

/**
 * How strongly the town layer draws at a given band position. The layer itself reads
 * {@link TOWN_ENV} through `bands.bandAlpha`; this is the same ramp, exposed so it can be tested
 * without the camera.
 *
 * @param {number} band the current band value
 * @returns {number} 0 below the fade-in, ramping to 1 by BAND_FULL
 */
export function townAlpha(band) {
  if (!(band > BAND_IN)) return 0;
  if (band >= BAND_FULL) return 1;
  return (band - BAND_IN) / (BAND_FULL - BAND_IN);
}
