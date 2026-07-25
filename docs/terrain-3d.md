# 3D terrain — the target look, the spike that validated it, and the plan

**Status:** SPIKED 2026-07-25 (`tools/spike-iso3d/`, commit `27b27dc`); the approach is **validated**
and **PLANNED** (§The plan, decided 2026-07-25). Nothing is built in `web/` yet.

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

### P0 — the projection seam (no three.js)

`pxr`/`pyr` become calls into a swappable projector; the affine one stays the default. Add
`unproject(sx, sy)` — the inverse exists today only hand-rolled inside `hittest.plotAt` and
`core.latAtScreenY`.

Acceptance: **pixel-identical** frames via `tools/webverify` at k = 1, 8, 20, 40, 120. Ships and reverts
alone, and is worth having regardless of what renderer follows.

### P1 — the ground mesh at tilt 0

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

### P2 — the tilt

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
