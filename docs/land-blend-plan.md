# The land blend on the authored table — session transfer

**Status: 2026-07-26. Phase 1 (the cell bake) SHIPPED. Phases 2–4 not started.**

The surviving half of [`coast-corner-lattice-plan.md`](coast-corner-lattice-plan.md) §3, now that the
coast half is shipped. Read that doc first: the corner rule, the bit order and the measurement method
it records are the same ones this needs, and they are proven rather than proposed.

Cross-refs: [`civ4-texture-inventory.md`](civ4-texture-inventory.md) §4 (the art inventory),
[`plots.md`](plots.md) / [`province-plots.md`](province-plots.md) (the terrain pipeline),
[`terrain-3d.md`](terrain-3d.md) (the 3D path this feeds, since the province canvas is the mesh
texture), [`frontend-performance.md`](frontend-performance.md) (read before optimising any of it).

---

## 1. The problem, measured

Land terrain boundaries read as a **checkerboard of soft-edged squares** rather than a transition.
Province **550** at max zoom is the reference case: its neighbours run `PLAINS:212 / LUSH:33`
(province 547) and similar mixes, and where the generated terrain alternates plot by plot the map
looks tiled.

The cause is not a bug in the blend — it is that **no authored cell is being placed at all**. Stage 2
of `plots.mjs buildPlotTexCanvas` is `BLEND_NOISE`: a procedural feather that draws the neighbour's
*ground tile* inward from each shared edge (`f = tpp * 0.85`, alpha 0.7 for equal `LayerOrder`, 0.95
above, 0.55 below), plus a separate radial pass (2b) for diagonal corners. The unit of the operation
is the plot square, so the output is a soft-edged square.

**Two hypotheses were tested and falsified — do not spend time on them again:**

- *"It is a rotation problem."* There is no rotation, because there is no authored cell. The land
  table's rotations are all `0` (§2), so rotation cannot be the fault even after the rewrite.
- *"The textured blend is not running at this zoom."* It is. Stage 2 is gated `tpp >= 12`, and
  measured over every in-view province at province 550, max zoom: `tpp` ran **12–32** and `textured`
  was `true` for all of them, including the 3383-plot impassable at the floor of the range.

Reproduce the `tpp` measurement by importing the app's own modules in the page (the ES module cache
returns the same instances the app uses), which is also how the sea-canvas states in the coast doc
were measured:

```js
const core = await import('/js/core.mjs');
core.P.filter(q => q._tcanvas && core.provOnScreen(q))
  .map(q => ({ id: q.id, plots: q._plots.length, tpp: Math.round(q._tcanvas.width / q._tbox.w) }));
```

## 2. What the art gives us — all measured, none of it assumed

Every number here came out of `terrain-art.json` and the real `.dds` atlases on this machine.

**One shared table for all 16 land terrains.** The 24 blend-bearing manifest entries fall into exactly
**two** distinct `config → (cell, rotation)` tables: the 16 land terrains share one, the 8 water
terrains share the other (the coast one, which is full of rotations and variants). The land table is:

| cfg | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 | 12 | 13 | 14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cell | 8 | 1 | 2 | 6 | 13 | 10 | 3 | 5 | 9 | 7 | 4 | 12 | 11 | 14 |

All at **rotation 0** — 14 distinct authored cells, one per configuration, no rotation and no variants.
(Config 15 is the flat interior, 17 variants, already consumed by `authoredGroundTile`.)

**The alpha IS the corner mask, and it confirms the bit order independently.** Mean alpha per quadrant
of `LushBlend.dds`, for the cell each configuration selects — set bit = *that corner is this terrain*:

| cfg | cell | NW | NE | SE | SW | bits |
|---|---:|---:|---:|---:|---:|---|
| 1 | 8 | **132** | 0 | 0 | 0 | NW |
| 2 | 1 | 1 | **142** | 0 | 0 | NE |
| 4 | 6 | 0 | 0 | **108** | 0 | SE |
| 8 | 5 | 0 | 0 | 1 | **181** | SW |
| 3 | 2 | **226** | **213** | 3 | 8 | NW+NE |
| 12 | 12 | 57 | 40 | **215** | **238** | SE+SW |
| 5 | 13 | **234** | 80 | **249** | 94 | NW+SE |
| 7 | 3 | **222** | **251** | **229** | 38 | NW+NE+SE |
| 15 | 15 | 255 | 255 | 255 | 255 | all |

The alpha lands exactly on the set corners, in `1=NW 2=NE 4=SE 8=SW` — the same order
`water-terrain.coastConfig` was proven to use. Whole-atlas alpha spread: **24,848 transparent /
12,507 partial / 93,717 opaque**, i.e. a real soft-edged mask, not a binary stencil.

**Confirmed across all nine atlases during phase 1, and the measurement method matters.** Sampling
the outer eighth of each corner, all **126** (9 atlases × 14 configs) cells bind to exactly the
corners their config names, separating **240.4** (set) from **10.6** (clear) — no threshold anywhere
near a boundary. Do **not** measure quadrant *means* as the table above does: a diagonal cell (cfg 5,
10) runs a soft band through its middle, so its quadrant means read as all four corners set, and 17
of 126 cells look like mismatches that are not. This check now runs inside the bake every time.

**So nothing needs inventing.** Draw terrain A's `cell[cfg]` over this plot with its own authored
alpha; A's own painted ground supplies the RGB. That is the whole operation.

**Nine atlases, not twenty-four.** The 16 land terrains resolve to **9 distinct base atlases** —
`Plains` (GRASSLAND + PLAINS), `Lush` (LUSH + SCRUB), `Tundra` (TUNDRA + MARSH), `Muddy`, `Rocky`,
`Desert`, `Dunes`, `Salt`, `Ice`. Atlases are 256×512, **4×8 of 64px cells**.

**The masks are NOT shared between atlases — do not bake one 14-mask set.** Comparing cell 8's alpha
against `PlainsBlend`'s: `Lush` maxΔ 204 / meanΔ 6.5, `Tundra` 255 / 19.5, `Rocky` 255 / 57.6,
`Dunes` 255 / 45.9. Each atlas is authored separately. A shared mask set would be precisely the kind
of substitute `use-authored-art-not-substitutes` forbids.

**But the bake is per TERRAIN, not per atlas — 16 × 14 = 224 cells.** The 9-atlas figure counts only
the `<Path>` sheets; the 16 land terrains have **16 distinct `<Detail>` sheets**. GRASSLAND, PLAINS
and TAIGA all draw off `PlainsBlend` but grain with Grass/Plains/Taiga detail respectively, and since
a cell is composited base × detail × 2 (§4 — the ground's own rule, so the blend cannot differ in
palette from what it lands on), one cell per atlas would paint TAIGA's transitions in PLAINS' colour.
The two claims in this section were in tension; compositing wins, because matching the ground is the
whole point.

At native 64px that packs to **896×1024**, encoded at quality 92 to **351 KB** — far under the WebP
16383px cap, and **single-tier**: the subsection below explains why there is no higher tier to want,
and the renderer cannot use even 64 — the blend pass runs from ~12 px/plot against a deepest measured
zoom of ~32, so the cell is downscaled 2–5× even at the floor. That is the opposite of the ground
atlas, which does carry LoDs `[128, 256]` because its tile is a *repeating pattern* stretched over
~8 plots (≈32 px/plot at the deep tier), not one cell per plot.

### 64px is the authored ceiling for land, and it matters less than it sounds

Every `blend.dds` in the C2C tree was enumerated and decoded. **All nine land atlases exist only at
256×512 (64px cells)**, and they exist twice — once under `UnpackedArt/art/terrain/textures/land`,
once under `_art/terrain/textures/land` — at the *same* size. There is no hi-res land sibling to
switch to.

The 512×1024 (**128px cell**) atlases are a different family: the four coast sheets (which is why
`COAST_TILES.cell` is already 128 — that is the art, not our bake) plus the planetary set
(`lunarmaria`, `lunarregolith`, `martianbarren`, `martianplains`, `mercury`, `saturn`, `uranus`,
`venus`). Civ4 authored the coast at double the land's resolution and we are already taking both at
their native size.

Two findings worth keeping:

- **`textures/iceblend.dds` is 512×1024 (128px cells)**, while `TERRAIN_PERMAFROST` binds the 64px
  `textures/land/IceBlend.dds`. A single-terrain resolution upgrade is available if it ever matters.
- **`peakblend.dds` is 1024×1024 — 256px cells**, the highest in the tree. Unused: PEAK is relief and
  a prop, not one of the `KEEP` terrains.

**Why the 64px ceiling is not the constraint it appears to be.** The base sheet supplies low-frequency
colour and the corner SHAPE; all the visible grain comes from the `<Detail>` texture, and **40 of
those are 1024×1024** and already composited at full size by `authoredGroundTile`. So a blend cell
upscaled from 64px carries a soft mask over sharp detail — the mask is the one layer that can afford
to be low-resolution, because soft is what it is for. Do not go looking for a sharper mask; there
isn't one, and a hand-sharpened one would be a substitute.

## 3. The rule

For each plot, for each *distinct neighbouring terrain* A that owns at least one of the plot's four
corners, draw A's `cell[cfg]` where `cfg` is the 4-bit mask of which corners belong to A.

**A corner's owner is the highest-`LayerOrder` terrain among the (up to 4) plots touching it.** That
is what Civ4 exports `LayerOrder` for, and `terrain-art.json` already carries it per terrain
(`terrainLayerOrders()` in the bake, `LY` on the client). It also makes the pass deterministic and
order-independent: the same corner resolves the same way regardless of which neighbour is visited
first, which is the property `heightfield.mjs` argues for at length.

Note this is a *different* corner predicate from the coast's ("all four touching plots are water"),
and deliberately so: the coast asks "is this corner still open sea", the land blend asks "who wins
this vertex". Both are corner-keyed; only the tie-break differs.

## 4. What is already built — do not redo it

- **`coastConfig` (`js/water-terrain.mjs`)** — the corner rule for water, with the measurement in its
  docstring. The bit order and the "a corner is not its diagonal" argument transfer directly.
- **`authoredGroundTile` (`web/build.mjs`)** — already decodes these very atlases and reads
  `interiorCells(e)` off `blend["15"]`. Cells 1–14 are the same sheet, one function call away.
- **`MODULATE2X` / `boxSample`** — the composite rule the ground now uses (base × detail × 2, no
  recolour, no lift). A blend cell should be composited the SAME way so it cannot differ in palette
  from the ground it lands on; keep the cell's own alpha as the mask.
- **`shore-index.mjs`** — the global source-pixel index pattern, for when a neighbour lives in another
  province. The land blend needs cross-province neighbours too (a plot on a province edge), so this is
  very likely reusable as-is or with the value widened from "land terrain" to "terrain".
- **`_tshoreGaps` in `plots.mjs`** — the precedent for *precise* staleness: record the pixels a bake
  could not resolve, re-bake only when one resolves, and mark the canvas **stale rather than nulling
  it**. Both mistakes were made and fixed this session; §6 records why.

## 5. Phases (proposed, unvalidated)

1. ~~**Bake the cells.**~~ **SHIPPED.** `bakeLandBlendCells` in `web/build.mjs` → 16 terrains × 14
   configs @64px, one 896×1024 RGBA sheet (`assets/terrain/land-blend.webp`, 351 KB) plus
   `landBlend: {src, cell, cols, index:{TERRAIN_*: row}, cells:{cfg: atlas cell}}` in the web-asset
   manifest. Composited base × detail × ×2 with the authored alpha preserved, transparent pixels
   bled to the cell's own opaque mean (the coast bake's trap — lossy WebP drops colour under alpha 0
   and downscaling drags it back in). The land table is recognised **structurally** (14 configs, one
   variant each, all rotation 0), so the water and synthetic terrains fall out without being named.
   Verified by re-decoding the shipped `.webp`: corner check **224/224**, and **0** cells with dark
   RGB under alpha 0. No renderer change — nothing reads `landBlend` yet.
2. **Corner ownership, pure and tested.** A `terrain-corners.mjs` beside `shore-index.mjs`:
   `cornerOwner(index, x, y, LY)` → the winning terrain per corner, and `blendConfigs(plot, …)` → the
   `[terrain, cfg]` list for a plot. Zero-import, unit-tested, nothing renders from it.
3. **Replace stage 2.** Draw the authored cells instead of `BLEND_NOISE`. **This is the biggest visual
   change in the project** — every land boundary on the map. Capture before/after at several zooms
   (bands 4, 5, 6.5, max) and compare deliberately rather than eyeballing one frame.
4. **Retire what it supersedes** — `BLEND_NOISE`, the 2b radial corner pass, and the `LY`-driven
   0.95/0.7/0.55 strength ladder, which the authored alpha replaces.

Phases 1–2 are safe and self-contained; 3 is where the risk is.

## 6. Traps

- **The province canvas is also the 3D mesh texture** (`terrain3d.mjs` reads `p._tcanvas`), so this
  changes both renderers at once. There is no separate 3D ground path to keep in sync — but there IS a
  tilt-0 seam gate (`tools/webverify/terrain3d-verify.mjs`, 85.9% within 16 against a 90% threshold)
  that compares the 3D frame against the 2D canvas. Re-measure it after phase 3.
- **Never null a cached canvas to force a re-bake.** Under the 3D ground an absent canvas is an
  untextured mesh — for a sea province, the bare sea plane. Mark it stale and let
  `buildPlotTexCanvas` swap the new one in atomically. (Measured mid-pan before this was fixed: 5 of 8
  sea provinces in view had plots and no canvas.)
- **Never invalidate on a global version counter.** Dropping every canvas when any province loads
  thrashes continuously while panning and nothing finishes inside the 6 ms build budget. Track
  staleness against the specific unresolved pixels.
- **`textured` is gated on `!S.dragging`, but only for 2D now.** Under the 3D ground the flat
  1px/plot stand-in does not exist, so suppressing builds while dragging empties the map.
- **Costs land on `PLOT_FRAME_BUDGET_MS = 6`.** Fourteen cells per neighbour terrain per plot is more
  drawing than one feather; if a province bake gets slower, the budget defers it over more frames
  rather than dropping frames — but measure, and read `frontend-performance.md` first (its opening
  point is that the obvious metrics all lie).
- **Do not bake one shared mask set** — §2 measured the alphas as per-atlas.
- **`web/` auto-deploys on push; the server is manual.** Deploy the server first. A terrain bake also
  moves `terrainColors` in the web-asset manifest, which the SERVER serves via `/api/bundle`, so the
  two must ship in that order or flat fills disagree with the textures under them.
- **Bump the reactor patch version** before deploying (three poms by hand; `versions:set` will not run
  offline here).

## 7. Explicitly not in scope

- **A corner lattice for the ground.** The coast work proved the index is computable from per-plot
  adjacency; assume the same here until something forces otherwise.
- **Rivers.** Unchanged, and `river-rendering.md` §5 rejected Civ4's edge decals on the merits.
- **`MAP_VERSION`.** This is a rendering change; no plot data moves, so no rebake and no plot-cache
  clear.
- **The 9 synthetic terrains** (cavern, mushroom forest, glacier, urban, …). They have no art define
  and therefore no blend table; they keep the authored recolour and whatever edge treatment survives.

## 8. Loose ends from the same session

- `PEAK_GROUP.baseFade` is 0.18. It removed the hard bottom edge on the mountain billboards, but a
  faint boundary is still visible on the largest masses — 0.24 is worth trying.
- Coast config **0** (every corner touching land — one-plot lakes, one-plot-wide channels) has no
  table entry and draws no tile, so those show plain water: 78 of 3,000 shoreline plots.
- The polar sea roughly doubled in brightness when `SEA_ANCHOR` was removed (`13801f07`) and still has
  not been eyeballed on the map.
- Prod studio holds 25 `terrain-art` rows against the fixture's 33; a Seed Studio run syncs them.
  Nothing reads the dataset at runtime.
