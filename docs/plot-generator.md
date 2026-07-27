# Plan: procedural, province-driven plot terrain (C2C-style)

**Goal.** Stop assigning plot **terrain** (and features) from the imported `terrain.bmp` pixels and
instead generate them procedurally with a faithful **C2C-planet-generator** algorithm, driven by each
province's climate parameters — so all 33 terrains appear *properly* and climate-appropriately, instead
of the impoverished handful the pixel palette yields. The real Anbennar **geography stays**: province
shapes, the land/water mask, coastlines, rivers, and the mountain backbone.

Companion investigation lives in this doc's design; the C2C algorithm inventory is in the conversation
that produced it (terrain set + temperature-band + diversify logic from `C2C_Planet_Generator_0_68.py`).
Related: `docs/plots.md`, `docs/province-plots.md`, `docs/underworld.md` (special terrains). This
supersedes the map-pixel terrain path those describe.

## Decisions (locked with owner, 2026-07-12)

| Question | Decision |
| --- | --- |
| Terrain source | **Fully procedural** — `terrain.bmp` unused for terrain; 100% from province climate/winter/latitude + the C2C temperature×humidity algorithm |
| Features | Procedural too (C2C `FeatureGenerator` + terrain-implied); drop the `trees.bmp` feature hints, for consistency |
| Relief (flat/hill/peak) | **Hybrid** — real `heightmap.bmp` peaks (the mountain backbone) + `ReliefGenerator` C2C-range variation (≈ the current `rougher()` compose) |
| Geography kept from raster | province shape / land-water mask (`provinces.bmp`), coastlines, **rivers** (`rivers.bmp`), heightmap elevation |
| Special surface terrains | `province.type()` overrides the climate pick (a province typed `ANCIENT_FOREST`/`GLACIER`/… gets its terrain regardless of climate) |
| Determinism | **Seed-independent** (keep) — the canonical `Stream.TERRAIN` still excludes the game seed, so the field is identical every run and the shared plot cache/serving model is unchanged |
| Spatial coherence | **Coherent patches** — a value-noise / seed-and-spread **region pass** groups plots, and the C2C weighting picks per region (natural terrain patches, not per-plot salt-and-pepper) |
| Temperature | **Per-plot world latitude** — each plot's world latitude (province lat + plot-y offset) sets its temperature, giving a gradient across large north-south provinces |
| Food balance | **Accept the shift** — richer climate-driven terrain will move per-plot food yields; recalibrate the food economy + collapse-timing tests afterward, don't constrain the terrain to preserve today's balance |

## Why this is mostly *promotion*, not new code

The current live path is `MapTerrainCodec.ground(pixel)` **primary**, with the procedural
`TerrainGenerator` + `LatitudeClimate` only as the **fallback for unmapped pixels**
(`ProvincePlotField.java:186-188`). CivStudio already ships faithful C2C ports —
`TerrainGenerator` (climate-weighted pool), `LatitudeClimate` (C2C latitude→temperature + cold pool),
`ReliefGenerator` (C2C flat/hill/peak ranges), `FeatureGenerator` (C2C seed-and-spread), and
`ClimateProfile` (province → temperature+humidity). The work is to **promote the procedural generator to
primary**, complete the C2C two-stage terrain algorithm on top of it, and drive it from province params.

---

## The C2C algorithm to reproduce (from the script)

Per plot, in two stages, a **weighted probability pick** (matching `PrivateMaps/C2C_Planet_Generator_0_68.py`):

**Stage 1 — base terrain by temperature × humidity** (overlapping bands; humidity modulates weights):

| Terrain | Temp band (°C) | Weight |
| --- | --- | --- |
| `TERRAIN_DESERT` | > 30 | `7·(1.5 − humidity)` |
| `TERRAIN_PLAINS` | 15…39 & −2…25 | 7 |
| `TERRAIN_GRASSLAND` | 4…30 | `7·(humidity + 0.5)` |
| `TERRAIN_MARSH` | −5…18 | 10 |
| `TERRAIN_TAIGA` (C2C `terrainTundra`) | −10…10 | 7 |
| `TERRAIN_TUNDRA` (C2C `terrainPermafrost`) | −10…−20 | `15·(humidity/2+0.75)` |
| `TERRAIN_ICE` (C2C `terrainSnow`) | < 0 (esp. < −30) | `7–15·(humidity/2+0.75)` |

**Stage 2 — "Diversify"** (replace each base with a weighted variant):
`Desert → {Desert:2, SaltFlats:1, Dunes:4, Scrub:3}` · `Plains → {Plains:3, Barren:1, Rocky:2}` ·
`Grass → {Grass:2, Lush:3, Muddy:1}`.

**Water:** `TERRAIN_COAST` / `TERRAIN_OCEAN`→`SEA` (existing water path adds the `_POLAR`/`_TROPICAL`
climate suffix by latitude). Features (6): `FOREST, JUNGLE, SWAMP, OASIS, FLOOD_PLAINS, ICE`.

Coverage note: these 16 C2C terrains + the **7 Anbennar specials** (`province.type`) + the water climate
suffixes + `CAVERN`/`URBAN` = CivStudio's full 33. Nothing else needs inventing.

---

## Design

### Inputs
- **humidity** (per province) — from `climate` + `monsoon`, via `ClimateProfile.humidity()` (0.10–0.95).
- **temperature** (**per plot**) — each plot's **world latitude** = province lat + (plot-y → degrees offset
  from the province bounding box), fed through `LatitudeClimate`/`ClimateProfile` (`≈ 40 − 0.6·|lat|` minus the
  `winter` offset). So a tall province warms toward its equatorward edge instead of reading one flat value.

### Region coherence pass (new — runs before Stage 1)
Partition the province's land plots into **regions** with a deterministic value-noise / seed-and-spread field
(same shape as `FeatureGenerator`'s spread, on the canonical stream). Stage 1 then draws **once per region**
(not per plot), so terrain forms natural contiguous patches. Despeckle still runs to clean edges.

### Per-plot terrain (canonical `Stream.TERRAIN` rng, unchanged draw-order)
1. **Stage 1** — per region, weighted pick from the plot's temperature-band array (humidity-modulated) → base terrain.
2. **Stage 2** diversify → detail variant (per plot, so a patch still has fine variation).
3. **Special override** — `province.type()` ∈ {ANCIENT_FOREST, GLADEWAY, FEY_GLADEWAY, BLOODGROVES,
   MUSHROOM_FOREST, SHADOW_SWAMP, GLACIER} ⇒ that terrain (the existing `SPECIAL_POOL` pass).
4. **Water plots** — existing `generateWater` (coast/sea + climate suffix, near-shore shelf).
5. **Despeckle** — keep the majority-smoothing pass to clean region edges.

### Relief (hybrid) & rivers & coast — keep
- Relief stays the `ReliefGenerator` + heightmap compose (`rougher()`), but **repoint the "map relief"
  input from the `terrain.bmp` palette to `heightmap.bmp` elevation** — with terrain pixels gone, peaks/hills
  must derive from elevation thresholds, not `MapTerrainCodec.relief(terrainIndex)`. (Implementation check.)
- Rivers, the coast mask, and the land/water mask keep coming from the raster (`ProvinceMask`).

### Features (procedural)
`FeatureGenerator` seed-and-spread + terrain-implied features (forest on cold/temperate, jungle on hot-wet,
swamp on marsh, oasis in desert, flood-plains on river). Drop the `trees.bmp` (`treeFeatureKey`) hints.

---

## Code changes

- **`ProvincePlotField.generate`** (`geo/ProvincePlotField.java:159`) — the one authority. Replace the
  `MapTerrainCodec.ground` primary with the C2C two-stage procedural pass; drop the `terrain.bmp`/`trees.bmp`
  terrain+feature reads; keep the relief (repointed to heightmap), water, special-override, bonus, city, and
  despeckle passes. Preserve the **row-major, one-draw-per-cell** order so the canonical stream stays byte-stable.
- **`TerrainGenerator`** — complete it into the faithful C2C two-stage weighting from `(temperature, humidity)`
  (port per the `port-c2c-generator-faithfully` note — mirror the script's constants/order). Reuse
  `ClimateProfile`/`LatitudeClimate` for the inputs; reuse the existing `probabilityArray`-style weighted pick.
- **`MapTerrainCodec`** — `ground` / `relief(terrainIndex)` / `treeFeatureKey` / `terrainFeatureKey` /
  `isWoody` become dead for the primary path (keep `water(...)` for the shelf; delete or retire the rest).
  `ProvinceRaster` can stop loading `terrain.bmp`/`trees.bmp` for generation (still needed by the dev-time
  web terrain bake? — no, that reads Civ art, not these rasters; confirm before dropping the load).
- **`ProvincePlotStore.MAP_VERSION`** (`:49`) — bump `2 → 3`. This invalidates every plot cache
  (`map/provinces/*.json.gz` + the prod volume) and the client `?v=` URL, forcing regeneration.

## Determinism

Unchanged model: the seed-independent **canonical `Stream.TERRAIN`** (`RngSeed.forProvinceCanonical`) +
row-major draw order = identical field every run/seed, persisted once. The new pass must consume the stream
in the same deterministic order (fixed draws per cell whether or not a variant/feature lands).

## Consumers (contract preserved)

The plot's serialized fields are **unchanged** (`terrain, feature, plotType, river, elevation, coast, bonus`),
so farm-TFP food yield (`Plot.yields`), caravan A* routing (`ProvincePlotPool.corridor`), plot claiming, and
the web viewer (`plots.mjs`) all keep working — they just see richer, climate-driven terrain. The Civ6 art
(Phases 1–3) keys off terrain/feature type, so it renders the new terrains automatically.

## Deployment (per the runbook + `always-az-deploy-on-change`)

A `MAP_VERSION` bump is a generation change: **rebake** (`regenerate-map.yml` in CI, which runs
`WorldPlotGenerator` and uploads to `<share>/map/v<new>`) → **then** deploy the server → rebake/
redeploy the bundle + static site. Nothing is deleted: the cache is versioned per `MAP_VERSION`, so
the bump itself points the server at a fresh dir — and `map/v<N>` holds GeoNames names prod cannot
regenerate. The bake must precede the roll, or prod serves nameless on-demand plots. This is
server-affecting engine data, so it goes out via `az`, not just SWA.

## Verification

1. **Terrain variety** — regenerate a sample of provinces across climates; assert all base terrains appear
   and are climate-appropriate: arctic/severe-winter provinces read cold (taiga/tundra/ice), tropical wet read
   grass/jungle/marsh, arid read desert/dunes/scrub. No province should be a flat single terrain.
2. **Special terrains** — provinces typed `ANCIENT_FOREST`/`GLACIER`/`MUSHROOM_FOREST`/… still show their
   terrain (override intact).
3. **Determinism** — same province regenerates byte-identical across two seeds; `MAP_VERSION` bumped.
4. **Geography intact** — coastlines, rivers, and the mountain backbone still match the real map (heightmap
   relief, raster rivers).
5. **In-app** — `mvn -pl civstudio-engine install` → `spring-boot:run` → `tools/webverify` screenshots across
   several provinces/climates; confirm the Civ6 terrain art renders the new distribution.
6. **Tests** — `mvn test` (scenarios smoke-test terrain-dependent food balance; watch for collapse-timing shifts
   since food yield now tracks climate-driven terrain).

## Resolved decisions & remaining risks

- ✅ **Coherence** — coherent-patch region pass (above), not raw per-plot noise.
- ✅ **Temperature gradient** — per-plot world latitude (above).
- ✅ **Determinism** — seed-independent, shared cache unchanged.
- ✅ **Food balance** — accept the shift; recalibrate afterward (don't constrain terrain to preserve it).
- ⚠️ **Relief repoint** (implementation) — confirm relief no longer depends on the terrain palette once
  `terrain.bmp` is dropped; derive peak/hill from `heightmap.bmp` elevation thresholds + `ReliefGenerator`.
- ⚠️ **Food-balance fallout** — climate-driven yields will shift the colony-collapse timing the smoke tests
  assert (`colony-collapse-accepted`); plan to retune the food economy / test expectations after it lands.
- ⚠️ **Region-pass tuning** — patch size/count is a knob; too coarse = uniform provinces, too fine = noise.
  Tune against real output.

---

## As built — increment 1 (2026-07-12)

Shipped: **procedural terrain is live and primary.** `ClimateTerrainGenerator` (the C2C two-stage
temperature×humidity port) drives `ProvincePlotField.generate`; `terrain.bmp` is no longer read for the
biome (still read for the hybrid mountain-relief signal via `MapTerrainCodec.relief`). `MAP_VERSION` 2→3.
All 33 terrains appear climate-appropriately (verified: arid→dunes/scrub/desert, tropical→lush/grass,
temperate→grass/plains/marsh cooling to taiga at latitude, cold→tundra/permafrost). Covered by
`ClimateTerrainGeneratorTest`; the scenario smoke tests still pass (the food-balance shift did not break
the clean-collapse assertions).

Province-type decisions implemented:
- **IMPASSABLE** → a climate-appropriate **barren** pool (`ClimateTerrainGenerator.barren`): hot→desert/
  badland, cold→rocky/permafrost, temperate→rocky/scrub, + mountainous relief.
- **city_terrain** (`province.city()`) → **fully urban** — every plot paved `TERRAIN_URBAN`, no farmland/
  features/resources (the render layer covers it; a dedicated paved texture is deferred, and long-term the
  urban plots become Civ6 **district tiles**).
- **Surface special terrains** (ancient_forest, glacier, …) → signature terrain (82%) + **climate-aware
  filler** (a northern ancient forest fills with taiga, not grassland). **Underground** types keep the
  fixed cavern pool + flattened floor. `DWARVEN_HOLD_SURFACE` stays cavern (owner's call).
- **Bonus density** → **stochastic rounding** in `BonusGenerator` (the richer terrain spreads each bonus
  across fewer matching plots; probabilistic rounding preserves expected density so small provinces still
  draw resources). **Retuned (increment 1b, `MAP_VERSION` 3→4):** `DENSITY_SCALE` 0.275→**0.055** (≈5×
  sparser — the procedural terrain made too many plots eligible, blanketing the map), and **wastelands
  (`IMPASSABLE`) now carry no resources at all** — the bonus pass is skipped for them (barren ground is
  worked by no one). Covered by `ProvincePlotFieldTest.wastelandsCarryNoResources` +
  `BonusPlacementTest` (density band retuned, upper bound now guards the 5× regression).

Anbennar calibration deviations from pure C2C (documented in `ClimateTerrainGenerator`): a **dry-desert
gate** (an `arid` province reads desert across its latitude range, not only when scorching) and a
**humidity-gated marsh** (a dry province stays steppe, not wetland).

**Region-coherence (increment 2, `MAP_VERSION` 4→5).** Terrain is no longer an independent per-cell draw
smoothed by despeckle — it grows in contiguous **patches**. `ProvincePlotField.coherentGround` scatters ~1
seed per `PATCH_AREA` (22) land plots, each a climate-pool draw (`ClimateTerrainGenerator.next`); every
land plot takes its nearest seed's terrain, its sample point first nudged by a smooth `valNoise` field so
patch boundaries wander organically instead of forming straight Voronoi walls. Seeds are pool draws, so
each terrain keeps its aggregate share; the despeckle stays as a light tidy for the special-terrain
fillers. Deterministic on the TERRAIN stream. Verified: biomes read as contiguous zones, `speckFraction`
≈ 0.01 (was salt-and-pepper). Relief is unchanged (already coherent — it rides the smooth heightmap).

---

## Seamless generation (increment 3, `MAP_VERSION` 10→11, 2026-07-25)

**The bug.** Generation was *province-local* in five separate places, and a province border is a
**seam** in each of them. `ProvinceRaster.mask()` framed a mask whose `isLand()` meant "a pixel of
*this* province", and every spatial generator probed neighbours through it — so each one treated the
border as ocean:

| Stage | Border artifact |
| --- | --- |
| `coherentGround` | patch seeds scattered over *this* province's land; `valNoise` sampled in **mask-local** coordinates, so neither the patches nor the noise lattice lined up across a seam |
| `ClimateTerrainGenerator` | one pool per province → the terrain **distribution stepped** at every border |
| `despeckle` | out-of-province neighbours read `null`, so border cells were never smoothed |
| `FeatureGenerator.isCoastal` | *"a neighbour outside the province"* = coastline → a **vegetation ring seeded along every province outline** |
| `ReliefGenerator` | `canSeedPeak` needs 4 flat land neighbours and `peakBlocked` refuses to grow beside a non-land cell → **a flat ring around every province**, and ranges cut off at the seam |

Measured over Anbennar's Lencenor (72 provinces): terrain changed **6.3×** more often across a
province border than inside one, and border plots were **2.0×** more likely to carry vegetation than
inland plots. The province polygons were legible in the generated ground.

**The fix — generate as a function of world position, not of province.** A literal single global
pass was rejected: the sim generates lazily per province on demand, so a global path would have to
be kept byte-identical to a per-province one anyway. Instead the per-province path was made
*coordinate-pure*, which gives single-pass semantics for free.

1. **A halo on the mask** (`ProvinceRaster.HALO` = 8 px). The frame grows past the province's own
   bounding box and marks the neighbouring provinces' land too. Two land senses now:
   `ProvinceMask.isLand` = **own** pixels (the emission set — exactly these become plots) and
   `isGround` = **any** dry land in the frame (the generation set). Relief, ground, de-speckle and
   the vegetation spread all run over `isGround`; the halo is discarded at emission. Every raster
   overlay (terrain / trees / elevation / river / coast / land-distance) is filled across the whole
   frame for the same reason.
2. **`WorldClimate` — provinces as reference biomes, not cells.** Each land province paints its
   control values over its own pixels into a `DOWNSAMPLE`=2 grid; water and off-map cells are filled
   from the nearest painted cell by BFS; three box-blur passes turn the province mosaic into a
   **continuous field** with a ~6 px gradient at each border. `temperature(x,y)` / `humidity(x,y)`
   sample it bilinearly. Provinces still author the climate — they just stop being step edges.
   Rng-free, seed-free, built once per JVM.
3. **World-space terrain patches** (`ProvincePlotField.worldGround`). A `PATCH_SIDE`=5 lattice over
   the **whole raster in absolute coordinates**; each lattice cell hashes to a jittered seed point
   and to its own `Rng`, and draws its terrain from the pool at the seed's own sample of the climate
   field. A plot takes the nearest of the 3×3 surrounding seeds, its sample point displaced by
   `valNoise` — now also in absolute coordinates. **Consumes no rng stream at all**, so the ground is
   a pure function of world position: two provinces agree exactly on their shared border, and the
   lazy per-province path is byte-identical to a global pass.
4. **Real coastlines.** `FeatureGenerator` and the oasis pass seed on the global sea mask
   (`ProvinceMask.isCoastal`) instead of "outside this province".
5. **Continuous vegetation density.** `trees.bmp` is ~1/7.7 resolution, and a per-province *average*
   of it jumped at every border; `ProvinceRaster.treeDensity` bilinearly interpolates the woody flags
   instead, so density — like temperature and humidity — is sampled per cell.

**Result** (same Lencenor render): seam score **6.31 → 1.46**, border-vegetation ratio **1.99 →
0.97**, border-relief ratio **0.78 → 0.96**. The residual above 1.0 is the province types whose
ground is a deliberate override with a genuinely sharp edge — impassable wastelands, caverns, and the
special surface terrains (an ancient forest is *supposed* to stop at its own border). Those, plus the
cavern pool and the barren-waste pool, still draw per province off the terrain stream and are applied
to **own cells only**, so the halo keeps real neighbouring ground for the stages that read it.

Cost: generation is ~1.8× slower per province (the halo enlarges every grid). The whole-world CI
rebake goes from ~24 min to ~45 min, inside its 120-minute budget.

### The neighbour ring (MAP_VERSION 16)

The halo above is a *generation* device — it is discarded at emission, so the served payload has
always been the province's own land and nothing else (verified: across 16 adjacent provinces, **zero
shared cells**). That left one thing wrong at the seam, on the CLIENT rather than in the data.

A terrain blend asks "which terrain owns this corner", and a corner of a border plot is touched by
plots in another province. The web answers that from a global index keyed by source pixel
(`js/terrain-corners.mjs`), which is correct but only *eventually*: a province baked before its
neighbour loaded blends its border against a partial picture, records the corners it could not
resolve as `_tblendGaps`, and re-bakes when one of them resolves. Right after the neighbour arrives —
and, because fetching is viewport-bounded, possibly not until you pan.

So each province now also ships its **neighbour ring**: the halo cells immediately outside it, with
their terrain and relief. Four facts about it:

- **Eight neighbours, not four.** A corner is shared by up to four plots, so the diagonal neighbour
  owns one too; a 4-neighbourhood ring would leave every province's corner-most vertices unresolved,
  which is exactly where a seam shows.
- **Ground only.** A halo cell that is not ground belongs to a neighbouring *water* province, whose
  terrain variant is that province's own generation and is not computed here. Water keeps the
  eventual-consistency path; this closes the land-to-land case, which is the one that shows.
- **It is not plots.** The persisted envelope became an object, `{plots, edge}` — the ring is a
  SIBLING of the plot list, never an entry in it. `ProvincePlotStore.load` returns plots only, so the
  sim cannot see a neighbour's ground as this province's land, and on the client the ring never
  enters `p._plots` (which everything downstream counts: hover, the hamlet grouping, foliage, the
  city screen, the "N urban plots" caption).
- **It is provisional.** A ring cell carries the *world ground* — the pure function of position every
  province agrees on — while the province that owns it may then apply its own membership overrides.
  So the client keeps the ring in a second map that a real plot always beats, and `cornerResolved`
  stays blind to it: the ring changes what the first bake LOOKS like, never what is true, and the
  existing re-bake still corrects the rare disagreement. (Measured on 4411↔4412: 15 ring cells land
  on the neighbour's plots and **all 15 agree** with what it emits.)

Cost, measured on the demo neighbourhood: province 4411 gains 42 ring cells against 74 plots, and the
gzipped payload averages **2.0 KB** across sixteen provinces. `saveKeepingEdge` exists because the
place-naming pass loads a field, renames plots and writes it back — a plain save of what `load`
returned would silently erase the ring.

Covered by `SeamlessGenerationTest` (the four invariants above) and `WorldClimateTest` (field
continuity + determinism). `TerrainPreviewExporter` renders a whole region to a PNG and prints the
seam score and border profile — the fastest way to eyeball a generation change without a rebake.

## Temperature — one model, authored climate authoritative (same increment)

**The bug.** Cannor — Anbennar's temperate heartland — generated as snow. Three separate temperature
scales existed (`ClimateTerrainGenerator.temperature` for the ground bands, `ClimateProfile.of` for
`isHot`, `ClimateProfile.pyTemperature(latitude)` for the feature stage), and the ground one stacked
a climate base, a winter-severity cooling of **up to 16 °C**, and a poleward lapse of **0.4 °C/deg
beyond 30°** — on top of a latitude that is an **inverse-Mercator artifact** of the EU4 map. That
projection puts Cannor at |lat| **60–75°**. The stack put **1542 of 4121 land provinces below 0 °C**,
i.e. drawing from the tundra/permafrost bands:

| Superregion | sub-zero, before | after |
| --- | --- | --- |
| Western Cannor | 82% | 0% |
| Escann | 95% | 0% |
| Kheionai | 83% | 0% |
| Taychend | 51% | 0% |
| Gerudia (genuinely arctic) | 100% | 14% |

Anbennar's own `climate.txt` marks only **116 provinces arctic**. Two more contributors keyed on the
same inflated latitude: the sea terrain banded to its `_POLAR` variant at |lat| ≥ 66 and the ice cap
started there, so Cannor's *seas* froze too; and the feature stage read `pyTemperature(66°) ≈ 0`,
landing Cannor in the C2C `5…−10 → SWAMP` branch.

**The fix.** One temperature model, `WorldClimate.controlTemperature`, feeding the ground bands, the
feature stage, the sea-ice model and the polar water variant alike — as the C2C script does with its
single `getTileTemperature`. The **C2C band table is unchanged**; only the temperature handed to it
is re-derived:

- **authored climate anchors** it — tropical 27 (inside the grass band, so the ground greens and the
  feature stage supplies the jungle), arid 32 (clears the desert gate), temperate 19, arctic −4;
- **winter severity** is a modest modifier — 0 / −2 / −5 / −9 (was 0 / −5 / −10 / −16). A harsh
  winter makes a province boreal; it does not make it permafrost;
- **latitude** is demoted to a gentle lapse: −0.25 °C/deg beyond |lat| 55 (was −0.4 beyond 30);
- **polar water** keys on temperature (`ProvincePlotField.POLAR_TEMPERATURE`), not |lat| ≥ 66, and a
  sea inherits the climate of its nearest coast (water provinces are not control points, so the
  field's BFS fill hands them their shore's value) — a sea ices because the land around it is frozen.

Cold ground in Lencenor: **45.9% → 0.0%**. Gerudia (the Scandinavia analogue) still generates 58%
cold — permafrost 21%, taiga 15%, tundra 12%, glacier 10%. The full engine + server suites pass with
no retuning, including `PlotYieldTest`'s mean-food-factor calibration.

**Known consequence.** Shifting the temperate world out of the frozen bands moved it into the
**marsh** band (`−5…18`, weight 10 — the single heaviest entry in the C2C table, and the one weight
the script does *not* scale by humidity). Lencenor's marsh share went 25.2% → 34.3%. That is what the
faithful table gives at temperate temperatures, so it is left alone; scaling marsh by humidity the
way the neighbouring bands are scaled is the available knob if a third of Cannor as wetland reads
wrong.

**Not changed, but the same bug:** `LandRouter` still costs land travel off
`LatitudeClimate.effectiveTemperature(latitude, winter)` — the old inflated-latitude model — so all of
Cannor is priced as near-arctic terrain (up to 3.5× travel cost). That is a routing/caravan concern
rather than a terrain one and was left out of this change deliberately; pointing it at
`WorldClimate.controlTemperature` is the fix when someone wants to take the behaviour change.

**Still pending** (planned increments): making **features fully procedural** (they still read the
`trees.bmp` hints for the vegetation *kind*). Plus the food-economy recalibration the yield shift
invites.

---

*Planned 2026-07-12. Decisions locked with owner: fully-procedural terrain (ignore `terrain.bmp`), hybrid
relief (heightmap backbone + C2C variation), geography kept (shape/rivers/coast), **seed-independent**,
**coherent-patch** distribution, **per-plot-latitude** temperature, and **accept the food-balance shift**.
Largely promotes the existing faithful C2C ports from fallback to primary. When it lands, update
`docs/plots.md`/`province-plots.md` and the `docs-stale-terrain-pipeline` note, and cross-link here.*
