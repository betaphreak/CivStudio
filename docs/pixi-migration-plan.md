# CLOSED: the PixiJS map-renderer migration

**Status: CLOSED 2026-07-25, code reverted.** Ran as phases P0–P2 plus P4b over one session
(`7916f5e`, `154c430`, `5038647`, `89c0259`, `187ec3d`), then stopped and removed once the target look
was pinned down and turned out to need a **3D** renderer, which Pixi is not.

This is a record, not a plan. The two things worth reading were moved out so they would not be buried
here:

- **[`frontend-performance.md`](frontend-performance.md)** — how to measure `web/`, the four traps that
  produced every wrong turn below, the current baseline, and the one fix that actually mattered
  (`tiers`, 26.3 ms → 0.03 ms). **Read it before optimising anything.**
- **[`terrain-3d.md`](terrain-3d.md)** — the target look, the spike that validated a heightmapped-mesh
  approach, and what a real implementation would need.

## Why it was started

Two symptoms suggested canvas 2D was out of headroom: `repaint.mjs` caps paints at 30 fps because "the
scene is heavy", and every drawn thing recomputed `cam.x + cam.k * baseXr(sp)` per frame
(`core.mjs:47-48`). The plan was to migrate the map layers onto a retained GPU renderer one at a time,
back-to-front, with the plot layer first — enabling an isometric Ground regime and higher sprite counts.

**The premise was wrong.** The 30 fps cap was hiding one missing viewport cull, not a renderer limit;
after fixing it the whole scene paints in **under 3 ms at every zoom**. See
[`frontend-performance.md`](frontend-performance.md).

## What was built, and what it measured

- **P0** — vendored PixiJS 8.19.0 as `js/vendor/pixi.min.mjs` (committed, not bundled, so `web/`'s
  no-bundler property survived), a `#gl` canvas beneath `#map`, and three scene roots mirroring
  `paintScene`'s order. Drew nothing.
- **P1** — the camera seam. `world`'s transform *is* `cam`, so the per-point camera arithmetic becomes
  one matrix. A browser verifier compared **Pixi's own container matrix** against the real
  `core.pxr`/`pyr` across 105 samples: **exact agreement, 0 px**. `worldTransform` turned out to be a
  near-identity — the codebase always had the right split and merely applied the camera half by hand.
- **P2** — the plot layer, flag-gated (`?pixiPlots=1`). Median ms to get the layer on screen:

  | `cam.k` | on screen | canvas2d | pixi (sync+render) | |
  |---|---|---|---|---|
  | 5.5 | 181 | 0.8 ms | 0.9 ms | 0.89× |
  | 8 | 82 | 0.5 ms | 0.8 ms | 0.63× |
  | **16** | 24 | **7.2 ms** | **0.7 ms** | **10.3× faster** |
  | 40 | 2 | 0.4 ms | 0.7 ms | 0.57× |

  **Pixi's cost was flat — ~0.7–0.9 ms from 2 provinces to 181** — where the 2D path swung 0.4 → 7.2 ms.
  That flatness is the real property a GPU renderer buys, and it remains true for whatever renderer
  comes next. The k=16 win was in the textured regime, which profiling independently put at 83% of layer
  cost there.

- **P4b** — the `tiers` cull. Not a Pixi phase, and worth more than all of the above.
  → [`frontend-performance.md`](frontend-performance.md).
- **P3 step 1** — the void fill moved off the render path to CSS. Renderer-independent, kept.
  → [`frontend-performance.md`](frontend-performance.md).

## The two structural findings (why it could never ship incrementally)

**1. The back of the 2D frame is a wall of opaque full-area fills.** `paintScene` opens with an opaque
`#070a10` void fill, then `sea.drawSeaBase` (fills the viewport), then `drawRealmFogUnder` (fills the map
region), then the opaque land raster. `#gl` composited *beneath* `#map`, so each one occluded it
completely.

This cost real time: the plot sprites were placed *exactly* right and rendered a perfectly good frame
that was 100% hidden. The placement assertion passed and the screenshot was black; only a framebuffer
read-back proved the pixels existed. **A migrated layer that renders invisibly looks identical to a
broken one — test for pixels, not just placement.**

**2. Migration order was forced.** With `#gl` beneath `#map`, layers had to migrate strictly
back-to-front, so the static geographic prefix had to land before the plot layer could ship unflagged.
`plots` was entry 3 in `layers.LAYERS`, so P2 could only ever be a flagged spike.

## Why it was closed

The target look was pinned as `tools/samples/test2.png` — a Civ4/C2C screenshot: heightmapped terrain
under an oblique perspective camera, upright 3D props, screen-space city plates. **Pixi is a 2D renderer
and cannot produce that**, so the remaining phases did not lead there, and the flag-gated plot layer was
not a stepping stone to it. A two-day spike then validated the 3D approach against real eos data
([`terrain-3d.md`](terrain-3d.md)).

The reuse from P0–P2 turned out to be **conceptual, not literal**: `provinceTexture` returned a *Pixi*
texture and `pixi-cam` was Pixi-named, so neither transfers to three.js. Weighed against 780 KB shipping
to prod for a URL-flagged feature, plus dead branches in the two hottest frontend files, removal won.

## What the revert removed

Deleted: `web/js/vendor/pixi.min.mjs`, `js/pixi.mjs`, `js/pixi-cam.mjs` (+ tests), `js/pixi-plots.mjs`,
and `tools/webverify/pixi-{harness,p0-verify,p1-verify,p2-verify,p2-diag}.mjs`. Unwired: the `<canvas
id="gl">` and its CSS rule, the `toPixi` emit branch in `plots.drawPlots`, `provinceTexture` in
`plotcanvas.mjs`, the `pixiOwnsBackground()` suppressions in `main.paintScene`/`drawRaster`, and the
`pixi.js` devDependency. `web/` is dependency-free again.

**Kept**, because none of it is Pixi: `js/tier-geom.mjs` + the cull, the void fill on CSS, and the
repaired `tools/webverify/layer-profile.mjs` / `tiers-probe.mjs` / `fog-probe.mjs`.

## If a GPU renderer is revisited

Things this effort established that would apply again:

- The camera reduces to **one matrix** on a root container; `pxr` is already affine in base space
  (`core.mjs:44-50`). A province offscreen's destination rect contains **no camera term at all**, so a
  sprite/mesh is placed once, not per frame.
- The baked per-province offscreens are the reuse: they work directly as GPU textures, keying a
  `WeakMap` on the canvas object makes invalidation free (every rebuild allocates a fresh canvas, so the
  existing `p._tcanvas = null` hooks suffice), and the expensive rasterisation needs no changes.
- The back-to-front ordering constraint applies to **any** renderer composited beneath `#map`. Compositing
  *above* instead inverts it to front-to-back, which is worse — labels are the hardest layer.
- Two callers reach `drawPlots` with different predicates (`isSurface`, `isUnderground`), so a per-call
  opt-in is required; deriving it from the `only` argument silently disabled the surface layer.
