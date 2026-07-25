"use strict";
// What's under the cursor: province and plot hit-testing. Split out of panel.mjs — pure geometry
// over the camera and the loaded grids, with no DOM and no rail state, so both the panel
// (hover/select) and bandcaption.mjs (viewport focus) can ask without pulling in the whole panel
// module. The map is a finite sheet (docs/realms.md §Delete the wrap), so the cursor falls in exactly
// one world — no east-west wrap copies to shift into and retry.
import { P, pxr, pyr, px, py, provBoxHas } from "./core.mjs";
import { atLeast, BAND } from "./bands.mjs";
import { bonusIconRect } from "./bonusicons.mjs";

// point-in-polygon over a province's rings (even-odd, in screen space)
function pointInProv(p, mx, my) {
  let inside = false;
  for (const ring of p.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = pxr(ring[i][0]), yi = pyr(ring[i][1]), xj = pxr(ring[j][0]), yj = pyr(ring[j][1]);
      if (((yi > my) !== (yj > my)) && (mx < (xj - xi) * (my - yi) / (yj - yi) + xi)) inside = !inside;
    }
  }
  return inside;
}

export function provinceAt(mx, my) {
  // cheap bbox pre-filter before the full point-in-polygon: a bbox miss can't be a polygon hit,
  // so this skips all but the few provinces actually under the cursor (same projection space, so
  // the result is identical). provBoxHas is a strict superset of pointInProv.
  for (const p of P) { if (p.rings && provBoxHas(p, mx, my) && pointInProv(p, mx, my)) return p; }
  // else nearest centroid: land + coastal sea/lake all carry rings now (they hover/select alike); a
  // province with no outline (deep ocean, never shipped) has none and is skipped. Only a province
  // whose bbox (grown by the 9.5px centroid radius, √90) reaches the cursor can win, so cull first.
  let best = null, bd = 1e9;
  for (const p of P) { if (!p.rings || !provBoxHas(p, mx, my, 10)) continue; const dx = px(p.lon) - mx, dy = py(p.lat) - my, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = p; } }
  return bd < 90 ? best : null;
}

// the plot under the cursor at texture zoom (where the per-province plot canvases + their grids
// exist) — used for the resource tooltip. Ring-less sea provinces are found too, so coastal
// resources tooltip like land ones. Returns the plot record, or null.
export function plotAt(mx, my) {
  if (!atLeast(BAND.TERRAIN)) return null;
  for (const p of P) {
    if (!p._grid || !p._tbox) continue;                       // only provinces whose texture canvas is built
    const b = p._tbox, X0 = pxr(b.x0), X1 = pxr(b.x0 + b.w), Y0 = pyr(b.y0), Y1 = pyr(b.y0 + b.h);
    if (mx < X0 || mx >= X1 || my < Y0 || my >= Y1) continue;
    const spx = b.x0 + Math.floor((mx - X0) / (X1 - X0) * b.w);
    const spy = b.y0 + Math.floor((my - Y0) / (Y1 - Y0) * b.h);
    // prefer a resource ICON under the cursor: the glyph is large and anchored at its plot's
    // bottom-left, so it often overlaps a neighbouring cell — scan a small neighbourhood (owner is
    // at-or-left, at-or-below the cursor) and return the plot whose icon rect covers (mx,my).
    for (let gy = spy - 1; gy <= spy + 2; gy++) for (let gx = spx - 2; gx <= spx; gx++) {
      const c = p._grid.get(gx * 1e5 + gy); if (!c || !c.bonus) continue;
      const rc = bonusIconRect(c);
      if (rc && mx >= rc[0] && mx <= rc[2] && my >= rc[1] && my <= rc[3]) return c;
    }
    const q = p._grid.get(spx * 1e5 + spy);
    if (q) return q;                                          // land plot found first; else the sea shelf plot
  }
  return null;
}
