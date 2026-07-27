"use strict";
// WHICH improvement sprite a plot draws — pure, zero-import, and therefore testable
// (improvement-cell.test.mjs). The drawing itself lives in improvements.mjs, which needs core.mjs
// and so cannot be unit-tested; this is the part with actual decisions in it.
//
// Two of them, and both exist to stop a field of farms reading as one stamp repeated:
//   VARIANT — Civ4 ships an_eu_farm01/02/03 rather than one barn, and the bake keeps each as its own
//             atlas cell. A plot picks among them.
//   MIRROR  — a per-plot horizontal flip, so even a single-variant improvement is not uniform.
//
// Both are seeded on the plot's RASTER coordinates, never on anything frame-dependent: the same plot
// must choose the same barn on every repaint and across a reload, or the map shimmers as you pan.
// This is the same rule (and the same seed function) the foliage billboards follow.
import { mkRng, foliageSeed } from "./foliage.mjs";

/**
 * The atlas cell and mirror for the improvement on plot (sx, sy).
 *
 * @param sheet the manifest entry — `{src, w, h, sprites: [[x,y,w,h]…]}`; `sprites` may be absent on
 *              an older bake, in which case the whole sheet is the sprite (`rect` null).
 * @returns `{rect, flip}` — `rect` is the source rectangle to blit, or null for "the whole image".
 */
export function improvementCell(sheet, sx, sy) {
  const cells = sheet && sheet.sprites && sheet.sprites.length ? sheet.sprites : null;
  const rect = cells
    ? cells[Math.floor(mkRng(foliageSeed(sx, sy))() * cells.length) % cells.length]
    : null;
  return { rect, flip: !!((sx ^ sy) & 1) };
}
