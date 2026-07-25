# Porting the C2C planet generator to Java

Reference for bringing the Java per-plot generator into faithful agreement with the upstream
**Caveman2Cosmos** map script, `data/civ4/C2C_Planet_Generator_0_68.py` (3893 lines). The goal (see the
`port-c2c-generator-faithfully` memory) is to mirror the Python algorithm — same constants, same order —
not a loose reimplementation.

Java side to touch: `com.civstudio.geo.FeatureGenerator`, `ProvincePlotField`, `MapTerrainCodec`,
`ClimateProfile`, `ReliefGenerator`, `TerrainGenerator`, `BonusGenerator` (+ `TerrainRegistry`,
`FeatureExporter`). Line references below are into the Python file (`L####`) and the Java files as noted.

---

## Status (2026-07-08)

| Slice | State | Notes |
|---|---|---|
| Prereqs (temp/pyCategory/WeightedPick) | **done** | `ClimateProfile.pyTemperature`, `PyTerrain`, `WeightedPick` (+ `C2CFeaturePrereqTest`) |
| 1–3 feature choice + spread | **done** | rewrote `FeatureGenerator` (seed-and-spread, peak seeding, 8-conn, river-crossing block, weighted stop, jungle→forest-on-cold). **§2 decided: "feature consequences only" — no ground rewrite** (see the `c2c-feature-port-no-terrain-rewrite` memory). Tests: `C2CFeatureSpreadTest`, `ProvincePlotFieldTest` |
| 4 appearance scatter | **done** | `<iAppearance>` exported onto `Feature`; `ProvincePlotField.appearanceScatter` — unlocks forest_ancient/bamboo/very_tall_grass |
| 5 oasis scoring | **done** | `ProvincePlotField.placeOases` (feature-only) |
| 7 mid-latitude ice | **done** | temperature-driven drift ice in `generateWater`; coincides with the polar band under the default tent |
| 6 terrain diversification | **declined** | rewrites real ground → conflicts with the §2 decision and the `terrainComesFromTheRealMapNotTheClimatePool` test (asserts LUSH/MUDDY==0). Would only be admissible gated to unmapped pixels, which is near-inert |
| 8 bonus placement | **done** (per-province) | exported the placement fields (`iPlacementOrder`/`iConstAppearance`/`Rands`/`iTilesPer`/`iMinAreaSize`/`iGroupRange`/`iGroupRand`) onto `Bonus`; `BonusGenerator.place` runs the constrained placement **per province** (order + target density + group spacing/clustering). Faithful in-spirit; counts/spacing are province-local, not global — the one gap forced by eos's lazy per-province caching. Test: `BonusPlacementTest` |

### Update (2026-07-25, `MAP_VERSION` 11) — one temperature, sampled from a field

The **Prereqs** row above resolved the per-plot-temperature impedance mismatch by option (a): reproduce
the Python tent from latitude, so the thresholds transfer verbatim. That turned out to be wrong *for this
map* — Anbennar's latitudes are inverse-Mercator over the full 2048-row raster, so its temperate heartland
sits at |lat| 60–75° and the tent read it as sub-freezing. The generator now has **one** temperature,
`WorldClimate.controlTemperature`, anchored on Anbennar's authored `climate.txt` with latitude demoted to
a gentle lapse — and the **feature stage reads the same value** the terrain bands do, which is what the
script does with its single `getTileTemperature`. Every weight table and threshold below is unchanged;
only the scale feeding them was re-derived. `ClimateProfile.pyTemperature` survives as the documented
Python tent but no longer drives generation.

The stages also now run over a mask **halo** of neighbouring land (`ProvinceMask.isGround`) rather than
this province's pixels alone, and the ground is a pure function of world position. Two fidelity notes
follow from that: `isCoastal` is the real sea mask (the script's `isCoastal`), not "outside this
province"; and peak seeding/growth (§3) can now actually reach a province border, which it never could
before. Full write-up in `docs/plot-generator.md` §Seamless generation / §Temperature.

The whole-world plot caches + `web/assets/plots.pack` are regenerated after any of these change
(`WorldPlotGenerator` then `node web/build.mjs <seed>`); the caches are gitignored and the generator
skips already-present provinces, so a regen must delete them first.

---

## 0. Scope — what to port vs. what eos already supersedes

eos is a **hybrid**: it imports the real EU4/Civ4 map (`terrain.bmp`, `trees.bmp`, `heightmap.bmp`,
`rivers.bmp`) via `ProvinceRaster`/`MapTerrainCodec`, so much of the Python is replaced by real data and
should **not** be ported:

| Python stage | eos status |
|---|---|
| `generatePlotTypes` (continents/plates/hills/peaks, world-shape) | replaced by the real heightmap + `ReliefGenerator` clustering |
| base terrain from latitude-temperature (`addFeatures` §2, per-row weighted draw L2714–2784) | replaced by real `terrain.bmp` (`MapTerrainCodec.ground`); the Python weights survive only as `TerrainGenerator`'s *fallback* pool for unmapped pixels |
| `addRivers` / `addLakes` (L2627, L2644) | `allowDefaultImpl` in C2C (engine) → replaced by real `rivers.bmp` |
| `addBonuses` / `normalize*` (L3314+) | `allowDefaultImpl` / `placeC2CBonuses` in C2C (engine XML) → eos re-implements the constraint test only (see §8) |

**The only substantial *custom* Python per-plot logic is `addFeatures()` (L2650–3176).** That is the port
target. The slices below are ordered by value; slices 1–3 are one coherent chunk (the feature
seed-and-spread) and are the headline work.

### Prerequisites shared by all feature slices

Before porting the feature weights, resolve three impedance mismatches — get these wrong and every
threshold below is off:

- **Per-plot temperature on the Python scale.** The Python weights key off `getTileTemperature(y,h)`
  (L3301): a latitudinal tent, equator = `climateTemperature` (default **40**), poles =
  `lowestTemperature = (climateTemperature+50)·climateVariation − 50` (default `(90·0.4)−50 = −14`).
  eos's `ClimateProfile.temperature()` is a **different scale** (TROPICAL 45 … ARCTIC 0, `ClimateProfile.java:24-37`)
  and is per-**province**, not per-plot. Either (a) add a per-plot temperature `tempAt(lat)` reproducing the
  Python tent so the thresholds (`>30`, `>40`, `5..−10`, `<−20`…) transfer verbatim, **or** (b) re-express
  every threshold in eos's scale. Option (a) is the faithful choice.
- **eos-terrain → Python-category map.** The Python weights branch on `desert / plains / grass / marsh /
  tundra / permafrost / snow`. eos plot terrain comes from `MapTerrainCodec.ground` as Civ4 ids
  (`GRASSLAND, DESERT, PLAINS, MARSH, ROCKY, PERMAFROST, SCRUB, LUSH, TAIGA, TUNDRA, …`,
  `MapTerrainCodec.java:45-77`). Add a small classifier `pyCategory(Terrain)` mapping eos terrain →
  {desert, plains, grass, marsh, tundra, permafrost, snow} so the weight tables apply. **Mind the name
  swap** (§ Fidelity).
- **Humidity `H`.** Python uses one global `climateHumidity` scalar (default **0.5**, `addFeatures` L2663).
  eos has per-province `ClimateProfile.humidity()` (`ClimateProfile.java:39-51`) — *better* data; use it as
  `H`. Likewise eos's feature **density** already comes from real `trees.bmp` (`treeCover`,
  `ProvincePlotField.treeCover` 217-233), which is better than Python's humidity — **keep eos's density
  source** and port only the spread/choice/rewrite logic around it.
- **Determinism.** All new draws must ride the dedicated terrain RNG and consume a fixed number of draws
  per cell regardless of outcome (the existing generator is careful about this — e.g.
  `ProvincePlotField.java:278-289`). Preserve that.

---

## 1. Per-plot feature choice (weighted), not a province hot-flag

**Python** (`addFeatures` 4a, L2794–2900) builds a `probabilityArray randomFeat` per fresh land seed and
picks `randomFeat.randomItem(dice)`:
- **No-feature decay** L2797: `randomFeat[distanceFromRiver·14·(1−H)] = None` (+ extra None for hot tiles L2799).
- **Feature weights by terrain** L2828–2850: desert→jungle w1; grass→jungle w1 (if temp>20) + forest w3;
  plains→jungle w2 (if temp>25) + forest w3; marsh→swamp w3; tundra→forest w3; permafrost→forest w3; any
  non-cold temp>30→jungle w1 (again if H>0.8).
- **Floodplains** L2852–2883: standard mode → only riverside non-hill desert, temp-gated, big weight `60+…`.
- **Temperature override** L2885–2895: temp>40→jungle w2; `5..−10`→swamp w2; `>−20`→forest w2; else forest w1.

**Java today**: `FeatureGenerator` places jungle-if-`climate.isHot()`-else-forest *per province*
(`FeatureGenerator.java:61`) and only its **presence flag** is used; the real feature is resolved by
`ProvincePlotField.vegetationFeature` from the real terrain codec (`ProvincePlotField.java:264-275`). So the
Python's per-plot terrain+temperature **weighted mixing** is absent.

**Port plan**: replace the province-level kind with a per-cell `chooseFeature(terrainCat, temp, H, dist,
riverSide)` returning the weighted pick (or none), porting the tables verbatim (using a small
`WeightedPick` helper mirroring `probabilityArray`: append-if-weight>0, pick proportional to weight —
note repeated `value` at different weights add **cumulative** entries). Keep validity-gating via
`ProvincePlotField.valid()` afterward (host terrain / flat) so an invalid pick falls back as it does now.

---

## 2. Terrain-rewriting as features spread — the headline gap

**Java explicitly defers this**: `FeatureGenerator.java:22-25` — *"the terrain-rewriting the C2C stage does
as features spread (jungle turning desert to grass, etc.) is left for a later slice — this slice only
places the feature overlay."* And `ProvincePlotField.java:25-26` — *"the temperature-driven terrain
refinement is deferred."*

**Python** rewrites terrain in three places:
- **Pre-spread wetting** (before choosing a feature, L2801–2825): fresh-water non-riverside desert→grass
  (60%) else plains; plains→grass (rand>0.7). Coastal non-fresh: desert→plains (rand>0.3); plains→grass
  (rand>0.3, temp>5); tundra→grass (rand>0.6, temp>5).
- **On placing the feature, its OWN plot** (L2956–2987): **Jungle** — fresh→grass; desert→plains(rand>0.6)
  else grass; plains→grass(rand>0.1); **on cold (tundra/permafrost/snow) → substitute FOREST for jungle**
  (`setFeatureType(featForest)`). **Forest** — desert→plains(rand>0.3) else grass; plains→grass(rand>0.4).
  **Flood** — non-fresh: snow→taiga, permafrost→taiga.
- **On the NEIGHBOUR it spreads into** (L2990–3070): jungle "greens" a desert neighbour (60%) →
  plains/copy-source, tundra→plains/copy, snow→(50%) plains else tundra; forest greens desert (30%)→
  plains/copy.

**Port plan**: implement in the spread loop as `rewriteSelf(plot, feature)` and `rewriteNeighbour(nb,
feature, srcTerrain)`, porting the exact RNG gates and the jungle→forest cold substitution. The cold
substitution is why C2C has **no jungle on tundra/snow** — reproduce it rather than gating jungle out
elsewhere.

> **Open design decision (flag before implementing):** eos's base terrain is the *real EU4 map*. Rewriting
> it (jungle greening a desert plot) overrides real data. Options: (a) full faithful rewrite (matches C2C
> look, diverges from EU4 ground); (b) apply rewrite only where terrain was `TerrainGenerator`-drawn
> (unmapped pixels), leaving real terrain intact; (c) rewrite only the *feature choice* consequences (the
> jungle→forest-on-cold substitution) but not the ground colour. Decide per the desired look; the doc ports
> the full algorithm, the caller can gate it.

---

## 3. Spread topology: 8-connectivity, peak seeding, river-crossing block

**Python**:
- **Seeds** (L2782) = peak **or** fresh water **or** coastal (`isCoastal`). eos seeds only river+coastal
  (`FeatureGenerator.java:66-70`) — **missing peak seeds**.
- **Peak seeding** (4b, L2902–2949): a peak scores a 5×5 (`getTilesAroundDistance(...,2)`) from 80 (−20 per
  existing feature, −5 non-desert, −20 fresh, −5 water, +7 per peak); if `score>0`, for its 8 neighbours
  with prob `0.1 + H·0.6` enqueue a seed with a **preassigned** feature by temperature (temp>40 jungle;
  >35 60/40 jungle/forest; >28 20/80; >24 5/95; else forest), `distanceFromRiver = 2`.
- **8-connected spread** (`getTilesAround`, L2990) vs Java's 4-connected `DIRS4` (`FeatureGenerator.java:99`).
- **River-crossing block** (`isRiverCrossing`, L3179): jungle/forest do **not** spread across a river edge
  (L3008, L3052). eos has per-plot `riverCode` but no per-edge crossing test — add one from the flow/adjacency
  bits in `ProvinceRaster.classifyRiver` (`ProvinceRaster.java:256-282`).
- **Distance increments**: +1 (jungle/forest), **+3** (flood), base seed 1, peak-seed 2. **Stop option**:
  L3071 injects a `None` at `posList[len/2]` before `posList.random` — a probabilistic termination; port it
  (eos currently terminates via `MAX_SPREAD=4`, `FeatureGenerator.java:30` — reconcile: Python has no hard
  cap, it terminates on the distance-decayed no-feature/stop weights).

**Port plan**: fold peaks into the seed list, switch the neighbour enumeration to 8-connected, add
`isRiverCrossing(a,b)`, and replace the `MAX_SPREAD` hard stop with the weighted stop-option +
distance-decay so growth terminates as in C2C. (eos's relief already knows peaks via `ReliefGenerator` +
`MapTerrainCodec.relief`, `ProvincePlotField.java:143,238-240`.)

---

## 4. Generic appearance-probability scatter — unlocks the "dead" features

**Python** (end of §6, L3168): for any still-featureless non-water plot, iterate **all** feature infos and
`if plot.canHaveFeature(iI) and dice.get(10000) < feature.getAppearanceProbability(): set it`.

**Java**: no equivalent. This is exactly why `FEATURE_FOREST_ANCIENT`, `FEATURE_BAMBOO`,
`FEATURE_VERY_TALL_GRASS` are exported (`FeatureExporter.java:38-42`) but **never placed** — no path rolls
their appearance probability.

**Port plan**: export each feature's `<iAppearanceProbability>` from `CIV4FeatureInfos.xml` onto the
`Feature` record (dormant field like the bonus ones), then add a final `ProvincePlotField` pass over bare,
valid plots that rolls `rng.uniform() < prob/10000` per candidate feature. Small change; immediately makes
the three curated features live. (Then bake their art per `docs/features-art.md`.)

---

## 5. Oasis scoring & placement

**Python** (§5, L3076–3135): full-map scan; eligible = desert, non-fresh, non-hill, non-peak, non-coastal;
score from 10 with neighbour penalties (−20 fresh/riverside, +1 empty nbr, −5 jungle nbr, −3 forest nbr,
−20 flood nbr; terrain +1 desert / −2 plains / −6 grass / −20 tundra-snow; +1 nbr no-yield); place on
`len(candidates)/3` random candidates, skipping any adjacent to an existing oasis, abort after 20 misses.

**Java**: `OASIS` is emitted only where real `trees.bmp` paints the palm class (idx 12,
`MapTerrainCodec.treeFeatureKey`), no scoring. **Port plan**: add the scoring pass as a post-feature stage
in `ProvincePlotField` (province-local; the "abort after 20 misses" and candidates/3 translate directly).
Lower priority — eos's real-map palms already give plausible oases.

---

## 6. Terrain diversification into C2C variants

**Python** (§6, L3137–3167): final scan remaps base terrain by weighted draw — desert →
desert(2)/`SALT_FLATS`(1)/`DUNES`(4)/`SCRUB`(3); plains → plains(3)/`BARREN`(1)/`ROCKY`(2); grass →
grass(2)/`LUSH`(3)/`MUDDY`(1).

**Java**: `MapTerrainCodec.ground` maps real EU4 terrain to base Civ4 ids with **no** probabilistic
diversification, so ground reads flatter than C2C. **Port plan**: optional post-terrain pass in
`ProvincePlotField` applying these weighted remaps (guarded so it only diversifies base grass/plains/desert,
not already-specific real terrain). Requires the variant terrains (`SALT_FLATS/DUNES/BARREN/…`) to be in the
`TerrainRegistry` (some, `LUSH/SCRUB/MUDDY`, already are). Lower priority / affects look only.

---

## 7. Water ice — add mid-latitude drift ice

**Python** (§3, L2746–2780): **polar cap ice** within `poleSeparation` rows (prob `(poleSeparation −
distanceToPole)/poleSeparation`) **plus cold open-water ice** by temperature (`iceOnWater=0.5`): `<−40`→1.0,
`<−25`→0.5, `<−10`→0.25, `<−5`→0.167, `<0`→0.125.

**Java**: `ProvincePlotField.generateWater` places ice **only ≥66° latitude** with a coverage ramp
(`ProvincePlotField.java:177-211`). **Port plan**: add the temperature-driven cold-open-water branch (needs
the per-plot temperature from the Prereqs) so cold sub-polar seas get drift ice. Small.

---

## 8. Bonus placement (engine XML rules — port target is the engine, not the script)

C2C delegates bonuses to the engine (`placeC2CBonuses`), so there is **no Python to port**; eos's
`BonusGenerator` re-implements only the eligibility test with a flat `PLACEMENT_CHANCE = 0.08` + uniform
pick, and explicitly flags the gap (`BonusGenerator.java:20-23`): no rarity weighting, group spacing,
`<TilesPer>`, `<PlacementOrder>`, or area limits. **Port plan** (separate, larger): export the placement
fields from `CIV4BonusInfos.xml` and implement a map-wide placement pass (per-area target counts from
`TilesPer`, order by `PlacementOrder`, min-spacing between same-bonus groups). This is a distinct effort
from the `addFeatures` port and can follow it.

---

## Fidelity gotchas (do not skip)

- **Terrain name swap** — the Python variable names ≠ XML ids: `terrainTundra`→`TERRAIN_TAIGA`,
  `terrainPermafrost`→`TERRAIN_TUNDRA`, `terrainSnow`→`TERRAIN_ICE` (L2676–2693). Map to eos terrain
  accordingly (eos `TAIGA` = Python "tundra", eos `TUNDRA` = Python "permafrost", eos `ICE`/`PERMAFROST` =
  Python "snow"). Getting this wrong inverts all the cold-terrain feature logic.
- **Doubled `plains` weight** — plains is added twice in the base-terrain array (bands 15–39 and −2..25
  overlap, L2723/2729), so its effective weight is higher in the 15–25 range. (Only matters if the terrain
  *fallback* pool is re-derived; the real map supersedes it.)
- **Humidity-scaled weights** — carry the exact forms `7·(1.5−H)`, `7·(H+0.5)`, `15·(H/2+0.75)`,
  `distanceFromRiver·14·(1−H)`, peak-seed prob `0.1 + H·0.6` (H = eos `ClimateProfile.humidity()`).
- **`probabilityArray` semantics** — `arr[weight] = value` **appends** (only if weight>0) and repeated
  values accumulate; `.random()`/`.randomItem()` pick proportional to weight. A faithful `WeightedPick`
  helper must match this (append, don't overwrite).
- **RNG order/count** — keep one terrain-stream draw per decision point even when the outcome is "nothing",
  as the current generator does, so `(seed, province)` stays reproducible.

---

## Suggested order

1. **Prereqs** (per-plot temperature on the Python scale, `pyCategory` terrain map, `WeightedPick` helper).
2. **Slices 1–3 together** (the `addFeatures` seed-and-spread: weighted per-plot choice + terrain-rewriting
   + peak-seeding/8-connectivity/river-crossing) — the headline, and the piece Java flagged deferred. Decide
   the §2 open question (rewrite real terrain or only generated) first.
3. **Slice 4** (appearance-probability scatter) — small, unlocks the three dead features + their art.
4. **Slice 7** (mid-latitude ice) — small.
5. **Slices 5, 6** (oasis scoring, terrain diversification) — look polish, optional.
6. **Slice 8** (bonus placement) — separate, larger engine port.

Cite the Python function in the Javadoc of each ported method, as the existing generators already do
(`FeatureGenerator`, `ReliefGenerator`). Validate reproducibility with the existing plot-field tests and a
`WorldPlotGenerator` regen before/after.
