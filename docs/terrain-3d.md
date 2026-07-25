# 3D terrain — the target look, the spike that validated it, and what it would take

**Status:** SPIKED 2026-07-25 (`tools/spike-iso3d/`, commit `27b27dc`). The approach is **validated**;
nothing is built in `web/`. This doc is the seed of the direction, not a plan yet.

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

## What a real implementation would need

Roughly in dependency order. None of this is planned yet.

1. **A renderer.** Browser: three.js or Babylon (the spike used three.js and it was adequate within a
   day). Native: Godot/Unity, which forks the client — see the discussion recorded in
   [`pixi-migration-plan.md`](pixi-migration-plan.md).
2. **Terrain chunking**, one mesh per province, textured by that province's existing offscreen. Streams
   as you pan, exactly like the plot grids already do.
3. **LOD across the band spine.** `drawPlots` already returns below `K_PLOT`, which hands you the LOD
   boundary for free: keep the flat baked raster at Atlas as today, mesh only from k≥5. Worst case a few
   hundred thousand triangles.
4. **Camera.** Orthographic top-down at Atlas (looks like today's map) → oblique perspective at Ground.
   Civ4 and Civ6 both do this, and it dissolves the projection-discontinuity problem a 2D isometric
   shear would have created at the Overland→Ground seam.
5. **Upright props** (see above), then depth-sorting and anchor tuning.
6. **Prop art at the oblique angle** — buildings, units. This is where the C2C asset question lands:
   pre-rendering from NIF in Blender sidesteps the `.kf`/`.kfm` animation-import risk entirely, and the
   ~700 Firaxis-origin models of ~6,086 need a decision. See `docs/civ4-files.md`.
7. **Hit-testing** — the inverse camera transform for screen→plot, threaded through `hittest.mjs`,
   `maptip`/`plotlabel` hover and the city screen.

**What does not change:** the server, `/api/bundle`, the bake pipeline, and all ~13.5k lines of DOM UI.
The city plates in the target are already how `labels.mjs`/`city.mjs`/`districts.mjs` work — screen-space
content anchored to world positions.

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
