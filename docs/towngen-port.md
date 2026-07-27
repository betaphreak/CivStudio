# Plan: the town generator port (TownGeneratorOS → CivStudio)

**Status:** PLAN (2026-07-27). Nothing implemented. This is the sequenced plan for giving a
settlement a **real medieval town layout** — walls, gates, streets, wards and building lots — by
porting the generation core of [Watabou's Medieval Fantasy City Generator]
(`C:\Code\TownGeneratorOS`, Haxe/OpenFL, GPL-3) and driving it from **live sim state** instead of
from scratch randomness.

**Companion to:** [`district-buildout.md`](district-buildout.md) (the district contract this rides —
its D5 "generator view" is what this fulfils), [`district-generator.md`](district-generator.md) (the
Civ6 LSystem reference this **supersedes** as the layout engine; its Layer-3 C2C building sprites
stay), [`urban-plots.md`](urban-plots.md) (the urban overlay and why it is *not* the footprint —
§2), [`city-of-hamlets-plan.md`](city-of-hamlets-plan.md) (the village/fief land model the ward
assignment reads), [`zoom-bands.md`](zoom-bands.md) (bands 6–8, the render surface this fills),
[`terrain-3d.md`](terrain-3d.md) (the ground-height seam the layout drapes onto).

## The model in one paragraph

A settlement's **built plots** form an irregular polyomino. That polyomino is meshed into one
**patch per plot** (a bijection — the patch *is* the district slot), wrapped in a **curtain wall**
that is simply the union outline of the mesh, pierced by **gates aimed at the neighbouring
provinces' border portals**, and threaded with **streets** that A* from each gate to the city centre
over a slope-penalised graph. Each patch then draws a **ward** — chosen by a `rateLocation` score
over real sim state (who owns the plot, what buildings stand on it, how high it sits) — and each
ward recursively subdivides its block into **building lots**. The result is a set of polygons in
ground space, computed server-side, streamed on a dirty flag, and drawn by one new web layer that
replaces today's placeholder `footprints.mjs` grid.

**One-line takeaway:** the generator's own `findCircumference` already computes "the wall around an
arbitrary set of cells" — so this is not a rewrite of the algorithm, it is **feeding it our cells
instead of its own Voronoi**, plus making four steps *total* that today escape failure by
regenerating.

---

## 1. Decisions

| Question | Decision |
| --- | --- |
| **Footprint** | The **1444 starting core** ∪ the settlement's **claimed plots that have raised a building** (`Plot.owner() == settlement && Plot.hasRegularBuilding()`, a filter over `Settlement.getDistrictPlots()`). The city is founded at its 1444 size and grows from there (§2). |
| **Decline** | The **wall is a high-water mark** — re-fitted only when the footprint grows, never contracted. A shrinking settlement hollows out *inside* its walls as ruins and emptying lots (§2a). |
| **Density** | Lot counts come from **real sim state** — households per plot (`PlotField.homePlotLoads`) and the exact buildings on it (`Plot.buildings()`) — not from the original's invented random subdivision target (§4a). |
| **Ward ↔ plot** | **Bijection.** One Voronoi seed per plot centre, jittered, clamped, one Lloyd pass, clipped to the footprint (§4). A patch *is* a plot, so the engine's per-plot `DistrictType` **is** the patch's ward — no divergence from the engine-authoritative decision in `district-buildout.md`. |
| **Mesh irregularity** | **Jitter, clamped to `r < 0.5` plot widths; one Lloyd pass, re-clamped** (owner, 2026-07-27). The clamp makes the bijection true *by construction* rather than asserted after the fact, and bounds how far a growing town can reshuffle its existing wards (§4.1). Starting point, uncalibrated: `r = 0.35`, one pass. |
| **Walls** | **Permanent settlements only** — `Settlement.isPermanent()`, true from `SettlementTier.TOWN` up (owner, 2026-07-27). Below that the town is unwalled: no `CurtainWall`, no gates, streets radiate from the centre to the footprint edge. This also sidesteps the single-plot wall failure (§5.3). |
| **Gates** | Aimed at the **neighbouring provinces' border portals** (`/map/portals.json` → `WorldMap.portalByEdge`), not chosen at random (§6). |
| **Altitude** | Feeds ward placement, street cost, and the 3D drape (§7). Relief (`PlotType`) carries more signal than raw `elevation()` at city scale — use both, scaled separately, as `web/js/heightfield.mjs` already does. |
| **Language / where it runs** | **Java, server-side** (`com.civstudio.server.town`). The layout is a pure projection of engine state + seed, exactly like the D3 district type/era/style projection, so it belongs where that lives. Keeps the sim engine free of render geometry, and the client free of the temptation to invent state. |
| **Transport** | **The route precedent** (owner, 2026-07-27): a **dirty flag on the snapshot**, the polygons themselves fetched **per settlement from their own endpoint** — never inlined into the snapshot. Standing routes were moved off the snapshot for exactly this reason (`route-viewport-feed`), and a town is hundreds of lot polygons; the SSE queue is drop-oldest, and nothing below band 5.5 wants the data at all (§3). |
| **Client** | One new web layer registered in `js/layers.mjs`, drawing served polygons. Over its bands it **replaces** the surfaces it supersedes outright (owner, 2026-07-27) — `js/footprints.mjs`' `sqrt`-grid placeholder, and the district-icon/neighborhood-chip treatment of the same ground — rather than drawing over them (§8a). |
| **Determinism** | A **per-settlement salted RNG stream**, never the economic stream (repo convention). No global static RNG (§10). |
| **Water** | **Split by cost** (owner, 2026-07-27). The cheap, invariant-touching half lands now, inside T2/T4/T5 — quay-vs-wall outline edges, sea blocked / rivers bridgeable in the street A*, and a water-aware hole-fill. Bridges, the river clip line and the harbour ward defer to **T4b** (§7a). |
| **Extramural sprawl** | The walled core is **capped**; footprint plots beyond the cap are **suburbs outside the wall**, not enclosed (owner, 2026-07-27). This is how the ~62 all-urban `city_terrain` provinces stay sane, and the original already supports it — outskirts thinning and gate-clustered wards are first-class in it (§2b). |
| **One vocabulary for all** | **Every race and every age uses the same layout logic** for now (owner, 2026-07-27) — including dwarven holds and the Dwarovar. `ArtEra` and race-specific vocabularies are a later refinement, not a v1 branch (§11). |
| **Ruins** | A layout **persists after the colony dies** (owner, 2026-07-27), so the map remembers failed settlements. This means the layout must **outlive the `Settlement`** — key it by site, not by live colony (§9 T7). |
| **Storage** | **A `json.gz` artifact, exactly like the province data** (owner, 2026-07-27) — not an in-memory cache. A layout is durable, inspectable, servable as a static file, and **other systems will consume it**, so it is a first-class world artifact from day one rather than a render cache that later has to be promoted into one (§3a). |
| **Starting core** | A founded 1444 city is **generated at its historical size, populated** (owner, 2026-07-27) — a metropolis's starting core gets real households and buildings in its lots, not empty blocks waiting for the sim to claim them (§4b). |
| **Lot scale** | **Symbolic** (owner, 2026-07-27). One plot = 1.0 unit; lots are sized to read well, not to metres. A lot per household is legibility, not a claim that a household occupies that footprint of ground (§3). |

---

## 2. The footprint: a 1444 start that then grows

**The map's urban data is a 1444 snapshot, not a global truth** (owner, 2026-07-27). Both inputs are
authored EU4/Anbennar state frozen at game start:

- `Province.development()` = `base_tax` + `base_production` + `base_manpower` **at game start**.
- `Province.city()` = Anbennar's `city_terrain` flag.
- `Plot.urban()` is derived from those, baked into the plot cache, **seed-independent — a property of
  the map, not of a run**.

So they are exactly right for **t = 0** and wrong for everything after. A city is *founded at* its
1444 size and thereafter its extent is session state. Three facts make the naive reading fail:

- `CityPlacement.coreSize()` returns **1** for any province that is not `city_terrain`, so an
  ordinary settlement has **exactly one** urban plot — no irregular shape to wrap.
- Only the ~62 `city_terrain` provinces flag every plot urban (`ProvincePlotField` — "a city_terrain
  province is one sprawling city").
- Baked data cannot grow with the city.

### 2.1 The two footprints disagree today — this plan reconciles them

There are currently **two different answers** to "how big is this city", and they do not match:

| | Source | Value at founding |
| --- | --- | --- |
| **Rendered** | `district-plots.mjs nearestPlots()` lights the `startingDistricts` urban plots nearest the centre | the 1444 development number |
| **Simulated** | `PlotField.claimPlot(PlotOccupant)` — one plot claimed per firm, nearest-first | **1** (the centre), growing firm by firm |

`Settlement.getStartingDistrictCount()` has **no engine consumer at all** — its only non-test caller
is `Snapshots.java`, feeding `ColonyView.startingDistricts` to the renderer. It is display metadata
that never claims a plot.

**The layout uses the union:** the 1444 starting core (`startingDistrictCount` plots nearest the
centre) ∪ the claimed-and-built plots. A city therefore *starts at its historical size* — which is
what makes a 1444 metropolis look like one on day one instead of a single hut — and grows outward as
firms claim and build. If the engine later claims the starting core for real, the union collapses to
the claimed set with no change here.

The built-plot half also hands us the generator's own three-way split for free:

| TownGen concept | CivStudio |
| --- | --- |
| `inner` / `withinWalls` — the walled core | the settlement's **built** plots |
| outer patches → `Farm` ward | the settlement's **claimed but unbuilt** plots — the farm belt |
| far patches → plain `Ward` | unclaimed province plots — countryside |

That split is already in the original (`Model.createWards`' countryside branch). It is the strongest
signal that the two models want to be the same model.

## 2a. Decline: the wall is a high-water mark

A settlement **shrinks as well as grows** — `Settlement` has a real starvation-descent loop
(*"starved down from TOWN to SMALLHOLDING"*), floored at `SMALLHOLDING` for a booted colony and
`CAMP` for a foraging camp. But what shrinks is the **tier and the population, not the plot set**:

- The only call site that releases a plot is `PlotField.releasePlotsToPool()` → `pool.release(plot)`,
  and it runs **once, at colony death**, releasing everything at once.
- There is no single-plot un-claim. A living colony's claimed set is therefore **monotone**.

That gives the design its cleanest rule, and it happens to be the historically faithful one — real
medieval cities kept their walls and hollowed out inside them:

> **The wall records the maximum extent the settlement ever reached.** It is re-fitted only when the
> footprint *grows*. Decline is rendered **inside** the wall — lots go to ruin, wards desaturate,
> households vanish from their dwellings — and the wall never contracts.

Three things fall out of this:

1. **Mesh stability is solved, not deferred.** Patches are only ever *added*, so a growing city never
   reshuffles the wards it already has. (This resolves the growth-stability item §11 previously
   carried as an open interim.)
2. **The vocabulary already exists.** `urban-plots.md` ships an **ABANDONED** neighborhood variant — a
   desaturated/ruined chip for urban plots not linked to a live settlement. Ruins inside the walls
   reuse that treatment rather than inventing one.
3. **The deferred un-boot is handled in advance.** `Settlement` notes that the symmetric un-boot back
   to a foraging camp is deferred; if plot release ever becomes incremental, a high-water-mark wall
   needs no change — the footprint shrinking simply leaves more ruins.

**Colony death** is the one case that *does* clear everything: plots return to the pool and the site
becomes an abandoned urban core (already a modelled state — a marching caravan may camp on one). The
layout **persists as a ruin** (owner decision): see §9 T7 for the cache consequence.

## 2b. Extramural sprawl — the walled core is capped

The ~62 `city_terrain` provinces flag **every** plot urban, so one of them can offer 70+ plots. Left
unbounded, a metropolis there would wall a footprint several times any other city's.

**Rule: the wall encloses a capped core; the rest of the footprint is suburb.**

- The **walled core** is the `WALLED_CORE_MAX(tier)` footprint plots nearest the centre — reusing the
  same nearest-first ranking the renderer and the plot claim order already use. Starting points,
  uncalibrated: `TOWN` 16, `METROPOLIS` 32.
- Everything beyond it is **extramural**: outside the wall, thinner, clustered at the gates.

This is not a compromise — **the original already models exactly this**, and it is one of its better
details:

- Wards outside the walls get **outskirts thinning**: buildings are culled by distance from the
  populated edges, so density decays outward instead of stopping at a hard line.
- Wards adjacent to a gate become **gate wards**, so sprawl clusters along the roads leaving town
  rather than spreading evenly — historically what a *faubourg* is.
- Beyond the sprawl, patches fall through to farm and open countryside (§2's three-way split).

So the cap costs nothing extra to implement: it is the boundary that decides which side of the
existing `inner` / outskirts branch a patch takes. It also means the wall stays legible at every
tier, and a huge city reads as *dense core + sprawling suburbs* rather than a wall around a district.

## 2c. What a really large settlement actually looks like

`tools/samples/nathalaire.png` — *Nathalaire, the Pirate City, 1446*, hand-drawn Anbennar — is the
reference for the top of the size range, and it breaks three assumptions this plan carries. Worth
recording now, because two of them are cheap if designed for and expensive if retrofitted.

1. **A big coastal city is not one blob with suburbs — it is a cluster of named quarters.**
   Nathalaire is Nescann, Quarterquarters, Fish Island, Shadowport, Smugglersbay, Fortunespent,
   Jollyport, Upper and Lower Noblewaters: separate built masses around bays, linked by causeways.
   §2b's "walled core plus thinning sprawl" describes an inland town; here the outlying clusters are
   **peers**, not fringe. T2's `outliers` already keeps them, but they deserve their own outlines
   and names rather than being a lesser class of the body's leftovers.
2. **The wall is not universal, and its water analogue is different in kind.** Nathalaire has no
   curtain wall. What it has is **gate forts on the causeways** (Shadowgate, Goldgate) and
   **defensive chains across the channels** — fortification at the chokepoints, because the water
   is the wall. §1's "walls from `TOWN` up" needs a water branch: a settlement whose approaches are
   channels gets gates and chains, not a ring.
3. **The field belt is a first-class layer, not background.** Outside the built masses the whole map
   is white field lines over green — the farm belt of §2's three-way split, and visually about a
   third of what makes it read as a city rather than a diagram of one. Our claimed-but-unbuilt plots
   are exactly that belt.

Two details worth stealing directly: the built texture is fine grey blocks against a dense white
street network, with **notable buildings drawn as large coloured masses** (palaces, temples,
warehouses) — which is precisely §4a's "one lot per building, sized by importance" — and every
quarter carries a name, which our per-plot GeoNames place names could supply for free.

---

## 3. Architecture and data flow

```
engine (authoritative state)
  Settlement.getDistrictPlots()      claim-ordered plots
  Plot.owner() / hasRegularBuilding() the footprint predicate
  Plot.buildings() / DistrictType     what stands there → which ward
  Plot.elevation() / plotType()       the height field
  Settlement.isPermanent()            walls or no walls
  SettlementTier + population         town size (nPatches equivalent)
        │
        ▼
server  com.civstudio.server.town  (NEW — the port)
  Footprint  → largest connected component, holes filled
  TownMesh   → one patch per plot (bijection), Lloyd-relaxed
  TownWall   → union outline + portal-aimed gates
  TownStreets→ slope-weighted A* gate → centre
  TownWards  → rateLocation over sim state → ward per patch
  TownLots   → recursive block subdivision → building lots
        │  written per site as layout.json.gz, invalidated on a dirty flag
        ▼
store   <layout dir>/<site>.json.gz   (the province-data pattern — §3a)
        │  snapshot carries only townDirty; the polygons come from
        ▼  GET /api/sessions/{sid}/town/{site}   (the routes precedent)
web  js/town.mjs (NEW)  — registered in layers.mjs, bands 5.5→8
     draws wall / gates / streets / lots; C2C building sprites stamp into lots
     drapes via core.mjs setGroundHeight at band ≥ 6.5
```

**Coordinates.** The layout is computed and served in **plot-raster space** (the same `x`/`y` the
plot feed and `district-plots.mjs plotKey` already speak), with fractional offsets inside a plot. So
the client projects it with the existing `projectOn` and it survives realm crops, the homography
projector, and the 3D drape without a second coordinate system.

**Scale.** One plot = 1.0 unit. The original's street widths (main 2.0 / regular 1.0 / alley 0.6) and
ward block sizes (`minSq` roughly 10–110) assume a patch ~10–30 units across, so divide those by
~20–25 when porting the constants, or re-tune from scratch. Fix this early — every ward tuning
number depends on it.

**Lots are symbolic** (owner decision). A plot is a Civ4-scale tile — kilometres, not blocks — so a
literally-scaled medieval town would be a smudge inside one plot, and a 16-plot walled core would
enclose more ground than any real medieval city. We are not doing that. Lots are sized to **read**:
one lot per household is a legible unit of "a family lives here", not a claim about how much ground a
family occupies. This is the same bargain every 4X makes with tile scale, and it means the tuning
target for lot size is *how many blocks look right in a patch*, never metres.

## 3a. Storage: a `json.gz` artifact, like the province data

The layout is **not an in-memory cache** (owner decision). It is written per site as gzipped JSON,
the same shape of artifact as the committed/baked province data, because:

- **Ruins need it.** A dead colony's footprint is gone from `Settlement`, so a layout that lives only
  in a JVM cache cannot be recomputed after a container roll — the ruin would silently vanish on the
  next deploy. Durable storage is the only way §2a's promise survives a restart.
- **World history will want it** (owner, 2026-07-27) — *"the same way Dwarf Fortress needs to age the
  simulation for decades when generating a new world."* The long game is a worldgen pass that runs
  the sim for decades or centuries before play begins, so that a founded world is *lived-in*: towns
  that grew, were sacked, were abandoned. A town layout is then not a render cache at all — it is
  **part of the generated history**, written once by a headless batch and read forever after. That
  reframes three requirements, and they are cheap now and expensive later:
  - **Batchable and headless.** Generation must run for thousands of sites with no session and no
    client, at a cost that survives being multiplied by centuries of history.
  - **Time-stamped.** A layout needs to know *when* — founded, last grown, ruined — or history cannot
    be told from a directory of shapes.
  - **Stable identity.** Lots and gates that keep their ids across a regeneration, so a later system
    can say "this house" and mean the same house.
- **It serves itself.** A `json.gz` per site is directly servable and cacheable, so the fetch endpoint
  is a file read, not a generation request on a session thread.

**Where it lives: the `.map` volume, one directory per session** (owner, 2026-07-27) — the same
`PLOT_CACHE_DIR` volume the plot cache uses, inheriting its "wipe on a version change" discipline, so
a layout carries a **version stamp** and a generator change invalidates old files the way
`MAP_VERSION` does. Per-session also settles the key collision: two sessions on the same seed found
the same site and must not overwrite each other's town.

Per-session and "ruins outlive the colony" are consistent — a ruin outlives the *`Settlement`*, not
the session it belongs to. The worldgen-history case above is the exception that will eventually want
a session-independent tier (a generated world's history is the world's, not one playthrough's); it
does not need one yet, and the per-session directory is the right first shape either way.

---

## 4. The ward → plot mapping (T3, the core inversion)

The original *creates* its shape: scatter a spiral of points, Voronoi, take the nearest `nPatches`
cells as the city. We invert it — the shape is **given** and the mesh is fitted to it:

1. **Seed one point per plot centre** in the footprint. Not a free scatter.
2. **Jitter each seed off its plot centre**, clamped to a radius `r < 0.5` plot widths (§4.1 — this is
   where the irregularity comes from, and the clamp is what makes step 4 free).
3. **Voronoi**, then **one Lloyd pass** with the cells clipped to the footprint polygon, **re-clamping
   each seed to its `r`-disc after the pass**.
4. Each cell still contains exactly one plot centre ⇒ **a bijection `Plot ↔ Patch`**, guaranteed by
   the clamp rather than checked and hoped for.

Why this and not the alternatives:

- **Squares (patch = the plot cell literally)** preserves the bijection but every ward is a square —
  the city reads as a grid, and the wall outline is a staircase with 4 vertices per plot edge, which
  over-produces gates and defeats the wall smoothing.
- **Free Voronoi clipped to the footprint** is organic but breaks the bijection, so the engine's
  per-plot `DistrictType` and the drawn ward diverge — the client would be inventing district
  identity, which `district-buildout.md` explicitly forbids.
- **One seed per plot, jittered and clamped** is both: irregular organic cells *and* a bijection.

### 4.1 Jitter makes the mesh, the clamp makes it safe

**A lattice's Voronoi diagram is the lattice.** Plot centres sit on a regular grid, and the Voronoi
cells of a regular grid are exactly the grid squares — each square's centroid is its own centre, so
**Lloyd relaxation on unjittered plot centres moves nothing at all**. Read literally, "seed the plot
centres and relax" is a no-op that lands on the square-ward, staircase-wall outcome the alternatives
above reject. The irregularity cannot come from the relaxation; it has to be **injected as jitter**,
and relaxation's job is only to take the slivers back out.

That inverts the usual dosage. Lloyd converges toward a honeycomb — it *spends* irregularity — so
running it to convergence undoes the jitter it was given. **One pass**, which removes the worst
slivers and lets footprint-clipped edge cells settle inward, then stop.

**The clamp: `|seedᵢ − centreᵢ| < r` with `r < 0.5` plot widths, enforced on the jitter and again
after the pass.** With plot spacing 1, for any other plot `|centreᵢ − seedⱼ| ≥ |centreᵢ − centreⱼ| − r
≥ 1 − r`, so `r < 0.5` gives `r < 1 − r` and `centreᵢ` is strictly closer to its own seed than to any
other. Therefore:

- **every plot centre lies in its own cell** (the forward bijection), and
- **every cell is non-empty**, since it contains at least that centre (the reverse).

Both directions hold **by construction, for any footprint shape**. This matters beyond tidiness: a
clipped cell over a concave footprint can be L-shaped, and *an L's centroid can lie outside the L* —
so an unclamped Lloyd pass can walk a seed into a neighbour's territory and break the bijection on
real geometry. T3's assert would then fire on a session thread under `-ea`, which is the same failure
class §5 exists to eliminate: a shape-dependent throw that retrying cannot fix. Under the clamp the
check can never fire, which is what lets it be **a guard and not a hard rule** (owner, 2026-07-27):
if it ever does fire, it logs and that patch falls back to its plot square — the mesh degrades by one
cell, and no session thread dies over a render feature (§5.1's rule).

**A bounded reshuffle, as a bonus.** §2a argues a growing town never reshuffles its existing wards
because the plot set is monotone. That is true of the plot set but *not* of the geometry: Lloyd is a
global fixed point, so a new seed shifts its neighbours' centroids, which shift theirs, decaying with
distance but never to zero. The clamp bounds the damage — no seed can ever be more than `r` from its
plot centre, so **no patch boundary can move by more than ~2r however the town grows**. Existing
wards breathe; they do not migrate. That is the honest form of §2a's stability claim.

**Consequence — `rateLocation` becomes the district placement CivStudio already needs.** The
original's static-per-ward-class score ("Cathedral wants the plaza, Military wants the wall, Slum
wants the outskirts") is a strictly richer version of today's `district-plots.mjs nearestPlots()`
distance ranking. Since a patch is a plot, scoring wards over patches *is* assigning district types
to plots. Feed it real state:

| Score input | Source |
| --- | --- |
| distance to centre / plaza | the founding plot (`ColonyView.centerX/centerY`) |
| the buildings standing here | `Plot.buildings()` → `DistrictType.fromCategory` (the derivation already exists) |
| who holds the plot | `Plot.ownerId`, `Noble.fief`, crown demesne (`city-of-hamlets-plan.md`) — the real Patriciate/Slum split, instead of the original's invented one |
| height | `Plot.elevation()` + `plotType()` (§7) |
| on the wall / on a street | computed by T4/T5 |

`DistrictType` covers six of the ward roles; `CAMPUS` (`Advisor.SCIENCE`) has **no ward in the
original** and must be authored — a scholars' quarter, closest in form to `AdministrationWard`
(large, regular blocks).

## 4a. Density from real state, not invented subdivision

The original decides how many buildings a ward holds by recursively bisecting its block until each
half falls under a random size threshold (`minSq`, jittered per ward class). The count is *invented* —
it has to be, because nothing else knows.

**We know exactly** (owner, 2026-07-27):

| Datum | Source |
| --- | --- |
| households living on a plot | `PlotField.homePlotLoads` (`Map<Plot,Integer>`) — the per-plot load the food split already divides by |
| the exact buildings on a plot | `Plot.buildings()` → served as `DistrictView.buildings` with **id, owner and ownerName** |
| how many the tier permits at the centre | `SettlementTier.maxCenterBuildings()` — CAMP 0, COTTAGE 1, HAMLET 3, SMALLHOLDING+ unrestricted |

So subdivision stops being a random target and becomes a **fitted** one: subdivide the block until it
yields at least `buildings + households` lots, then assign in order —

1. **one lot per real building**, stamped with its C2C `nifbake` sprite (the Layer-3 art from
   `district-generator.md`), sized by the building's importance so a cathedral is not a cottage;
2. **one lot per household**, a dwelling — and since `DistrictView` already carries `ownerName`, a
   house can be labelled for the family living in it;
3. the remainder left **empty** — yards, gardens, or ruins under decline (§2a).

This is the payoff of the whole port: a plot with twelve households and three buildings *looks*
different from one with two households, because it is. `minSq` and the ward chaos parameters survive
only as **shape** controls — how regular the blocks are, how the alleys run — not as population
controls.

## 4b. The founded city: the starting core is populated, not empty

§4a fits lots to real households and buildings, and §2 walls the 1444 starting core ∪ the built
plots. Those two rules collide at founding: a 1444 metropolis walls ~32 plots of which the sim has
claimed **one**, so a strict reading gives a full curtain wall around thirty-one empty blocks — worse
than the single hut it replaced.

**The resolution (owner, 2026-07-27): generate a city of the appropriate size, with lots of
households.** A founded city is *already a city*. The starting core's plots get a **synthetic
population** — households and buildings placed so the town reads at its historical size on day one —
and the sim's real state overwrites that as it claims and builds.

This makes the layout's density input a **two-source** quantity, and the split has to be explicit or
it will rot:

| Plot | Households and buildings from |
| --- | --- |
| claimed and built by the sim | **real state** — `PlotField.homePlotLoads`, `Plot.buildings()` (§4a) |
| in the 1444 starting core, not yet claimed | **synthetic** — derived from `Province.development()` and tier, distributed over the core's patches |

Three constraints on the synthetic half:

1. **It is render-only — for now** (owner, 2026-07-27). It never enters the engine, is never counted
   as population, never eats and never pays tax. It is the same category of thing as
   `startingDistricts` is today: display metadata describing a world the sim has not simulated.
   *Founding a colony with a real population to match* is the eventual answer and a much larger
   change — it touches plot claiming, the peasant pool, the food economy and every balance
   assumption — so it belongs to its own plan, not to this one. Keep the synthetic layer thin enough
   that it can be deleted the day the engine makes it redundant.
2. **Real state always wins.** When the sim claims a core plot, that patch switches to real counts
   permanently. The transition should read as *filling in*, not as a discontinuity — a plot the sim
   claims with two households should not visibly lose fourteen the moment it becomes real. Cap the
   synthetic count near what the sim plausibly reaches, or fade the difference in.
3. **It is derived, not stored.** Same seed + same province ⇒ same synthetic town, so nothing about
   it needs persisting beyond the layout file itself (§3a).

**Open:** the distribution function — how `development()` (a 1444 number in the ballpark of 3–30)
becomes a household count per patch, whether density falls off from the centre (it should) and
clusters along the streets T5 lays down (it should). This is the main uncalibrated quantity in the
plan, and the one most visible when wrong.

---

## 5. The four totality fixes

The original escapes bad geometry by **regenerating**: its constructor is a `do { try { build() } catch {} } while (!ok)` loop, and several steps throw on degenerate shapes. With the footprint **fixed by sim state**, regeneration cannot change the shape, so every shape-dependent throw becomes an infinite loop. All four of these are load-bearing, and all four land in T2/T4.

### 5.1 The retry loop must not gate on shape

Re-randomising only the **free** parameters (relaxation jitter, ward shuffle, lot subdivision) does
fix street- and ward-level failures, because those consume randomness. It does **not** fix wall or
gate failures, which are pure functions of the footprint. So:

- Wall and gate construction become **total** — they fall back, they never throw.
- The retry loop keeps a **hard attempt cap** (e.g. 8) and, on exhaustion, emits a valid degenerate
  layout (walls omitted, streets straight-line) plus a `SimLog` warning. A render feature must never
  be able to hang a session thread.

### 5.2 Holes and disconnection

The union-outline walk follows exactly one loop and terminates on returning to its start. A **hole**
— entirely reachable, since `CityPlacement.coreCells` skips `PEAK` cells and a settlement can build
around one — or a **second disconnected clump** is silently dropped or mis-walked.

Fix in the footprint stage, before any geometry:

1. 4-neighbour connected components over the built plots → **keep the largest**; log the discarded
   count. (Outlying built plots then read as hamlets outside the wall, which is correct anyway.)
2. **Fill interior holes** — flood-fill from outside the bounding box; anything unreached is a hole,
   promote it into the footprint.
3. Assert the resulting outline is a single closed simple loop. This is a real `assert` (the repo
   uses them as invariant checks under `-ea`), not a silent recovery.

### 5.3 Single-plot and tiny footprints

A one-patch footprint takes the wall builder's degenerate branch — four vertices against a
spacing loop that wants ≥3 candidates — and throws. Resolved by the locked decision: **walls only on
permanent settlements** (`isPermanent()`, `TOWN`+). Below `TOWN` there is no wall at all, so the
branch is never reached. Additionally require **≥ 4 plots in the footprint** before walling, so a
freshly-promoted town with a two-plot core stays unwalled until it has something to enclose.

### 5.4 Gate over-production

The original's gate spacing (splice out neighbouring candidates until fewer than three remain)
assumes a Voronoi-length vertex list. A polyomino-derived outline has far more vertices, so the same
heuristic yields a wall that is mostly gate. Moot once gates come from portal bearings (§6) — but
**do not inherit the spacing logic**; replace it with the angular-separation rule there.

---

## 6. Gates from the neighbour portals (T4)

Random gate placement is the crudest step in the original. We have better data:

- `/map/portals.json` → `WorldMap.portalByEdge`, keyed by directed edge (`from<<32 | to`), giving
  the raster pixel on `from`'s side of each shared border — **where a route actually crosses**.
- MAP_VERSION 16 ships each province's **neighbour ring**, so the neighbour set is local.

Algorithm: for each neighbouring province, take its portal pixel → bearing from the city centre →
choose the wall vertex whose outward normal best matches that bearing.

Three constraints inherited from the original, all still necessary:

1. **A gate must sit on a vertex with ≥2 adjacent inner patches**, or no street can be routed to it.
   The directed pick becomes "nearest *valid* vertex to the bearing", with a fallback (next-best
   bearing; then skip that neighbour) when none qualifies.
2. **Minimum angular separation** between gates, or two near-collinear neighbours produce two
   adjacent gates. Replaces the spliced spacing rule of §5.4.
3. **Keep the gate-vertex smoothing** — flaring the wall at each gate is what makes a gate read as a
   gate rather than a gap.

**The payoff is the streets, not the gates.** Because streets A* from each gate to the plaza, aiming
gates at the portals makes the town's main avenues point at the roads that actually leave it — and
they then line up with the standing route ribbons (`route-ribbon.mjs`) at the province border.

---

## 7. Altitude (T5, T6, T7)

`Plot.elevation()` (0–255 heightmap) and `plotType()` (`FLAT`/`HILL`/`PEAK`) are already on the plot
and already reach the client; `web/js/heightfield.mjs` already folds them into **corner** heights
(mean of the up-to-4 plots touching a corner). Three uses, in ascending order of payoff:

1. **Ward placement** (T6) — a height term in `rateLocation`. Citadel/castle on the high ground,
   cathedral on a rise, slums in the low ground.
2. **Street routing** (T5) — **the highest-value use.** The street graph today weights each link by
   plain distance. Weight it `distance × (1 + k·|Δh|)` and A* contours streets around a hill instead
   of running them straight up it. One line; most of what separates a plausible town map from a
   convincing one.
3. **3D drape** (T7) — the layout is 2D polygons in ground space, so it rides the existing
   `core.mjs setGroundHeight` seam onto the terrain mesh from band 6.5, exactly like the other
   ground-anchored 2D content.

### 7a. Water

The generator we are reimplementing has no waterbodies (the open-source drop dropped them), yet
CivStudio sites cities **water-first** — `CityPlacement`'s dominant term is coast edges plus reachable
river cells — so a large share of settlements sit on shore or river. The work splits cleanly by cost,
and the split is decided by a structural fact:

> **Coastlines are edge-based; rivers are cell-based.** `Plot.coast()` is a bitmask of which of the
> plot's *edges* face water. Rivers come from EU4's `rivers.bmp` and run through plot **centres**,
> chaining cell to cell (`web/js/river-geom.mjs`). So a coastline lies on patch boundaries — free to
> work with — while a river cuts *through* a patch.

**Free — already true.** The footprint is claimed built plots, land by construction (`mask.isLand`).
No water plot can enter it, so the union outline **already traces the shoreline exactly**.

**In scope now (T2/T4/T5).** These are cheap, and — decisively — they are what a later water pass
would otherwise have to reopen:

- **Quay vs wall.** Classify each outline edge by the adjacent plot's `coast()` bitmask; waterfront
  edges render as quay with terminating towers instead of curtain wall. A bitmask lookup, no new data.
- **Street cost.** Sea edges blocked, river cells high-cost-but-crossable (a bridge). Identical in
  shape to the slope penalty above — one weight function carries both terms.
- **Water-aware hole-fill.** An enclosed lake is a *legitimate* hole, but §5.2's fill would swallow
  it. Hole-fill must distinguish unbuilt land (fill) from water (keep) — which makes the outline
  multi-loop and **relaxes T2's single-loop assertion to "one outer loop plus zero or more water
  holes"**. This is the item that must be right up front: it is an invariant, not a feature.

**Deferred to T4b:**

- **The river clip line.** Port `river-geom.mjs`'s centre-line decode to Java (~30 lines, pure,
  already unit-tested on the web side) and use the polyline as a clip with a bank buffer, so lots
  avoid the channel and the patch survives intact. The cheap alternative — promoting a river plot to a
  whole water patch — is consistent with the bijection but coarse at city scale.
- **Bridges.** Where a street crosses the centre-line, mark the crossing and draw it. The one piece
  with no existing analogue anywhere in the codebase.
- **Harbour ward.** One new ward class scoring on `bitCount(coast())`. Small, but it needs T4's quay.

**Caveat, and it matters for tuning:** the imported heightmap is continental and low-frequency —
`heightfield.mjs` records a test province spanning only 99..145 of 255 — so *within one settlement*
the raw elevation range is small. Relief carries more signal at city scale. Scale the two terms
separately. Note also that `CityPlacement` never founds on a `PEAK` and clamps peak core cells to
`HILL`, so a city already sits on the flattest ground available.

---

## 8. What to build, what to skip

Scope map of the reference generator's concerns. Under the clean-room decision (§0) "build" means
*implement this capability from the spec above*, **not** translate the corresponding file.

| Concern | Disposition |
| --- | --- |
| Polygon algebra — inset/outset by per-edge distance, cut by a line, edge iteration, compactness, barycentric interpolation | **Build.** The workhorse everything else calls. |
| Voronoi + Lloyd relaxation; a weighted graph with A* | **Build.** §4's mesh and §5's streets. |
| Block cutters — bisect, radial, semi-radial, ring | **Build.** No CivStudio equivalent; needed for parks, plazas, ring cathedrals. |
| Ward vocabulary + `rateLocation` scoring hook + recursive block subdivision | **Build**, re-specified per §4/§4a — subdivision is *fitted* to real counts, not random. Replaces `footprints.mjs`. Author `CAMPUS`. |
| The build pipeline itself | **Build, restructured.** The pipeline inverts (§4) and the retry loop changes (§5.1) — this is the part that differs most from the reference. |
| Curtain wall + gates + street topology | **Build with the §5/§6/§7a changes** (capped core, portal-aimed gates, quay edges). |
| RNG | **Ours outright** — a salted per-settlement stream (§10). |
| Renderer, palette, patch views, hover | **Skip.** The flat parchment palette does not fit real recoloured terrain art; `layers.mjs` replaces the draw dispatch and `maptip.mjs` the hover. |
| App shell, scene graph, UI widgets, URL state | **Skip entirely.** CivStudio's frontend already exists. |
| Markov name generation, Perlin noise | **Skip.** Dead code in the reference — referenced by nothing. CivStudio has its own name generator. |

## 8a. What the town layer replaces on the client

**Over its bands, `town.mjs` is the only thing drawing built ground** (owner, 2026-07-27) — the
superseded treatments are removed, not layered under it. Two surfaces cannot both claim to say what
stands on a plot; that is how the two-footprint disagreement of §2.1 happened in the first place.

- **Retired outright:** `js/footprints.mjs`' `sqrt`-grid of blocks, and the district-icon /
  neighborhood-chip drawing of the same plots at these bands. A real lot with a real building sprite
  on it says everything the chip said, better.
- **Moved server-side, not merely replaced:** `district-plots.mjs nearestPlots()`. The footprint is
  T2's answer now, so the client must stop computing a second one (see the JS→Java note below).
- **Kept, band-scoped:** the icon/chip treatments stay alive **below** band 5.5, where there is no
  room for a town and a settlement must still read as a marker. This is a band-envelope handover in
  `layers.mjs`, the same shape as every other one on the spine.
- **Untouched:** the **city screen** is a panel, not a map layer, and stays the authoritative
  per-plot readout. The natural follow-on is a lot click opening it at that plot's row, which needs
  the Ground-regime input dispatch still deferred (§11).

## 8b. Client logic this port should pull into Java

The rule: **logic that derives world or sim truth belongs in Java; logic that derives pixels from
data already served stays in JS.** This port creates or worsens four violations, so they are in
scope, not adjacent cleanup:

| Client logic | Why it moves |
| --- | --- |
| `district-plots.mjs nearestPlots()` | Decides *which urban plots are the city* on the client. T2 makes that the server's answer and §2b reuses the same nearest-first ranking for the walled-core cap — leaving it here restores the §2.1 disagreement by hand. |
| `cost.mjs costFactor()` | Already a hand copy of the engine's `ProvincePlotPool.slopeFactor` constants (`0.06 / 3.5 / 0.05 / cap 8`). T5's slope-weighted A* would be the **third** copy. One owner, served value or served constants. |
| `river-geom.mjs` | T4b ports the decode to Java. Decide there whether Java becomes authoritative and serves the polyline, or we knowingly maintain two decoders — two that drift give bridges that miss the route ribbon by a pixel, in public. |
| `heightfield.mjs` corner rule | T5/T6 score streets and wards on height in Java while the 3D mesh derives corner heights in JS. If the two disagree, lots float off the drape. |

Smaller, optional, and not blocking: `hamlet-food.mjs isFed()` encodes an engine rule the server
could send as a boolean; `footprints.mjs plotBlocks()` ordering is subsumed by T6's lot assignment;
`plotstats.mjs`' land-plot count is a world-data fact that could ride the bundle. Everything else on
the client — `terrain-corners`, `water-terrain`, `coast`, `shore-index`, `sea`, `foliage`,
`tier-geom`, `band-math`, `project-math`, `minimap-geom`, the notify rules — is pixels-from-served-
data and several are per-frame hot paths, so a round trip would be strictly worse. Leave them.

---

## 9. Phases

Each is independently verifiable. **T1–T6 are headless server work and land behind a flag defaulting
off**; T7 is the first user-visible change.

- [x] **T0 — Licence decision (§0).** ✅ **Reading the sources is allowed** (owner, 2026-07-27,
      superseding the earlier clean-room lock): implementers may read anything in
      `C:\Code\TownGeneratorOS` freely.

      **The facts, verified rather than assumed** (2026-07-27): `watabou/TownGeneratorOS` ships a
      `LICENSE` at HEAD and it is **GPL-3** — it covers this open-source drop, not only the closed
      itch.io build. (The local checkout merely has the file deleted in its working tree;
      `git ls-tree HEAD` still lists it.) The project is nine years dormant, which changes the
      practical risk but not the grant.

      **Owner's position:** abandonware, nine years dormant; the commercially-licensed artifact is the
      released app whose source we do not have; and by completion the code will have changed several
      times over, with nothing recognizable left of the Haxe.

      **✅ Decided (owner, 2026-07-27): a single Apache-2.0 module, reference-informed.** The port
      lives in `com.civstudio.server.town` as this plan already specifies — no separate GPL-3 module,
      no relicensing. The sources are read for understanding and the implementation is written from
      §1–§8, which is a substantial re-derivation rather than a translation: the pipeline **inverts**
      (the shape is given, not generated — §4), the retry loop is **restructured** (§5.1), the
      subdivision is **fitted to real sim state** instead of random (§4a), and the constants are
      **re-tuned from scratch** at our unit scale (§3). An accepted risk, taken knowingly and recorded
      here so the reasoning is not lost.
- [x] **T1 — Geometry core.** ✅ **Shipped 2026-07-27.** `com.civstudio.server.town.geom`, 51 tests
      green, no engine and no Spring dependency: `Pt`, `Poly` (area centroid, orientation, contains,
      half-plane and convex clipping, per-edge inset, cut-by-line, compactness, barycentric
      interpolation, distance-to-boundary), `Voronoi` (bounded, by half-plane intersection),
      `Lloyd` (jitter + clamped relaxation), `Graph` (weighted, A*), `Cutter` (bisect, radial, ring,
      and the fitted `subdivide` §4a needs), `TownScale` (the unit scale, fixed per §3), and
      `GridOutline` — the union outline of a set of plots, i.e. the wall line before it is a wall.
      RNG is an explicitly threaded `RandomGenerator` throughout (§10); there is no global.

      Three findings worth keeping, all of them the same shape — <b>degenerate input coming back
      plausible instead of empty</b>, which is precisely what §5 is about:
      - **Coincident seeds have no bisector**, so the naive clip leaves *both* cells holding the
        whole bounds — two patches claiming the same ground while looking perfectly healthy. The
        earlier seed now takes the cell and the later gets `EMPTY`.
      - **An over-inset polygon does not flip orientation.** Inset a unit square by 0.6 and the
        opposite edges cross, but the corners still wind the same way: a tidy 0.2 square with
        positive area, entirely wrong. Neither area nor sign detects it; the test that works is
        that every inset vertex stays at least the inset distance from the original boundary
        (`Poly.distanceToBoundary`).
      - **§4.1's lattice claim is exactly true and slightly narrower than stated**: relaxation is a
        no-op on bare plot centres only where the cells *are* the plot squares. At a concave
        footprint boundary, cells reach into open ground and their centroids genuinely move — which
        is the one place relaxation does useful work unprompted, and is now asserted both ways.

      `GridOutline` landing here rather than in T2 is deliberate: the grid→polygon walk is pure
      geometry (integer corners, so coincident vertices compare exactly and no floating-point union
      is needed), while T2 keeps the rules that decide *which* loops to keep — largest component,
      fill land holes, leave lakes.
- [x] **T2 — Footprint.** ✅ **Shipped 2026-07-27.** `Footprint` (pure: cells + a land predicate in,
      cleaned cells + boundary loops + diagnostics out) and `ColonyFootprint` (the engine adapter),
      18 tests. 1444 starting core ∪ built plots (§2.1) → largest 4-connected component → water-aware
      pocket fill (land filled, lakes kept, a mixed pocket kept whole) → outline as one outer loop
      plus zero or more water holes. **Ships §5.2.**

      **Outlying clumps are extramural, not discarded** (owner correction, 2026-07-28): scattered
      urban plots are real built ground, so the largest component becomes the walled body and
      everything else stays in the layout as `Footprint.outliers()` — suburbs outside the wall
      (§2b). Dropping them, as the first cut did, quietly deleted plots the sim had built on.

      **The single-loop check is a reported diagnostic, not an assert** — consistent with T3 and
      §5.1: `Diagnostics.singleOuterLoop()` travels with the footprint for the caller to log, and
      nothing throws. `Footprint.nearest()` is `district-plots.mjs nearestPlots()` moved server-side
      with its `(y, x)` tie-break preserved (§8b), and it now answers both questions that must never
      diverge — which urban plots form the starting core, and which fall inside T4's walled-core cap.

      **Verified on Dhenijansar** (the §9 canonical site): the sim has claimed exactly one plot, and
      the footprint is nonetheless a **30-plot town with a 20-vertex outline**, one loop, no holes —
      §2.1's argument holding in practice rather than on paper. That number is now a regression
      assertion, so dropping the starting core from the union would fail loudly instead of quietly
      walling a hut. Note the site founds at `METROPOLIS` already, so the big-city path is the one
      under test by default.

      **For T3:** cells come back sorted by `(y, x)`, not in claim order. Sorting is stable under
      re-derivation (a ruin re-read from disk has no claim order), but it means a new plot can land
      in the middle of the list — so T3 must **derive each cell's jitter from a hash of (seed, x, y)
      rather than from draw order**, or growth reshuffles every seed after the insertion point. That
      also retires §10's order-sensitivity worry for the mesh entirely.
- [x] **T3 — Mesh.** ✅ **Shipped 2026-07-28.** `TownMesh` (one patch per plot: keyed jitter,
      clamped, one Lloyd pass) and `TownRng` (keyed randomness), 19 tests. The bijection holds **by
      construction under the clamp**, and the check is a **non-fatal guard, not a hard rule**
      (owner) — zero repairs on every shape tested, including one that is concave, holed and
      carrying a detached suburb at once. Extramural clusters are meshed like everything else: a
      suburb is built ground with households on it.

      **Grid-line clips beat ghost seeds.** The footprint is a polyomino, so clipping cells to it
      would need general polygon booleans. Ghost seeds in the empty cells were the obvious dodge and
      are *worse*: a bisector against a ghost falls short of the plot edge, so every boundary ward
      would pull back and leave a ring of unclaimed ground between the last houses and the wall.
      Clipping at the shared grid line is exact for a polyomino, keeps every patch convex, and puts
      the ward precisely on the line the wall will follow. Residue: a patch can round a diagonal
      corner into an empty cell by up to the jitter radius — bounded, rare, hidden under the wall.

      **Locality is a guarantee, not an optimisation.** Each patch is built from the seeds within
      two plots, against bounds derived from its own cell, so it is a **bit-exact function of its
      5×5 neighbourhood**. The first cut derived bounds from the town's bounding box, and growing
      the town then shifted every patch by a few ulps — the same class of bug as stream-ordered
      jitter, only quieter. Asserted now: build a plot three away and every existing patch compares
      equal, byte for byte.

      Also found: `Poly` had no value equality, so two identical meshes never compared equal — every
      cache check and test comparison would have silently reported "changed".
- [ ] **T4 — Wall + gates.** Walled core capped, remainder extramural (§2b); union outline +
      smoothing; **waterfront edges as quay, not wall** (§7a); gates from portal bearings (§6); walls
      gated on `isPermanent()` and ≥4 plots; **wall retained as a high-water mark** (§2a). **Ships
      §5.1, §5.3, §5.4.**
- [ ] **T5 — Streets.** A* from each gate to the centre under **one weight function carrying both the
      slope penalty and the water terms** (sea blocked, rivers crossable at bridge cost — §7, §7a);
      artery deduplication; smoothing. Unwalled settlements radiate from the centre to the footprint
      edge.
- [ ] **T6 — Wards + lots.** `rateLocation` over real sim state (§4); block subdivision **fitted to
      the real household and building counts** (§4a) **plus the starting core's synthetic population**
      (§4b — a founded city is generated at its historical size, not as empty blocks), lots assigned
      buildings → dwellings → empty;
      **outskirts thinning + gate clustering** for the extramural belt (§2b). `CAMPUS` authored.
      Decline renders as ruins in the empty remainder.
- [ ] **T4b — Water, the expensive half.** *(after T6; independent of T7)* River centre-line clip with
      a bank buffer (port `river-geom.mjs`'s decode); bridges at street crossings; harbour ward (§7a).
- [ ] **T7 — Store, serve, draw.** The layout written per site as **`json.gz`, keyed by site and not
      by live `Settlement`** (§3a) with its own version stamp — a dead colony's layout persists as a
      ruin (§2a), so its lifetime is decoupled from the colony's here rather than bolted on later.
      Served from **its own endpoint** with only a `townDirty` flag on the snapshot (§1 Transport);
      `js/town.mjs` registered in `layers.mjs` over bands 5.5→8, **retiring the surfaces it
      supersedes** (§8a); C2C building sprites stamped into lots; 3D drape via `setGroundHeight`.

**The vertical slice that first shows something real** is T1→T2→T3→T7-prototype (draw the mesh and
outline only). Wall, streets and wards can then land one at a time on a surface that already renders.

**Validate against a real city, not the current demo** (owner, 2026-07-27 — "the current demo is not
relevant"). The target case is a founded 1444 city at historical size with a full synthetic
population (§4b); a fresh colony that may never reach `TOWN` exercises the unwalled branch only and
tells you nothing about whether the feature looks right.

**The canonical test site is Dhenijansar** (owner, 2026-07-27) — province **4411**, the Raj's capital
in Rahen (`Realm.Haless`): `city_terrain`, development **30** (12/12/6), centre of trade 2, culture
`rabhidarubsad`, high philosophy, paper. It is close to a worst case in every axis this plan worries
about, which is why it is the right one to look at:

| It exercises | Because |
| --- | --- |
| §2b's extramural cap | all-urban, so the footprint offers far more plots than the walled core may take |
| §4b's density function | top-of-range development — if 30 does not read as a capital, nothing will |
| realm handling | Haless, so the layout crosses a realm crop rather than sitting in the Cannor default |
| §11's known wrongness | a Rahen imperial capital rendered as a European market town is the most conspicuous instance of "one vocabulary for all", and worth *seeing* before deciding how long to accept it |

Practically this needs a way to found a colony there on demand — a dev scenario or `CalibrationRun`
variant taking a province id — which T2 should ship, since every phase after it needs the same thing
to look at.

## 9a. Open for the owner

1. **The synthetic density function (§4b).** How `development()` becomes households per patch. The
   most visible uncalibrated number in the plan, and Dhenijansar's 30 is the number to tune against.
2. **Generation cost at worldgen scale (§3a).** Per-session, per-site, on demand is fine today; a
   Dwarf-Fortress-style aging pass multiplies it by thousands of sites × centuries. Nobody needs to
   solve that now, but T1 should **measure** a single layout's cost so the later decision is made
   against a number rather than a guess.

---

## 10. Determinism and testing

- **RNG.** A per-settlement **salted stream** derived from the session seed + settlement id — never
  the economic stream (repo convention: a new feature never consumes from it). The original's global
  static LCG is replaced by an instance threaded through generation. This is mechanical but touches
  every call site, so do it in T1, not later.
- **The float trap survives the language change.** The original's LCG relies on `seed * 48271`
  staying exact in floating point. In Java use `long` arithmetic; never `int`, which overflows and
  silently breaks the sequence. Applies to any LCG we choose, not just theirs.
- **Jitter draw order.** The per-seed jitter (§4.1) is the mesh's only randomness, so it is also the
  mesh's whole reproducibility surface: draw it in **plot claim order**, two draws per seed, never
  keyed on iteration order over a `Map`. A town that reshapes because a hash bucket moved is the
  worst kind of non-determinism to chase.
- **Order sensitivity.** Generation is order-sensitive to every draw — hoisting one call out of a
  loop changes all downstream output. Freeze the draw order per phase and add a **draw counter** per
  stage; a test asserting stage draw counts localises any divergence to the stage that changed.
- **Golden fixtures.** Snapshot a few `(settlement footprint, seed)` → canonical JSON (outline
  vertices, gate positions, ward assignment per plot, lot counts) as regression tests. Cheap, and the
  only practical guard against a refactor quietly reshaping every town.
- **Web unit tests.** `js/town.mjs`'s pure parts (projection of served polygons, band envelopes) get
  `node --test` coverage alongside the existing `web/js/*.test.mjs`, per repo preference.
- **Performance.** The Ground-band frame budget is <3 ms (`frontend-performance.md`). Layout is
  computed server-side and cached per settlement, so the client cost is draw-only — but a 30-plot
  town is on the order of several hundred lot polygons, so measure before adding per-lot sprites.
  Read that doc before optimising anything here; its warning that the obvious metrics all lie applies.

---

## 11. Deferred

- **Era and race vocabularies** — **one vocabulary applies everywhere in v1** (decision, §1),
  including dwarven holds (`DWARVEN_HOLD`, underground, `Realm.Serpentspine`), which will read as
  medieval European towns underground until this lands. `ArtEra`
  (ANCIENT/CLASSICAL/MEDIEVAL/RENAISSANCE) selecting ward tuning and building palettes — the analogue
  of the Civ6 `EraDistribution` — is the refinement, and a per-race vocabulary rides the same seam.
  Accepted as a known wrongness, not an oversight.
- ~~**Waterbodies**~~ — **split, not deferred** (§7a). The cheap half is in T2/T4/T5; the rest is
  **T4b**, a scheduled phase.
- ~~**Ruins after colony death**~~ — **in scope** (§2a, T7). The layout cache is keyed by site so it
  outlives the `Settlement`.
- ~~**Growth stability**~~ — **resolved by §2a + §4.1.** The claimed set is monotone in a living
  colony, so patches are only ever added; and the seed clamp bounds any patch boundary's movement to
  ~2r however the town grows, so what reshuffle remains is a breath rather than a resettling. No
  `GrowthStage` machinery needed.
- **Interactivity** — per-lot hit-testing (click a house → the household that lives in it) needs the
  Ground-regime input dispatch still deferred in `zoom-bands.md` phase 6.
