import { test } from "node:test";
import assert from "node:assert/strict";
import { wallStyle, patchFill, patchStroke, townAlpha, BAND_IN, BAND_FULL, WALL_STYLE,
  streetStyle, STREET_STYLE, MIN_STREET_PX, MIN_WALL_PX,
  wardTint, WARD_TINT, lotStyle, LOT_STYLE, ICON_ENV,
  BRIDGE_STROKE, BRIDGE_CASING, BRIDGE_LENGTH, BRIDGE_WIDTH } from "./town-style.mjs";

// The town layer's pure parts (docs/towngen-port.md T7). The one that matters is the wall styling:
// a wall here is per-plot-edge and typed by what lies beyond it, so the COLOUR is what shows that
// the generator read real terrain — Nathalaire's line is 20 quay to 5 curtain because its plots say
// they front water.

test("every fortification kind has its own look", () => {
  const kinds = ["CURTAIN", "QUAY", "ROAD_GATE", "RIVER_GATE"];
  const strokes = new Set(kinds.map(k => wallStyle(k).stroke));
  assert.equal(strokes.size, kinds.length, "no two kinds read the same");
  for (const k of kinds) {
    assert.ok(wallStyle(k).width > 0, `${k} has a width`);
    assert.ok(wallStyle(k).label.length > 0, `${k} has a label`);
  }
});

test("a gate is drawn heavier than the wall it stands in", () => {
  assert.ok(wallStyle("ROAD_GATE").width > wallStyle("CURTAIN").width);
  assert.ok(wallStyle("RIVER_GATE").width > wallStyle("QUAY").width);
});

test("an unknown kind falls back to curtain rather than vanishing", () => {
  // an older client against a newer server: a wall in the wrong colour beats a hole in the line
  assert.deepEqual(wallStyle("PALISADE_OF_THE_FUTURE"), WALL_STYLE.CURTAIN);
  assert.deepEqual(wallStyle(undefined), WALL_STYLE.CURTAIN);
});

test("a walled ward reads stronger than a suburb", () => {
  const walled = patchFill(true, 1);
  const suburb = patchFill(false, 1);
  assert.notEqual(walled, suburb, "the wall has to be legible as an enclosure");
  const alphaOf = s => Number(s.match(/,\s*([0-9.]+)\)$/)[1]);
  assert.ok(alphaOf(walled) > alphaOf(suburb));
});

test("fills and strokes scale with the band alpha and never leave it", () => {
  const alphaOf = s => Number(s.match(/,\s*([0-9.]+)\)$/)[1]);
  assert.equal(alphaOf(patchFill(true, 0)), 0);
  assert.ok(alphaOf(patchFill(true, 0.5)) < alphaOf(patchFill(true, 1)));
  assert.equal(alphaOf(patchStroke(0)), 0);
  // out-of-range alphas are clamped, not trusted
  assert.equal(alphaOf(patchFill(true, 5)), alphaOf(patchFill(true, 1)));
  assert.equal(alphaOf(patchStroke(-3)), 0);
});

test("the layer fades in over the city bands and not before", () => {
  assert.equal(townAlpha(BAND_IN), 0, "nothing at the fade-in point");
  assert.equal(townAlpha(4), 0, "and nothing at world zoom");
  assert.ok(townAlpha((BAND_IN + BAND_FULL) / 2) > 0);
  assert.ok(townAlpha((BAND_IN + BAND_FULL) / 2) < 1);
  assert.equal(townAlpha(BAND_FULL), 1);
  assert.equal(townAlpha(9), 1, "and stays up at the deepest zoom");
});

test("the high street is drawn heavier than the lanes that join it", () => {
  // the server already decided which is which (MAIN reached the centre, STREET ended on another),
  // so the client's only job is not to throw that away
  assert.ok(streetStyle("MAIN").width > streetStyle("STREET").width);
  assert.notEqual(streetStyle("MAIN").stroke, streetStyle("STREET").stroke);
});

test("an unknown street kind falls back to a lane rather than vanishing", () => {
  assert.deepEqual(streetStyle("BOULEVARD_OF_THE_FUTURE"), STREET_STYLE.STREET);
  assert.deepEqual(streetStyle(undefined), STREET_STYLE.STREET);
});

test("a street never outdraws the wall it runs up to", () => {
  // the wall is the subject at these bands; a street wider than the curtain would read as the
  // enclosure and the actual enclosure as decoration
  assert.ok(streetStyle("MAIN").width <= wallStyle("CURTAIN").width);
  assert.ok(MIN_STREET_PX < MIN_WALL_PX, "and it stays the thinner of the two when zoomed out");
});

// --- T6: wards and lots ---

test("every district reads as its own ground", () => {
  const tints = new Set(Object.values(WARD_TINT).map(t => t.join()));
  assert.equal(tints.size, Object.keys(WARD_TINT).length, "no two wards look the same");
  for (const [ward, t] of Object.entries(WARD_TINT)) {
    assert.equal(t.length, 3, `${ward} is an rgb triple`);
    for (const c of t) assert.ok(c >= 0 && c <= 255, `${ward} channel in range`);
  }
});

test("a district this client has not heard of reads as ordinary ground", () => {
  // a new DistrictType must never leave a hole where a ward should be
  assert.deepEqual(wardTint("DISTRICT_OF_THE_FUTURE"), WARD_TINT.NEIGHBORHOOD);
  assert.deepEqual(wardTint(undefined), WARD_TINT.NEIGHBORHOOD);
});

test("the ward tints the walled ground and a suburb stays outside the scheme", () => {
  // §2b: the suburb reading cooler and thinner is what makes the wall legible as an enclosure
  assert.notEqual(patchFill(true, 1, "HOLY_SITE"), patchFill(true, 1, "ENCAMPMENT"));
  assert.equal(patchFill(false, 1, "HOLY_SITE"), patchFill(false, 1, "ENCAMPMENT"),
    "a suburb is a suburb whatever district it is");
  assert.equal(patchFill(true, 1), patchFill(true, 1, "NEIGHBORHOOD"),
    "no ward at all falls back to residential");
});

test("a building is the heaviest thing on the ground and a yard the lightest", () => {
  // §2c's contrast: notable buildings as solid masses against the fine grain of the ordinary town
  const alphaOf = s => Number(s.match(/,\s*([0-9.]+)\)$/)[1]);
  const a = k => alphaOf(lotStyle(k, 1).fill);
  assert.ok(a("BUILDING") > a("DWELLING"));
  assert.ok(a("DWELLING") > a("RUIN"));
  assert.ok(a("RUIN") > a("EMPTY"));
});

test("a ruin is grey where a dwelling is warm", () => {
  // decline has to read as decline, not as a differently-sized house
  assert.notDeepEqual(LOT_STYLE.RUIN.fill, LOT_STYLE.DWELLING.fill);
  const [r, g, b] = LOT_STYLE.RUIN.fill;
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 20, "the ruin tint is near-neutral");
});

test("an unknown lot kind draws as a dwelling rather than vanishing", () => {
  assert.deepEqual(lotStyle("PAGODA_OF_THE_FUTURE", 1), lotStyle("DWELLING", 1));
});

test("lot fills scale with the band alpha and clamp", () => {
  const alphaOf = s => Number(s.match(/,\s*([0-9.]+)\)$/)[1]);
  assert.equal(alphaOf(lotStyle("BUILDING", 0).fill), 0);
  assert.ok(alphaOf(lotStyle("BUILDING", 0.5).fill) < alphaOf(lotStyle("BUILDING", 1).fill));
  assert.equal(alphaOf(lotStyle("BUILDING", 9).fill), alphaOf(lotStyle("BUILDING", 1).fill));
});

test("the icons come in after the town itself does", () => {
  // the masses have to establish the place before buttons are stamped on it, or a dense ward is
  // a pile of overlapping icons at the band it first appears
  assert.ok(ICON_ENV[0] >= BAND_IN, "icons never precede the layer");
  assert.ok(ICON_ENV[0] < ICON_ENV[1], "and they fade in over a range like everything else");
});

// --- T4b: water ---

test("the waterfront reads as water-side ground", () => {
  // the one ward decided by location rather than by what anybody built on it
  assert.ok(WARD_TINT.HARBOR, "there is a harbour tint");
  const blueness = t => t[2] - t[0];
  const harbour = blueness(WARD_TINT.HARBOR);
  assert.ok(harbour > 0, "it leans blue");
  for (const [ward, t] of Object.entries(WARD_TINT)) {
    if (ward !== "HARBOR") {
      assert.ok(blueness(t) < harbour, `${ward} reads less like water than the wharves do`);
    }
  }
});

test("a bridge is a crossing, not a widening of the road", () => {
  // it is drawn ACROSS the street, so it must be longer than it is wide or it reads as a passing
  // place. The channel itself stays the river ribbon's to draw (§8b).
  assert.ok(BRIDGE_LENGTH > BRIDGE_WIDTH * 2);
  assert.notEqual(BRIDGE_STROKE, BRIDGE_CASING, "pale on dark, like the wall and the streets");
});

test("the ramp is monotone", () => {
  let prev = -1;
  for (let b = 5; b <= 7; b += 0.1) {
    const a = townAlpha(b);
    assert.ok(a >= prev, `alpha dropped at band ${b}`);
    prev = a;
  }
});
