# 3D terrain — the target look, the spike that validated it, and the plan

**Status:** SPIKED 2026-07-25 (`tools/spike-iso3d/`, commit `27b27dc`), **PLANNED** P0–P5 (§The plan),
and **P0–P4b SHIPPED** 2026-07-25 — the 3D ground is live from band 5 up, PITCHES OVER to 34° by band 6.5 with
the whole 2D layer stack projected through the tilted camera, its foliage STANDS UP as ~12k billboards
that lie flat at the seam and rise with the tilt, and **relief is props**: PEAK plots carry Civ4's own
mountain models on nearly-flat ground, so the terracing is gone. Gated on a frame diff at the seam against
the 2D path (mean **4.74**/255 — P4b improved it from 5.12) plus a geometric check that the props land on the
2D bake's own rects, and a check that ground-anchored content stands on the terrain rather than on its
sea-level shadow. P5 (prop art at the oblique angle) remains.

## The target

`tools/samples/test2.png` — a Civ4/C2C screenshot. Read precisely, it is:

- **A heightmapped 3D terrain mesh under an oblique perspective camera.** Not a sheared flat plane: the
  central range shows real relief, snow on the tops, a volcano with a crater, and terrain occluding what
  is behind it.
- **Upright 3D props standing on that mesh** — forests, cottages/hamlets/villages, farms, mines, animals.
- **Civ4's terrain atlas with edge blending** on the surface: grassland into plains into desert into tundra.
- **Screen-space 2D plates anchored to world positions** — city bars (`34 San Marco (76) / Petting Zoo
  (2) +409%`), growth bars, lake labels.

So: **fixed-camera 3D**, not sprite-isometric. This is what closed the PixiJS effort — Pixi is a 2D
renderer and cannot produce it ([`pixi-migration-plan.md`](pixi-migration-plan.md)).

## The spike

`tools/spike-iso3d/` answers the one question that could not be reasoned about: does *eos's own* baked
terrain, on a mesh shaped by *eos's own* relief data, look like that?

- `extract.mjs` drives the real app headless and exports one province's `_tcanvas` (the fully baked
  province offscreen) plus its per-plot grid to `data/`.
- `iso3d.mjs` renders it in three.js — heightmapped mesh, real directional light, height model on live
  sliders. `index.html` is the page; `shot.mjs` captures the comparisons.
- Deps and extracted data are gitignored (regenerable); the four cited screenshots are committed.

Test case: **Ardumu**, LAND, 1084 plots, 45×45, PEAK 350 / HILL 332 / FLAT 402, 10 terrains, forest.

## It works — and `plotType` is the load-bearing height source

| shot | height model | result |
|---|---|---|
| `shot-civ-oblique` / `-low` | PEAK 3.4, HILL 1.0, elev ×6 | **Reads as terrain.** Legible ridges, valleys, light and shade. Closest thing to the target. |
| `shot-heightmap-only` | PEAK 0, HILL 0, elev ×**30** | **A warped carpet.** No legible landforms — despite a *larger* total height range (5.25 vs 4.45 plot-widths). |
| `shot-flat` | no relief | **A tilted painting.** The texture's rocky patches read as paint. This is what a 2D shear gets you. |

The elevation result is the important one. Ardumu spans **99–145 of 255**: the imported heightmap is
continental and **low-frequency**, so exaggerating it only inflates a smooth swell. The eye reads terrain
from the **discrete per-plot FLAT/HILL/PEAK variation** — which is how Civ4 gets its mountains too. This
corroborates from the other direction the comment that removed the 2D hillshade (`plots.mjs:330-333`):
elevation alone was never going to carry relief here.

`shot-flat` also settles the 3D-vs-2.5D-sprite fork **visually rather than by argument**: sprite relief
misses this target.

> **CORRECTED 2026-07-25, after reading the target closely (§Relief is props, not displacement).** The
> conclusion above is right about the DATA and wrong about the CONSEQUENCE. `plotType` is indeed the
> load-bearing signal and the imported heightmap is indeed too smooth to carry relief — but the target does not
> solve that by displacing the mesh either. It keeps the ground nearly flat and stands a mountain MODEL on each
> peak tile. So `plotType` is load-bearing as *prop placement*, not as *vertex displacement*, and the spike's
> question ("how much do I displace a peak?") had no good answer because it was the wrong question. P4b fixes
> this; the terracing that P2 and P3 could only mitigate is a direct consequence of the misreading.

## Confirmed, with numbers

- **The baked province canvas works as a mesh diffuse texture, unmodified.** So all of
  `buildPlotTexCanvas`'s edge/corner blending, noise masks, snow, coast shallows and rivers arrive
  intact. This is the single biggest reuse in the whole direction, and it is now proven rather than
  assumed — the ~150 most intricate lines in the frontend need no changes.
- **1084 quads / 2168 triangles** for a 1084-plot province. The Ground regime shows 1,600 plots falling
  to 24 (see [`frontend-performance.md`](frontend-performance.md) for the table), so the mesh is
  trivially small. **Performance is not a discriminator here** — for either 3D or 2.5D.
- **Corner-averaged vertex heights avoid the checkerboard.** Vertices sit on plot *corners* and take the
  mean of the up-to-4 plots touching them, which interpolates instead of stamping a square per plot —
  precisely the failure that killed the 2D hillshade. One smoothing pass suffices.
- Tuning that looked right: **PEAK ≈ 3.4, HILL ≈ 1.0 plot-widths, elevation ×6, 1 smoothing pass.**

## What the spike exposed as required work

**Upright content must come out of the baked canvas.** `plots.mjs:360-362` draws `featureSprite` into the
province offscreen, so on a lit slope the foliage reads as top-down symbols lying on the ground where the
target has upright 3D. Same for the Civ6 feature/improvement overlays. Ground stays in the sheared/meshed
texture; anything that stands up becomes separate, world-positioned billboards.

This is **the largest single piece of work** in any version of this direction, and it is surgery on the
densest code in the frontend — multi-pass compositing where render *order* is load-bearing (`plots.mjs:350-353`
is explicit that foliage must sit over rivers, via province-level passes rather than per-plot).

Not a real problem, but do not mistake it for one later: the **stepped silhouette** in the shots is an
artifact of rendering one province in isolation. Neighbours would fill it.

## What makes this additive rather than a rewrite

Three properties of the existing frontend, all verified against the code:

**The whole camera is two functions.** `core.mjs:47-48`:

```js
const pxr = sp => cam.x + cam.k * baseXr(sp);
const pyr = sp => cam.y + cam.k * baseYr(sp);
```

Every layer, label, icon, highlight and hit-test in ~13.5k lines goes through them. Make them *project
a source-pixel through the 3D camera at ground height* and the point-anchored half of the 2D overlay
follows the tilt for free. [`pixi-migration-plan.md`](pixi-migration-plan.md) found the same property
from the other side ("the camera reduces to one matrix") and filed it as a Pixi fact; it is the
frontend's own.

**The compositing order inverts, and that is what unblocks it.** Pixi died because `#gl` sat *beneath*
`#map` behind a wall of opaque full-area fills, forcing strictly back-to-front migration — and `plots`
was entry 3 in `layers.LAYERS`, so it could only ever be a flagged spike. A 3D renderer takes the
**entire back of the frame wholesale** (`raster` + `plots` + `seaBase`), which is one cut at a natural
seam, not an incremental migration. The constraint that closed Pixi does not apply.

**Plot coords are source pixels.** `q.x`/`q.y` feed `pxr`/`pyr` directly
(`plotcanvas.blitProvinceCanvas`), so one plot = one source px and the spike's tuning is already in
world units — no conversion.

## The plan

**Decided 2026-07-25.** Two calls shape everything below:

- **3D engages at band 5 (LOCALE, 32×) and deeper only.** Bands 0–4 (Atlas + Overland) keep the
  canvas-2D path unchanged, pixel-for-pixel. Tilt is 0° at band 5 and ramps to ~32° by band 6.5, so the
  Overland→Ground regime seam (`band-math.regimeAt`, b=6) *is* the tilt. Nothing below band 5 can regress.
- **Ground-draped vector layers bake into the province texture**, following the pattern rivers and
  coast already prove (`buildPlotTexCanvas` stage 4). Per-frame draped content (hover, selection) is the
  exception and stays projected.

Also load-bearing: `_tcanvas` builds from band 4 (`atLeast(BAND.TERRAIN)`), a full band *below* where
the mesh turns on, so every visible province already has its texture — no new build machinery. And
`plotType`/`elevation` already ride the per-plot JSON, so **P0–P1 need no engine, server or bundle
change**.

### P0 — the projection seam (no three.js) — SHIPPED

`pxr`/`pyr` become calls into a swappable projector; the affine one stays the default. Add
`unproject(sx, sy)` — the inverse exists today only hand-rolled inside `hittest.plotAt` and
`core.latAtScreenY`.

Acceptance: **pixel-identical** frames via `tools/webverify` at k = 1, 8, 20, 40, 120. Ships and reverts
alone, and is worth having regardless of what renderer follows.

### P1 — the ground mesh at tilt 0 — SHIPPED

Built as `js/terrain3d.mjs` (the renderer), `js/heightfield.mjs` + tests (the pure height model), and
`tools/webverify/terrain3d-verify.mjs` (the gate). **Results: mean delta 0.71/255 at z=120 and 3.60 at
z=40, p99 9 and 29, 99.6%/95.9% of pixels within 16.** Below band 5 the check asserts something stronger
than a diff — `ground3D()` false, `#gl` hidden, `#map` fully opaque, and **zero network requests for
three** — so "bands 0–4 are untouched" is verified rather than asserted.

The design as built, and the six things that were not obvious going in:

- **`drawPlots` still runs; only its BLITS are skipped.** It was tempting to have the renderer own plot
  loading and texture building, and it would have duplicated the viewport cull, the lazy `loadPlots`, the
  6 ms/frame build budget and `MAX_TEX_PLOTS`. Instead `drawPlots` keeps all of it and terrain3d reads
  `p._tcanvas`/`_tbox` off what that pass maintains. The 3D path added no fetching or scheduling code.
- **Three loads lazily, and that answers the bundle objection.** 751 KB / 188 KB gz behind a dynamic
  `import()` fired the first time the camera crosses band 5, so the cost falls only on sessions that
  actually zoom in. The verifier asserts zero `three.*.js` requests at band 3.
- **The sea lost nothing.** The worry was `drawSeaBase`'s ripple, which a plane can't reproduce without a
  shader — but the ripple already fades out by `K_TEX` (band 4), one band *below* where 3D starts. At
  every zoom the 3D ground is active, the 2D sea is the bare latitude gradient, which the sea plane bakes
  in map space at 512 rows against the 2D path's 17 gradient stops.
- **"Flat lighting" must mean UNLIT, not a white ambient light.** Two rounds were lost here. Leaving the
  ambient at its scene colour (a blue-grey `0x8fa8c8`) multiplies the texture down and tints it; even a
  pure-white ambient at intensity 1 leaves a uniform factor from three's physically-correct light units and
  Lambert's 1/π. Both render as "the 3D ground is too dark" and diff as a large near-uniform delta — a
  lighting artifact wearing the costume of a projection bug. `MeshBasicMaterial` takes the lighting model
  out of the comparison entirely, which is the only version of the gate that measures what it claims to.
- **The sun needed a GAIN the spike could not supply, and it is not linear.** The spike judged its
  intensities on one province in a dark void, where "too dim?" has no reference; here the terrain must sit
  at the same brightness as the texture the 2D path blits or crossing band 5 reads as the sun going down.
  Measured, the spike's values render the ground at **0.66** of its texture. The trap: lighting is computed
  in linear space and converted to sRGB on output, so a gain of *g* moves measured brightness by
  **g^(1/2.2)**, not by *g* — a first attempt at `1/0.66 = 1.52` duly landed at 0.80. The correction is
  `GAIN /= ratio^2.2`, giving 2.5, which measures 1.017. The verifier prints the ratio so this is
  recalibrated by arithmetic rather than by eye.
- **Water plots index at height 0.** SEA/LAKE shelf plots carry `elevation` that means DEPTH. They must
  still be indexed rather than skipped, because a coastal land corner averages them — that is what makes
  the shore ramp down to sea level instead of ending in a cliff the height of the continental heightmap
  (~2.4 plot-widths at a typical coast).

And one honest limitation: **at tilt 0 the relief can only read as gentle shading.** Viewed from straight
down, a Lambert surface's brightness depends solely on its normal, so the geometry is present and correct
but understated — the spike's dramatic landforms came from the OBLIQUE camera. P1 buys the correctness;
P2 is where it becomes the look.

#### The original P1 plan, for reference

Vendor `three.module.min.js` **and** `three.core.min.js` (0.185.1) — the module imports the core, which
is not obvious and cost the spike a debugging round. A `<canvas id="gl">` beneath `#map`; from band 5
`drawRaster`, `drawSurfacePlots` and `drawSeaBase` suppress, leaving `#map` transparent there so the
mesh shows through.

- **A global corner-height store** keyed on `(x, y)` source pixel, written by each province as its plots
  load and read by every mesh. Corner height = mean of the up-to-4 plots touching it, then one smoothing
  pass. Heights straight from the spike: **PEAK 3.4, HILL 1.0, elevation ×6, 1 smoothing pass.**

  **Derived in the client, deliberately NOT baked into the bundle.** A corner height is a mean over
  `plotType` + `elevation`, both already in the per-plot JSON, so baking it ships millions of derived
  floats to restate bytes the client has — and it would freeze the height model behind a `MAP_VERSION`
  bump, a ~24-minute CI rebake and a plot-cache clear, when the tuning above is a guess from one province
  that P1 exists to iterate on. Keying the store **globally** rather than per-province is what solves the
  seam instead: a boundary corner takes contributions from whichever provinces have loaded and the mesh
  rebuilds when the neighbour lands — transiently wrong at an off-screen edge, self-healing, exactly how
  the plot layer already builds under its 6 ms/frame budget.

  What would reverse this: height ceasing to be **cosmetic**. The moment it feeds the sim (movement cost,
  line of sight, building placement) or stops being a pure function of per-plot fields (carved valleys,
  hydrology-consistent terrain, the engine z-levels in [`zoom-bands.md`](zoom-bands.md)), it is world data
  and must come from the bundle so the engine and client cannot disagree. A smoothing kernel wider than
  one local pass is the same argument — a wide kernel is genuinely global and does not converge cleanly
  from progressive loads.
- **One `BufferGeometry` per province**, one quad per plot that exists (so the mesh carries the real
  silhouette, holes and all), **rebuilt when a *neighbouring* province's plots land** — otherwise every
  province edge is a cliff. This is the hazard the spike punted on as a rendering-in-isolation artifact:
  neighbours only fill the step if they *share corner heights*, and plot grids arrive per-province
  asynchronously via `loadPlots`.
- **`CanvasTexture` on the existing `p._tcanvas`**, WeakMap-keyed on the canvas object so invalidation is
  free (every rebuild allocates a fresh canvas, so the existing `p._tcanvas = null` hooks suffice). UVs
  must account for `buildPlotTexCanvas`'s `PAD = 2` cells of transparent margin. A province over
  `MAX_TEX_PLOTS` (20 000) never builds a `_tcanvas` at all — it falls back to `_pcanvas` with
  `NearestFilter`.
- **Sea provinces get flat meshes at y = 0** with their own `_tcanvas` (`buildPlotTexCanvas` already
  handles water), plus a horizon plane. `sea.drawSeaBase` is the one layer above the cut that cannot be
  projected — it fills the viewport from the latitude at each screen row and is not geometry at all — so
  it has to move here.
- **Orthographic camera** reproducing `baseXr`/`baseYr` exactly, plus the spike's light (directional
  `0xfff3e0` @2.1, az 315°, alt 38°; ambient `0x8fa8c8` @0.55).

Acceptance, in this order: (1) with lighting flat (ambient 1.0, sun off) the frame diffs
**near-identical** to today's 2D at k = 40 and k = 120 — this is the real gate, because at tilt 0 the
mesh is the same picture; (2) then the sun goes on and the comparison is `shot-civ-oblique.png`.
**Test for pixels, not placement**: Pixi rendered a perfect frame that was 100% occluded and the
placement assertion passed.

...and the trap that caught the verifier itself, which is worth more than the plan above. A WebGL canvas
created with the default `preserveDrawingBuffer: false` has its drawing buffer **discarded once the browser
composites the frame**, so reading it from a later task — a separate `page.evaluate`, i.e. a separate turn
of the event loop — yields an empty buffer. The first run reported a mean delta of 108 against a blank 3D
frame: the renderer was fine and the measurement was lying. Render and read in the same synchronous block.
The Pixi effort's lesson was "test for pixels, not placement"; the sequel is **make sure the pixels you
test are the ones that were drawn.**

### P2 — the tilt — SHIPPED

`band-math.tiltAt` pitches the camera 0° → 34° over bands 5 → 6.5 (smoothstep, so both ends ease), and the
ground projection is handed to the 2D layers through P0's seam. Verified: tilt 34° at band 6.9, projector
installed and non-separable, the focus holding the viewport centre to **[0, 0] px**, horizontal magnification
**52.76 px/plot against the 2D camera's 52.76** — so crossing the seam neither pans nor zooms the world — and
the seam frame diff still passing (mean 5.12/255).

Four things that decided the design, none of which were in the plan:

- **The ground projection is a HOMOGRAPHY, and that is what makes the tilt affordable.** A perspective
  camera's projection of one PLANE is a 3×3 projective transform, and nearly everything the 2D layers project
  — rings, plot boxes, bboxes, label anchors, icons — lives on the ground. So the tilt costs them six
  multiplies and a divide, not a 4×4 and a `Vector3`. It has to: `provOnScreen` runs ~50k times a frame and
  must now project FOUR corners, because a tilted camera maps a rectangle to a trapezoid that two corners no
  longer bound. 200k matrix transforms a frame is not affordable; 200k homography applications are. It also
  keeps screen→ground a closed-form 3×3 inverse instead of a raycast.
- **ONE camera at every tilt, including zero — and the LENS LENGTHENS AS IT FLATTENS.** A perspective camera
  looking straight down projects the ground plane as a pure uniform scale, indistinguishable from an
  orthographic one, so no ortho→perspective blend is needed (there is no continuous family between them).
  But geometry ABOVE the ground gets parallax of r/(r−h), and r falls out of the scale requirement: at band 5,
  r ≈ 164 source px against 6.4 px of terrain is 4% magnification on peaks — tens of pixels near the frame
  edge. **The P1 frame diff caught exactly this**, going from mean 0.7 to 24.8 the moment the camera became
  perspective. Tying FOV to the tilt fixes it at the root: 1° at tilt 0 (r ≈ 3.7k px, parallax under 0.2% —
  which *is* P1's orthographic camera, to a fifth of a pixel) opening to 22° at full tilt. Both ends are what
  they must be and the middle is continuous. Mean went back to 5.12.
- **Relief must be exaggerated LESS as you zoom in** (`band-math.heightScaleAt`). Terrain height is fixed in
  world units, so a peak's screen height grows with zoom exactly as a plot's width does and the ratio is
  constant — which sounds like it should look right everywhere, and does not. The spike tuned PEAK = 3.4
  plot-widths while looking at a whole 45×45 province, where it reads as a mountain range; four bands deeper
  the viewport holds ~23 plots and the same ratio puts a 180-pixel cliff across a 52-pixel plot. The eye
  judges relief against the FRAME, not against a plot. Halving every two bands keeps landforms growing on
  approach at about half the rate, and it is applied as a per-mesh Y scale — one transform per province per
  frame, no rebuild.
- **`plotAt` had to become a raycast.** The ground-plane inverse is wrong by tan(tilt) × height — about 2.3
  plots downhill on a PEAK at 34° — so hovering a mountain would name a cell two away. `terrain3d.pickGround`
  raycasts the meshes; the box interpolation survives underneath for the untilted path.

Gated OUT of 3D, both for the same underlying reason — the plot layer never builds a texture there, so the
mesh would have nothing to drape: the **underworld** (its plots come through `drawPlots(isUnderground)` and
terrain3d builds no z=−1 meshes) and **political overlays** (the layer is gated `notPolitical`, and an opaque
ownership wash has no relief to show anyway).

**The honest remaining flaw:** the terrain reads as *terraced plates* at deep zoom. A PEAK plot beside a FLAT
one is a genuine one-plot cliff, and a single smoothing pass over corner heights cannot round it. The
exaggeration curve makes it far better than it was but does not dissolve it; a wider smoothing kernel would,
at the cost of the order-independence that lets corners be derived on demand (see the height-field note
above). Worth revisiting with P3's props in place, since upright content on the slopes will change how much
the stepping actually reads.

#### The original P2 plan, for reference

`tiltAt(band)` lands in `band-math.mjs` (pure and unit-tested, like everything else there): 0° at band
5 → ~32° at band 6.5. The projector swaps to the camera matrix, and the point-anchored half of `LAYERS`
follows for free — labels, bonus and trade-good icons, city plates, districts, live caravans, cave
entrances, realm arrows, `S.markers`.

- `hittest.plotAt` becomes a `Raycaster` against the meshes; `provinceAt` stays polygon-based over
  projected rings.
- Province borders and the lake / sea-cell / impassable / political fills move **into**
  `buildPlotTexCanvas` as a new stage (after rivers, before features), so they drape over relief for
  free and cost nothing per frame. `drawHoverHighlight`/`drawSelectedHighlight` change per frame and
  stay projected — accept their edges cutting relief, or promote them to 3D lines later.
- Horizon: fog + far plane. At tilt 0 `clampPan` guarantees the map fills the viewport; an oblique
  perspective camera sees past its edge.

All the regression risk lives in this phase.

### P3 — upright props — SHIPPED

Foliage placement moved out of `plots.mjs` into a pure `js/foliage.mjs` that BOTH renderers ask, and the 3D
path turns each answer into a quad standing on the mesh. **~12k props over 124 atlas groups**, from six Civ4
atlases (leafy, palm, swamp, bamboo, cactus, city).

- **The billboard pitches with the camera, and that is why one code path is enough.** Civ4-style foliage is
  world-vertical and rotates about Y to face the camera — but this camera goes fully overhead at band 5, where
  a world-vertical quad is edge-on and invisible. Instead the quad's plane stays perpendicular to the view
  axis: at tilt 0 it lies flat and covers exactly the screen rect the 2D bake drew, and by full tilt it has
  risen to stand. No second bake, no cross-fade. It pivots about its BASE so a tree stays planted rather than
  sinking half of itself into the hillside.
- **`featureOverlays` turned out to cover only OASIS and SWAMP.** The plan assumed the flat Civ6 overlays were
  the common case for forest and jungle and would all have to be replaced; in fact forests were already
  scattered Civ4 billboards, so P3 was a change of *geometry* rather than of art for nearly everything.
- **The placement is shared, not reimplemented, and that is the whole point of the extraction.** If the 3D path
  invented its own scatter, crossing band 5 would rearrange every forest on the map. `foliage.mjs` is
  deterministic per plot, and the ORDER of its random draws is copied verbatim — the sequence *is* the
  placement, so reordering two lines there moves every tree in the world. The tests assert exactly this.
- **The 2D bake now skips foliage when the props own it**, recorded per province as `_tfoliage` and invalidated
  lazily by `drawPlots` when the mode flips, so crossing band 5 costs one texture rebuild per province spread
  over the existing 6 ms budget — and nothing after that.

**How it is verified, and why the frame diff alone could not do it.** Props change foliage from a stamp baked
at 32px-per-plot and then minified with the whole canvas into a quad sampled once at screen scale, so a few
percent of pixels differ *by construction*: the seam diff went 5.12 → 9.32 on that alone. Loosening the
threshold would have hidden real faults, so instead `?props=0` puts the trees back in the texture and the frame
diff compares GROUNDS (back to exactly 5.12, i.e. P3 left the ground untouched), while the props are checked as
GEOMETRY — every quad's corners against the rect its plot fraction implies. Worst error **1.2e-4 source px over
11,982 quads**, which is the Float32Array precision floor at map coordinates, i.e. as exact as the storage
allows.

An attempt to fix the pixel difference with a firm `alphaTest` made it slightly worse and is worth recording:
at band 5 a tree is ~8px drawn from a ~60px sprite, so its antialiased edge is a wide fringe that *is* most of
the tree, and cutting it hard shrinks every tree in the world. The material blends, with only a token
alphaTest to drop the invisible tail; `depthWrite` stays on so trees still occlude against terrain and each
other.

#### The original P3 plan, for reference


The largest single piece, and surgery on the densest code in the frontend. `plots.mjs:346-353` draws
`featureSprite`/`improvementSprite` into the province offscreen, so on a lit slope the foliage reads as
top-down symbols lying on the ground — visible in `shot-civ-oblique.png`.

Emit per-plot prop instances instead, drawn as an `InstancedMesh` of billboards **whose pitch follows
the camera tilt**: at tilt 0 they lie flat and look exactly like today, so there is one code path and no
second bake. Reuse `mkRng`/`treeGroupFor`/`stampTrees` placement verbatim so nothing moves. The ground
keeps base terrain, edge/corner blends, snow, coast, rivers and urban; it loses foliage and the Civ6
feature/improvement overlays.

The ordering constraint at `plots.mjs:339` — foliage must sit over rivers, via province-level passes
rather than per-plot — is satisfied by construction once the props stand above the surface.

### P4 — standing on the terrain — SHIPPED

Billed as "interactions and polish"; it turned out to contain a **real bug left by P2** and one design change
that supersedes a decision made in the plan.

- **`provPath` was still on `pxr`/`pyr`.** Every province polygon in the scene — borders, the lake / sea-cell /
  impassable washes, the political fills, the hover and selected highlights — was therefore drawn through the
  separable fast path, which lies once the camera tilts. It survived P2 because the P2 gate measured the ground
  and the tilted checks measured the camera; nothing looked at the polygons.
- **A second seam, the vertical counterpart of the projector.** `project()` takes a height because the caller
  knows it, and almost no caller does: a resource icon, a city marker, a district, a route sprite, a ring vertex
  all just want to sit on the ground wherever the ground is. So `core.projectOn`/`pllOn` ask an installed
  height lookup (`setGroundHeight`, filled by terrain3d exactly as `setProjector` is), and under the 2D camera
  the lookup is skipped entirely — bands 0–4 pay nothing.
- **This measurably mattered:** standing on the terrain moves an on-screen PEAK plot's content by up to **66 px**
  versus its sea-level projection, at a zoom where a whole plot is 52.8 px. Everything ground-anchored was more
  than a plot out of place on high ground.
- **It also supersedes the plan's bake decision.** §The plan chose to bake province borders and fills into each
  province's texture so they would drape over relief. Projecting each ring vertex at ITS OWN terrain height
  drapes them just as well, keeps ONE copy of the geometry, needs no texture invalidation, and works for the
  per-frame layers — hover, selection — that a bake could never have covered. Only the straight segment between
  two ring vertices can still cut a hill, and these outlines are dense enough that it rarely reads.
- **A robustness fix worth naming:** the tilted projector guarded against geometry behind the camera with
  `W <= 1e-9`, but a point barely IN FRONT of the camera has a tiny positive `W` and divides into coordinates in
  the billions. Off the top of a tilted viewport that is a perfectly ordinary place for a ring vertex to be, and
  a `Path2D` carrying 1e9 coordinates is at best slow. The floor is now a quarter of the near plane.

#### The original P4 plan, for reference


`maptip`/`plotlabel` hover, the city screen, districts anchored to real mesh height, the minimap, and a
no-WebGL fallback — which is cheap, because 3D only engages at band 5, so the 2D path below it *is* the
fallback (clamp the zoom).

## Relief is props, not displacement — what the target actually does

**Read 2026-07-25 from `tools/samples/test2.png`, magnified.** This is the most consequential thing in the whole
document and it took four phases to notice, because it only shows up when you look at what the tile borders do.

**The tile-border lines and the roads run flat, between and around the mountain cones, at base level.** They do
not climb over anything. Each peak is a discrete repeated cone model — snow cap, dark shadowed base, a contact
shadow on the ground — sitting on one tile. The volcano is the same machinery with a different model.

So Civ4's terrain surface is essentially **smooth**, carrying only gentle continental elevation, and
"mountainous" means *a mountain object standing on a nearly flat tile*.

Three things follow, and they matter more than any tuning done so far:

1. **The terracing is architectural, not a tuning problem.** Displacing the mesh by PEAK = 3.4 plot-widths makes
   a peak beside a flat plot a cliff by construction. No smoothing kernel and no exaggeration curve removes a
   cliff the model puts there; the target simply never creates it.
2. **It reverses the spike's headline** — see the correction under §It works. `plotType` is load-bearing as prop
   placement, not as vertex displacement.
3. **Much of P4's terrain-height seam becomes belt-and-braces.** On a near-flat surface, ground-anchored content
   barely moves. It is still correct and still needed for the gentle relief that remains — but the 66 px it was
   correcting was mostly relief that should not have been there.

What is NOT the gap: the camera. Measured tile aspect in the target is ≈0.89, i.e. **~27° from vertical** (rough
— two regions gave inconsistent tile sizes, so read it as 25–35°) against our 34°. And the target's ZOOM is about
a band shallower than where the gates have been comparing: tiles are ~45–77 px in a 2241 px frame, so **~30–50
tiles across** versus 26 plots at z=120, which puts the reference view near band 5.9–6.3 where `tiltAt` gives
22–28°. The angle is already in the right neighbourhood and should not be touched until relief is fixed, because
relief is what the angle reads against.

### P4b — relief becomes props — SHIPPED 2026-07-25

- **Peaks and hills stopped being cliffs.** `heightfield.HEIGHT` dropped PEAK 3.4 → **0.8** plot-widths and HILL
  1.0 → **0.4**, so mountainous ground is a gentle rise rather than a wall, and the continental heightmap (×6)
  does what it is actually shaped for. The terracing is gone. It also made the *seam diff better*, from mean
  5.12 to 4.74 — worth noting, because it means the old relief was not only wrong-looking, it was actively
  disagreeing with the 2D ground it was supposed to match.
- **PEAK plots get a mountain prop** — the real Civ4 model, baked by `tools/fpk/bake-peaks.mjs` — standing on
  the mesh through exactly the P3 billboard machinery. `foliage.placeRelief` returns the identical record shape
  `placeFoliage` does, so `propGeometry` takes both with no branch, and the props inherit the placement
  guarantee and the geometric gate for free (now 11,982 quads, exact to 1.2e-4 source px).
- **Every prop gets a contact shadow**: a flat, ground-plane, blended quad under it, its four corners each
  taking their own `groundAt` so it lies on a slope rather than through it.

**Relief props live in the 3D ground only, and fade in with the tilt** — the one design decision P4b added
rather than inherited, and it went the other way first. The obvious move is to stamp the mountain into the
province canvas too, exactly as P3 does for trees, so the two renderers agree at the seam. Tried, measured,
reverted, for two independent reasons:

1. **It is the wrong drawing.** `tools/nifbake` renders a FRONT elevation. A tree from overhead is roughly a
   blob either way, which is why P3 gets away with it; a mountain's front elevation laid flat on a top-down
   map is not a mountain seen from above. Bands 0–4 have never had mountain sprites, and adding them there is
   a change to the 2D map, not to the 3D one.
2. **It measurably widens the seam.** Stamped in 2D, the tilt-0 frame has to reproduce a 280 px sprite at ~22
   screen px through GPU mipmapping against canvas 2D's two-step downscale — 13× minification on a
   high-contrast rock texture, covering a whole plot each rather than a tree's few pixels. Measured: 93.7% →
   82.6% within 16, against a 90% gate. Rebaking the atlas at 96 px instead of 320 recovered only half of it
   (86.0%), which is what identified minification as the mechanism rather than a placement bug.

So `terrain3d.RELIEF_FADE_DEG` ramps both the mountains and the shadows from nothing at tilt 0 to full by 10°
(≈ band 5.44). This is not a cross-fade of two representations — below the ramp there is simply no prop, which
is the state the 2D ground has always been in. It also happens to be right: a standing mountain means something
once the camera is oblique, and the target screenshot is an oblique view.

**One art finding, recorded because it looks like an option and is not.** `peak_hill{a,b,c}.nif` is the SAME
MESH as `peak_mountain{a,b,c}` — byte-identical vertices, verified by hashing them. They differ only in the skin
they name (`Hill.dds` vs `Mountain.dds`, both in the `features/hills/` directory the FPK also yields, which are
the game's per-base-terrain hill tints). So there is no hill *model* to place, and nothing places one: HILL
stays vertex displacement. That is also what Civ4 does — its actual hill art, `features/hills/hills_grass*.nif`,
is a near-horizontal ground patch that the billboard renderer's flat-plane filter drops. Relief, not a prop.
`peak_single*.nif` IS a distinct mesh (101 verts, a lone cone), but its skin `peak_single.dds` is an unwrapped
sheet with violet-blue snow that reads wrong outside the game's own lighting — decoded faithfully, simply not
usable here. The bake is therefore `peak_all.dds` over `peak_mountain{a,b,c}` and nothing else.

**Where the art comes from — and a false start worth recording.** C2C's `UnpackedArt/art/Terrain` has no `Peaks`
or `Hills` directory; it holds only what C2C itself ships unpacked (`features`, `heightmap`, `improvements`,
`natural_wonders`, `plottextures`, `resources`, `routes`, `sky`, `textures`, `water`, `waves`). A first attempt
therefore GENERATED a mountain sprite from canvas primitives, on the reasoning that the real model was
unreachable. It was reverted: inventing terrain art is the wrong answer in a project whose whole terrain
pipeline is a faithful port (see the note on porting the C2C generator), and the generated cones looked exactly
like what they were.

The real art was reachable after all — it is packed rather than absent. `tools/fpk/unpack.mjs` reads the
game's own FPK archives, and `Assets/Art0.FPK` yields:

| file | what |
|---|---|
| `art/terrain/features/peak/peak_mountain{a,b,c}.nif` | the mountain models, three variants |
| `art/terrain/features/peak/peak_hill{a,b,c}.nif` | hill models |
| `art/terrain/features/peak/peak_single{,a,b,c}.nif` | the lone-peak variants |
| `art/terrain/features/peak/peak_all.dds`, `peak_single.dds`, `mountaincraggy01.dds` | their textures |
| `art/terrain/textures/peakdetail.dds` | the peak ground detail texture |

P4b's work was therefore a bake rather than an invention — but the bake was blocked on a NIF version, and
unblocking it took **three separate version guards**, each of which desynchronised the block walk in a way that
only showed up hundreds of bytes later. `tools/nifbake/nif.mjs` read **Gamebryo 20.0.0.4**, the version C2C's
own models use (which is why the cactus and city sprites always baked). The base-game peaks are **NetImmerse
10.0.1.0**, and it differs in three places:

| where | 10.0.1.0 | how it presented |
|---|---|---|
| header | no endian byte, no user version | failure at offset 1,685,016,229 — an ASCII run read as a length |
| **block stream** | every block is prefixed by a u32 object index (versions `[10.0.1.0, 10.2.0.0)`) | 8 unexplained bytes before the first block's name |
| `NiGeometry` | no material-name arrays — `Has Shader` follows the skin ref directly | a phantom material count landing on the next block's string length |
| `NiTriShapeData` | no `Has Triangles` flag (it arrived at 10.1.0.0) | the whole index array shifted by one byte, footer one past EOF |

Localising them meant hand-decoding the bytes and checking each field against what it *should* be — a
`NiMaterialProperty` whose diffuse reads (1,1,1) and glossiness 10.0 is aligned; one whose ambient is garbage is
not. Correctness is confirmed by landing exactly on the footer, which is what makes the whole exercise safe:
a wrong guess fails loudly instead of producing plausible-looking geometry.

The fixes generalise. All 16 peak/hill models now parse, and across the cached C2C art corpus **7 of 8
Gamebryo 10.1.0.0 files that previously failed now parse to EOF** (they were being carried by the gap-resync
heuristic); all 35 20.0.0.4 files are byte-identical to before. Three 4.2.2.0 files remain unsupported.

The textures alongside the models are not a substitute: `peak_all.dds` is a UV-mapped model SKIN — a rock-and-snow
sheet with a soft alpha edge — not a billboard atlas of mountain cutouts, so the connected-component extractor
that handles `trees_1024.dds` has nothing to cut out of it. Verified by decoding it.

**The bigger find behind it:** `C2C{0..3}.FPK` + `C2CPatch0.FPK` hold ~900 MB of C2C's OWN art, packed. Most of
C2C's art was never in `UnpackedArt` either, which matters well beyond terrain — the building and unit models P5
wants are in there.

**One constraint this creates.** Extracted art is gitignored (`/.civ4-fpk/`): it is the publisher's, it is large,
and it is one command to reproduce from a local install. But CI has no game install, so anything baked from it
must have its OUTPUT committed — which is already how the tree and flag atlases work, so the pattern exists; it
just has to be a deliberate choice rather than an accident.

### P5 — prop art at the oblique angle

Buildings and units. Where the C2C asset question lands: pre-rendering from NIF in Blender sidesteps the
`.kf`/`.kfm` animation-import risk entirely, and the ~700 Firaxis-origin models of ~6,086 need a
decision. See [`civ4-files.md`](civ4-files.md).

## Retiring the 2D path — when, and how much of it

The question comes up naturally once 3D owns the deep zooms: at what point does the canvas-2D renderer go? The
useful answer is that **"2D" is four different things with four different answers**, and only two of them are
really duplication:

| what | when it can go |
|---|---|
| **The screen-space overlay** — labels, icons, city plates, hover, minimap, all ~13.5k lines of it | **Never.** It is the right technology for screen-space UI, and the city bars in the target screenshot *are* this. |
| **The 2D ground below band 5** | Costs almost nothing to keep: one `drawImage`, a gradient, and a `drawPlots` pass the 3D path needs anyway to build the textures it drapes. Also the no-WebGL fallback, for free. |
| **Political overlays and the underworld** | The real duplication — both are gated out of 3D today. Worth unifying, and a far smaller and better-aimed job than "remove 2D". |
| **The foliage double path** (bake vs props, P3) | Soonest of the four: it is the only place where the same content has two renderers that have to agree. |

Three reasons to hold off on the ground path specifically:

1. **It is the measuring instrument.** Every phase here was gated by diffing against it — P1 at mean 0.71, P2
   catching the perspective-parallax regression the moment it appeared (0.7 → 24.8), P3 confirming the ground
   was untouched at exactly 5.12. Delete it and the next phase has nothing to verify against.
2. **It is the WebGL fallback at no cost.** Removing it means a visitor without WebGL sees nothing instead of a
   working map. That is a product decision, not a cleanup.
3. **The right trigger is a feature 2D BLOCKS, not "3D is good enough now."** P3 is the model: content baked
   into a texture physically cannot stand up, so foliage had to move. Every future thing that hits that wall is
   a reason. Tidiness is not one.

A plausible sequence, then: finish P4 and P5 → bring political and the underworld into 3D so `ground3D()`
collapses to "band ≥ 5 and WebGL exists" → consider dropping the threshold toward band 0, at which point the
2D ground is dead except as fallback and can be weighed on its own merits.

### What it costs, and what does not change

`three.module.min.js` + `three.core.min.js` = **751 KB raw / ~180 KB gzipped**, committed into a
dependency-free `web/` that auto-deploys to prod on every push. Pixi's 780 KB was cited as a reason to
revert it — but that was 780 KB for a URL-flagged experiment; the same weight for the shipping renderer
is a different trade, and it is made here deliberately rather than discovered later.

**Unchanged:** the server, `/api/bundle`, the bake pipeline, bands 0–4, and all ~13.5k lines of DOM UI.
The city plates in the target are already how `labels.mjs`/`city.mjs`/`districts.mjs` work — screen-space
content anchored to world positions.

The **native** alternative (Godot/Unity) forks the client and is not planned; see the discussion recorded
in [`pixi-migration-plan.md`](pixi-migration-plan.md).

## How to re-run the spike

```sh
cd tools/spike-iso3d
npm install                                   # three + playwright-core
cp node_modules/three/build/three.module.js node_modules/three/build/three.core.js vendor/
cp node_modules/three/examples/jsm/controls/OrbitControls.js vendor/
node extract.mjs http://localhost:8080        # needs a running server; writes data/
node shot.mjs                                 # writes shot-*.png
node shot.mjs --headed                        # or drive it by hand: orbit, tilt, work the sliders
```

`three.module.js` imports `three.core.js` — both must be vendored, which is not obvious and cost a
debugging round.
