# Civ4 / C2C texture inventory — what exists vs. what we bake

**Status: 2026-07-26.** Now that `tools/fpk/unpack.mjs` reads the game's FPK archives
(`docs/terrain-3d.md` §P4b, `docs/c2c-building-import.md`), the *whole* published art tree is
reachable, not just C2C's `UnpackedArt` overrides. This document is the census: every texture that
exists, which ones the web bake actually consumes, and therefore what is missing.

**Headline: the beach.** The shoreline was the one map element drawn entirely from procedural JS
(`web/js/coast.mjs` — a hand-picked `SAND` colour, hash-driven bumps, a white feather for foam), while
Civ4's *real* hand-painted beach sat unread in `textures/coastblend.dds`. §4 covers what that art is,
what each file in it is for, and the P1 fix that is now **shipped** — the sand comes out of the atlas,
in three climate palettes.

---

## 1. Regenerating this inventory

The six archives (~1.2 GB, in the Steam install, never committed):

```
Assets/Art0.FPK                                       7,583 entries   base Civ4 / BTS art
Beyond the Sword/Mods/Caveman2Cosmos/Assets/C2C0.FPK  9,114
                                              C2C1.FPK  9,310
                                              C2C2.FPK  9,173
                                              C2C3.FPK  3,933
                                         C2CPatch0.FPK    378          overrides — read LAST
```

```powershell
$G = "C:\Program Files (x86)\Steam\steamapps\common\Sid Meier's Civilization IV Beyond the Sword"
node tools/fpk/unpack.mjs list "$G\Assets\Art0.FPK" art/terrain --all
```

`--all` exists for exactly this: without it `list` caps at 400 lines, which is under 5% of an archive.

**39,491 entries / 38,711 unique paths** across the six, by extension:

| ext | unique paths |
|-----|-------------:|
| `.dds` | 25,362 |
| `.nif` | 7,633 |
| `.kf` | 4,829 |
| `.kfm` | 535 |
| `.tga` | 296 |

---

## 2. `art/terrain` textures — the census

**1,012 unique `.dds`/`.tga` under `art/terrain`.** By family:

| family | textures | what it is | in the bake? |
|--------|---------:|------------|--------------|
| `resources/` | 364 | per-bonus model skins | ✗ — bonuses are procedural glyphs (`bonusGlyph`) |
| `heightmap/` | 215 | relief + blend masks (`coasts` 29, `hills` 82, `peaks` 81, `flats` 7, `coastblendmasks` 16) | ✗ (peak/hill *models* are used; these masks are not) |
| `textures/` | 149 | ground + coast + water blend/detail/grid | **partial** — 16 land `detail`, 6 water; **all coast art unused** |
| `features/` | 130 | forest/jungle/ice/reef/… skins | 5 in use of 51 feature dirs |
| `routes/` | 59 | road/rail/river/bridge skins | 4 in use |
| `natural_wonders/` | 57 | unique map wonders | ✗ |
| `water/` | 12 | ocean surface, bump, wave/zephyr masks | ✗ (the sea is baked from `textures/water/`, not here) |
| `improvements/` | 6 | — | ✗ |
| `sky/` `plottextures/` `terrainmasks/` `gridstyles/` `waves/` | 19 | environment + overlays + surf | 1 (`wave_crest.dds`, prefetched then dropped at runtime) |

**≈35 of 1,012 textures (3.5%) reach the browser.** That is not a criticism of the bake — a 2D client
does not want 364 resource model skins — but it does mean every "this looks procedural" complaint is
worth checking against this list first.

### What is in use today

- **16 land terrains** via the `terrain-art.json` manifest (`TerrainArtExporter`'s `KEEP` set):
  `detail` is decoded into the recoloured tile atlas, `path` (the blend texture) is read for a **mean
  colour only**, and `grid` is prefetched but never read. The exported **16-way `TextureBlend` table is
  still unread** — the on-screen blend is `BLEND_NOISE`, a procedural feather.
- **6 water textures** — `textures/water/{sea,seatrop,seapol,seadeep}blend.dds`, `seadetail.dds`,
  `shoredetail.dds` (`bakeSeaBands`/`bakeSeaTile`/`bakeShoreTile`).
- **4 route textures** — `rivers/allriverssmall.dds`, `path/roadprimitive.dds`, `railroads/railroad.dds`,
  `roman roads/roadroman.dds`.
- **5 feature textures** — `icepack_1024`, `treeleafy/trees_1024`, `savanna/palms_1024`, `swamp/trees1`,
  `bamboo/bambooattachments` — plus two groups rendered from `.nif` by `tools/nifbake` (`kaktus`,
  `sword_grass`). See §5: features are *covered*, not missing.
- **The peak/hill props** — `features/peak/*` + `features/hills/*`, extracted from `Art0.FPK` and baked
  by `tools/fpk/bake-peaks.mjs`.

---

## 3. The gap, ranked

1. **Coast/beach blend art.** The sand and the surf are now real (§4, P1 + P2 shipped). What is still
   procedural is the shoreline *shape* — and that is the one worth doing next. §4 P3.
2. **Bonuses (364 textures + `.nif`).** Every resource on the map is a procedural glyph. The blocker is
   the offline `.nif`→sprite baker, which now exists (`tools/nifbake`, already used for cactus and
   grass) — so this is work, not a blocker.
3. **Features — not missing, but one atlas is doing four jobs.** Every feature the generator places has
   real art (§5). The gap is *variety*: `FOREST`, `FOREST_ANCIENT` and `JUNGLE` all stamp the same
   `treeleafy` sheet, while Civ4's own `ART_DEF_FEATURE_FOREST` carries three varieties
   (`TreeLeafy`/`TreeEvergreen`/`TreeSnowy`) and `jungle/` has 19 dedicated models. §5.
4. **The 16-way `TextureBlend` table + `heightmap/coastblendmasks/coastscalemask00..15.tga`.** Both the
   table (exported, unread) and the authored alpha masks exist; the renderer uses procedural noise.
   Replacing `BLEND_NOISE` with these is the pixel-faithful upgrade path.
5. **Natural wonders (57).** Nothing drawn at all.

---

## 4. The beach

### What we draw now

`web/js/coast.mjs` builds the shoreline from three procedural pieces:

- `drawCoastBands` — a shore-hue band fading outward from the shoreline (the one real ingredient is
  `shoredetail.dds`, soft-lit over it as a ripple)
- `drawBeach` — a hardcoded `SAND` colour: wet-sand quads jutting into the water by a per-corner hash,
  dry sand feathered back onto the land
- `drawFoam` — a white feather at the water's edge

The sand is a flat fill. It has no grain, no wet/dry gradient, no variation between a tropical and a
polar coast, and its outline is a hash function rather than art.

### What actually exists

| file | size | what it is |
|------|------|-----------|
| `textures/coastblend.dds` | 512×1024 | **the real Civ4 beach** — a 4×8 atlas of 128 px hand-painted shore transition tiles: golden sand grain, teal shallows, deep blue water, with per-tile alpha for the shoreline shape. Bound by `ART_DEF_TERRAIN_COAST` |
| `textures/coasttropblend.dds` | 512×1024 | the same atlas, tropical palette (`ART_DEF_TERRAIN_COAST_TROPICAL`) |
| `textures/coastpolarblend.dds` | 512×1024 | polar palette (`ART_DEF_TERRAIN_COAST_POLAR`) |
| `textures/coasttempblend.dds` | 512×1024 | temperate palette — **present but bound by no `ART_DEF`**, a spare |
| `textures/coastdeepblend.dds` | 128×256 | deep-water variant (`*_COAST_DEEP`, all three climates) |
| `textures/coastdetail.dds` | 1024×1024 | the coast grain detail layer (alpha 0 — pure detail) |
| `textures/coastgrids.dds` | 512×1024 | grid overlay, same layout |
| `textures/coastscalemask.tga` | 9 KB | shoreline scale mask (**colour-mapped TGA — `web/tga.mjs` cannot decode it yet**) |
| `heightmap/coastblendmasks/coastscalemask00..15.tga` | 16 × 1 KB | the 16-way neighbour-bitmask alpha masks (also colour-mapped) |
| `heightmap/coasts/coasttile{1,3,5,7}_NN.tga` | 29 | coast height/shape tiles, four families |
| `waves/wave_base.dds`, `waves/wave_crest.dds` | 256×128 | the surf strips — soft foam base + white crest |
| `waves/coastwave{1,3,5,7}_NN.nif` | 29 | the animated surf meshes, one per `coasttile` shape |
| `water/coastlandblends.dds` | 64×128 | binary land↔water blend masks |
| `water/wavemask.dds`, `water/zephyrmask.dds` | 512²/256² | soft noise masks that animate the water |

`coastblend.dds` is the find. It is a painted beach — the sand is a *texture*, warm gold flecked with
grain, feathering into turquoise shallows and then into deep blue, with the shoreline shape carried in
the alpha channel. The 4×8 grid of 128 px cells is the transition set the `TextureBlendNN` table
indexes: every water `ART_DEF_TERRAIN_*` carries a full 15-entry table, and across
`CIV4ArtDefines_Terrain.xml` the cell indices run 1..29 — i.e. a 32-cell atlas, which is exactly
512×1024 at 128 px. (The cells bleed into each other by design, so there are no visible seams to
measure; the grid is the XML's indexing convention, not a cut.)

### Why it was never baked

`TerrainArtExporter.KEEP` is deliberately **settleable land only** — water and space terrains are
skipped, so `ART_DEF_TERRAIN_COAST` and friends never reach `terrain-art.json`, and the web build only
ever saw the water textures it names by literal path in `build.mjs`. The coast *blend* family was never
in anyone's path list. Nothing was wrong; the art was simply outside the export's scope.

### What each file is actually for

Listing art is easy; committing to a use for it is the part that matters. Every row above, with the
job it does in the plan — including the four that have **no job in a 2D client** and should not be
baked at all.

| file | verdict | use |
|------|---------|-----|
| `coastblend.dds` | **P1** | the sand + shallows source. One cell's cross-section is a complete beach profile: dry sand → wet sand → turquoise shallow → deep. Sliced into a repeating along-shore strip |
| `coasttropblend` / `coastpolarblend` | **P1** | the same slice per climate band. `bakeSeaBands` already bands the sea by latitude — the beach reuses those band boundaries and varies with latitude for free |
| `coasttempblend` | P1, opportunistic | bound by no `ART_DEF`, so Civ4 never draws it. Bake it as the mid-latitude band and A/B it against plain `coastblend`; keep whichever reads better |
| `coastdeepblend.dds` | ~~P2~~ ✗ **tried, rejected** | intended as the shallow→deep outer ring. Its opaque pixels average `104,103,104` — a flat neutral grey with no hue, a blend MASK, the same trap `bakeSeaBands` already documents for `shoreblend`. And the band it drove made the coast worse regardless of colour (see P2 below) |
| `coastdetail.dds` | **P2 shipped** | not a ripple at all — grey shingle, a *ground* texture. That makes it the coast bed, and it is what every `ART_DEF_TERRAIN_*_COAST` binds, so it replaced `water/shoredetail.dds` (a `LAKE_SHORE` texture) as the shallows' grain source. Read RGB; the file is alpha-0 by design |
| `coastlandblends.dds` | **P3** | the shoreline *shape*. 64×128 = the same 4×8 grid as `coastblend` at 16 px/cell, holding each cell's alpha as a hard black/white cut. The cheap way to get Civ4's wiggle without decoding the full 700 KB atlas |
| `coastscalemask.tga` | **P3** | the same 4×8 grid again, but as a **soft grey ramp** — the falloff *strength* to `coastlandblends`' hard *shape*. Together they are the shoreline gradient, and they are 9 KB |
| `coastblendmasks/coastscalemask00..15.tga` | **P3** | sixteen 16×16 greyscale ramps, one per 4-bit neighbour configuration (00 and 15 are solid white — fully-open and fully-enclosed). This is the authored falloff that replaces `coastDepth`'s hash, keyed on `q.coast` folded from 8-bit to 4-bit |
| `wave_crest.dds` | **P2 shipped** | the surf. 256×128 of pure white rgb with the whole shape in ALPHA — a foam *mask* that tiles along its long axis. **Static art, not animation**: one blit per shore edge |
| `wave_base.dds` | ✗ **empty** | listed as the crest's soft base, and it is not: flat grey rgb, alpha mean 20 / max 153. A near-blank smudge with no structure. Only the crest carries art |
| `coastgrids.dds` | ✗ **no use** | the atlas with Civ4's hex grid burned in. We draw our own grid |
| `heightmap/coasts/coasttile*.tga` | ✗ not 2D | 16×16 seabed-drop heightmaps. Real value, but only to `terrain3d.mjs` — the shelf's underwater relief. Park until 3D touches water |
| `coastwave*.nif` | ✗ animation | 29 animated surf meshes. Out of scope by the same rule that keeps every other `.nif` out of the client |
| `wavemask.dds` / `zephyrmask.dds` | ✗ animation | soft noise masks that scroll to animate the water surface. Nothing to bake for a static frame |

Nine of thirteen non-animated rows earn a place. `coastgrids` is genuinely redundant and the coast
heightmaps are a 3D asset filed in the wrong decade — saying so is more useful than finding them a job.

> **Sourcing correction.** The FPK archives are how these files were *found*, but `coast*blend.dds`,
> `coastdetail`, `coastgrids` and the `water/` family are also in C2C's `UnpackedArt` — so
> `resolveArt`'s ordinary GitHub fetch reaches them and **CI can bake them like any other water
> texture**. No committed output is needed. The genuinely FPK-only art is elsewhere (`features/peak`,
> `features/hills`, the building models); the `heightmap/` mask families are FPK-only too.

### The plan

**P1 — real sand. SHIPPED.** Built as a colour *ramp* rather than the strip sketched here, because
measuring the atlas changed the design: the shoreline inside each cell is a painted curve, so no
axis-aligned slice gives a clean cross-shore profile. The bake instead walks the alpha boundary, steps
inward along the alpha gradient, and — the part that matters — **aligns each row on its own
sand→water transition before averaging**, since the painted rim varies in width cell to cell and a
naive per-depth mean smears the step into grey mush. What landed:

- `web/beachramp.mjs` — `beachRampFromAtlas()`, the rectification, kept out of `build.mjs` so it is
  unit-testable against a synthetic atlas (`beachramp.test.mjs`); the real art is a fetch dependency
  CI should not have to assume just to test the algorithm.
- `bakeBeachRamps()` in `web/build.mjs` → `BUNDLE.beach = {trop, temp, polar}`, each a 9-stop RGB ramp;
  `WorldBundle` passes the key through.
- `web/js/coast.mjs` — `SAND`/`WET_SAND` become the *fallback*. `drawBeach` now runs a **seaward
  gradient** across each wet-sand extension quad (`coastExtendPolys` carries its outward axis for
  this) and takes the dry apron from the ramp's bright body. The band is picked from the province's
  latitude via the same boundaries `sea.mjs` uses, so a beach and the water off it agree.

The measured ramps, and why per-climate was worth it — tropical sand is pale and barely warm,
temperate is the golden one, polar sits between with a colder tail:

| band | land edge | dry body | waterline | past it |
|---|---|---|---|---|
| tropical | `185,173,150` | `208,199,178` | `195,196,178` | `147,166,151` |
| temperate | `171,150,108` | `200,185,140` | `175,178,141` | `135,157,136` |
| polar | `177,163,139` | `202,193,169` | `186,186,167` | `149,160,147` |

Against the old hand-picked `226,208,164`, the real sand is duller and less yellow — the previous
colour read as a lemon rim glowing against the water at every latitude.

**P2 — surf and depth. SHIPPED, minus one part that was tried and rejected.**

*The surf (shipped).* `bakeFoamStrip()` crops `wave_crest.dds` to its dense crest rows and emits an
RGBA strip (`web/assets/water/foam.webp`, 256×26) as `BUNDLE.foam`; `drawFoam` stamps it along each
water edge via a per-edge transform, seaward of the sand. Two tunings were found by looking rather
than by reasoning, and both are load-bearing:

- **Crop to the crest, not the wash.** The alpha runs rows 2–48, but it is dense over 3–21 and then
  trails at a tenth of that for another 27. Shipping the trail made the coastline a pale *haze* — a
  few screen pixels cannot resolve a long soft ramp, so all it does is lighten everything.
- **A lap, not a band.** 0.18 cells of reach at 0.34 alpha, scaled by the same `detail` ramp the
  beach uses. The first cut (0.3 cells, 0.72 alpha) read as fog around the whole coast.

*The shelf-edge band (rejected).* The plan was for the shallows to ramp to a dimmer shelf tone rather
than fade out. It fails twice over, and the second reason is the interesting one:

1. `coastdeepblend` has no hue to ramp to — measured above.
2. **Even with a good colour it makes the coast worse.** Fed `coastblend`'s painted water
   (`84,102,112`, a real blue-grey), the band put a mid tone between bright shallows and dark open
   sea — which *widens the pale halo* instead of deepening it. The existing fade to transparent over
   dark water was already doing the job better. Shipped as a comment in `drawCoastBands` explaining
   why there is one band and not two, so the next reader does not re-derive it.

*The shallows' grain (shipped, quietly).* `bakeShoreTile`'s C2C source moved from
`water/shoredetail.dds` to `textures/coastdetail.dds`. Neither is a wave texture — both are ground
detail, and either works as neutral grain — but coastdetail is what `ART_DEF_TERRAIN_*_COAST` binds
while shoredetail belongs to `LAKE_SHORE`, and our shallows are the sea shelf. A correctness fix, not
a visible one: the Civ6 coast tile still wins where it is available.

**P3 — faithful shoreline shape.** Two halves, and they are separable:

- *Falloff.* Bake the sixteen `coastscalemask00..15.tga` into one strip and index it by the plot's
  4-bit water-neighbour mask. Replaces `coastDepth`'s per-corner hash with the authored ramp. Needs
  **colour-mapped TGA support in `web/tga.mjs`** — the mask families are 8-bit palettised and today's
  decoder is truecolour-only (a working reader is ~40 lines; it was prototyped to produce this
  document's figures).
- *Wiggle.* Extend `TerrainArtExporter.KEEP` — or add a water-terrain pass beside it — so the coast
  `ART_DEF`s export their `TextureBlend` tables (every one carries a full 15-entry table already), then
  select the atlas cell by bitmask + rotation instead of hashing. Same unlock as §3.4 for land.

Order matters: P1 was a bake plus a fill change, P2 a bake plus a renderer change, P3 is the one that
touches the Java exporter.

### What stays procedural, on purpose

Replacing art with art is not the goal — three of these files were rejected above precisely because
the procedural version was better. The line that has held so far:

- **Authored art wins on *material*** — what sand is, what foam is. A hand-picked `226,208,164` was a
  guess standing in for a painting.
- **Procedural wins on *variation at map scale*.** The shoreline's wavy outline is still a corner-
  continuous hash (`coastDepth`), and the surf *keeps* a per-cell hash on top of the real art to pick
  its window and flip — because one authored scallop stamped into every coastal cell of a 5,264-
  province world reads as a rhythm, which is worse than noise. Even P3, which replaces the falloff
  with the sixteen authored masks, should keep a procedural phase on top for the same reason.
- **Procedural also wins when the asset is simply worse.** `FEATURE_VERY_TALL_GRASS` draws as
  `stampGrass` tufts because the C2C `sword_grass` billboard is a muddy wheat crop (§5), and
  `drawCoastBands` stays one band because the authored second one hurt.

---

## 5. Features

**Features are not the beach.** The vegetation layer is genuinely done: `docs/features-art.md` describes
a real pipeline (connected-component cutout extraction from Civ4's irregular billboard sheets, plus
`tools/nifbake` for models that ship no sheet), and every feature `FeatureExporter.KEEP` places has art
or is deliberately bare. Ranking features next to the beach would be wrong.

| feature | drawn today | source |
|---|---|---|
| `FOREST`, `FOREST_ANCIENT` | `leafy` billboards | `treeleafy/trees_1024.dds` |
| `JUNGLE` | `leafy` billboards, denser | `treeleafy/trees_1024.dds` |
| `SAVANNA`, `OASIS` | `palm` billboards | `savanna/palms_1024.dds` |
| `SWAMP` | Civ6 SV overlay, else `swamp` billboards | `swamp/trees1.dds` |
| `BAMBOO` | `bamboo` billboards | `bamboo/bambooattachments.dds` |
| `CACTUS` | `cactus` billboards | `kaktus/kaktus2.nif` via `nifbake` |
| `VERY_TALL_GRASS` | **procedural** (`stampGrass`) | — the C2C `sword_grass` sprite is a muddy wheat crop |
| `FLOOD_PLAINS` | nothing, by design | a ground quality, not foliage |
| `ICE` | pack-ice tile | `features/icepack` |

> Two corrections to `docs/features-art.md` while we are here: it claims `VERY_TALL_GRASS` is
> `nifbake`d from `sword_grass/wheat.nif`, but `build.mjs` bakes only the `kaktus` group and
> `featureSprite` short-circuits grass into `stampGrass` — grass is procedural in the live renderer.
> And its "atlases live under `data/civ4/assets/`" note predates the de-vendoring; `web/civ4.mjs`
> resolves them (FPK first, then the C2C fetch cache).

### The real gap: one sheet doing four jobs

`treeleafy` is stamped for temperate forest, ancient forest **and** jungle. Civ4 does not do that —
`ART_DEF_FEATURE_FOREST` carries **three** `FeatureVariety` blocks (`TreeLeafy`, `TreeEvergreen`,
`TreeSnowy`), and jungle and ancient forest have their own model sets. So a taiga forest and a
Cannorian broadleaf wood currently render identically, which is the one place the foliage layer looks
thin.

**And two of the three fixes are free**, because the sheets already exist in exactly the format
`bakeFeatureSprites` eats:

| want | sheet in the FPK | cost |
|---|---|---|
| conifer forest (TAIGA/TUNDRA) | `treeevergreen/trees_1024.dds` (+ `trees_1024_2.dds`, `treeevergreen1/trees_1024.dds`) | **one line in `bakeFeatureSprites`'s `groups` map** |
| ancient forest | `ancient forest/ancient_24.dds` | **one line in the same map** |
| real jungle | `jungle/` — 19 `.nif`, **no sheet** | `nifbake`, like cactus |
| snowy forest | `treesnowy/` — 16 `.nif`, **no sheet** | `nifbake` |

The bake side really is that cheap — `groups` is a literal map of group name → art path, and
`bakeSpriteGroup` already relaxes its green-dominance filter for sheets that are not green.

The renderer side is the actual work, and it is small but not one line: selection is ours to make,
not Civ4's. `foliageGroup(feature)` in `web/js/foliage.mjs` dispatches on the feature string alone,
so it cannot tell a taiga forest from a temperate one — it needs the plot's **terrain** threaded in
from `plots.mjs` (`foliageGroup(feature, terrain)`), then TAIGA/PERMAFROST picks evergreen or snowy,
`FEATURE_JUNGLE` picks jungle, and `FEATURE_FOREST_ANCIENT` picks ancient. Note the existing
first-match-wins ordering in that function is load-bearing (JUNGLE before FOREST) and the new tests
have to respect it.

### Features with art but nothing placing them

Worth knowing about, but each is blocked on the *generator*, not on art:

- **Water vegetation** — `reef/fungus_1024.dds` is a ready sheet; `kelp`, `coral`, `seagrass`,
  `mangrove`, `flotsam` all have art. The coastal shelf currently grows nothing, so the shallows read
  as empty water. This is the natural companion to the §4 beach work.
- **Underworld / special terrains** — `xenofungus/fungus_1024.dds` (a ready 1.4 MB sheet),
  `alienfungusblue`, `seafungus`, plus `rockforms{,_dark,_polar}` and `cave`/`caves`. `TERRAIN_MUSHROOM_FOREST`
  and the Serpentspine (`docs/underworld.md`) presently recolour a borrowed ground texture and grow no
  foliage at all; `xenofungus` is a drop-in.
- **Marsh variety** — `bog`, `peatbog`, `wetlands` beside the single `swamp` sheet.
- **`volcano`, `volcano2`, `tornado`, `fallout`, `crater`** — no gameplay hook; noted only so a future
  reader does not re-inventory them.
