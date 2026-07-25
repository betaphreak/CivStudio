# Terrain Art System — Reference for a Java Port

**Scope:** everything the game draws *on the map tiles* — the ground, the things
growing on it (features), the resources sitting on it (bonuses), the things built
on it (improvements), and the roads/rails/rivers connecting it (routes).

**Source of truth in the mod:**
- Art assets: `UnpackedArt/art/terrain/**`
- Bindings (which asset belongs to which game object): `Assets/XML/Art/CIV4ArtDefines_*.xml`
  and `Assets/XML/Art/CIV4RouteModelInfos.xml`
- Schema: `Assets/XML/Schema/Caveman2Cosmos.xsd`

This is a Civ4 (Gamebryo/BTS) mod — **Caveman2Cosmos (C2C)**. The notes below
describe the *data model and rendering rules*, not the C++ engine internals, so a
Java port can reproduce the behaviour with its own renderer.

> **As-built note (2026-07):** this repo no longer vendors `UnpackedArt/` and no longer
> uses **Git-LFS** — both were removed. The build's sole art source is the committed,
> **non-LFS** `data/civ4/assets/` subset (~24 MB), and `resolveArt` reads only there.
> The `UnpackedArt/…` paths throughout this doc describe the **upstream C2C mod's** layout
> (where the art originates) and the earlier vendoring — not this repo's current tree. To
> add more upstream art, copy it into `data/civ4/assets/`.

---

## 1. Asset pipeline (why the folder is called *Unpacked*Art)

```
ArtSource/            (original working files: .max/.psd-style sources)
    │  export
    ▼
UnpackedArt/art/…     (shipped assets: .nif meshes, .dds textures, .kf/.kfm anims)
    │  PakBuild  (Tools/PackFPKs.bat → PakBuild /I=UnpackedArt /O=Assets /R=C2C /X=bik)
    ▼
Assets/*.fpk          (compressed archives the Gamebryo engine loads at runtime)
```

Key facts (from `Assets/art/Readme.txt`):
- Art no longer lives in `Assets/art`; it lives in `UnpackedArt/art`.
- The engine resolves an art path (e.g. `Art/Terrain/Features/IcePack/Ice01_01.nif`)
  **loose-file-first, then FPK**. Dropping a loose file into `Assets/art/…` overrides
  the FPK content of the same path — the standard hot-patch/dev workflow.
- `.bik` movies are excluded from packing (`/X=bik`) because they can't be FPK'd.
- Art paths in XML are **case-insensitive, `/`-separated, relative to the assets
  root**, and always begin with `Art/` (note: `Art/Terrain/...` even though the
  on-disk folder is lowercase `terrain`).

**Java port implication:** you don't need FPK. Treat `UnpackedArt/art` as the asset
root and resolve XML paths directly against it (case-insensitively). If you ever
need the packed format, `Tools/PakBuild.exe` is the reference packer. *(As built, the
in-use textures are committed non-LFS under `data/civ4/assets/` and `build.mjs`'s
`resolveArt` reads only there; the `UnpackedArt/` tree and LFS were removed — see §10/§11.)*

---

## 2. File types

| Ext | Count* | What it is | Java-port handling |
|-----|-------:|------------|--------------------|
| `.nif` | ~1190 | Gamebryo/NetImmerse 3D model (mesh + material + texture refs) | Convert to glTF/OBJ, or write a NIF loader. `Tools/NifTools` has helpers. |
| `.dds` | ~629 | DirectDraw Surface texture (diffuse/gloss/normal) | Most Java engines load DDS (LWJGL/libGDX do). |
| `.kf`  | ~236 | Keyframe animation clip | Bake into your animation format. |
| `.kfm` | ~67  | Keyframe **manager** (state machine tying `.kf` clips to a `.nif`) | Model as an anim controller. |
| `.tga` | ~100 | Heightmap / blend masks (mostly under `heightmap/`) | Load as raw texture / heightfield. |

\* counts are for `UnpackedArt/art/terrain` specifically.

---

## 3. Folder → consumer map

Every gameplay object references an **`ART_DEF_*` tag**; the matching `ArtDefine`
entry maps that tag to concrete asset paths. Folders under `terrain/`:

| Subfolder | Bound by | Tag family | Notes |
|-----------|----------|-----------|-------|
| `textures/` | `CIV4ArtDefines_Terrain.xml` | `ART_DEF_TERRAIN_*` | Base ground tiles (grass, ice, desert…). Blend/grid/detail DDS. |
| `features/` | `CIV4ArtDefines_Feature.xml` | `ART_DEF_FEATURE_*` | Forest, jungle, ice, reef + C2C extras (bamboo, ancient forest, alien fungus…). 3D `.nif` sets. |
| `resources/` | `CIV4ArtDefines_Bonus.xml` | `ART_DEF_BONUS_*` | Map model for a resource on a tile (wheat, iron…). ~855 files. |
| `routes/` | `CIV4RouteModelInfos.xml` | `ROUTE_*` | Roads, rails, bridges, docks, rivers. ~588 files, **1687** path refs (many rotations). |
| `natural_wonders/` | Feature/Improvement defines | — | Unique map wonders. |
| `heightmap/` | terrain relief renderer | — | Coast blend masks, hills, peaks, flats, ocean tiles. `.tga` masks, not a single `ART_DEF`. |
| `water/`, `waves/`, `sky/` | environment renderer | — | Ocean surface, shoreline waves, skybox. |
| `lights/` | `<LightType>` in defines | `LIGHT_TYPE_*` | Light setups referenced by feature/other defines. |
| `plottextures/` | tile overlays | — | `plottexture.dds` (grid), `areaborder.dds` (culture border). |

> Note: **improvements** (`ART_DEF_IMPROVEMENT_*`, e.g. farm, mine, fort) mostly
> point at `Art/Structures/Improvements/…`, **not** `Art/Terrain/improvements`.
> The small `terrain/improvements` folder is a minor exception. Treat "improvements"
> as a sibling art category to terrain, not a subfolder of it.

---

## 4. Data model (from `Caveman2Cosmos.xsd`)

Below are the exact fields per art-info type. Model each as a Java class; the
`Type` string is the primary key that gameplay objects reference.

### 4.1 TerrainArtInfo — base ground
```
Type          ART_DEF_TERRAIN_ICE            (PK)
Path          .../IceBlend.dds               main blended texture
Grid          .../IceGrid.dds                grid overlay texture
Detail        .../IceDetail.dds              close-up detail texture
Button        atlas ref (see §5)             minimap/UI icon
LayerOrder    int                            paint/blend priority between terrains
AlphaShader   0|1                            use alpha-blend shader
TextureBlend01..15   "index,rotation" pairs  transition tiles vs. neighbours
```
`TextureBlendNN` encodes the 4-bit neighbour bitmask (which of the 4 diagonal
neighbours share this terrain) → which blend tile + rotation to draw. `Blend15`
is the fully-surrounded case and lists many variants. **This is the terrain
auto-tiling table** — replicate it as a 16-entry lookup.

### 4.2 FeatureArtInfo — forests, ice, reefs, etc.
```
Type            ART_DEF_FEATURE_ICE          (PK)
bAnimated       0|1
bRiverArt       0|1                          special river-adjacent rendering
TileArtType     TILE_ART_TYPE_HALF_TILING|PLOT_TILING|… placement mode
LightType       LIGHT_TYPE_SUN|…             lighting rig
fScale          float                        world scale
fInterfaceScale float                        UI/preview scale
Button          atlas ref
FeatureVariety[]                             one or more visual variants:
  ├─ FeatureArtPieces[]
  │    └─ FeatureArtPiece
  │         ├─ ModelFile[]   (several .nif = random pick for variety)
  │         └─ Connections   e.g. "NW NE SE"  → edge-matched to neighbours
  ├─ FeatureDummyNodes[]     attachment points
  ├─ bGenerateRotations      auto-derive rotated variants
  └─ VarietyButton
```
**Connection-based tiling:** a feature that spans adjacent tiles (forest, ice)
picks the `FeatureArtPiece` whose `Connections` matches which neighbouring tiles
also have the feature (directions `N NE SE S SW NW`, hex/plot adjacency). Multiple
`ModelFile`s under one piece = pick one at random for visual variety.

### 4.3 BonusArtInfo — resources on the map
```
Type            ART_DEF_BONUS_BARLEY         (PK)
fScale          float
fInterfaceScale float
NIF             Art/Terrain/Resources/Barley/Wheat.nif
KFM             optional animation manager (may be empty)
Button          atlas ref
FontButtonIndex int    glyph index in the resource font/atlas (city screen, text)
```
Simplest category: one model per resource, optionally animated.

### 4.4 ImprovementArtInfo — built tile improvements
```
Type            ART_DEF_IMPROVEMENT_LAND_WORKED   (PK)
bExtraAnimations 0|1
fScale, fInterfaceScale  float
NIF             Art/Structures/Improvements/…/x.nif
KFM             optional
Button          atlas ref
```

### 4.5 RouteModelInfo — roads / rails / rivers  (`CIV4RouteModelInfos.xml`)
```
ModelFile        Art/Terrain/Routes/Roads/RoadA00.nif   base-era model
LateModelFile    …                                       modern-era swap
ModelFileKey     "A00"                                   short id
Animated         0|1
RouteType        ROUTE_ROAD | ROUTE_RAILROAD | …         which route this serves
Connections      "-" | "N" | "NE" | …                    real neighbour connection this covers
ModelConnections "-" | …                                 connections baked into the mesh
Rotations        "0 90 180 270"                          symmetry: reuse mesh at these yaw angles
```
Routes are the most granular auto-tiling system: for a tile's set of connected
neighbours, pick the `RouteModelInfo` whose `Connections` matches, then apply the
`Rotations` symmetry so one mesh (e.g. a straight segment) covers all four
orientations. `LateModelFile` swaps the look in later eras. This is why `routes/`
has 588 files but 1687 path references.

---

## 5. Button / atlas reference format

Several fields (`Button`, and the `Path` fields via minimap) use an **atlas
reference** string with this shape:

```
<single-path> ,<icon-path> ,<atlas-path> ,<col> ,<row>
```

Example: `,Art/Interface/Buttons/BaseTerrain/Ice.dds,Art/Interface/Buttons/BaseTerrain_TerrainFeatures_Atlas.dds,5,1`

- Field 1 (before first comma): a standalone image (often empty).
- Field 2: individual icon DDS.
- Field 3: a sprite-sheet atlas DDS.
- Fields 4–5: **column,row** of this icon within the atlas grid.
- `-1,-1` means "no atlas cell".

Java port: parse into `{iconPath, atlasPath, col, row}` and blit the sub-rect.

---

## 6. Rendering rules a Java port must reproduce

1. **Terrain auto-blend (16-way):** per tile, compute the 4-neighbour "same terrain"
   bitmask → look up `TextureBlendNN` → draw that transition tile at its rotation,
   ordered by `LayerOrder`. `Grid`/`Detail` textures overlay the base `Path`.
2. **Feature edge-matching:** per feature tile, compute connected-neighbour set →
   pick `FeatureArtPiece` by `Connections`; randomly choose one `ModelFile`;
   optionally auto-rotate (`bGenerateRotations`).
3. **Route auto-tiling:** per route tile, compute connected-neighbour set → pick
   `RouteModelInfo` by `RouteType`+`Connections`; apply `Rotations` symmetry;
   swap `LateModelFile` by era.
4. **Bonus/Improvement:** single model, placed and scaled (`fScale`), optionally
   animated via `KFM`.
5. **Variety via random model pick** keeps repeated tiles from looking stamped —
   seed the RNG by tile coords for determinism.
6. **Layering / z-order:** terrain → routes/rivers → features → improvements →
   bonuses → units (units are a separate art category, out of scope here).

---

## 7. Modules extend the same system

`Assets/Modules/**/*_CIV4ArtDefines_*.xml` add new terrain/features/bonuses that
point at the exotic art in this tree (`alienFungusBlue`, `alienplants`,
`asteroids`, `biogas`, from `War_Of_The_Worlds`, `Pepper2000`, `Alt_Timelines`,
etc.). A port's loader should **merge all `CIV4ArtDefines_*` across base + modules**,
keyed by `Type`, with modules overriding/adding.

---

## 8. Suggested Java architecture

```
model/                 record classes mirroring §4 (TerrainArtInfo, FeatureArtInfo,
                       BonusArtInfo, ImprovementArtInfo, RouteModelInfo)
loader/
  ArtDefinesLoader     JAXB/DOM parse of CIV4ArtDefines_*.xml + RouteModelInfos,
                       merged base+modules, indexed by Type string
  AssetResolver        maps "Art/…" path → file under UnpackedArt/art (case-insensitive)
  NifLoader/DdsLoader  mesh + texture loading (or offline-convert to glTF)
render/
  TerrainBlender       §6.1 — 16-way blend lookup
  FeatureTiler         §6.2 — connection matching + variety
  RouteTiler           §6.3 — connection + rotation symmetry
  AtlasSprites         §5   — button/icon atlas blitting
```

Load order: parse XML defines first (cheap, string-keyed), then lazily load the
referenced `.nif`/`.dds` on first draw. Gameplay code references only the
`ART_DEF_*` / `ROUTE_*` string — the art layer is fully data-driven and swappable.

---

## 9. Concrete worked examples (trace these to validate the port)

- **Ice terrain:** `ART_DEF_TERRAIN_ICE` → `textures/Land/IceBlend.dds` (+Grid/Detail)
  with the full `TextureBlend01..15` table.
- **Ice feature:** `ART_DEF_FEATURE_ICE` → `features/IcePack/Ice01_01.nif …` with
  `<Connections>` per piece — good test of §6.2.
- **Barley bonus:** `ART_DEF_BONUS_BARLEY` → `resources/Barley/Wheat.nif` (+`.kfm`).
- **Road:** `ROUTE_ROAD` → `routes/Roads/RoadA00.nif … A15` with `Connections` +
  `Rotations "0 90 180 270"` — good test of §6.3.

---

## 10. Target is a browser game — web asset delivery (supersedes §8's runtime loaders)

**CivStudio's client is a browser.** The Java code is the simulation/source of
truth; the rendering client is the web app under `web/` (today a **2D `<canvas>`**
map, `web/app.js`; no Three.js/Babylon). So the art must be **delivered to the
browser as pre-converted, web-optimised assets** — §8's "load `.nif`/`.dds` at
runtime" is the wrong target for the client.

**Hard rule — source vs. deliverable.** The upstream C2C `UnpackedArt/art` tree is
**offline source only**; it must **never ship to the client**. The browser receives a
**curated, converted, atlased subset** (target: a few MB total, lazy where possible). The
in-use subset is committed **non-LFS** under `data/civ4/assets/` (~24 MB); the full
upstream tree (the 3D `.nif` meshes are its bulk, and are **not** runtime assets for a 2D
client) is **no longer vendored here** — pull from upstream C2C if you need more.

**Decided: 2D sprites** (matches today's `<canvas>` renderer; 3D WebGL is not the
target). Concretely:

- **Textures** — `.dds` → **WebP/PNG atlases** (WebP preferred; AVIF optional).
- **Meshes** — the 3D `.nif` sets are **not runtime assets**. A feature/bonus that
  needs a sprite is **pre-rendered once, offline**, from its `.nif` into a 2D sprite
  (or replaced with hand-authored 2D art); the browser only ever sees the sprite.
- **Terrain blend** — draw from a WebP tile atlas driven by the §4.1 16-way
  `TextureBlend` table (pre-composed tiles, or composited on the canvas).
- **Art source (as built)** — every in-use texture (terrain, water/sea, river, feature/tree, bonus)
  lives committed **non-LFS** under `data/civ4/assets/`, and `build.mjs`'s `resolveArt` reads only
  there. **Git-LFS and the `UnpackedArt/` tree were removed entirely** (2026-07): the build is fully
  self-sufficient on `data/civ4/assets` (verified — terrain tiles, trees, bonus icons and the
  sea/river/foam/ice art all bake without UnpackedArt), and `deploy-web.yml` just uploads the
  prebuilt `web/` folder. To add more upstream art, copy the files into `data/civ4/assets/`.

*(3D WebGL — `.nif`→glTF/GLB + `.dds`→KTX2/Basis — is recorded only as the road not
taken, should the client ever go 3D.)*

**Pipeline shape** (extends the existing `web/build.mjs` bake of `terrain.bmp`→PNG):
the XML **exporter emits JSON manifests only** (blend table, layer order, atlas
coords — small, text, committed like the other `map/` resources); a **build step
bakes the curated `.dds` → a web image atlas**. Caveat: `web/build.mjs` is
deliberately **dependency-free and hand-rolls its PNG encoder — it cannot decode
`.dds`**. Converting therefore needs either a **build-time-only** dependency (a DDS
decoder / `sharp`, kept out of the shipped page) or a hand-rolled DXT1/5 decoder.
Whichever: the runtime page stays dependency-free; conversion is an offline/build
concern, exactly like the LFS source it reads from.

**So the exporter set from §3 still holds, but each pairs with an asset-bake step,
and the *deliverable* is web atlases + JSON, not Civ4 formats.**

---

## 11. As-built status (2026-07) — what's actually wired vs. §10's plan

> **Census: [`docs/civ4-texture-inventory.md`](civ4-texture-inventory.md)** (2026-07-26) — every texture
> in the FPK archives vs. the ~35 the bake consumes, family by family. Its headline: the coast/beach
> blend atlases (`textures/coast*blend.dds`) are real painted art and are 100% unused, which is why the
> shoreline still looks procedural.

§1–§10 describe the *target*. This section is the **current implementation**, so the
gap between "art available" and "art rendered" is explicit. **Ground, water and rivers are done;
features/bonuses/improvements/wonders are not.** Of the whole `terrain/` tree, the web client bakes
the **16 land ground blend/detail textures** (as a colour source), the **sea/shore water textures**
(climate gradient + ripple + shore shallows), and the **river ribbon** — all from the real `.dds` at
build time. The 3D `.nif` feature/bonus/improvement/wonder meshes are untouched; on-map bonuses are
drawn as procedural glyphs and land features as procedural marks.

**Done**

- **`TerrainArtInfo` (ground) only.** `TerrainArtExporter` (`geo/export/TerrainArtExporter.java`)
  parses `CIV4ArtDefines_Terrain.xml` for a curated `KEEP` set of **16 land terrains**
  (GRASSLAND, LUSH, PLAINS, SCRUB, MARSH, MUDDY, ROCKY, BADLAND, JAGGED, BARREN, DESERT,
  DUNES, SALT_FLATS, TAIGA, TUNDRA, PERMAFROST) → `src/main/resources/map/terrain-art.json`
  (`path`/`grid`/`detail` paths, `layerOrder`, and the full 16-way `blend` table). The
  §4.2–4.5 exporters (Feature/Bonus/Improvement/Route) are **not built**.
- **Water & coast art — baked directly in `build.mjs`, no `ArtInfo` exporter.** The sea/shore is
  textures, not an `ART_DEF`: `bakeSeaBands`/`bakeSeaTile`/`bakeShoreTile` read `textures/water/*.dds`
  via `dds.mjs` for the climate band hues, the open-sea ripple tile, and the shore-wave tile;
  `ProvinceRaster` + `ProvincePlotField` add the global coast mask and the coastal-shelf water plots
  (with sea bonuses + polar ice). See `docs/coastlines.md` (Phases A–F) and `docs/river-rendering.md`.
- **The §10 "build.mjs can't decode `.dds`" caveat is resolved.** `web/dds.mjs` is a
  **hand-rolled, dependency-free DXT1/3/5 decoder** used *at build time* by `web/build.mjs`
  to read detail-texture mean colours and bake the recolored texture atlas. The runtime
  page stays dependency-free; DDS decoding is offline, as §10 required.
- **Per-plot data pipeline.** `ProvincePlotField` (via `MapTerrainCodec`, real
  `terrain.bmp`/`trees.bmp`/`heightmap.bmp`) → `ProvincePlotStore` gzipped JSON per province
  in `map/provinces/<id>.json.gz` → `build.mjs packPlots` concatenates into
  `web/assets/plots.pack` + a byte-offset `plotIndex` in `data.js`. Each plot carries
  `x, y, river, terrain, plotType(FLAT/HILL/PEAK), feature, bonus, elevation`.

**As-built rendering, by camera scale `k`** (`web/js/plots.mjs`; thresholds in
`web/js/core.mjs`: `K_PLOT = 5`, `K_TEX = 16`, zoom cap 64×):

- **`k < 5`** — background raster `assets/terrain-<seed>.png`: a box-downsample of
  `terrain.bmp` with **one flat muted colour per terrain category** (`terrainTint`),
  optionally re-hued from real Civ4 detail averages. No texture, no relief.
- **`k ≥ 5`** — per-plot **1px flat tiles**: flat `terrainRgb` + cheap tints
  (forest/jungle darken, swamp desaturate, hill lighten, peak → grey, river → blue).
- **`k ≥ 16`** — real Civ4 **detail** textures, but **recolored so each texture's mean
  equals its flat display colour** (`terrain-tiles-<seed>.png`, gitignored) — real grain,
  synthetic hue. Plus: a **terrain edge + corner blend** — the neighbour's real recoloured
  tile feathered across each shared edge/corner under a soft alpha ramp modulated by a
  procedural smooth-noise mask, blended on **both** sides of every boundary and weighted by
  `LayerOrder` (higher bleeds strongly onto lower, lower bleeds back to soften the higher edge,
  equal layers meet in the middle) so boundaries interleave organically rather than meeting at a
  square seam. This **approximates** Civ4's blending with a procedural mask, *not* the real
  `TextureBlend` alpha tiles (§6.1 — see the upgrade path in *Not built* below). A **feathered
  snow cap** on the highest ground (built at 1px/plot, blitted upscaled with bilinear smoothing so
  it ramps between snowy and bare plots); **procedural vector feature marks** (`featureSprite`:
  trees = circles, swamp = reeds, cactus, oasis, savanna tufts; `FLOOD_PLAINS` left bare);
  **rivers as a real water-tile ribbon** tapered by authored width (`drawRiver`, see
  `docs/river-rendering.md`); the **coast shallows** (real shore-wave texture); and, on sea/lake
  provinces, the **coastal-shelf water plots** with **resource glyphs** + **polar pack ice**.
  The open sea itself is a separate screen-space layer (climate gradient + ripple + depth band,
  `main.mjs drawSeaBase`), drawn behind the land raster at every zoom.

**Not built** (the visible half of §3–§6):

- **Rivers now use real 2D water art** (Phase 1B, done 2026-07) — a texture ribbon baked
  from `routes/rivers/allriverssmall.dds`, tapered by the authored width recovered from
  `rivers.bmp` (`ProvinceRaster.classifyRiver`, no longer flattened to a boolean). See
  `docs/river-rendering.md`. Flow *direction* (Phase 2 — an invisible data product for
  river-navigation, `geo/RiverFlow`) is also done; the faithful `borderNN` edge tiles
  (Phase 3) are still open.
- **Coast & open sea now use real Civ4 water art** (Phases A–F, done 2026-07 —
  `docs/coastlines.md`): the shore shallows carry the `textures/water/shoredetail.dds` ripple over a
  `shoreblend`-derived hue; the open ocean is a climate-banded gradient (`seatrop`/`sea`/`seapol`
  blends) with the `seadetail` ripple and a distance-to-land depth band; and every sea/lake province
  grows a coastal-shelf of water plots. All **baked from the real `.dds` via `web/dds.mjs`** — water
  is textures, not meshes, so no `.nif` was needed.
- **Still no real feature, improvement, or natural-wonder art.** Land features are procedural JS
  marks (plus procedural polar **pack ice** on water plots); these stay gated on the offline
  `.nif`→sprite baker. The 3D `.nif` mesh tree is untouched.
- **The offline `.nif`→sprite baker (§10) does not exist** — this is the gating unlock for
  Feature/Bonus/Improvement/Wonder art, which is all 3D `.nif`.
- **The 16-way `TextureBlend` table is exported to `terrain-art.json` but never read by
  `build.mjs`** — the on-screen blend is the procedural textured-feather + noise-mask
  approximation above (`web/js/plots.mjs` `buildPlotTexCanvas`, `BLEND_NOISE`).
  **Faithful upgrade path — the real Civ4 blend alpha masks.** Two families of authored DDS
  masks exist and would make deep-zoom transitions pixel-faithful to Civ4 instead of noise-driven:
  (1) the per-terrain **`TextureBlend01..15` transition tiles** referenced from
  `CIV4ArtDefines_Terrain.xml` (`textures/`), selected by the 4-bit "same-terrain neighbour"
  bitmask + rotation (§4.1/§6.1) — this is the table already exported but unread; and (2) the
  reusable **edge/corner alpha masks** under `heightmap/` — the `coastblendmasks` and the
  `border00a` / `border01[a-h]` / `border02[a-h]` / `border03..05[a-d]` family (6 configs × 4–8
  rotations, a band along one edge with corner variants) catalogued in `docs/river-rendering.md §4`.
  Baking those via `web/dds.mjs` and driving the blend from the exported bitmask/rotation table —
  in place of `BLEND_NOISE` — is the way to replace the approximation with the real art.
- **Bonuses are now rendered — as procedural category glyphs, not real Civ4 art** (Phase F,
  `web/js/plots.mjs` `drawBonuses`/`bonusGlyph`): each resourced plot draws a small colour+shape
  glyph keyed by category (sea food, gems/luxury, energy, metal/stone, crop, livestock) at texture
  zoom, for land and coast alike, with a hover tooltip (`panel.mjs` `plotAt`) plus the info-panel
  resource tally. Real `ART_DEF_BONUS_*` sprites (all 3D `.nif`) remain gated on the sprite baker.
