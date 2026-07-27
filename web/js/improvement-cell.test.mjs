import test from "node:test";
import assert from "node:assert/strict";
import { improvementCell } from "./improvement-cell.mjs";

const SHEET = { src: "assets/improvements/imp-farm.webp", w: 167, h: 113, sprites: [[0, 0, 60, 113], [61, 0, 52, 100], [114, 0, 52, 98]] };

test("picks a cell from the sheet's variants", () => {
  const { rect } = improvementCell(SHEET, 4012, 888);
  assert.ok(SHEET.sprites.includes(rect), "the chosen rect is one of the sheet's own cells");
});

test("the choice is stable for a plot — a repaint must not reshuffle the map", () => {
  for (const [x, y] of [[4012, 888], [0, 0], [-3, 7], [99999, 12345]]) {
    const a = improvementCell(SHEET, x, y), b = improvementCell(SHEET, x, y);
    assert.deepEqual(a, b, `(${x},${y}) chose differently on a second call`);
  }
});

test("neighbouring plots do not all get the same barn", () => {
  const seen = new Set();
  for (let x = 4000; x < 4040; x++) seen.add(SHEET.sprites.indexOf(improvementCell(SHEET, x, 888).rect));
  assert.ok(seen.size > 1, "a run of 40 plots used more than one variant");
});

test("the mirror alternates on the checkerboard, so one variant is still not uniform", () => {
  assert.equal(improvementCell(SHEET, 10, 10).flip, false);
  assert.equal(improvementCell(SHEET, 11, 10).flip, true);
  assert.equal(improvementCell(SHEET, 10, 11).flip, true);
  assert.equal(improvementCell(SHEET, 11, 11).flip, false);
});

test("an older bake with no sprite cells falls back to the whole image", () => {
  const { rect, flip } = improvementCell({ src: "x.webp", w: 128, h: 128 }, 5, 6);
  assert.equal(rect, null, "null rect = blit the whole sheet");
  assert.equal(typeof flip, "boolean");
});

test("a missing sheet does not throw — the layer simply draws nothing", () => {
  assert.equal(improvementCell(null, 1, 2).rect, null);
  assert.equal(improvementCell(undefined, 1, 2).rect, null);
});
