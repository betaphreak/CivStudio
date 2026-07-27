"use strict";
// The REALM RIM — the outline where the active realm meets the fog (docs/realms.md §The fog must not
// be mute). Decorative fog says "nothing is here" when the truth is "something is here, on another
// map"; the rim is what turns that silence into a boundary you can see, and the crossings drawn on
// top of it (main.drawCaveEntrances / drawRealmArrows) are what make it a boundary you can cross.
//
// This matters more than the three-realm design expected. Cannor, Haless and Sarhal were carved out
// of ONE landmass, so their seams are walkable ground, not ocean: 18 passable land borders between
// Cannor and Sarhal, 24 between Haless and Sarhal. Unrimmed, a player walking south out of Cannor
// hits fog at a spot where nothing about the world changed. (Cannor↔Haless is the honest frontier —
// zero passable borders, because Anbennar put the Serpentspine's impassable wall between them.)
//
// ---- how the outline is computed ----
// Not from geometry: from a SILHOUETTE. Two passes on an offscreen canvas —
//   1. stroke the union of the realm's province paths at 2×RIM_W, giving a band straddling every
//      edge, interior ones included;
//   2. composite `destination-out` and FILL the same union, which erases everything inside it.
// An interior edge's band lies wholly within the union and vanishes; the outer boundary keeps the
// half of its band that falls outside. What is left is exactly the rim, RIM_W wide, hugging the
// realm's true outline including its islands and lakes — with no adjacency walk, no shared-border
// geometry, and no union-path algorithm.
//
// Cost: two path ops on one offscreen, cached on S.viewVersion like every other geometry cache here,
// so a static camera pays nothing and a pan pays it once. See docs/frontend-performance.md before
// changing that — the tier layer was the scene's most expensive purely for tessellating what it did
// not need.
import { ctx, cv, P, VIEW, S, provPath, provOnScreen, provSrcBox, pxr, pyr, ACTIVE_REALM } from "./core.mjs";
import { bandAlpha, kBand, ground3D } from "./bands.mjs";

const RIM_W = 3.0;                 // rim thickness in CSS px (screen-anchored: it reads the same at every zoom)
// How far the erase reaches on EITHER side of every edge. This is not a fudge factor for antialiasing
// — it is the width of the SLIVER GAPS between neighbouring provinces. Each province's outline is
// simplified independently by ProvinceBorderExporter, so two provinces that share a border in the
// raster do not share vertices in the polygon: the union has a hairline gap along every internal
// edge. Those gaps are outside the union, so the rim survives in them, and the realm draws as a fine
// amber mesh, one cell per province. Erasing GAP px to each side closes them.
//
// The rim is therefore painted GAP px further out than the true outline, which is what the widened
// stroke widths below pay for. At deep zoom the slivers grow with everything else, but so does the
// province you are inside, and the rim is off-screen by then.
const GAP = 2.5;
const RIM = "rgba(226,178,120,0.55)";   // warm amber, the same family as the cave-mouth glyph
// The rim is a boundary, not a landmass edge, so it must not compete with the coastline; low alpha and
// a soft outer glow read as "the map ends here" rather than "here is a cliff".
const GLOW = "rgba(226,178,120,0.16)", GLOW_W = 7;

let _cv = null, _cx = null;        // the offscreen, sized to the viewport
let _pv = -1;                      // S.viewVersion the offscreen was drawn at

// Provinces whose box intersects the viewport GROWN by the rim width. The margin is load-bearing: an
// off-screen neighbour still has to be in the union for step 2 to erase the shared edge's band, and
// culling it would leave a false rim along the viewport edge.
function nearScreen(p) {
  if (!p.rings) return false;
  if (provOnScreen(p)) return true;
  const box = provSrcBox(p);
  if (!box) return false;
  const m = GLOW_W + RIM_W + 2;
  const ax = pxr(box.x0), bx = pxr(box.x1), ay = pyr(box.y0), by = pyr(box.y1);
  return Math.max(ax, bx) >= -m && Math.min(ax, bx) <= VIEW.w + m
      && Math.max(ay, by) >= -m && Math.min(ay, by) <= VIEW.h + m;
}

// the union of every near-screen realm province, as one Path2D (provPath is already cached per
// province per viewVersion, so this is addPath calls and no re-tessellation)
function unionPath() {
  const u = new Path2D();
  for (const p of P) if (nearScreen(p)) u.addPath(provPath(p));
  return u;
}

// The rim is a WAYFINDING cue — "this map ends here, and there is more over there" — so it belongs to
// the zoomed-out half of the spine, where you are reading the shape of a world. From band 5 the 3D
// terrain owns the ground and you are looking at one province's hillside; a screen-anchored amber line
// over a heightmapped mesh is a HUD element drawn on a landscape, and the crossings (cave mouths, border
// arrows) carry the same message up close without contradicting the terrain. So it fades out across the
// handover rather than being painted over three.js.
// (in0/in1 are BELOW band 0 on purpose: bandAlphaAt returns 0 at b <= in0, so an envelope starting
// at 0 would make the rim invisible at world zoom — exactly where it is most wanted.)
const RIM_ENV = [-1, -0.5, 4.4, 5.4];   // full from world zoom out to band 4.4, gone by 5.4 (LOCALE = 5)

/** Paint the realm's fog-facing outline. A no-op on the uncropped whole-world view, which has no
 *  elsewhere to point at. */
export function drawRealmRim() {
  if (!ACTIVE_REALM) return;
  const a = ground3D() ? 0 : bandAlpha(RIM_ENV);
  if (a <= 0.01) return;
  if (!_cv) {
    _cv = document.createElement("canvas");
    _cx = _cv.getContext("2d");
    _pv = -1;
  }
  const dpr = VIEW.dpr || 1, w = Math.round(VIEW.w * dpr), h = Math.round(VIEW.h * dpr);
  if (_cv.width !== w || _cv.height !== h) { _cv.width = w; _cv.height = h; _pv = -1; }
  if (_pv !== S.viewVersion) {
    _cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _cx.clearRect(0, 0, VIEW.w, VIEW.h);
    const u = unionPath();
    _cx.lineJoin = "round"; _cx.lineCap = "round";
    // the soft outer glow first, then the crisp rim over it — both straddle the edge, and both get
    // their inner half erased by the same destination-out fill
    // Each stroke is widened by GAP so that, after the erase eats GAP px inward, what survives outside
    // is exactly RIM_W (and GLOW_W) wide.
    _cx.globalCompositeOperation = "source-over";
    _cx.strokeStyle = GLOW; _cx.lineWidth = (GLOW_W + GAP) * 2; _cx.stroke(u);
    _cx.strokeStyle = RIM;  _cx.lineWidth = (RIM_W + GAP) * 2;  _cx.stroke(u);
    _cx.globalCompositeOperation = "destination-out";
    _cx.fill(u);                       // erase the realm's interior — every internal edge with it…
    _cx.lineWidth = GAP * 2; _cx.stroke(u);   // …and the sliver gaps between neighbours (see GAP)
    _cx.globalCompositeOperation = "source-over";
    _pv = S.viewVersion;
  }
  // blit in DEVICE pixels: the main context carries the dpr transform, the offscreen already baked it
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = a;
  ctx.drawImage(_cv, 0, 0);
  ctx.restore();
  void cv;
}
