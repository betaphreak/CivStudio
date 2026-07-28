import { test } from "node:test";
import assert from "node:assert/strict";
import { wallStyle, patchFill, patchStroke, townAlpha, BAND_IN, BAND_FULL, WALL_STYLE,
  streetStyle, STREET_STYLE, MIN_STREET_PX, MIN_WALL_PX } from "./town-style.mjs";

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

test("the ramp is monotone", () => {
  let prev = -1;
  for (let b = 5; b <= 7; b += 0.1) {
    const a = townAlpha(b);
    assert.ok(a >= prev, `alpha dropped at band ${b}`);
    prev = a;
  }
});
