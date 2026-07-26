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
- **`peakblend.dds` is 1024×1024 — 256px cells**, the highest in the tree. ~~Unused: PEAK is relief
  and a prop, not one of the `KEEP` terrains.~~ **Wrong — it is now baked; see §5.3.** It is not one
  of *our* `KEEP` terrains, but Civ4 gives it a full art define, the same 14-cell table, and
  LayerOrder 100 — the top of the game.

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
2. ~~**Corner ownership, pure and tested.**~~ **SHIPPED.** `js/terrain-corners.mjs` beside
   `shore-index.mjs`: `indexTerrain` / `cornerOwner(index, cx, cy, LY)` / `cornerResolved` /
   `blendConfigs(index, x, y, LY)` → `{configs: [[terrain, cfg], …], gaps}`. Zero-import, 15 unit
   tests (`node --test web/js/terrain-corners.test.mjs`), nothing renders from it. Measurements and
   the two design points that were not in this plan are in §5.1 below.
3. **Replace stage 2.** Draw the authored cells instead of `BLEND_NOISE`. **This is the biggest visual
   change in the project** — every land boundary on the map. Capture before/after at several zooms
   (bands 4, 5, 6.5, max) and compare deliberately rather than eyeballing one frame.
4. **Retire what it supersedes** — `BLEND_NOISE`, the 2b radial corner pass, and the `LY`-driven
   0.95/0.7/0.55 strength ladder, which the authored alpha replaces.

Phases 1–2 are safe and self-contained; 3 is where the risk is.

### 5.1 What phase 2 settled, measured on real plots

Validated against real plot grids fetched from `dev.civstudio.com/api/plots`, since the local plot
cache is empty. **Two patches, and the second is the one that matters** — the first attempt used the
2-ring patch around province 550 (the reference case in §1), which turned out to be entirely inland:
all 5,534 of its plots are land, so it exercised none of the water behaviour. The coastal patch is
the 2-ring around **1231 Grimmstig**, 26 provinces, **74,514 plots** (19,431 land). Phase 3 should
re-run both rather than trust the synthetic fixtures.

- **Order-independence holds on real data: 0 mismatches** across both patches, indexing forwards and
  backwards. This is the property §3 claims for the `LayerOrder` rule, now measured rather than
  argued.
- **The cost is far below what §6 feared.** 24.4% of land plots have any corner owned by another
  terrain, and such a plot averages **1.02 owners** — 4,824 entries across 19,431 land plots. Better
  still, only ~1,800 of those are actually *drawable* (see suppression below), so the real load is
  well under one extra `drawImage` per ten plots. That is the true shape of the
  `PLOT_FRAME_BUDGET_MS` question, not "fourteen cells per neighbour terrain per plot".
- **62.1% of all corner ownership on the coastal patch goes to WATER** (2,994 of 4,824). Nothing is
  drawn for those — see §5.2 — but that is exactly the point: without water in the index every one of
  them would have been claimed by a land neighbour and painted with a land cell over a vertex the sea
  owns, while `coast.mjs` drew the same vertex from the water side.
- **Config 15 occurs: 134 (2.78%)**, so phase 3 must handle it — by drawing the owner's ordinary
  ground tile, since the baked sheet carries 1–14 only.
- **Owners with no blend column occur: 21 (0.44%)**, all GLACIER, one of the nine synthetic terrains.
  Phase 3 must skip them rather than assume every owner has a cell.
- **Configs 5 and 10 — the two authored DIAGONAL cells — are real but very rare: 4 each of 4,824.**
  They need a near-checkerboard, because every plot touching the NW corner other than the NW diagonal
  also touches NE or SW. (The inland patch had zero, which is why an earlier note here wrongly called
  them unreachable.) Do not tune anything around them, but do not drop them either.
- Coastal distribution:
  `1:348 2:337 3:561 4:313 5:4 6:400 7:402 8:291 9:434 10:4 11:412 12:468 13:346 14:370 15:134`.
  Owning terrains: COAST_POLAR 2794, TUNDRA 1769, COAST 200, TAIGA 27, GLACIER 21, MARSH 13.

### 5.2 Water is a full participant, and that is what suppression is

Water plots are indexed and **compete for corners like any other terrain — and win**: the eight water
terrains carry LayerOrders 50–71 against land's 2–31, so any corner touching water belongs to the
water. This is what §3 says ("the highest-`LayerOrder` terrain among the plots touching it", with no
land restriction); an earlier build of this module excluded water and was wrong.

Nothing is drawn for a water-owned corner, because water has no column in the land blend sheet — so
the effect is **suppression**, and that is correct twice over. It is what `LayerOrder` means, and the
land↔water transition at that vertex is *already* drawn, by Civ4's painted coast tile which
`coast.mjs` stamps on the water plot.

**So water does not need a tile bake of its own — it already has one.** `bakeCoastTiles` ships the
three climate atlases (4×8 of 128px cells, 15 configs, 105 variants, rotations and all), and all
eight water keys resolve to one of those three bands through `water-terrain.shelf` (lakes borrow the
temperate atlas, there being no painted lake art). Water's blend table is the *other* table of §2 —
rotated and multi-variant — which is precisely why it is a separate bake and cannot be a column in
the land sheet. Baking water into this sheet would draw the same vertex twice, from both sides.

**Two further design points this plan did not anticipate:**

- **Every terrain is indexed, so an absent key means "not loaded" and nothing else.** That is what
  makes `cornerResolved` trustworthy. (The module needed a `null` sentinel for water back when water
  was excluded; including it removed both the sentinel and the `isWater` parameter.)
- **`gaps` is a list of corner keys, not a boolean.** A plot at the world edge has corners that can
  never resolve, so "has gaps ⇒ stale" would thrash forever — exactly the trap §6 records. The caller
  stores the keys and re-bakes only when one *resolves*, which is the `_tshoreGaps` contract.

### 5.3 Relief: PEAK is a blend layer, HILL is a wash

Relief is `Plot.plotType` (FLAT/HILL/PEAK), orthogonal to the terrain key — a 3D prop since P4b and a
hand-rolled recolour in the 2D bake (`plots.mjs`: HILL `×1.14 + 8`, PEAK averaged toward 150,152,158).
Civ4 authors both as terrain layers with their own blend art, and **both use the identical 14-cell
land table**, so neither needs new machinery. But they are not the same kind of art, and the
difference decides what to do with each.

**PEAK — baked, as a 17th row.** LayerOrder **100**, above every terrain in the game including the
eight water keys at 50–71. `PeakBlend.dds` is 1024×1024 (4×4 of 256px, the highest-resolution blend
art in the tree) and its detail is **IceDetail** — Civ4 paints a peak as snow-capped rock that
REPLACES the ground rather than tinting it. Its corner mask is the cleanest measured anywhere: set
corners **254.9**, clear corners **0.7** (LushBlend, the reference, is 240.4/0.5). Its interior cell
is alpha 246–254.

This is what puts real mountain ground under the billboard: at LayerOrder 100 a PEAK plot wins all
four of its own corners, so it takes the interior cell, and its neighbours take its blend cells —
the rock spills outward the way the sprite's base sits. That should let §8's `PEAK_GROUP.baseFade`
question be reopened, since the billboard would then meet peak ground instead of grassland.

The 256px cells sample down to the sheet's 64 and lose nothing visible — the blend pass draws at
12–32 px/plot, so even 64 is oversampled 2–5× (same argument as §2's LoD note).

**HILL — deliberately excluded, and the measurement is the reason.** `ART_DEF_TERRAIN_HILL` exists
with the same table and LayerOrder 30, but `Land/HillBlend.dds` is **not a corner mask**. Mean alpha
per cell runs 28–102, and its INTERIOR cell reaches only **102 of 255** where PEAK's is 254 and every
land terrain's is opaque. Scored like every other atlas it binds **0 of 14** configs — its "set"
corners peak at alpha 25. Civ4 authors a hill as a translucent **wash over whatever terrain the plot
already has** (a grassland hill is still grassland), where a peak replaces the ground.

So HILL must **not** own corners either. A hill plot's ground *is* its base terrain, so it should keep
contributing that terrain to the ownership contest exactly as it does today. Giving HILL its own
LayerOrder 30 in the contest would let it suppress a lower neighbour's blend while having nothing to
draw — strictly worse than the present behaviour. `terrainLayer` therefore carries `PEAK: 100` and no
`HILL` key at all.

What HILL should get instead is its authored wash as a **ground overlay**, replacing the invented
`×1.14 + 8` brightening — see §8.

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

- **The HILL wash is authored art we are not using.** `Land/HillBlend.dds` interior cell (alpha ~102)
  × `Land/HillDetail.dds` is Civ4's real hill treatment: a translucent overlay composited over the
  plot's own ground. Today `plots.mjs` fakes it with `r*1.14 + 8`, an invented brightening — exactly
  what `use-authored-art-not-substitutes` forbids. Baking the interior cell as an RGBA wash tile and
  compositing it over a HILL plot's ground at its authored alpha would retire that. Note it is a
  GROUND overlay, not a blend row (§5.3), and that 3D already has the other half of Civ4's hill —
  `heightfield.mjs` raises the mesh. PEAK's own invented recolour (averaging toward 150,152,158) is
  retired by §5.3 instead.
- `PEAK_GROUP.baseFade` is 0.18. It removed the hard bottom edge on the mountain billboards, but a
  faint boundary is still visible on the largest masses — 0.24 is worth trying. **Re-open this after
  phase 3:** with PEAK baked as a blend layer (§5.3) the billboard will stand on real peak ground
  rather than on grassland, which may make the fade unnecessary rather than merely better tuned.
- Coast config **0** (every corner touching land — one-plot lakes, one-plot-wide channels) has no
  table entry and draws no tile, so those show plain water: 78 of 3,000 shoreline plots.
- The polar sea roughly doubled in brightness when `SEA_ANCHOR` was removed (`13801f07`) and still has
  not been eyeballed on the map.
- Prod studio holds 25 `terrain-art` rows against the fixture's 33; a Seed Studio run syncs them.
  Nothing reads the dataset at runtime.
