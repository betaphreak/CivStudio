# Civ4 / C2C texture inventory — what exists vs. what we bake

**Status: 2026-07-26.** Now that `tools/fpk/unpack.mjs` reads the game's FPK archives
(`docs/terrain-3d.md` §P4b, `docs/c2c-building-import.md`), the *whole* published art tree is
reachable, not just C2C's `UnpackedArt` overrides. This document is the census: every texture that
exists, which ones the web bake actually consumes, and therefore what is missing.

**Headline: the beach.** The shoreline is the one map element still drawn entirely from procedural JS
(`web/js/coast.mjs` — a hand-picked `SAND` colour, hash-driven bumps, a white feather for foam), and
Civ4's *real* hand-painted beach has been sitting in `textures/coastblend.dds` the whole time. See §4.

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
  `bamboo/bambooattachments`.
- **The peak/hill props** — `features/peak/*` + `features/hills/*`, extracted from `Art0.FPK` and baked
  by `tools/fpk/bake-peaks.mjs`.

---

## 3. The gap, ranked

1. **Coast/beach blend art — 100% unused, and it is the ugliest thing on screen.** §4.
2. **Bonuses (364 textures + `.nif`).** Every resource on the map is a procedural glyph. The blocker is
   the offline `.nif`→sprite baker, which still does not exist — but that baker now has a working NIF
   reader (`nifbake`, 94% of C2C building models parse) and the FPK route to the meshes.
3. **Features (130 textures, 51 dirs, 5 used).** Land features are vector marks. `reef`, `kelp`,
   `seagrass`, `coral`, `mangrove`, `floodplain`, `oasis`, `bog`, `wetlands`, `volcano` all have real art.
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

### The fix, in order of effort

1. **Cheapest, biggest win — bake the sand from the atlas.** Slice a mid-shore cell out of
   `coastblend.dds`, take its sand band as a repeating strip, and replace `coast.mjs`'s flat `SAND` fill
   with that texture. Real grain, no new plumbing. Pick the strip per climate band from
   `coasttrop`/`coasttemp`/`coastpolar` and the beach varies with latitude for free.
2. **Restore the surf.** `wave_base.dds` + `wave_crest.dds` are already prefetched (`wave_crest` was
   dropped when the continuous shallows landed). Lapping the crest strip along the shoreline polyline
   replaces `drawFoam`'s white feather with real art.
3. **Faithful shoreline shape.** Extend `TerrainArtExporter.KEEP` (or add a water-terrain pass) so the
   coast terrains export their `TextureBlend` table, then drive tile selection off the 4-bit neighbour
   bitmask instead of `coastDepth`'s hash. This is the same unlock as §3.4 for land, and it needs
   **colour-mapped TGA support in `web/tga.mjs`** for the mask families.

Step 1 alone should retire the complaint.
