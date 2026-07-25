"use strict";
// Geographic-tier boundary GEOMETRY — pure, zero-import, and therefore testable (tier-geom.test.mjs).
// Same split as river-geom.mjs / plots.mjs and band-math.mjs / bands.mjs: the arithmetic takes its
// inputs as arguments so it can load under node, while overlays/tiers.mjs keeps the canvas work.
//
// WHY THIS EXISTS. The tier overlay was the most expensive layer in the scene — 26 ms/frame at 5.5x
// (85% of all layer cost) and 23 ms at 8x, several times the plot layer. Profiling
// (tools/webverify/tiers-probe.mjs) attributed effectively ALL of it to one thing:
//
//   real layer draw:  cache MISS 13.7ms   cache HIT 0ms
//   tessellate:       all 12.6ms   culled 0.2ms
//   stroke:           all+shadow 0ms   all no-shadow 0ms
//   regions:          802 rings / 15862 pts — on screen: 30 rings / 1294 pts
//
// Stroking was free. The `shadowBlur` was free. The cost was building a Path2D over the WHOLE WORLD's
// rings on every camera change: 15,862 points to draw the 1,294 that were on screen. Path2D
// moveTo/lineTo turns out to cost ~0.8 us a point, so the fix is simply not to call it 12× more often
// than needed — the same viewport cull core.provOnScreen has always done per province, which this
// layer never had.
//
// The cache in overlays/tiers.mjs is keyed on S.viewVersion, so a still camera already cost nothing
// (cache HIT 0 ms). This was purely the cost of PANNING AND ZOOMING, which is exactly when it is felt.

/**
 * Flatten a tier's `{groupKey: [ring…]}` map into a list of rings, each with its SOURCE-space
 * bounding box precomputed.
 *
 * Source coordinates never change — they are absolute pixels on the province raster — so a ring's box
 * is computed ONCE, when the geometry lands, and never again. That is what makes the per-frame cull
 * O(rings) instead of O(points): only the box's two corners get projected, not every vertex.
 *
 * @param {Object<string, number[][][]>} groups one tier of the /api/tiers payload
 * @returns {{ring:number[][], x0:number, y0:number, x1:number, y1:number}[]}
 */
export function indexTierRings(groups) {
  const out = [];
  for (const key in groups) {
    for (const ring of groups[key]) {
      if (!ring || !ring.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < ring.length; i++) {
        const x = ring[i][0], y = ring[i][1];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      out.push({ ring, x0, y0, x1, y1 });
    }
  }
  return out;
}

/**
 * Is an indexed ring's box within the viewport?
 *
 * `projX`/`projY` are core.pxr/pyr — affine and MONOTONICALLY INCREASING in the source coordinate
 * (cam.k > 0 and VIEW.dw/dh > 0), which is what lets a source-space box map corner-for-corner onto a
 * screen-space box. If that ever stops holding — an isometric shear on this projection would break it
 * — this has to project all four corners instead of two.
 *
 * `margin` covers the stroke that bleeds inward from a ring just outside the frame: half the widest
 * tier line plus the shadow blur. Without it, coarse boundaries would pop in at the viewport edge
 * during a pan.
 */
export function tierRingVisible(r, projX, projY, w, h, margin = 8) {
  return !(projX(r.x1) < -margin || projY(r.y1) < -margin
        || projX(r.x0) > w + margin || projY(r.y0) > h + margin);
}
