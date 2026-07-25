# 3D terrain — the target look, the spike that validated it, and the plan

**Status:** SPIKED 2026-07-25 (`tools/spike-iso3d/`, commit `27b27dc`), **PLANNED** P0–P5 (§The plan),
and **P0 + P1 + P2 SHIPPED** 2026-07-25 — the 3D ground is live from band 5 up and PITCHES OVER to 34° by
band 6.5, with the whole 2D layer stack projected through the tilted camera. Gated on a frame diff at the
seam against the 2D path it replaces (mean 5.12/255 at band 5.0, where tilt is 0). P3 (upright props) is
next, and is the largest single piece left.

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

### P3 — upright props

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

### P4 — interactions and polish

`maptip`/`plotlabel` hover, the city screen, districts anchored to real mesh height, the minimap, and a
no-WebGL fallback — which is cheap, because 3D only engages at band 5, so the 2D path below it *is* the
fallback (clamp the zoom).

### P5 — prop art at the oblique angle

Buildings and units. Where the C2C asset question lands: pre-rendering from NIF in Blender sidesteps the
`.kf`/`.kfm` animation-import risk entirely, and the ~700 Firaxis-origin models of ~6,086 need a
decision. See [`civ4-files.md`](civ4-files.md).

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
