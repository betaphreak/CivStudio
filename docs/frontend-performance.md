# Frontend performance — how to measure `web/`, and what has already been found

**Read this before optimising anything in `web/`.** It is renderer-agnostic and outlived the effort
that produced it: during the July 2026 PixiJS experiment ([`pixi-migration-plan.md`](pixi-migration-plan.md),
closed) every wrong turn was a **measurement error**, not a coding error, and one of them nearly cost
two unnecessary ports. The traps below are cheap to re-fall-into.

## The current baseline

Measured with `tools/webverify/layer-profile.mjs`, 1600×900, warm, after the `tiers` fix:

| `cam.k` | `paintScene` | of which layer registries | largest layer |
|---|---|---|---|
| 1 | 2.9 ms | 1.52 ms | |
| 2 | 2.7 ms | 2.35 ms | `caveEntrances` / `impassable` / `tiers` ≈ 0.5 ms each |
| 4 | 1.7 ms | 0.67 ms | `tiers` 0.75 ms |
| 5.5 | 1.6 ms | 0.51 ms | `plots` 0.43 ms |
| 8 | 1.6 ms | 0.47 ms | `labels` 0.43 ms |
| 16 | 1.9 ms | 0.59 ms | `tradeGoods` 0.13 ms |

**The whole scene paints in under 3 ms at every zoom, and no layer exceeds ~0.8 ms.** Canvas 2D is not
out of headroom. Any proposal to change the renderer for *speed* has to start by disproving this table.

Useful scale figure for reasoning about zoom: `band = log2(cam.k)`, and the Halcann crop is 2780×2047
source px fit into 1222×900, so **0.44 base px per plot**. Plots visible on a 1400×900 screen:

| band | `cam.k` | px/plot | plots on screen |
|---|---|---|---|
| 4 Terrain | 16 | 7.0 | 25,472 |
| 5 Locale | 32 | 14.1 | 6,400 |
| 6 Plot | 64 | 28.1 | 1,600 |
| 7 Settlement | 128 | 56.3 | 400 |
| 8 Building | 256 | 112.6 | 96 |
| 9 (cap) | 512 | 225.1 | 24 |

Per-plot detail is baked into **per-province offscreens** and blitted once per province, which is why
25k plots on screen costs 1.6 ms. That architectural trick is doing the heavy lifting — preserve it.

## Trap 1 — `draw()` → rAF is NOT a frame cost

`js/repaint.mjs` coalesces to one paint per animation frame behind a **30 fps cap**, re-queueing a frame
that comes due early. A tight `draw()` loop therefore iterates at ~60 Hz while paints land at ~30 Hz:
**half the awaits measure no paint at all**, and the wall reports rAF cadence (~16 ms) or the cap
(~33–50 ms) depending on where the loop lands.

Subtracting a layer sum from that wall produced a "residual" that read as **21–30 ms of mystery work at
some zooms and 0 ms at the same zoom minutes later**. Two hypotheses were chased and disproved —
`seaBase` (0.08–0.12 ms) and then the realm fog (0 ms in every variant,
`tools/webverify/fog-probe.mjs`) — before the metric itself turned out to be the bug. For the record: at
2× the rAF wall is 41.9 ms and the real paint is **2.7 ms**.

## Trap 2 — a 0 ms canvas draw is not proof of zero cost

Canvas 2D `fillRect`/`stroke` queue work and return, so per-call CPU timing captures **command
issuing**, not rasterisation. Stroking 113k inked pixels of tier boundary timed at **0 ms**.

This cuts both ways: it is why the `tiers` fix below worked (its cost was CPU-side `Path2D`
construction), and why you must corroborate with the whole-frame number before concluding a draw is
cheap. If you need to separate issuing from fill-rate, run the same zoom at a quarter of the pixels —
`layer-profile.mjs` takes a viewport argument for exactly that. Fill-rate scales with pixel count;
issuing does not.

## Trap 3 — warm-up contaminates everything

The same `cam.k` profiled at different points in a multi-zoom run gives layer sums of **0.4 ms or
2.5 ms**, because plot-grid fetches and province offscreen builds are still in flight (`drawPlots`
defers builds past a 6 ms budget and reschedules via `draw()`).

Settle on a **stable count of what is actually on screen** and hold it for several rounds. A global
"how many provinces have a canvas" tally converges while the visible set is still building.

## Trap 4 — is the benchmark camera looking at anything?

Assert a non-zero count of the thing being measured **on screen**, and fail the run otherwise. Parking
on a province's `provSrcBox` centre and then calling `clampPan()` can leave the viewport empty — a
province bbox can be huge and centred over water. That produced a confident *"0.21× SLOWER"* from a
single sprite sitting at global x = −2694.

## The metrics that are trustworthy

| Question | How |
|---|---|
| Whole-frame cost | The **diag chip's tooltip**. `main.paint()` times `paintScene()` synchronously and feeds `diag.noteFrame()`; parse `Render cost: X ms mean`. This is the only honest frame number. |
| Per-layer attribution | Wrap `layers.LAYERS` and `layers.SCREEN_LAYERS` entries' `draw` fns — `tools/webverify/layer-profile.mjs`. Measures CPU issuing (Trap 2). |
| Did a change alter the picture? | Draw both versions to offscreen canvases and **diff every pixel, against a control** — the same content drawn twice, establishing the renderer's noise floor. Without the control a 3-pixel diff reads as a real regression. `tools/webverify/tiers-probe.mjs` does this. |

## Fixes already made

### `tiers` — a missing viewport cull (26.3 ms → 0.03 ms)

The tier-boundary overlay was **85% of all layer cost at 5.5×** and 75% at 8×. Diagnosis
(`tools/webverify/tiers-probe.mjs`):

```
real layer draw:  cache MISS 13.7ms   cache HIT 0ms
tessellate:       all 12.6ms   culled 0.2ms
stroke:           all+shadow 0ms   all no-shadow 0ms
regions:          802 rings / 15862 pts — on screen: 30 rings / 1294 pts
```

Stroking was free. `shadowBlur` was free. All of it was building a `Path2D` over **every ring of the
whole world** on each camera change — 15,862 points to draw the 1,294 on screen. **`Path2D.lineTo`
costs ~0.8 µs a point**, so 16k points is a 12 ms frame by itself, while *projecting* the same points
costs ~0.2 ms. Path construction, not arithmetic and not rasterisation.

`tierPath` already cached per `S.viewVersion`, so a still camera never paid it — it was purely the cost
of panning and zooming, i.e. exactly when it is felt.

Fix: cull rings before adding them to the path, as `core.provOnScreen` has always done per province and
this layer alone never did. `js/tier-geom.mjs` (pure, zero-import, 7 tests) precomputes each ring's
**source-space** bbox once, so the per-frame cull projects two corners instead of every vertex —
O(rings), not O(points). Valid because `pxr`/`pyr` are affine and monotonically increasing; an
isometric shear on that projection would break the assumption, which the module notes.

Result: all layers at 5.5× went **30.89 ms → 0.45 ms**, and the diag chip from ~29 fps/34 ms to
~612 fps/4 ms. Verified pixel-identical at k = 2, 3, 5.5, 8, 9 against a 0-pixel control.

**The generalisable lesson: profile a layer for a missing cull or a cache that never hits before
concluding the renderer is the problem.** This one fix delivered more than the entire renderer
migration that found it.

### The void fill — off the render path entirely

`paintScene` used to open every frame with an opaque full-viewport `#070a10` `fillRect`. It is now
`.stage`'s CSS background (`styles.css`). A static backdrop has no business being repainted 30 times a
second, and as an opaque canvas fill it made anything composited *beneath* the map canvas invisible.

Safe because nothing depended on it: the only main-canvas blend mode is `sea.mjs`'s `soft-light`, which
composites against the opaque sea gradient laid down immediately before it; nothing reads pixels back
from `#map`; and `drawRealmFog`'s hatch is plain source-over alpha, identical over an equal-coloured CSS
background. (`.stage` was `#090d14` — a different dark, invisible all along because the fill covered it.)

## Known remaining costs, unexamined

Small in absolute terms, but they are what is left at the top of the table:

- `labels` — 0.43 ms at 8×, the largest layer there. A BitmapText/atlas approach was proposed and is
  **not** currently justified by these numbers.
- `caveEntrances`, `impassable`, `seaCells` — ~0.5 ms each at band 2. Worth a glance for the same
  missing-cull pattern `tiers` had, since none of them cull as carefully as `provPath` does.
