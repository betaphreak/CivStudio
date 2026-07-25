# Plan: the map to PixiJS — retained-mode rendering under the same band spine

**Status:** P0–P1 BUILT 2026-07-25 (P0 = commit `7916f5e`); P2–P8 proposed. This is the enabling work
for an isometric Ground regime and for sprite counts canvas 2D cannot reach; it is *not* itself a
visual feature, and it should be judged on the fps delta at P2 and abandoned there if the delta is
not real.

Companion to [`zoom-bands.md`](zoom-bands.md) (the band spine and layer registry this preserves
wholesale), [`plots.md`](plots.md) / [`province-plots.md`](province-plots.md) (the plot layer P2
moves), [`river-rendering.md`](river-rendering.md) (the `Graphics`-shaped geometry P5 must not
regress) and [`web/README.md`](../web/README.md) (the dependency-free property this ends).

## Why

The frontend is at the limit of what immediate-mode canvas 2D gives cheaply. Two symptoms:

- `repaint.mjs` caps paints at **30 fps** and renders on demand because "the scene is heavy"
  (`repaint.mjs:29`). That cap exists to hide per-frame CPU cost, not because 30 is enough.
- Every drawn thing recomputes `cam.x + cam.k * baseXr(sp)` per frame (`core.mjs:47-48`). Pan and
  zoom cost work proportional to scene size even when nothing changed.

Under a retained renderer the scene lives on the GPU, the camera is one matrix, and both costs
go away. The point is the headroom, not the current picture — which should look identical.

## Decisions to confirm before P0

These are proposals, not settled. P0 is cheap to reverse; P2 is not.

| # | Question | Proposed |
|---|---|---|
| **Renderer** | Pixi v8, or stay on canvas? | **Pixi v8.x, pinned.** WebGPU with WebGL2 fallback (`preference: "webgpu"`). |
| **Bundler** | Introduce one? | **No.** Vendor the ESM build to `web/js/vendor/pixi.min.mjs` and import it directly — `staticwebapp.config.json` already serves `.mjs`, and `web/` keeps its no-build-step-for-JS property. Costs ~450 KB min+gzip untree-shaken; revisit only if that hurts. |
| **Coexistence** | Big-bang or incremental? | **Incremental, strangler-fig.** The Pixi canvas sits *under* the existing 2D canvas; layers move one at a time; the 2D canvas is deleted when empty (P7). Every phase ships green. |
| **Scope** | Does the UI move? | **No.** DOM stays DOM. Only the map canvas changes. |
| **Isometric** | Part of this? | **No.** Separate plan. This unblocks it; conflating them makes both unshippable. |

## Current state (what exists to build on)

The codebase is better positioned for this than it looks:

- **The plot layer is already retained.** `plots.mjs` rasterises each province once to an offscreen
  canvas (`p._pcanvas` / `p._tcanvas` with `_pbox`/`_tbox`) and pan/zoom is "a single `drawImage`
  per province" (`plots.mjs:197`). Under Pixi those canvases become `Texture.from(canvas)` and the
  blit becomes a positioned `Sprite`. **The expensive half — `plotcanvas.mjs`'s pixel building —
  does not change at all.** Invalidation already has a hook (`p._tcanvas = null`, `plots.mjs:28/38`).
- **The layer registry is declarative.** `LAYERS` (`layers.mjs:54-80`) is an ordered array of
  `{id, band, gate, z, draw}`. Array order is paint order — which is exactly `addChild` order.
  `gate`/`z` are visibility predicates. This maps onto a container tree with no redesign.
- **The band system is pure and tested.** `bandAlphaAt` returns 0–1 (`band-math.mjs:35`) and feeds
  container `alpha` directly. `band-math.mjs` does not change a line; nor do its tests.
- **The screen-space stack is already separated.** `SCREEN_LAYERS` must not run per world copy, a
  rule currently enforced by a 10-line comment (`layers.mjs:28-36`). Under Pixi it becomes
  structural: a child of `stage`, not of `world`.
- **No east-west wrap.** "The map is a finite sheet, not a cylinder" (`main.mjs:167`) — one world
  copy, no tiling loop to reproduce.
- **Culling and cache-versioning exist**: `provOnScreen`, `provPath`, `S.baseVersion`/`S.viewVersion`.
- **Pure modules are already split out for testability** — `band-math`, `river-geom`,
  `route-tiling`, `district-plots`, `plotstats`. All renderer-agnostic; all survive untouched.

## P0 — Vendor Pixi, stand up an empty stage

**Status: BUILT.** `web/js/vendor/pixi.min.mjs` (pixi.js 8.19.0, pinned devDependency),
`web/js/pixi.mjs`, `canvas#gl` in `index.html`/`styles.css`, and the resize/render wiring in
`main.mjs`. Two verifiers landed beside it: `tools/webverify/pixi-harness.mjs` (does the vendored
bundle boot at all, and on which backend — no server needed) and `tools/webverify/pixi-p0-verify.mjs`
(the full assertion set below). Verified on a local server against the committed world-bundle
fixture: **WebGPU**, roots empty, both canvases agreeing on backing store before and after a resize,
no console errors, `boot-check` green, 123/123 web unit tests passing.

Two deviations from what this section originally specified, both deliberate:
- **Transparent clear, not `#070a10`.** A background colour would paint a dark rectangle beneath
  `#map`, and P0's whole claim is that the page is pixel-identical. The clear colour becomes real at
  P7, when `#map` goes away and `#gl` owns the void fill.
- **`autoDensity: false`.** It would write inline px width/height onto the canvas and fight
  `styles.css` (which sizes `#gl` `inset:0`/100%×100%, exactly like `#map`). `resizePixi` sizes the
  backing store only — mirroring what `main.resize` does for the 2D canvas.

**Goal.** The renderer exists and draws nothing. Zero visual change, zero fps change.

1. Vendor `web/js/vendor/pixi.min.mjs` (ESM, pinned to an exact 8.x — record the version in
   `web/README.md`).
2. New `web/js/pixi.mjs`: owns `app`, and the two root containers — `stage` (screen-space) and
   `world` (camera-transformed). `await app.init({ canvas, resolution: dpr, autoDensity: true,
   preference: "webgpu", background: "#070a10" })`. Export `app`, `stage`, `world`.
3. `index.html`: a `<canvas id="gl">` **beneath** the existing map canvas, same size/stacking.
4. Resize wiring shares `VIEW`/`fitView` — one source of truth for viewport dimensions.

**Risk / tests.** None visual. Verify: page loads, splash still hides on first paint, `diag.mjs`
fps readout unchanged, no console errors on both WebGPU and WebGL2 (force each via `preference`).

## P1 — The camera seam, provably in agreement

**Status: BUILT.** `web/js/pixi-cam.mjs` (`worldTransform` / `applyWorldTransform` / `mapClipRect`,
pure and zero-import), `pixi.syncCamera(cam, VIEW)` called first in `main.paintScene`, the clip mask,
5 tests in `pixi-cam.test.mjs` (128 total in `web/`), and `tools/webverify/pixi-p1-verify.mjs`.

**Result: 105 samples, `worstXY = 0` — exact agreement**, not merely sub-pixel. The verifier compares
**Pixi's own container matrix** (`world.toGlobal`, i.e. what the GPU will use) against the **real
`core.pxr`/`pyr`**, across k ∈ {1, 1.7, 5, 16, 64, 233, 512} × three pans × five source pixels.
Nothing in it is transcribed, which is why it — not the node tests — is the authority.

Three things worth recording:

- **`worldTransform` is a near-identity**, and that is the finding, not a disappointment.
  `pxr(sp) = cam.x + cam.k · baseXr(sp)` is already affine in base space, so the codebase always had
  the right split — it just applied the camera half by hand, per drawn thing, per frame. It still
  earns a named module with a test: it is the one place an isometric shear would go, and a silent
  drift between the two renderers is the worst bug class this migration can produce.
- **The clip mask got simpler than specified.** The plan said "a rectangular `Graphics` mask on
  `world`"; making it a **child** of `world` puts its geometry in base space, where it is just the fit
  rectangle (`VIEW.dx/dy/dw/dh`) and the camera carries it for free. `main.paintScene` re-derives the
  same rectangle in screen space every frame; this cannot fall out of step with the layers it clips.
  Rebuilt only when the fit rect moves (resize / realm switch), not on pan or zoom.
- **The mask is a child of `world` but is not a layer**, so P0's "the scene is empty" assertion still
  holds — `pixi-p0-verify.mjs` now filters on `label !== "mapClip"`. That claim expires at P2.

**Verifier gotcha, fixed.** Mutating `cam` to stress the transform can race a repaint the app
schedules for its own reasons (an SSE snapshot, the clock): the 2D canvas then paints at a stress
camera, and restoring `cam` without repainting leaves that stale frame for the screenshot — which
looked exactly like a rendering regression. The verifier now calls `repaint.draw()` after restoring
and waits for the frame. Any later phase that drives the camera from a test needs the same care.

**Goal.** `world`'s transform tracks `cam`, and it demonstrably agrees with `pxr`/`pyr` — because
for the whole migration two renderers draw one scene, and a disagreement is a subtle drift bug.

1. New pure module `web/js/pixi-cam.mjs`: `worldTransform(cam, VIEW)` → `{x, y, k}`. Imports
   nothing (same pattern and rationale as `band-math.mjs`).
2. `syncCamera()` in `pixi.mjs` applies it: `world.position.set(x, y); world.scale.set(k)`.
   Called from `paintScene()` before the legacy draw.
3. Sprites are positioned in **base** space — `baseXr`/`baseYr` output, never `pxr`/`pyr`. Write
   this down in `pixi.mjs`'s header; it is the single rule the whole migration rests on.
4. The map clip (`main.mjs:154-159`) becomes a rectangular `Graphics` mask on `world`.

**Risk / tests.** `pixi-cam.test.mjs` (node:test): for a sampled grid of `(cam, VIEW, sp)`, assert
`worldTransform` composed with `baseXr` equals `pxr` to within a pixel. This is the guard rail for
every later phase.

## P2 — The plot layer moves (the pilot, and the go/no-go)

**Goal.** The heaviest layer renders through Pixi. Measure the delta. **Decide here whether to
continue.**

1. `plotcanvas.mjs` gains `provinceTexture(p)` beside `blitProvinceCanvas` — wraps the existing
   `_pcanvas`/`_tcanvas` in a `Texture`, cached on the province, invalidated by the same
   `_tcanvas = null` hook that already exists.
2. A `plots` `Container` under `world`; one `Sprite` per on-screen province, positioned from
   `_pbox`/`_tbox`, `alpha` from the layer's existing band envelope.
3. Reuse `provOnScreen` for culling — add/remove sprites on the same predicate the canvas path uses.
4. `drawSurfacePlots` stops drawing (keep the function behind a flag for one commit, then delete).

**Risk / tests.** The known ones: `imageSmoothingEnabled = false` (`plots.mjs:146`) must become
`texture.source.scaleMode = "nearest"` or the terrain goes blurry at deep zoom; giant provinces
(~80k plots) already have a flat-canvas fallback that must survive. Test with `tools/webverify`
screenshots at `K_PLOT`, `K_TEX` and `K_MAX`, diffed against pre-migration captures.

**Kill criteria.** If fps at `K_TEX` is not materially better than the 30-cap, or the terrain
cannot be made pixel-identical, stop here and revert. P0–P2 is a bounded, deletable spike.

## P3 — The registry becomes a container tree

**Goal.** One declarative place decides what is visible, at what alpha, on which renderer — with
the migrated and unmigrated layers side by side and legible.

1. `LAYERS` entries gain an optional `container` (Pixi) beside `draw` (legacy canvas). An entry has
   one or the other; the migration is visibly "how many entries still say `draw`".
2. New pure `layer-state.mjs`: `layerStateAt(LAYERS, z, bandPos, gateResults)` → `[{id, visible,
   alpha}]`. `renderLayers()` becomes: apply that to containers, then run the remaining `draw` fns
   on the 2D canvas above.
3. Container creation order follows array order, so paint order stays single-sourced.

**Risk / tests.** `layer-state.test.mjs` — z-filtering, gating, band alpha, and that order is
preserved. This is the phase that keeps P4/P5 from becoming a mess.

## P4 — The static geographic layers

**Goal.** Everything that changes only on bundle/realm/mode moves. Build-once, mutate-rarely.

`raster`, `lakes`, `seaCells`, `impassable`, `provBorders`, `tiers`, `political`, plus `seaBase`
(child of `stage`, not `world`) and the two realm-fog passes (`drawRealmFogUnder` becomes a
container between sea and raster; `drawRealmFog` a screen-space masked `Graphics`).

Province borders and political fills are `Graphics` — build on `S.baseVersion` change, never per
frame. For 5,264 province fills, measure `Graphics` first; bake to a texture if tessellation costs.

**Risk / tests.** The fog compositing (`_fogFill`'s two-pass parchment + sepia, `main.mjs:193-197`)
is the fiddly one — soft-light over sea, under land. Screenshot-diff the World and Realm bands.

## P5 — The dynamic session layers

**Goal.** The per-tick surface, without allocating per frame.

`routes`, `city`, `districts`, `live`, `tradeGoods`, `cost`, `hover`, `selected`. These change on
snapshot arrival, so: sprite **pools** keyed by stable id, rebuilt on data-dirty (`routeDirty`
already signals this — see the viewport-windowed route feed), mutated otherwise.

`hover`/`selected` stay cheap — one `Graphics` each, redrawn on hit-test change, not per frame.
`S.markers` (the non-polygon hit-test channel) is unaffected; hit-testing stays math-based, not
Pixi's `eventMode` — faster, and `hittest.mjs` already exists.

**Risk / tests.** Sprite lifecycle is the new bug class: leaks on colony death, stale sprites after
a realm switch. Add a `diag.mjs` readout of live sprite count per container — cheap, and it makes
leaks visible instead of gradual.

## P6 — Labels to BitmapText

**Goal.** Map text at GPU speed.

1. Bake a Jost\* bitmap font atlas in `build.mjs` (sharp is already a build dep).
2. `labels.mjs` moves to pooled `BitmapText`. `plotlabel.mjs`/`maptip.mjs` are DOM — untouched.

**Risk / tests.** This is the phase most likely to look *worse* before it looks right — hinting,
subpixel positioning, and the halo/outline treatment. Keep the canvas label path behind a flag
until side-by-side screenshots at every band are acceptable. Country names carry heraldry
(`flags.md`) — verify the atlas-sprite + text pairing still aligns.

## P7 — Retire the 2D canvas

**Goal.** One renderer.

1. Delete the `ctx` path from `paintScene`, the dpr transform, the clip save/restore, `drawRealmFog*`'s
   canvas variants, and the second `<canvas>`.
2. Re-tune `repaint.mjs`: the 30 fps cap was CPU triage. Raise or remove it, keep the coalescing,
   and keep `draw()` as the API (Pixi supports manual `renderer.render()` — an on-demand scene is
   still the right policy, just no longer a rationed one).
3. `minimap.mjs` decision point: it is a small separate canvas and may simply stay 2D. Leaving it
   is fine and is the cheaper answer.

**Risk / tests.** Full `tools/webverify` sweep — every band, both z-levels, every map mode, Live
mode with the lobby dismissed (Esc, per the live-shot note), and a realm switch.

## P8 — Spend the headroom

Not part of the migration; the reason for it. In rough order of value: free-running ticker,
higher-density plot rendering past `K_MAX`, then the isometric Ground regime as its own plan.

## What does not change

Worth stating explicitly, because it is most of the frontend and the whole cost argument:

- **All DOM UI** — `techtree` (823 lines), `lobby`, `advisors`, `rail`, `city-screen`, `panel`,
  `notify`, `bandcaption`, `colony-detail`, `caravan-detail`, `searchbox`, `shortcuts`, `auth`,
  `lore`, `maptip`, `btntip`, `livelog`, `diag`. Pixi renders to a canvas; the DOM sits on top.
- **Every pure module and its tests** — `band-math`, `river-geom`, `route-tiling`, `district-plots`,
  `plotstats`, `notify-*`, `lobby-rows`, `snapshot-dedupe`, `route-index`, `md`.
- **`plotcanvas.mjs`'s pixel building**, the province rasterisation, the terrain codec, the plot
  cache, `MAP_VERSION`.
- **Server, `/api/bundle`, the bake pipeline, the deploy.** No engine or server change anywhere in
  this plan.

Roughly 2,000–2,500 lines of drawing code move; ~11,000 lines do not.

## Risks

| Risk | Mitigation |
|---|---|
| Two renderers disagree mid-migration | P1's agreement test; short phases; screenshot diffs each phase |
| Sprite/texture leaks | P5's per-container sprite-count readout in `diag.mjs` |
| `Graphics` re-tessellation cost on province geometry | Build on `baseVersion`, not per frame; bake to texture if measured slow |
| Pixi v8 API churn (v7→v8 broke `Graphics`, made init async) | Pin an exact version; vendored, so no silent drift |
| WebGPU vs WebGL2 divergence | Test both backends at every phase; WebGL2 is the floor |
| `web/` stops being dependency-free | Accepted, deliberately. Update `web/README.md` and the CLAUDE.md one-liner at P0 |
| Migration stalls half-done | Every phase ships green and is independently valuable; P2 is an explicit kill gate |

## Sequencing note

P0–P2 is the spike — bounded, deletable, and it answers the only question that matters. Do not
start P3 until P2's numbers are in hand. Do not start P6 (labels) early because it is visible;
it is the phase most likely to look bad and stall confidence in a migration that is otherwise fine.
