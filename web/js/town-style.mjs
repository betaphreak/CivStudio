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

/**
 * The fortification kinds, and how each reads. Widths are fractions of a plot.
 * <p>
 * THESE ARE REAL FRACTIONS AGAIN. They were once about twice this, because the layer sampled its
 * plot size at source (0, 0) rather than at the town and got 0.24 px for a plot that was 330 px
 * across — so every width collapsed onto MIN_WALL_PX and "make the wall thicker" could only mean
 * raising a number that never applied. With the sampling fixed the wall scales with the zoom, and
 * these values put it at roughly the same few px it read at when the layer was first accepted.
 */
export const WALL_STYLE = {
  CURTAIN:    { stroke: "#f2e8d0", width: 0.060, label: "wall" },
  QUAY:       { stroke: "#6fc4ea", width: 0.050, label: "quay" },
  ROAD_GATE:  { stroke: "#ffcf5c", width: 0.090, label: "gate" },
  RIVER_GATE: { stroke: "#79e3cf", width: 0.075, label: "water gate" },
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
export const CASING_EXTRA = 0.024;   // plot-fractions added to the segment's width

/** The narrowest a wall may draw, in screen px, so it survives being zoomed away from. */
export const MIN_WALL_PX = 2.5;

const FALLBACK = WALL_STYLE.CURTAIN;

/**
 * The streets (docs/towngen-port.md T5). Widths are fractions of a plot, as everywhere here.
 * <p>
 * PALE, NOT DARK. The reference art (§2c) is fine grey blocks against a *dense white* street
 * network, and it reads that way for a reason: at this scale the streets are the negative space
 * between the built ground, so they have to be lighter than what they separate or the town looks
 * like a diagram of drainage. The artery is wider than its branches — that is the whole difference
 * between a high street and a lane, and the server has already decided which is which.
 * <p>
 * WARMER AND NARROWER THAN THE WALL, and that is the load-bearing part. Drawn at the wall's own
 * near-white and near its width, the two became indistinguishable on screen: the enclosure stopped
 * reading as an enclosure and the town looked like a tangle. The wall is the subject at these
 * bands; the streets are what fills it.
 */
export const STREET_STYLE = {
  MAIN:   { stroke: "#e6d3a4", width: 0.042 },
  STREET: { stroke: "#d0be93", width: 0.026 },
};

/** The dark casing under a street, for the same reason the wall has one: pale needs an edge. */
export const STREET_CASING = "rgba(38, 30, 20, 0.55)";
export const STREET_CASING_EXTRA = 0.016;

/** The narrowest a street may draw, in screen px. Thinner than a wall — it is not the subject. */
export const MIN_STREET_PX = 1.5;

const STREET_FALLBACK = STREET_STYLE.STREET;

/**
 * The style for a street kind. As with the wall, an unknown kind falls back rather than vanishing:
 * a lane drawn as a lane when the server called it something new is a far better failure than a
 * street network with a hole in it.
 *
 * @param {string} kind MAIN or STREET
 * @returns {{stroke: string, width: number}} its style
 */
export function streetStyle(kind) {
  return STREET_STYLE[kind] || STREET_FALLBACK;
}

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
 * The WARDS (docs/towngen-port.md T6) — one tint per DistrictType, as rgb triples the fills below
 * mix into the ground colour.
 * <p>
 * A ward here is the plot's own district, not a second vocabulary: where the sim has built, the
 * type is the fold of its buildings' advisor categories, so these colours are the same axis the
 * district chips and the city screen already speak. Kept low-saturation on purpose — this is ground
 * under a town, and a saturated ward map would read as a political overlay rather than as a place.
 */
export const WARD_TINT = {
  CITY_CENTER:    [232, 214, 176],   // the plaza: the brightest ground in town
  CAMPUS:         [186, 202, 214],   // scholars' quarter — authored, no reference equivalent (§4.1)
  HOLY_SITE:      [216, 202, 222],
  ENCAMPMENT:     [206, 176, 166],
  COMMERCIAL_HUB: [226, 206, 158],
  THEATER:        [212, 194, 208],
  NEIGHBORHOOD:   [204, 192, 168],   // where most people live, and most of the town
};

const WARD_FALLBACK = WARD_TINT.NEIGHBORHOOD;

/**
 * A ward's tint, falling back to the residential one for a district this client has not heard of —
 * a new district type should read as ordinary ground, never as a hole in the town.
 *
 * @param {string} ward the DistrictType name
 * @returns {number[]} an [r, g, b] triple
 */
export function wardTint(ward) {
  return WARD_TINT[ward] || WARD_FALLBACK;
}

/**
 * A patch's fill, tinted by its ward. Extramural patches (suburbs outside the wall — §2b) read
 * thinner and cooler than the walled core, which is what makes the wall legible as an enclosure
 * rather than a decoration.
 *
 * @param {boolean} walled whether the patch is inside the wall
 * @param {number} alpha the layer's band alpha
 * @param {string} [ward] its DistrictType, if the server sent one
 * @returns {string} an rgba fill
 */
export function patchFill(walled, alpha, ward) {
  const a = Math.max(0, Math.min(1, alpha));
  if (!walled) return `rgba(180, 186, 170, ${0.11 * a})`;
  const [r, g, b] = wardTint(ward);
  return `rgba(${r}, ${g}, ${b}, ${0.30 * a})`;
}

/**
 * The LOTS (docs/towngen-port.md T6 §4a) — what stands on a block.
 * <p>
 * A building is a coloured MASS, not an outline: §2c's reference draws its palaces, temples and
 * warehouses as solid blocks against the fine grain of the ordinary town, and that contrast is most
 * of what makes the picture read as a city rather than a street plan. A dwelling is quieter, a yard
 * quieter still, and a ruin is the ground going grey — decline rendered inside a wall that never
 * contracts (§2a).
 */
export const LOT_STYLE = {
  BUILDING: { fill: [206, 180, 132], alpha: 0.88, edge: 0.62 },
  DWELLING: { fill: [178, 162, 134], alpha: 0.70, edge: 0.40 },
  EMPTY:    { fill: [150, 154, 116], alpha: 0.28, edge: 0.16 },
  RUIN:     { fill: [124, 121, 116], alpha: 0.48, edge: 0.26 },
};

const LOT_FALLBACK = LOT_STYLE.DWELLING;

/**
 * A lot's fill and edge. An unknown kind draws as a dwelling rather than vanishing — a block in the
 * wrong shade beats a hole in the town.
 *
 * @param {string} kind BUILDING, DWELLING, EMPTY or RUIN
 * @param {number} alpha the layer's band alpha
 * @returns {{fill: string, edge: string}} the two rgba strings
 */
export function lotStyle(kind, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const s = LOT_STYLE[kind] || LOT_FALLBACK;
  const [r, g, b] = s.fill;
  return {
    fill: `rgba(${r}, ${g}, ${b}, ${s.alpha * a})`,
    edge: `rgba(52, 44, 34, ${s.edge * a})`,
  };
}

/** The band from which a building's icon stands on its mass. Below it the mass alone reads. */
export const ICON_ENV = [6.4, 7.0];

/** How much of a plot a building's icon takes, and the floor below which it is not worth drawing. */
export const ICON_PLOT_FRACTION = 0.30;
export const MIN_ICON_PX = 9;

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
