# Reference: engine exporter datasets (studio data-model source of truth)

> Companion to [`studio-datamodel-rebuild-plan.md`](studio-datamodel-rebuild-plan.md). This is the
> measured inventory of every dataset the `civstudio-engine` exporters emit — the raw material the
> rebuilt Strapi model mirrors. Counts are actual top-level array lengths at time of survey
> (2026-07-18); field types: `s`=string, `i`=int, `n`=float, `b`=bool, `[…]`=array, `{…}`=object,
> `enum-s`=string enum. FK notes point at the key/id another dataset is joined on.

All paths are under `civstudio-engine/src/main/resources/` (`generated/` unless noted). Exporters
live under `com.civstudio.{geo,tech,settlement,good}.export`.

## A. World-map geography — `generated/map/*.json`

| # | File | Entity | Count | Exporter | Key fields (→FK) |
|---|------|--------|------:|----------|------------------|
| 1 | `map/provinces.json` | Province | 5268 | `ProvinceExporter` (+History/Cavern/Continent/Realm/Climate overlays) | `id`i(PK), `name`s, `lat`n, `lon`n, `plots`i, `waterPlots`i, `type`enum-s, `region`s→region.key, `area`s→area.key, `continent`enum-s, `realm`enum-s, `winter`/`monsoon`/`climate`enum-s(opt), `owner`/`controller`s→country.tag, `culture`s→culture.key, `religion`s→religion.key, `trade_goods`s→tradegood.key, `base_tax`/`base_production`/`base_manpower`i, `city`b, `neighbors`[i]→province.id |
| 2 | `map/countries.json` | Country | 1454 | `CountryExporter` | `tag`s(PK), `name`s, `color`s(#rrggbb) |
| 3 | `map/cultures.json` | Culture | 617 | `CultureExporter` | `key`s(PK), `name`s, `group`s, `color`s |
| 4 | `map/religions.json` | Religion | 118 | `ReligionExporter` | `key`s(PK), `name`s, `group`s, `color`s |
| 5 | `map/tradegoods.json` | TradeGood | 36 | `TradeGoodExporter` | `key`s(PK), `name`s, `color`s, `category`enum-s = FOOD\|LUXURY\|STRATEGIC\|MANUFACTURED\|MAGICAL |
| 6 | `map/areas.json` | Area | 1573 | `AreaExporter` | `key`s(PK), `name`s, `provinces`[i]→province.id |
| 7 | `map/regions.json` | Region | 178 | `RegionExporter` | `key`s(PK), `name`s, `areas`[s]→area.key |
| 8 | `map/superregions.json` | SuperRegion | 32 | `SuperRegionExporter` | `key`s(PK), `name`s, `regions`[s]→region.key |
| 9 | `map/adjacencies.json` | Adjacency | 285 | `AdjacencyExporter` | `from`i→prov, `to`i→prov, `type`enum-s = sea\|canal\|lake\|"", `comment`s |
| 10 | `map/edges.json` | ProvinceEdges | 5268 | `LandRouteExporter` | `id`i→prov, `km`[n] (parallel to province.neighbors) — pure geometry |
| 11 | `map/portals.json` | ProvincePortals | 6094 | `PortalExporter` | `id`i→prov, `portals`[{`to`i→prov,`x`i,`y`i}] — pure geometry |
| 12 | `map/route-models.json` | RouteModelInfo | 350 | `RouteModelExporter` | `routeType`s→route.type, `modelFileKey`s, `modelFile`s, `lateModelFile`s, `animated`b, `connections`s, `modelConnections`s, `rotations`[i] — art |
| 13 | `map/terrain-art.json` | TerrainArtInfo | 25 | `TerrainArtExporter` | `terrain`s→terrain.type, `artTag`s, `path`s, `grid`s, `detail`s, `layerOrder`i, `alphaShader`b, `blend`{} — art |

Enum value sets (from real data):
- Province `type` = LAND, CAVERN, DWARVEN_HOLD, DWARVEN_HOLD_SURFACE, DWARVEN_ROAD, ANCIENT_FOREST, GLADEWAY, FEY_GLADEWAY, BLOODGROVES, MUSHROOM_FOREST, SHADOW_SWAMP, GLACIER, SEA, LAKE, IMPASSABLE
- `realm` = cannor, serpentspine, haless, sarhal, aelantir, hinuilands (NONE = absent; `halcann` is a RETIRED value kept readable — docs/realms.md §Halcann must be migrated); `continent` = europe, serpentspine, asia, africa, north_america, south_america, oceania
- `winter`/`monsoon` = mild, normal, severe (NONE); `climate` = arctic, arid, tropical (TEMPERATE = default/absent)

## B. Tech tree — `generated/*.json`

| # | File | Entity | Count | Exporter | Notes |
|---|------|--------|------:|----------|-------|
| 14 | `techs.json` | Tech | 339 | `TechInfoExporter` | Raw C2C casing. `Type`s(PK), `name`s, `help`s, `Quote`/`quote`s, `Description`s, `Civilopedia`s, `Advisor`enum-s(ADVISOR_*), `iCost`s(num-string), `Era`enum-s(C2C_ERA_*), `bTrade`/`bGoodyTech`s, `iGridX`/`iGridY`s, `Flavors`{}, `OrPreReqs`/`AndPreReqs`{`PrereqTech`:s\|[s]}→tech (graph edges), `Sound`s, `Button`s. **Numeric fields are strings.** |
| 15 | `building-unlocks.json` | tech→building overlay | ~280 keys | `BuildingInfoExporter` | `{ "TECH_*": [{target→building.id, kind:"UNLOCK"}] }` — model as tech↔building relation |
| 16 | `unit-unlocks.json` | tech→unit overlay | ~98 keys | `UnitInfoExporter` | `{ "TECH_*": [{kind:"UNLOCK", target→unit.id}] }` — model as tech↔unit relation |
| 17 | `resources/tech-effects.json` (+`-harimari`) | eos tech-effect overlay | `{}` empty | hand-authored | Placeholder stub; root `resources/`, not `generated/` |

## C. C2C buildings & units — `generated/*.json`

| # | File | Entity | Count | Key fields |
|---|------|--------|------:|-----------|
| 18 | `buildings.json` | Building | 1270 | `id`s(PK,BUILDING_*), `name`s, `pedia`s, `category`enum-s = CULTURE\|ECONOMY\|GROWTH\|MILITARY\|RELIGION\|SCIENCE, `prereqTech`s→tech, `andTechs`[s], `artDefineTag`s, `button`s, `cost`s(num-string) |
| 19 | `units.json` | Unit | 273 | `id`s(PK,UNIT_*), `name`s, `pedia`s, `prereqTech`s→tech, `andTechs`[s], `combatClass`enum-s→unit-combat.id, `defaultUnitAI`enum-s, `caravanRole`enum-s = COVERT\|EXPLORER\|HEALER\|HUNTER\|MILITARY\|MISSIONARY\|SETTLER\|TRADE\|WORKER, `domain`enum-s, `iMoves`i, `iCombat`i, `obsoleteTech`s→tech, `quality`enum-s, `bandSizeClass`enum-s, `artDefineTag`s, `button`s, `builds`[s]→improvement/route, `special`s, `species`s |
| 20 | `unit-combats.json` | UnitCombat | 28 | `id`s(PK,UNITCOMBAT_*), `name`s, `signatureSkill`enum-s(12 skills), `categoryButton`s, `iEarlyWithdrawChange`/`iTauntChange`/`iDodge…`/`iDamage…`/`iPrecision…`/`iCaptureResistance…`i, `bForMilitary`b |

## D. Plot-terrain reference — `generated/*.json`

| # | File | Entity | Count | Key fields |
|---|------|--------|------:|-----------|
| 21 | `terrains.json` | Terrain | 33 | `type`s(PK,TERRAIN_*), `yields`[i]×3, `bFound`b, `buildModifier`i, `healthPercent`i, `movement`i |
| 22 | `features.json` | Feature | 11 | `type`s(PK,FEATURE_*), `yieldChanges`[i]×3, `clearCost`i, `requiresFlatlands`b, `requiresRiver`b, `validTerrains`[s]→terrain, `healthPercent`i, `growth`i, `movement`i, `appearance`i |
| 23 | `bonuses.json` | Bonus | 106 | `type`s(PK,BONUS_*), `bonusClass`enum-s, `yieldChanges`[i]×3, `techReveal`s→tech, `techCityTrade`s→tech, `health`i, `happiness`i, `min`/`maxLatitude`i, `hills`/`flatlands`/`peaks`b, `validTerrains`/`validFeatures`/`validFeatureTerrains`[s], `placementOrder`i, `constAppearance`i, `randApps`[i]×4, `tilesPer`i, `minAreaSize`i, `groupRange`i, `groupRand`i, `techEra`i |
| 24 | `manufactured-bonuses.json` | Bonus (manufactured) | 326 | Same schema as #23, `bonusClass`=BONUSCLASS_MANUFACTURED — **merge into `bonus`** |
| 25 | `improvements.json` | Improvement | 12 | `type`s(PK,IMPROVEMENT_*), `yieldChanges`[i]×3, `prereqTech`s→tech, `hillsMakesValid`/`freshWaterMakesValid`b, `validTerrains`/`validFeatures`[s], `buildCost`i, `healthPercent`i, `upgradeType`s→improvement(self), `upgradeTime`i, `culture`i, `actsAsCity`b, `techYieldChanges`[…] |
| 26 | `routes.json` | RouteType | 12 | `type`s(PK,ROUTE_*), `value`i(tier), `movement`i, `flatMovement`i, `advancedStartCost`i, `bonusType`s→bonus, `seaTunnel`b, `yields`[i]×3, `trail`b |
| 27 | `recipes.json` | Recipe | 318 | `type`s(PK,BUILDING_*)→building, `outputs`[s]→bonus, `bonus`s, `prereqBonuses`/`vicinityBonuses`/`rawVicinityBonuses`[s], `prereqTech`/`obsoleteTech`s→tech, `prereqBuildings`/`prereqOrBuildings`[s]→building, `prereqOrTerrains`/`prereqOrFeatures`[s], `river`/`freshWater`b |
| 28 | `tier1-providers.json` | TierOneSource | 48 | `type`s(PK), `output`s→bonus, `gatherers`[{`type`s,`prereqTech`s,`bonus`s,`prereqBonuses`[s],`vicinityBonuses`[s],`rawVicinityBonuses`[s],`prereqOrTerrains`[s],`prereqOrFeatures`[s],`river`b,`freshWater`b}] |
| 29 | `housing.json` | HousingBuilding | 56 | `type`s(PK,BUILDING_HOUSING_*), `prereqTech`/`obsoleteTech`s→tech, `obsoletesToBuilding`s→building, `prereqPopulation`i, `freshWater`/`autoBuild`b, `bonus`s→bonus, `prereqBonuses`/`prereqBuildings`/`prereqOrBuildings`/`prereqOrFeatures`/`prereqOrTerrains`[s], `replacements`[s], `health`i, `happiness`i, `yieldChanges`[i]×3, `commerceChanges`[i]×4 |

## E. Calendar / naming — `resources/` root

| # | File | Entity | Count | Key fields |
|---|------|--------|------:|-----------|
| 30 | `feasts.json` (+`-harimari`) | Feast | 31 | `month`i, `day`i, `name`s — hand-authored; `-harimari` = race variant |
| 31 | `human-names/{male,female,dynasty}.json` | name pools | — | hand-authored human; other races generated under `generated/names/<race>/…` (gitignored except committed `harimari/`) |
| 32 | `geo/region-earth-map.json` | region→Earth ISO map | — | `{<regionKey>: "ISO-a2"}` + notes — hand-authored, drives plot place-naming |

## F. Enums / records with NO JSON dataset (definition lives in code)

`era.Era` (C2C_ERA_*), `tech.Advisor` (ADVISOR_*), `agent.Rank`/`RankLadder`, `race.Race`,
`geo.Continent`, `geo.Realm`, `geo.Climate`/`WinterSeverity`/`Monsoon`, `agent.CaravanRole`,
`skill.Skill`. Persisted only as enum keys on the datasets above (or code-defined ladders).

## Relations hub-map (for schema wiring)
- **Province** is the hub: `owner`/`controller`→Country.tag, `culture`→Culture.key,
  `religion`→Religion.key, `trade_goods`→TradeGood.key, `region`→Region.key, `area`→Area.key,
  `neighbors`/adjacencies/edges/portals→Province.id (self); `type`/`continent`/`realm`/`winter`/
  `monsoon`/`climate` are enums.
- Geo hierarchy: Province→Area→Region→SuperRegion; Continent & Realm are parallel partition axes.
- Tech graph: Tech↔Tech (And/OrPreReqs, self); Tech→Building (`building-unlocks`), Tech→Unit
  (`unit-unlocks`); every Building/Unit/Bonus/Improvement/Housing/Recipe carries `prereqTech`→Tech.
- Unit: `combatClass`→UnitCombat, `builds`→Improvement/Route. Terrain layer: Bonus/Improvement/
  Feature `validTerrains`/`validFeatures`→Terrain/Feature; Route.`bonusType`→Bonus.

## Data origins
- **Anbennar EU4**: provinces, countries, cultures, religions, tradegoods, areas, regions,
  superregions, adjacencies, edges, portals, continent/realm/climate overlays, non-human race names.
- **Caveman2Cosmos**: techs, buildings, units, unit-combats, terrains, features, bonuses,
  manufactured-bonuses, improvements, routes, route-models, terrain-art, recipes, tier1-providers, housing.
- **Hand-authored**: tradegood categories, feasts, human names, region-earth-map, tech-effects stub.
