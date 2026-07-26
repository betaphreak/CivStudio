# Realms

**Status:** design, not built. 2026-07-17.

A **Realm** is a map. Today CivStudio has exactly one — the whole cylindrical world, 5264 provinces,
wrapping horizontally at 360° of longitude. This doc splits it into three, each cropped to its own
pixels, each unaware the others exist.

The Old World realm is named **Halcann** (decided) — Anbennar's own word for it, *earth-center* in Old
Castanorian, the landmass holding Cannor, Sarhal and Haless. The mod's localisation uses it as the direct
antonym of Aelantir ("out of Aelantir to Halcann"), so the three realm names are all canon and all
distinct: **Halann** is the *planet* the three realms sit on, and stays reserved for it. Halcann exists in
Anbennar only as lore vocabulary — `map/continent.txt` has no such entry, it spans the `europe`/`asia`/
`africa`/`serpentspine` engine continents — so the union is ours to define, which is exactly what a realm
is.

| Realm | Land | Water | Total | Crop | Playable |
|---|---|---|---|---|---|
| **Halcann** | 3418 — `europe`, `asia`, `africa`, `serpentspine` | 187 | **3605** | 2437px (43.3%) | yes |
| **Aelantir** | 1377 — `north_america`, `south_america` | 178 | **1555** | 2369px (42.1%) | yes |
| **Hinuilands** | 2 — `oceania` | 0 | **2** | 162px (2.9%) | no — viewable only |
| *(no realm)* | 3 quirks | 99 deep ocean | **102** | — | fogged everywhere |

3605 + 1555 + 2 + 102 = **5264** — it balances against the imported map exactly. (Land counts are
below the raw continent totals because ~50 `SEA`/`LAKE` provinces carry a continent and are counted as
water here: water is assigned by adjacency, never by continent.) Phase 0 adds 4 more.

> **These numbers are post-`fb79aaa`.** The committed map resources had drifted from the locked Anbennar
> ref — the lock moved on 2026-07-12 and only `provinces.json` was regenerated — so an earlier draft of
> this doc measured a world that was part pre-bump and part post. Regenerating moved 192 fields on 113
> provinces, and three of them land squarely here: **Ekyunimoy is `oceania`, not `north_america`** (so it
> is a *Hinuilands* quirk, not an Aelantir one); **Vyr Pas is `LAND`, not `GLADEWAY`**; and deep ocean is
> **99**, not 91. Every conclusion below survived — including the load-bearing one, **zero water
> conflicts** — but the counts moved, and the earlier ones are not worth trusting.

The Serpentspine underworld stays **inside Halcann** as its existing `z:[-1]` plane — realm and z are
orthogonal axes (§Realm is not z).

## Why this exists

**EU4 cannot have separate maps.** Everything must live on one cylinder, so Anbennar's modders faked
their second and third worlds: Aelantir is a real landmass across a real ocean, but the Hinuilands —
meant to be elsewhere entirely — became two isolated provinces stranded in the Pacific with no route in,
plus 243 reserved-but-unpainted placeholders and a teleporter network wired to nothing.

CivStudio is not EU4 and has no such limit. **Realms is us lifting the limitation Anbennar worked
around.** That framing decides the open questions below: where the data looks broken, it is usually a
workaround for the single-map constraint, and the fix is to stop reproducing the workaround.

## What the map data actually says

Every claim here is verified against `civstudio-engine/src/main/resources/generated/map/` and the
Anbennar source at `.anbennar-cache` (→ `C:\Code\anbennar-eu4-dev`).

### Hinuilands is not painted, and nothing reaches it

`hinuilands_superregion` has five regions — Titanoflora Riverlands, Lakelands, Forests, Valley, Savanna —
spanning **61 areas** that reference **245 province ids**. Exactly **two** are real. The other 243 are
reserved placeholders in `map/definition.csv`, unpainted on `provinces.bmp`, so the importer correctly
skips them:

```
3333;190;125;119;UnusedLand143_#be7d77;x
3083;47;252;249;Unused70_#2ffcf9;x
```

Every area is *populated* in `area.txt` — not one is an empty block — and 243 of the 245 ids it names
were never drawn. The modders reserved the whole realm and painted two provinces of it.

Those two are exactly the *land* of `Continent.OCEANIA` — **Vyr Pas** (3060, `LAND`, 739 plots,
`arihan_area` in the Forests region) and **Vyr Cirentyn** (3061, `LAND`, owner N57, culture holoino,
`titanoflora_lakelands_6_area`). **The two sources agree**: realm-by-continent and realm-by-superregion
select the same pair, so nothing about Hinuilands' membership is ambiguous, and Phase 1 can use
`Continent` for it as it does for the other two realms.

Both are **graph islands: zero neighbors**. In Anbennar's own
source, Vyr Pas has no adjacency at all, and Vyr Cirentyn has exactly one:

```
3061;3370;sea;3598;-1;-1;-1;-1;Insyaa        # 3370 = UnusedLand180, 3598 = Anbennar3598
```

Both endpoints are **painted** (364px and 5414px) but placeholder-*named*, so our name filter drops them
(§Teleporters). Even with them, the route reaches only more reserved ground.

So in practice there is **no route to Hinuilands**. You reach it by switching the dropdown, not by
travelling. Hence: viewable, not playable. This is the single-map limitation in its rawest form — a
realm that exists only as coordinates, because EU4 gave it nowhere else to be.

### Teleporters are real, and we drop half of them

Anbennar's `adjacencies.csv` names them literally:

```
7025;3050;;-1;-1;-1;-1;-1;Deepwoods_Teleporter
3050;3051;;-1;-1;-1;-1;-1;Deepwoods_Teleporter
6258;3050;canal;...;deepwoods_fey_portal
6241;6242;canal;...;domandrod_fey_portal
```

92 portal rows in total: 64 `Deepwoods_Teleporter`, 14 `deepwoods_fey_portal`, 9 `domandrod_fey_portal`,
and five seasonal gates (`domandrod_summer_gate`, `spring`, `autumn`, `winter`, `winter2`).

**We import them.** They arrive in `adjacencies.json` as `type:""` rows carrying the comment, they ride
in `WorldMap.combinedNeighbors`, and **`LandRouter` already traverses them today.** The teleporter
mechanic exists and works; it is only the *marker* that is missing, because the `teleport` flag is a
rendering heuristic (`WorldBundle.java:233`, `gcKm > TELEPORT_KM` where `TELEPORT_KM = 800`) and the
gladeways sit close together, so they draw as ordinary connection lines.

> **The heuristic is 0-for-92, and the truth is already in the row.** `adjacencies.json` ships a
> **`comment`** field — the four keys are `from`, `to`, `type`, `comment` — and the comment is literally
> `Deepwoods_Teleporter`, `deepwoods_fey_portal`, `domandrod_summer_gate`. `WorldBundle` **discards it**
> and re-derives `teleport` from great-circle distance instead. That guess is wrong in both directions:
>
> - it **misses all 92** real portals (gladeways sit close together, under 800km);
> - it **fires on four things that are not portals** — the Ee Teah/Sachkriok/Talyasgam/Xaybatencos rows
>   below, ordinary long sea and canal links.
>
> **Ship the flag from the comment and retire `TELEPORT_KM`** — Phase 0 is already opening this data,
> and every consumer downstream (the arrow, the cross-realm line suppression, any future gating of the
> Seasonal Court) needs to know *a teleporter is a teleporter*, not *these two provinces are far apart*.
> Building Phase 4's arrow on a heuristic that has never once been right about a portal is not a
> foundation.
>
> **It keeps the wire name `teleport`** (`[from, to, type, teleport]`, destructured at `main.mjs:363`) —
> only its *source* changes, so no frontend change is needed. And it is emphatically **not** called
> `portal`: `ProvincePortals.Portal` already means a border-midpoint anchor for corridor routing
> (`docs/land-routing.md` Level 2), which has nothing to do with teleportation. One collision of that
> word in the tree is enough.

> **We drop 41 of the 92 portal rows, and all of them are needed.** Every dropped row has an endpoint of
> `7025`, `7027`, `7030` or `7033` — absent from `provinces.json`. What is lost, by row type:
>
> ```
> Deepwoods_Teleporter    kept 28 | dropped 36
> deepwoods_fey_portal    kept 10 | dropped  4
> domandrod_fey_portal    kept  8 | dropped  1
> the five seasonal gates kept  5 | dropped  0   <- fully intact
> ```
>
> So the *gates* survive; it is the **Deepwoods mesh** that is gutted — more than half of it.
>
> **This is not an importer bug — it is a deliberate filter with an unanticipated consequence.**
> `ProvinceExporter.java:134-138` skips provinces whose `definition.csv` name is a placeholder
> (`RNW*`, `Unused*`, or the auto-generated `Anbennar<digits>` pattern), documented at `:82-85`. That
> filter is *correct*: 6661 provinces are painted on `provinces.bmp`, we keep 5264, and the 1397 dropped
> are overwhelmingly RNW filler and unnamed ocean (`Anbennar1405`, 99418px).
>
> The four portal endpoints are collateral. They **are** painted — 100px, 91px, 36px, 33px — and they are
> not junk land: **Anbennar uses placeholder-named provinces as functional teleporter waypoints.** The
> name is a placeholder; the role is not. This is the single-map limitation again — a hub that exists
> only to make the portal graph work has no reason to be given a name.
>
> **Fix: whitelist provinces referenced by a portal adjacency row**, rather than loosening the name
> filter (which would drag in all 1397). Independent of Realms; fix it regardless.
>
> The same filter strands the one sea route Anbennar drew toward Hinuilands —
> `3061;3370;sea;3598;…;Insyaa` dies because `3370` is `UnusedLand180` (364px, painted) and `3598` is
> `Anbennar3598` (5414px, painted, a sea province). Both are real pixels behind placeholder names. We
> leave that route dead by decision, not by accident (§Deferred).

The only rows the 800km flag *does* fire on are four accidents, all within one continent:

```
2193km  canal  Ee Teah -> Fospont            [north_america]
1137km  canal  Sachkriok -> Fospont          [north_america]
1057km  sea    Talyasgam -> Taldaayo         [asia]
 935km  sea    Xaybatencos -> Crooked Island [north_america]
```

Nothing links Halcann to Aelantir **by sea, or by any road**. What links them is a fey portal, and that
is the next section.

### Anbennar already built the crossing, and we were deleting it

**The single most important thing in this doc, and it was found by accident.** Phase 0 shipped, and the
six teleporter rows that the `MAX_KM = 4000` filter had been eating turned out to be this:

```
5491km  Dwhainadbrahin [HALCANN]  -> Domancadh [AELANTIR]   deepwoods_fey_portal
5388km  Domancadh [AELANTIR]      -> Vyr Tars [HALCANN]     domandrod_fey_portal
5266km  Domancadh [AELANTIR]      -> Portal 1 [HALCANN]     domandrod_fey_portal
5707km  Domancadh [AELANTIR]      -> Vyr Sawel [HALCANN]    domandrod_fey_portal
5337km  Domancadh [AELANTIR]      -> Vyr Ian [HALCANN]      domandrod_fey_portal
5768km  Domancadh [AELANTIR]      -> Vyr Tronna [HALCANN]   domandrod_fey_portal
```

**Anbennar authored a cross-realm teleporter network.** Domancadh — the Domandrod fey enclave in Aelantir
— is wired to the Deepwoods gladeways in Halcann by six portals. Not a sea route, not a canal: fey magic,
which is exactly how a mod with no second map moves you between worlds. We dropped every one of them
because 5000km "cannot be a real connection" — the same mistake as the name filter and the distance
marker, for the third time (§Teleporters are real).

**They are land-to-land, and `LandRouter` already walks them.** So as of Phase 0, verified against the
committed graph:

```
Wesdam (Cannor) -> … 33 provinces … -> Clirypriah -> Portal 1 [HALCANN] -> Domancadh [AELANTIR]
```

**You can walk from Cannor to Aelantir.** Today. On foot. Through the province this session named Portal 1
— the nameless hub Anbennar left as filler is the gateway between the Old World and the New.

That upends three things, and they are not small:

- **The realms are *not* disconnected components.** The old claim here — "splitting them cuts no edge, so
  `WorldMap.path()` and `LandRouter` need no realm-awareness" — **is false.** A route *can* leave a realm.
  `LandRouter` therefore needs exactly one realm check, and only one: a cross-realm portal is gated
  default-closed (§Crossing a realm on foot is gated), so a caravan cannot walk off the edge of the map
  unless the gate is open.
- **§Phase 0b is redundant.** It proposed *authoring* a Halcann↔Aelantir sea teleporter so the realms would
  be discoverable. There is no need to invent one: Anbennar already authored six, with better lore than an
  invented sea gate, and the arrow (§The fog must not be mute) now has a real anchor —
  **Portal 1 ↔ Domancadh**.
- **§Deferred's inter-realm travel is not deferred — the mechanism exists.** It said travel "needs boats,
  which do not exist — caravans are land-only". The fey portals *are* land-only, and gated by season
  rather than by boats. The thing we were deferring already exists in the map data.

**Still true, and now the only thing holding the partition up:** the *pixel* and *water* geography is
still cleanly separable. Not one land province in Halcann pixel-touches Aelantir, and not one water
province touches land in more than one realm (§The ocean splits cleanly). The crop is unaffected. What
changed is that the province *graph* is connected, which is a routing question, not a rendering one.

The only three cross-*continent* adjacencies that are ordinary geography all stay within a realm:

```
395km  sea    Altarcliff (north_america) -> Chesh (south_america)      # both Aelantir
 35km  canal  Marrhold (europe) -> Natvirod 2 (serpentspine)           # both Halcann (underworld)
200km  canal  Nooks Cranny (serpentspine) -> Noms10 (asia)             # both Halcann (underworld)
```

### The ocean splits cleanly — by adjacency, not by reachability

BFS over water from each coast is useless: 419 water provinces reachable from Halcann, 336 from
Aelantir, **301 shared**. Multi-hop reachability says nothing about ownership.

**Anbennar's sea superregions cannot help — they are empty shells.** `map/superregion.txt` names all
eight, and every one has an empty body:

```
north_pacific_sea_superregion = {
	
}
```

(An earlier draft of this doc proposed importing them. There is nothing to import. Verified against all
eight: `west_american_sea`, `east_american_sea`, `north_european_sea`, `south_european_sea`,
`west_african_sea`, `east_african_sea`, `indian_pacific_sea`, `north_pacific_sea`.)

**Adjacency answers it exactly.** Assign each water province the realm of the land it *touches*:

```
HALCANN   187 water provinces
AELANTIR  178
deep ocean (touches no land)  99   -> fog
CONFLICTS (touch 2+ realms)    0
```

187 + 178 + 99 = 464 — all of it, unambiguously. Zero conflicts is not luck: no water province touches
land in more than one realm (§Anbennar already built the crossing — the *water* geography stays cleanly separable even though the graph does not).

**And "deep ocean" is a real category, not an invented one** — 99 provinces touch no land at all. That
is precisely the water that should be fogged, and the data volunteers the set. No threshold, no
heuristic, no tuning.

Crops stay contiguous with each realm's water included — Halcann 2437px (43.3%), Aelantir 2369px
(42.1%) — so this costs the pure crop nothing.

## The model

**A realm is a partition of provinces.** No new province ids, no generated geography. `Continent`
already carries the Anbennar display names (`Continent.java:33-39`) — both Americas map to Aelantir,
`OCEANIA` to Hinuilands. The enum was written for this.

**Two sources, one field.** Realm is *not* a pure function of `Continent`: the 408 water provinces have
`continent: null`, so their realm comes from **the land they touch** (§The ocean splits cleanly) while
land's comes from `Continent`. Resolve both **in the exporter** and ship a single `realm` key per province
in the bundle. The frontend must never re-derive it — that is how `CONTINENT_NAME` ended up with three
copies.

**Four rules, not two.** The full resolution, in order — Phase 1 implements exactly this list:

| provinces | realm from |
|---|---|
| land with a continent | `Continent` (both Americas → Aelantir, `OCEANIA` → Hinuilands, rest → Halcann) |
| water | the realm of the land it is adjacent to (zero conflicts, §The ocean splits cleanly) |
| the 3 quirks, the 99 deep-ocean | **none** → fog everywhere |

> **Three rules, not four — the portal-waypoint rule was a guess, and the data refuted it.** An earlier
> draft of this doc claimed Phase 0's four waypoints are placeholder-named hubs with no continent, so
> land-by-`Continent` would resolve them to *no realm* and silently fog them. **Wrong.** Phase 0 shipped
> and all four come back `continent: europe`, `region: west/east_deepwoods_region` — Anbennar assigned
> them properly; only their *names* are filler. Rule 1 already lands them in Halcann.
>
> Keep it as an **assertion**, not a rule: Phase 1 should fail if a portal waypoint resolves to a realm
> its adjacency endpoints disagree with. That is cheap, and it is the claim the guess was reaching for.
>
> (They are `FEY_GLADEWAY`, incidentally — `CavernExporter`'s count went 10 → 14 the day they landed.)

**"No realm" means no realm, in the sim too.** The three quirks and the continent-less land province keep
their ids, neighbors, plots and settleability — they just render nowhere. That is a live divergence:
`TimelineSites` could spread a colony onto North Toreiel and no realm can show it, and a caravan can march
into a province that draws as void. **Phase 1 excludes realm-less land from the settleable/site set** so
the two agree.

> **Drift warning.** `CONTINENT_NAME` is hardcoded a second time in `WorldBundle.java:72-81` and a third
> in `web/build.mjs`. A realm mapping must not become a fourth copy. Ship the realm key **in the bundle
> per province** and let the frontend read it, rather than re-deriving continent→realm in JS.

### Realm is an engine field, not a bundle key

`Province.realm`, typed `geo.Realm` (decided) — resolved at export, written to `provinces.json`, read back
by `WorldMap`, and *serialised* into the bundle. Same shape as `ownerTag`, `culture`, `tradeGood`: canonical
in the engine, mirrored to the client.

The tempting alternative — realm as a bundle-only key, since only the viewer crops — **breaks the moment
realm has a sim consequence, which it already does.** Excluding realm-less land from the settleable set is
Java. Scoping Ranked to one realm (§Ranked is per realm) is Java. Both would have to re-derive
continent→realm server-side, which is precisely the fourth copy §Drift warning exists to prevent — and it
would be the *worst* copy, because the exporter's four rules include two (adjacent-land for water, endpoints
for portal waypoints) that are graph walks, not table lookups. Resolve once, at export, where the adjacency
data is already open.

`Realm.NONE` (or a null) is a real member, not an oversight: it is the 95 provinces of the last table row,
and the thing the settleable filter tests.

### Ranked is per realm

**A Timeline is scoped to exactly one realm** (decided). Its sites spread within that realm, its colonies
race within that realm, and the last one standing wins *that realm's* Timeline. Halcann has its Ranked;
Aelantir has its own. Hinuilands is not playable, so it has none.

This is decided **now, at Phase 1**, because Phase 1 is what gates the settleable set — and the alternative
is not a deferral, it is a bug that ships. Ranked today is one shared world (seed 7654321), lockstep, last
colony standing, with `TimelineSites` spreading colonies across the map. Nothing in that stops it seeding
Aelantir *and* Halcann, and the moment realms crop:

- the royale spans a boundary the UI says you **cannot see across** — a spectator watches half a match;
- the scoreboard ranks colonies that share a world but not a map, which is exactly the "session spans
  realms" problem (§Deferred) arriving through the back door, unasked;
- **it is one line now** (`TimelineSites` filters to the Timeline's realm) and a data migration later, once
  Timelines with cross-realm rosters exist in the DB.

So `Timeline` carries a realm, and it is not `Realm.NONE`. This also makes realms a **content axis** rather
than only a view: a second realm is a second Ranked ladder on the same server, running the same engine, with
its own geography — which is the cheapest new content the map has ever offered.

**Scoping the *start* is only half of it** — Phase 0 proved a caravan can walk between realms through the
fey portals, so a Halcann colony could otherwise migrate into Aelantir's ladder mid-match. The other half
is §Crossing a realm on foot is gated: the cross-realm portals are default-closed, so no colony walks
between ladders. Start-scoping plus the gate is what makes Ranked-per-realm hold.

### A session carries its realm, and joining switches

**Realm is a field on `SessionSpec`, and opening a session switches the viewer to it** (decided). One realm
per session; §Whether a session can span realms stays deferred and this does not touch it — the question
here is only *which*, not *how many*.

**Carried, not derived.** A colony sits in a province, so a session's realm *looks* derivable — but the
derivation has no answer exactly when it is needed. A Timeline scenario is **born empty** and its realm has
to exist before the first seat joins and founds anything; a finished run (`GAME_OVER`) has no living colony
to read a province from, and it is still viewable. The spec is authoritative in both cases. It is also the
savegame (`SessionSpec` + command log), so realm becomes part of what a save *is*, which is right: replaying
a Halcann run into Aelantir is not a restore.

Without the switch, the failure is quiet in the way this doc keeps warning about: open the Caravan view on
Halcann while the session's colony lives in Aelantir and you get a live session streaming over the wrong
map — `colonyInView` (`bandcaption.mjs:90`) correctly reports nothing, forever, and the band caption falls
back rather than erroring. Nothing is broken; nothing is there.

Two things fall out for free:

- **The lobby is in the realm dropdown** (§UI), so the dropdown holds the realms *and*, one entry up, the
  sessions — each of which names the realm it will take you to. The affordance and the destination sit in
  the same menu.
- **An old spec with no realm defaults to Halcann**, the same rule as a legacy `?p=` link (§Deep links need
  a realm). So every session in the registry restores with no migration, which matters because restore is
  lazy and replays from spec + roster + command log.

### Crossing a realm on foot is gated, not free

Phase 0 established that a caravan *can* walk Cannor → Portal 1 → Domancadh into Aelantir — the fey portals
are real edges `LandRouter` already traverses (§Anbennar already built the crossing). **A cross-realm
portal is gated, not freely walkable** (decided): the edge exists, the arrow marks it, but an ordinary
caravan cannot take it. It opens only under a condition.

**The gate is the Seasonal Court, not a new system.** The `domandrod_*_gate` rows are *already* seasonal
(§the Domandrod Seasonal Court) — a date predicate on an adjacency, built on the solar calendar and
hemisphere-aware winter that already exist. Cross-realm traversal is the same predicate one level up: a
`teleport` edge whose endpoints are in different realms is passable only when its gate condition holds
(a season, later perhaps a fey pact or a tech). So "gate the crossing" and "build the Seasonal Court" are
**one mechanism**, not two — which is why this is the cheap answer as well as the lore-true one.

This makes **§Ranked is per realm airtight against migration**: a colony seeded in Halcann cannot drift
into Aelantir's ladder mid-match, because the only edge out is gated and a colony does not hold a fey pact.
Scoping `TimelineSites` to one realm (Phase 1) bounds where colonies *start*; the gate bounds where they
can *go*. Both are needed, and now both hold.

> **This is the realm check §The partition is free swore `LandRouter` would never need** — and it is a
> narrow one: not "reject any route that leaves the realm" (that would forbid the crossing entirely), but
> "a cross-realm `teleport` edge carries a gate predicate, default-closed." Ungated `teleport` edges — the
> 86 intra-Halcann Deepwoods rows — are unaffected and stay freely walkable. The check fires only on the
> six edges whose endpoints' realms differ.

### What a realm is not

**A realm is a partition axis, not a plane axis.** It answers *which part of Halann am I looking at* — and
it can only ever hold ground Anbennar already painted on the cylinder. Ask the test question, *can I add a
realm?*, and the honest answer is: **only if it is already on the raster.**

That is a deliberate bet, not a limitation to route around. All three realms are genuinely *places on the
planet Halann*, so one coordinate space is not a shortcut — it is true. `gcKm` between Venail and Lastsight
is a real distance; Vyr Pas gets real daylight at lat 25.96. Giving each realm a local origin would invent
a lie to model a truth we already have, which is why §Keep the pixels absolute forbids it.

**The plane axis already exists, and it is z.** The Serpentspine is a distinct surface at the same lat/lon,
with its own clock (`FixedDaylightClock`), its own terrain (`TERRAIN_CAVERN`) and its own art. That is far
closer to "a second map" than Aelantir is. So:

| | **realm** | **z** |
|---|---|---|
| means | a partition of Halann's surface | a distinct plane at the same coordinates |
| must | already exist on the 5632×2048 raster | — |
| shares | one id space, one projection, one lat/lon | the coordinates, nothing else |
| gets | a crop, a bake, fog | its own clock, terrain, yields, art |
| where a **Feyrealm** would go | ✗ | ✓ |

They compose (§Realm is not z), which is the proof they are different questions: `(Halcann, z=-1)` is a
partition *and* a plane.

So the rejected Feyrealm (§Rejected) was rejected on the right grounds and filed under the wrong axis. Its
own sentence names the axis it belongs on: *"Hinuilands is a location on the planet Halann; a Feyrealm
would be a parallel plane of the whole world."* A parallel plane is not a realm. It is `z:+1`, and nothing
in this doc blocks it.

**If you want a new map, ask which axis first.** A dropdown is where maps *appear*, so the instinct will be
to add a realm. That instinct is right only for ground already on the cylinder.

### Realm is not z

The underworld is `z:[-1]` *within Halcann* — you walk into it from Cannor; no ocean, no portal. So:

- **realm** — which map you are looking at. Dropdown. Crops the view.
- **z** — which level of that map. Button. Filters `LAYERS` via `activeZ()` (`core.mjs:102`).

They compose: `(Halcann, z=0)`, `(Halcann, z=-1)`, `(Aelantir, z=0)`. Aelantir has no underworld (zero
Dwarovar provinces outside `europe`/`asia`/`serpentspine`), so its plane button hides.

**Decided: two separate controls**, not one flat list with "Halcann (Underworld)" in it. `layers.mjs`
already filters on a z-**set** and generalises cleanly; folding realm into it would overload one axis
with two meanings and tangle `activeZ()`.

### Ocean and fog

Fog is **decorative**: it marks *this is not here*, not *you have not explored this*. The rule is
symmetric — you cannot see Aelantir from Halcann, and **on the Aelantir and Hinuilands maps there is no
middle landmass**. Each realm keeps the water touching its own coast (§The ocean splits cleanly); every
other realm's land, every other realm's water, and the **99 deep-ocean provinces that touch no land at
all** are fog.

The baked art is already in the tree and has never had a consumer: `FOW_TILE` (`web/civ6.mjs:217-246` —
`HATCH_MED`, `HATCH_MED_LIGHT`, `HATCH_LIGHT`, `PARCHMENT`), baked by `bakeFowTiles()`
(`build.mjs:1226-1244`) as tileable greyscale luminance masks, shipped as `fow`
(`WorldBundle.java:246-251`). This is its first use.

> `build.mjs:1230` notes the art was baked ahead of the per-settlement `RevealedMap` (explorer-caravan
> Phase 6, unbuilt). **Realm fog is a different consumer of the same art**, and the two are orthogonal:
> realm fog says "not here", explored fog says "not seen". If Phase 6 lands they stack.

Hinuilands is ~all fog with two revealed provinces, so fog does 99% of its visual work. It uses **hatch,
not parchment** (decided) — the realm reads as dim and unexplored rather than as blank paper, which is
the honest impression: Anbennar reserved 245 provinces there and drew two.

### The fog must not be mute

Decorative fog has a failure mode: it says *nothing is here*, when the truth is *something is here, on
another map*. A player who never opens the dropdown never learns Aelantir exists.

**The cue belongs on the realm's outline** — the province edges where the realm meets the fog — not on an
interior marker. That outline *is* the place you leave from, so it should read as one: a border you cross,
not a border that stops you. **The whole outline is rimmed** (decided), so no stretch of the boundary is
mute; where a teleporter sits on that edge, **a red arrow expands outward over the fog**, pointing the way
to a place this map cannot show.

The arrow is **not animated** and **carries a text label** — `to Aelantir`, `to Halcann` (decided). A bare
arrow says *something is out there*; a labelled one says *what*, which is the entire point. And it is
**clickable** (decided): clicking it switches realm. So the arrow is the discovery path and the dropdown is
the power-user route, rather than the dropdown being the only way to learn the other realms exist.

**The arrow and the dropdown fire the same action with different destinations** (decided). One switch-realm
action, one `destination` argument:

- **dropdown → fit the realm.** It means *show me that map*. You land at band WORLD, looking at the whole
  thing.
- **arrow → the far portal, at your current zoom.** It means *cross here*. Click the arrow on Portal 1 and
  you land on **Domancadh** in Aelantir, looking back at the fog you just came from — the same place, the
  same scale, the other side of the same fey portal a caravan would walk through.

Collapsing both onto "fit the realm" would make the arrow a decorated dropdown and throw away the one thing
it is for: that a crossing has two ends and you arrive at the far one. The arrow is a *place*; the dropdown
is a *view*.

> **Switching realm otherwise holds nothing.** A realm switch from band 7 on a plot in Cannor cannot hold
> its camera — the target realm has no such coordinate on its crop. Dropdown switches refit; the arrow is
> the exception because it names a province to land on, which `focusProvince` already does.

**A cross-realm adjacency must not draw as a line** — this is the arrow's other half, and it does not
happen for free. Phase 1 ships **one bundle with all 5268 provinces**, so `WorldBundle` ships the six
**Domancadh fey-portal rows** (§Anbennar already built the crossing) with both endpoints present — and
they are already flagged `teleport` from the source comment, so nothing draws them as a line *within* a
realm today. But across realms, left alone, Halcann's map would still mark Portal 1 with a teleporter glyph
pointing at Domancadh, a province the crop cannot show. **A row whose two endpoints have different realms
is suppressed as an ordinary marker and promoted to the arrow**, on both maps — the arrow *is* the
cross-realm teleporter's marker. Same `teleport` + `realm` data as everywhere else in this doc; no new
geometry.

Red because the fog tiles are greyscale luminance masks (`FOW_TILE`) with no colour of their own, so a
warm hue owns the layer without fighting it. There is no arrow art in the tree — the existing teleport
marker is a hand-drawn cave-mouth glyph at `TELEPORT_SCALE = 4` (`main.mjs:305-307`), and the arrow joins
it as canvas paths.

**The pattern already exists one level down.** `drawCavernRims` (`layers.mjs:68`, `z:[-1]`) rims the
underworld plane's boundary in amber for exactly this reason — to say *the plane ends here, and here is
where it opens*. A realm rim is that move one level up, and should be built as its own layer entry beside
it rather than folded into the fog draw.

This is what makes realms **discoverable rather than merely available**: the fog stops being an absence
and becomes a signpost. The arrow is only correct for an **off-realm** destination — and the test is the
`realm` of the two endpoints, not the row's kind. Of the 92 teleporter rows, **86 stay within Halcann**
(the Deepwoods mesh, both endpoints on the same map) and draw the ordinary cave-mouth glyph; **6 cross to
Aelantir** (the Domancadh portals) and draw the arrow. A row is an arrow iff its endpoints' realms differ.

## Rendering: the cylinder goes away

Each realm crops to its own provinces' pixel extent. There is no 360°, so there is no wrap.

### The trap

`worldW()` (`core.mjs:210`) is documented as *"one full 360° of longitude — the horizontal wrap period
of the cylindrical map."* It actually returns `cam.k * VIEW.dw`, and `VIEW.dw` comes from the **baked
crop rect** (`cw = MAP.x1 - MAP.x0`, `core.mjs:26-32`). It is 360° today only by coincidence — the
shipped bundle crops to the whole raster:

```json
"map": { "x0": 0, "y0": 0, "x1": 5631, "y1": 2047, "W": 5632, "H": 2048, "dw": 2816, "dh": 1024 }
```

The moment a realm crops smaller, `worldW()` silently becomes the realm's width and every wrap consumer
keeps working — **wrongly**. It tiles the realm side-by-side across the viewport forever, with no seam
and no error. This fails silently, not loudly, and is the most dangerous property of the change.

**So the wrap does not get a flag — it gets deleted** (decided). `worldW()` and `wrapCopies()` go; every
copy loop collapses to its single-copy branch; `clampPan` clamps. No `MAP.wrap`, no `period <= 0`
sentinel, no dead cylinder path kept alive behind a boolean.

The reason is §The trap itself. A flag leaves the tiling code in the tree, reachable, one truthy value
away from the exact silent failure this section exists to prevent — and the flag would be permanently
`false` the day Phase 3 lands, since **no realm wraps and no realm ever will** (a realm is a crop, and a
crop of a cylinder is a sheet). Keeping a switch for a state that can never be true again is how the bug
survives to be rediscovered. Delete the wrap and the trap cannot spring: there is nothing left to tile
with.

**Six call sites, and five already have the single-copy branch written** — the `period <= 0` guards
(`main.mjs:159`, `hittest.mjs:17-18`, `bandcaption.mjs:96`) are the code that survives; deletion is mostly
choosing the branch that already exists and dropping the other. `clampPan` is the one site with real new
logic (modulo → clamp).

This costs one real capability, and it is worth naming: **you can no longer pan east past the antimeridian
and come round the other side.** On the whole-world map that is a visible change, not a neutral one (§Phase
2) — the world becomes a finite sheet you hit the edge of. That is the correct behaviour for every realm,
which is what the map will be made of.

### Three quirk provinces, and then no realm needs a roll

Two realms have an outlier that wrecks a naive bounding box, and they are **dropped from their realm**
(decided). They are three provinces, but not one story — the regeneration (§post-`fb79aaa`) split them:

```
Aelantir    6238  North Toreiel  lat  62.0  lon 173.16  LAND        sarmadfar_region   owner=undefined
Aelantir    6237  South Toreiel  lat  57.1  lon 169.00  LAND        sarmadfar_region   owner=undefined
Hinuilands  1808  Ekyunimoy      lat -65.87 lon 124.12  IMPASSABLE  region=null        zero neighbors
```

**The Toreiels are a projection artifact, and in EU4 they are not a quirk at all** —
`sarmadfar_region`'s other provinces sit at lon −150, and on a wrapping cylinder the region is perfectly
contiguous across the date line. It only becomes a quirk when you crop. That is the single-map
limitation showing up one last time, in the geometry. Without them, Aelantir's bbox falls from **5375px
(95.4%)** to 2369px.

**Ekyunimoy is a different animal, and it moved realms under us.** An earlier draft called it an Aelantir
outlier; the regenerated data says `continent: oceania`, so it is *Hinuilands'* outlier. It is a 27,782-plot
**Antarctic** province at lat −65.87 — `IMPASSABLE`, no region, no owner, no neighbours: the polar ice
shelf, which Anbennar parks in `oceania` because the engine demands every province sit on some continent.
Keeping it drags Hinuilands' crop from 162px to **560px** and anchors it to the south pole, to show ice
nobody can enter. Dropping it is what makes Hinuilands two provinces (§Hinuilands is not painted) rather
than two provinces and a glacier.

With all three gone, **every realm is contiguous and nothing rolls**:

| realm | crop width | contiguous? |
|---|---|---|
| Halcann | 2437px (43.3%) | yes |
| Aelantir | **2369px (42.1%)** (was 5375px) | yes, once the Toreiels are dropped |
| Hinuilands | **162px (2.9%)** (was 560px) | yes, once Ekyunimoy is dropped |

So Phase 3 is a **pure crop** — no roll, no per-realm x offset, no seam-straddling polygons. Keep it
that way: if a future province re-introduces a seam crossing, drop it or fix its continent rather than
resurrecting the roll.

> Hinuilands' two provinces are ~6000km apart (Vyr Pas at lat 25.96, Vyr Cirentyn at lat −28.3), so its
> 162px-wide crop is 321px tall and almost entirely empty. That is the honest picture of the realm.

### Keep the pixels absolute

The projection is **Mercator in y, linear in x** (`core.mjs:22-23`), and lat/lon are computed *from*
pixels at export (`ProvinceExporter.java:314-320`), not the reverse. Polygons are absolute source pixels
on the 5632×2048 raster (`ProvinceBorderExporter.java:45`) — `rings`, `bbox`, `lab` share that space.

The chain is already parameterised on the crop:

```
lon/lat --sxSrc/sySrc--> source px (5632x2048) --baseXr/baseYr--> base screen --pxr/pyr--> screen
                                                ^ normalises by (sp - MAP.x0) / (MAP.x1 - MAP.x0)
```

**So: hold `MAP.W`/`MAP.H` global at 5632×2048; crop only the window `x0..x1`/`y0..y1`.** The whole
polygon/label/plot stack then follows for free, and every engine consumer is untouched — `gcKm`
haversine (`WorldMap.java:939-964`), `SolarClock` (real-lat daylight), `WorldMap.path()` (province-id
topology) all read baked lat/lon and touch no pixels.

> **Re-basing pixels to a realm-local origin would corrupt solar times and caravan march distances with
> no exception thrown — just wrong numbers.** Don't. `build.mjs:472-480` already computes a clamped,
> margined crop rect; the bundle is ready to crop. Nothing downstream is ready to notice.

### The background is baked, so it is baked per realm

**`MAP` is not a viewport rect — it is a baked image's extent.** `build.mjs:465-485` opens `terrain.bmp`,
computes a margined crop rect **from the provinces it is handed** (`for (const p of provs)`), tints, and
emits one WebP; `main.mjs:207` blits it whole (`drawImage(mapImg, 0, 0, MAP.dw, MAP.dh, …)`). So the world
background is a *resource*, like the terrain tiles and the river ribbon — and three realms means **three
bakes** (decided), a `map` manifest entry per realm.

The pipeline is already shaped for it: the crop rect is derived from a province set, so **handing it
Halcann's provinces bakes Halcann.** This is the art-side twin of "the bundle is ready to crop" — so is
`build.mjs`.

Three reasons this is the right call and not just the necessary one:

**Resolution.** The shipped image is 2816×1024 — half the 5632×2048 source. Re-using it and drawing a
sub-rect would give a realm *half-res* background over the pixels it actually shows. A per-realm bake spends
the same output budget on 45% of the world instead of 100%: roughly **twice the detail, for free**, because
the raster stops paying for a hemisphere nobody is looking at.

**The overlap is real, so fog cannot live outside the crop alone.** Halcann is 45.0% of the world and
Aelantir 42.1% — of a 100% world. They **overlap**, in the Atlantic, where each realm's water reaches
toward the other (§The ocean splits cleanly assigns that water, but the crop rects are rectangles and do not
respect the assignment). So Halcann's crop *contains* Aelantir pixels, and fog has to be drawn **inside** the
crop over real baked terrain — not merely beyond its edge.

**Baking the mask makes that fog exact and free.** The bake is the one place with a province-per-pixel view
(`provinces.bmp`, the same raster `ProvinceExporter` reads) — so it can resolve realm per pixel and mask
non-realm ground as it tints. That is pixel-accurate to the province paint, needs no union path, and costs
nothing per frame. The alternative — a runtime clip over ~1650 foreign polygons — is approximate at the
edges and pays every draw.

> **This does not collide with §Ocean and fog's stacking claim; it sharpens it.** Realm fog is *static per
> realm* — a property of the map, like the terrain under it — so it bakes. Explored fog (`RevealedMap`,
> explorer-caravan Phase 6) is *per session, per day* — so it stays a runtime layer and draws on top. The
> two were always different consumers of `FOW_TILE`; now they are different consumers at different times.
> Realm fog is baked art, explored fog is a draw call.

**The minimap is per realm too.** It is documented as "the bottom-left world thumbnail" (`main.mjs:170`) —
and a *world* thumbnail on Halcann's map shows Aelantir, which breaks the symmetric rule (§Ocean and fog)
in the one corner of the screen the crop does not reach. It becomes the **realm's** thumbnail: a third
consumer of the per-realm bake, and the reason to treat "bake the background" as a set of realm resources
rather than one image.

> **The cost: "switching is instant" gains an asterisk.** Phase 1 ships **one bundle** (decided, §Phases) —
> but three background images. The bundle switch is instant; the *art* switch is a WebP fetch. **Preload the
> other realms' backgrounds on idle** (or on dropdown-open), so the common case is warm. Say so rather than
> claiming an instancy the network does not provide.

### The work

**Safe, no change:** all engine lat/lon consumers; `ProvincePlotStore`/`PlotService` (province-keyed,
seed-independent); `plotIndex`; `provGeo`/`GEO_NAMES`; `rings`/`bbox`/`lab`.

**Wrap-dependent, all deleted (Phase 2):**

| site | today | after |
|---|---|---|
| `core.mjs:209-210` | `worldW()` — the wrap period, exported | **gone**, with its export |
| `core.mjs:212-215` `clampPan` | `cam.x = ((cam.x % w) + w) % w` | clamp to the crop — else panning east teleports you west. **The only site with new logic.** |
| `main.mjs:154-170` | renders once per world copy | keep the `:159` single-copy body, drop the loop |
| `hittest.mjs:12-20,35-37,59` | `wrapCopies()` shifts the cursor per copy | **`wrapCopies()` gone**; hit-test the one copy |
| `minimap.mjs:70-76,102-104` | `fx0 % 1`, two-piece seam rect | single-piece rect; no seam exists |
| `political.mjs:86-87` | `for (k = -1; k <= 1)` tests ±1 copy | just `k = 0`, inlined |
| `bandcaption.mjs:95` | `colonyInView()` tests the colony against ±1 copy | keep its `!(w > 0)` branch (`:96`) — it *is* the answer |

Labels, sea, borders, routes and adjacency lines have **no wrap code of their own** — they inherit it by
drawing inside the loop, and need nothing beyond the loop collapsing.

**Extent-dependent:** `sea.mjs` doesn't know where ocean is. It fills the *whole viewport* with a
latitude gradient (`:57-63`) and relies on the raster's ocean pixels being transparent. Cropped, it will
paint blue across the void. It needs an X clip (`main.mjs:140-147` already does the `#070a10` void fill +
Y clip — extend to X), or its existing off-ramp (`sea.mjs:32`, no `SEA_BANDS` → flat fill).

**Recompute per realm:** `rollupTier` geo label centroids (`WorldBundle.java:209,340`) are computed
globally; a continent/superregion centroid can land outside a realm's crop, putting labels in the void.

**Rebake per realm:** the world background image and the minimap thumbnail (§The background is baked) —
both are baked resources whose extent *is* `MAP`, not runtime crops of a shared raster.

## UI

The masthead becomes the realm selector. Today `advisors.mjs:23` builds the globe entry as
`"Halann v" + BUNDLE.mapVersion` — a **planet**-level label, correct while there is one map. Realms make
that entry **realm**-level, and the two words stop being interchangeable: you look at Halcann, on Halann.
It becomes a dropdown:

```
Lobby
────────────
Halcann v9       <- current
Aelantir v9
Hinuilands v9
```

**The lobby lives in the dropdown.** This matters because the brand (`index.html:180`) is *currently*
the way home — `role="button"`, `data-tip="Back to the lobby · reset to the world view"` — and the brand
is losing its "Anbennar" half (`CivStudio: Anbennar` → `CivStudio`). Moving the lobby into the dropdown
lets the brand shrink without orphaning the affordance.

The plane (surface/underworld) button stays separate, and hides outside Halcann.

### Deep links need a realm

`main.mjs:432-440` keys on `?p=<id>&z=<zoom>` — province id and zoom, no realm. A link to province 4211
is meaningless if the active realm's crop doesn't contain it: today it would silently frame empty void
rather than erroring. **Add the realm to the link**, and resolve province → realm on load so old links
still work (a legacy `?p=` auto-switches the realm under itself).

**Switching realms pushes history** (decided) — so back/forward navigates realms, and a realm is a
shareable URL. Each switch is a history entry; that is intended.

**An omitted realm defaults to Halcann** (decided). So every legacy `?p=` link keeps working with no
migration, and a bare URL opens where it always did.

**Realm selection replaced server selection as the first-run question** (built). The site used to open
on "Choose a server" — dev or local — which is not a question a visitor can answer: it is a deployment
detail, and someone arriving at the bare site has no basis to pick. The server now settles itself
(`?server=` → `?live=` → remembered → default), and the loading screen asks **which realm** instead,
listing each with a one-line blurb and its province count (Halcann 3,609 · Aelantir 1,555 ·
Hinuilands 2), largest first.

It runs *after* the bundle rather than in the server picker's slot, because the realm list and those
counts come from the bundle — so the order is forced: connect, fetch, then ask. The pick is written
with `replaceState` and the pending `app.js` import then continues, so there is **no second page
load**; `core.mjs` reads `?realm=` at import time and has not run yet.

The server picker is demoted, not deleted: it still opens on a failed auto-connect, on a lost live
connection, and from the title bar as a deliberate switch — the cases where the question is real.

**The masthead globe segment opens the same selector** (built), rather than the small `realm-menu`
dropdown it used to. One chooser either way; a realm is a world, and a three-item text menu under the
top bar undersold it. Over a running map the current realm is marked "here ·" and a pick navigates
through the same URL shape `switchRealm` uses (`cs.realmSwitch` included, so the fresh load crops to
the new realm and does not reopen the lobby over it). `window.__realms` is the seam, mirroring
`window.__picker`; the old dropdown survives as the fallback when the bootstrap predates the
selector. Lobby moves back to the brand, which has always opened it.

Verified on the local stack: a bare URL shows the picker and no server picker; picking Aelantir lands
on 1,555 provinces with `?realm=aelantir` in the URL and no reload; `?realm=` and `?p=` both skip it;
the globe segment opens it over the map and Esc closes it.

### Realm-less provinces are invisible — `?debug=holes`

`core.mjs` builds `P` as `provinces.filter(p => p.realm === ACTIVE_REALM)`, so a province with no realm
is dropped from **every** realm view: no polygon, no plots, nothing. The failure mode is silence —
what you see is open water or blurred raster, which is indistinguishable from "there is nothing here".

Measured on prod: **102 of 5,268 provinces have no realm**. 91 are deep-ocean `SEA`, which is
deliberate (`Realm.NONE`) and carries ~2.7M plots nobody wants drawn. The other **11 are bugs**:

| id | type | plots | lat | name |
|---|---|---|---|---|
| 1808 | IMPASSABLE | 27,782 | −65.9 | Ekyunimoy |
| 6237 | LAND | 212 | −3.5 | South Toreiel |
| 6238 | LAND | 216 | 17.6 | North Toreiel |
| 1884, 6068, 6087, 6511, 6512, 6559, 6592, 6762 | LAKE | 13–739 | — | incl. *Humacs Island* |

A **second, independent** defect overlaps them: 7 of those 8 lakes (all but 1884) declare plots and the
server serves **0**, while realm-bearing lakes serve fine. It tracks the high id range, not the missing
realm. 6762 "Humacs Island" beside the Gulf of Ouord (1298) has *both*, which is why it vanished
completely — and it was found by eye, not by any check.

So `js/debug-holes.mjs` makes them loud: **`?debug=holes`** paints every silently-unrendered province
in the magenta/black missing-texture checkerboard, labelled with its id and reason, and logs the list
once. It reads `BUNDLE.provinces` rather than `P`, so it can see what the realm filter already
dropped **without changing what `P` contains** — nothing else in the app behaves differently when it
is on. The checkerboard is generated, not vendored: a two-colour checker is six lines of canvas, and
fetching a game's asset for a debug marker would be both a licensing question and a new dependency
that breaks the fully-offline `tools/dev-local.ps1` loop. It is screen-anchored at 8px so it reads the
same at world zoom and plot zoom.

Deep-ocean `SEA` is excluded from the flag deliberately — realm-less is correct there.

**Not fixed yet.** The proper fix is `RealmExporter` resolving a lake or island enclosed by Halcann to
Halcann, plus whatever makes those high-id lakes serve no plots. A cheaper client-side mitigation —
include a realm-less province when its bbox intersects the active realm's crop — would close the
visible holes without a re-export, but must not drag in the 91 deep-ocean seas.

**A deep link skips the lobby** (built). `?p=` or `?realm=` names where you want to be, and the
Spectator Lobby exists to ask exactly that — so auto-opening it over a deep link strands you on a
modal covering the map you asked for. `index.html openLobbyDuringLoad` returns early when either
param is present, the same early return a realm switch already used. `?lobby=1` forces it back (for
picking a session from a deep link); `?lobby=0` still suppresses it unconditionally, for the
cross-origin embedded case.

The loading splash is NOT skipped and cannot be: it covers the bundle download, and there is nothing
to draw until that lands. It already clears on first paint (`main.mjs hideLoading`), so with the
lobby gone a deep link goes splash → map with nothing in between. Verified on the local stack:
`realm=aelantir&p=1186&z=60` lands on Idsetdain with `splashGone` true and no lobby; a bare URL still
gets the lobby; `p=4&lobby=1` still gets it. (Note `p=<id>` for a province in a NON-default realm
auto-switches the realm, which reloads once with `cs.realmSwitch` set — that path suppressed the
lobby before this change and still does, so `lobby=1` cannot force it there.)

## Cost

**No plot rebake for Realms itself.** `MAP_VERSION` (`ProvincePlotStore.java:62`, currently 9) keys the
plot cache, and plot grids are per-province and seed-independent — *"a province's geography is a property
of the map, not of a run"*. Phases 1–6 change `provinces.json`/`superregions.json` and the bundle; they
do not change a single plot grid. So: no `MAP_VERSION` bump, no cache drop. The dropdown keeps saying
**v9**; only the word before it changes.

> **Phase 0 adds four provinces.** Whitelisting the portal endpoints means four *new* plot grids. The
> cache is keyed `<id>.json.gz`, so existing grids are untouched and the four generate lazily. They are
> **not** GeoNames candidates — prod cannot bake names anyway ([[plot-place-naming]]), and a real Earth
> place name would be wrong here: this is **space inside the portal**. They are named **Portal 1–4**
> (decided), authored at export, not drawn from GeoNames. So Phase 0 needs no CI bake either.

**But there is a web art rebake, at Phase 3.** The background and minimap are baked resources, so realms
means running `node web/build.mjs` and shipping **three** background WebPs instead of one (§The background
is baked). That is a `web/` asset + manifest change, not a plot-cache change — the two are unrelated caches
and only the plot cache is keyed by `MAP_VERSION`. Bundle size grows by roughly the two extra realms'
images; each is smaller than today's whole-world bake, and Hinuilands is 162px wide.

The server still needs a redeploy — the bundle is assembled from engine resources
(`WorldBundle.ensureCached()`), and `web/` auto-deploys on push while the server is manual. **Deploy the
server first** or the frontend ships against a bundle with no realm field. Phase 3 makes this sharper:
`web/` auto-deploying a per-realm manifest against a server whose bundle has no `realms` block is a broken
map, not a degraded one.

## Phases

Ordering principle: **data before pixels, and the silent failure before the thing that triggers it.**
Phase 2 exists solely so the wrap can be killed and verified *while the map is still whole* — if the
crop lands first, every wrap bug appears at once, silently, with no baseline to diff against.

**Phase 0 — Restore the portal network, and mark it.** Ships alone, no Realms code, independent value.
Two halves:
 - **Whitelist** provinces referenced by a portal adjacency row, defeating the placeholder-name filter for
   those only (`ProvinceExporter.java:134-138`), and name them **Portal 1–4**. → 5268 provinces, **92/92
   portal rows survive** (from 51). Verify by count, not by eye.
 - **Ship the `teleport` flag from the row's `comment`** and retire `TELEPORT_KM` (§Teleporters are real) —
   the field is already in `adjacencies.json` and `WorldBundle` throws it away for a distance guess that
   has never once been right about a portal. Everything downstream (arrow, line suppression, a future
   seasonal gate) needs *is it a portal*, not *are these far apart*. → 92 marked, the 4 false positives
   unmarked.

> **Phase 0 is NOT behaviour-neutral, despite changing nothing visible.** The 41 restored rows become 41
> new edges in `WorldMap.combinedNeighbors`, which is what `LandRouter` walks. Caravans that route near
> the Deepwoods can start taking portal shortcuts the day this lands — emergent, unasked-for, and
> arguably correct, but it is a **sim change, not a data change**. Run the full engine suite, not just the
> server one, and expect the possibility of route-length fallout.

**~~Phase 0b — Author the realm portal.~~ CUT — Anbennar already authored it.** This phase proposed
inventing a Halcann↔Aelantir sea teleporter so the arrow would have something to mark. Phase 0 proved it
unnecessary: the six **Domancadh fey portals** (§Anbennar already built the crossing) are a real,
imported, land-to-land cross-realm link that `LandRouter` already walks. The arrow marks
**Portal 1 ↔ Domancadh**; no overlay, no authored data, nothing to hand-edit. The one thing this phase got
right — *don't* hand-edit `adjacencies.json` — is moot, because there is nothing to add.

> The sea-crossing analysis (§Deferred) is kept as a *record*, not a plan: it is the route Anbennar would
> have drawn if it wanted a boat lane, and it may still be wanted someday for flavour. But the realms are
> already connected, so it is no longer on the critical path for discoverability or for travel.

**Phase 1 — Realm as data. SHIPPED.** Resolve realm in the exporter by the four rules of §The model —
`Continent` for land, adjacent land for water, **adjacency endpoints for the four portal waypoints**, and
none for the 3 quirks + 99 deep-ocean. Land it as **`Province.realm`, an engine
field** (§Realm is an engine field), serialised into the bundle. Exclude realm-less land from the
settleable/site set, and **scope `TimelineSites` to one realm** (§Ranked is per realm).
**One bundle for all realms** (decided) — the client filters and crops, so switching is instant and
`WorldBundle`'s two `static volatile` cache fields stay as they are. Nothing renders differently. Guarded
by the bundle golden test.

> **As built.** `geo.Realm` (a fixed enum modelled on `Continent`, members `HALCANN`/`AELANTIR`/
> `HINUILANDS`/`NONE`) + `Province.realm`, resolved and stamped onto `provinces.json` by a new
> `geo.export.RealmExporter` (a pure derivation from the already-exported map — no external source —
> that re-reads and re-writes the committed file, at the end of the stamp chain). The counts match
> §The model exactly: Halcann 3422+187, Aelantir 1377+178, Hinuilands 2, `NONE` 3+99, **0 water
> conflicts**, all four waypoints Halcann — the exporter asserts the last two. `WorldMap` gains a
> `provincesByRealm` index + `provincesOfRealm`, and `settleableProvinces()` now excludes `Realm.NONE`.
> The bundle ships a per-province `realm` key + a `geoNames.realm` name dictionary read **straight from
> the `Realm` enum** (not a re-listed copy — §Drift warning). New `RealmTest` (5) + golden regen; full
> reactor green (374 engine + 109 server).
>
> **One deliberate deviation: the `realms` block (crop rect per realm) is deferred to Phase 3, not
> shipped here.** The authoritative crop rect is a *bake* product — `build.mjs` derives it from a margined,
> clamped, per-pixel pass over `provinces.bmp` (§The background is baked) — and the committed
> `web-asset-manifest.json` ships `bboxes: {}` (only the CI bake fills it), so there is nothing for
> `WorldBundle` to union locally. Computing a crop rect independently in Java would be exactly the
> drifting second copy §Drift warning forbids. Phase 1 has **no consumer** of the crop rect (nothing
> renders differently), so it waits for Phase 3, where the bake computes it once. Phase 1 ships realm
> *membership* + the *name catalog* — the drift-free data shape — instead.

**Phase 2 — Delete the wrap. SHIPPED.** Remove `worldW()` and `wrapCopies()`; collapse the six sites to
their single-copy branches; `clampPan` clamps (§The trap). **Ships against the whole uncropped map**,
which is the entire point: the cylinder dies while the world is still 360° wide, so any fallout is
visible and diffable *before* a crop exists to hide it.

> **As built.** `worldW()` + `wrapCopies()` deleted; the render loop (`main.mjs`), both hit-tests
> (`hittest.mjs`), the minimap frame (`minimap.mjs`), `political.inViewport` and `bandcaption.colonyInView`
> all collapsed to their single-copy bodies; `clampPan` now clamps **x** with the same `clampAxis` the
> poles already use (not a new modulo→clamp — the existing axis clamp generalises). The initial
> whole-world framing is **provably unchanged**: `fitView` is *contain* (the crop fits the viewport at
> k=1, `VIEW.dw ≤ VIEW.w`), so `clampAxis` centres and returns `cam.x=0` — exactly what the old
> `((0%w)+w)%w` returned, and you cannot pan at k=1 anyway. The one intended difference is the edge
> clamp when zoomed in and dragged east past the antimeridian (no wrap-around). Verified with
> `tools/webverify`: boot clean (no console errors, bundle loaded), deep-zoom render pixel-identical to
> the pre-change baseline within the run-to-run noise floor (0.38% vs 0.32%, identical max-Δ), all six
> modules syntax-clean, zero dangling references.

> **Not visually neutral, and that is intended.** The map stops repeating east-west: you now hit an edge
> at the antimeridian instead of coming round the other side. Everything else — every province, label,
> plot, hit-test — must be pixel-identical, and that is the actual acceptance test (`tools/webverify`
> against a pre-Phase-2 baseline). One deliberate difference, zero incidental ones.

**Phase 3 — Crop and bake.** Per-realm crop rect **and per-realm background bake** in
`build.mjs`/`WorldBundle` — a `map` manifest entry per realm, masked to the realm's own pixels at bake time
(§The background is baked). `MAP.W/H` held global at 5632×2048 (§Keep the pixels absolute). **No roll, no
per-realm x offset** — every realm is contiguous once the three quirks are dropped (§Three quirk
provinces), so there is nothing to roll and the seam case never arises. Per-realm minimap thumbnail falls
out of the same bake. Verify per realm with `tools/webverify`.

> **Assert the no-roll invariant, don't assume it.** Phase 3 should fail loudly if a realm's provinces
> are ever non-contiguous in x, rather than silently drawing a 95%-wide crop like Aelantir's naive bbox.
> A future province that straddles the antimeridian then gets dropped or has its continent fixed — the
> roll does not come back to accommodate it.

> **As built (part 1 — crop, bake, clip; the fog mask is part 2).** `build.mjs` bakes a per-realm
> background by handing `bakeTerrain` each realm's provinces (each ≤2816px → ~2× the whole-world
> detail: Halcann 2781×2048, Aelantir 2634×2048, Hinuilands 263×454), asserts x-contiguity
> (`assertContiguousX`, fails past 70% raster width), and emits a `realms:{<key>:{map}}` block in the
> manifest with `W/H` held global at 5632×2048. `WorldBundle` merges it; the client picks the crop via
> `MAP = BUNDLE.realms[?realm].map || BUNDLE.map` (`core.mjs`, ACTIVE_REALM) — **whole-world stays the
> default**, realms are opt-in via `?realm=` until Phase 5's dropdown, so prod does not regress. The
> per-realm minimap falls out free (it reuses `MAP.src`). Verified per realm with `tools/webverify`:
> each crop renders distinct and correct, province dots aligned, zero console errors.
>
> Two rendering fixes landed here (they surfaced the moment a realm cropped narrower than the viewport
> aspect): the scene clip now bounds **both** axes to the map's raster extent (was Y-only), so the sea
> no longer paints the left/right letterbox void blue — it reads as dark void; and `clampAxis` drops
> its `viewDim/2` margin to **0**, so the map's edges clamp to the viewport edges and no out-of-bounds
> void can be panned into view. Also removed `MIN_LOADING_MS` (the splash now clears on first paint, as
> its own comment already promised).
>
> **As built (part 2 — the baked realm fog mask).** `bakeTerrain` now takes a `realmKey`; when set, a
> lazy `provinceRealmLookup()` reads `provinces.bmp` (24-bit BGR, one colour per province) + `definition.csv`
> (colour→id, the same decode `ProvinceExporter` uses, key `r<<16|g<<8|b`) into one colour→realm map, and
> each source land pixel whose province belongs to another realm is dropped exactly like a sea sub-pixel —
> so the Atlantic overlap (Brazil's tip on Halcann's west edge, Cannor on Aelantir's east edge, the foreign
> landmass around Hinuilands' two provinces) reads as the realm's surrounding ocean instead of a stray
> coastline. Pixel-accurate to the paint, free per frame, whole-world bake unaffected (`realmKey=null`).
> Verified: Hinuilands now shows only its two provinces in open sea; Aelantir's east edge is clean.
>
> Still deferred to **Phase 4**: foreign province *outlines/dots/labels* still draw at the crop edge —
> `renderScene` iterates every province, so suppressing them is the "filter the province set to the active
> realm" work (also the modest per-frame perf lever), which sits with the rest of the fog (rim, arrow,
> cross-realm line suppression).

**Phase 4 — Fog the void.** The runtime half of the fog, on top of Phase 3's baked mask: sea X-clip;
per-realm `rollupTier` label centroids; **suppress cross-realm adjacency lines** (§The fog must not be
mute — one bundle ships both endpoints, so the Venail↔Lastsight line draws into the fog unless stopped).
Plus the **realm rim + red teleport arrow** as its own layer entry, modelled on `drawCavernRims` — this is
what makes the other realms discoverable, so it is not cosmetic polish to be cut.

**Phase 5 — The dropdown.** Realm selector + Lobby entry; brand loses "Anbennar"; plane button hides
outside Halcann; deep links gain a realm; **preload other realms' backgrounds on idle** (§The background is
baked). Owns the **switch-realm action** that the dropdown, the Phase 4 arrow, and **opening a session**
all fire — with its `destination` argument, since they differ: the dropdown fits the realm, the arrow lands
on the far portal at the current zoom, a session frames its colony. So the arrow's click lands here, not in
Phase 4. `SessionSpec` gains its realm field (§A session carries its realm), defaulting to Halcann when
absent so the registry restores unmigrated.

**Phase 6 — Hinuilands.** Falls out of 0–5 for free — a realm with two provinces and a lot of fog. Check
the band spine against its 162×321px crop (§Open). Add the **loading-screen trivia line**
(`web/assets/loading/trivia.json`) here, once all three realms are real — Anbennar reserving 245 provinces
in the Titanoflora and painting two is the tip that writes itself.

Not in this list: travel (deferred).

## Deferred

**Inter-realm travel — no longer deferred; the mechanism exists** (§Anbennar already built the crossing).
The Domancadh fey portals are land-to-land, already imported, already walked by `LandRouter`. What this
section describes — a *sea* crossing needing boats — was one way to build a crossing; Anbennar's fey magic
is another, and it is the one that already exists. Boats remain unbuilt, but travel between realms no
longer waits on them.

The crossing is **gated, not open** (§Crossing a realm on foot is gated): the portal is default-closed and
opens on the Seasonal Court's calendar, so it is a real, conditional route rather than a free highway. That
is what keeps Ranked-per-realm airtight while still letting the crossing be real.

**A sea lane is now optional flavour, not the mechanism.** The analysis below is kept because a boat route
may still be wanted someday — a mundane crossing for those without a fey pact — but it is no longer the
plan. Narrowest sea-to-sea pair per latitude band:

```
POLAR   lat 84    719km   Fjordsbay -> Sealpod Route
NORTH   lat 56/51 1548km  Coast of Venail (1265) -> Eastern Lastsight Islands (1567)   <- best candidate
MID     lat 27/30 2361km  Sandspite Approach -> Banished Sea
TROPIC  lat  3/8  2278km  Corsair Reaches -> Bay of Hope
```

The polar pair is shorter but it is a technicality — lat 84 sits in the stretched dead zone at the top of
the Mercator projection, and an Arctic hop is a strange colonisation route. **Coast of Venail → Eastern
Lastsight Islands** would be the Cannor→Aelantir sea route proper: Venail is Cannor's west coast
(`venail_area`, `lencenor_region`, the human heartland), at a latitude the projection treats honestly. And
Anbennar named the far side **Lastsight** — the last sight of land. It named the edge of the known world
for us. If a mundane crossing is ever wanted alongside the fey portals, this is the pair — but nothing is
committed to it now.

**Hinuilands gets no ocean teleporter** — it has no coast (nearest water is 1295km from Vyr Cirentyn) and
it is not playable. It is reached by the dropdown. If it ever becomes reachable, it is via the existing
gladeway teleporter network, not by sea.

**Whether a session can span realms.** Deferred with the above. If a colony lives in one realm, realm is
a bundle filter plus a crop — small. If something crosses mid-session, the snapshot needs a realm field
and the viewer must follow the caravan across maps. Much larger, **not** in scope — and §Ranked is per
realm is what keeps it out of scope rather than merely postponed.

## Adjacent opportunity: the Domandrod Seasonal Court

Not part of Realms; recorded here because Phase 0 is what surfaces it, and it would otherwise be lost.

> **This is the same Domandrod as §Anbennar already built the crossing.** The five `domandrod_fey_portal`
> rows *are* the cross-realm link a caravan now walks (Domancadh is in `domandrod_region`); this section is
> about the **four seasonal gates** on top of that link — a distinct, still-valid idea. The crossing is
> the door; the Seasonal Court is the door being open only a quarter of the year.

Anbennar authored **four seasonal gates**, all fully intact in our import, all leading into
`domandrod_region` — a fey enclave in **Aelantir**:

```
domandrod_summer_gate   Sidpar (sarmadfar)    -> Blastgat  (domandrod)
domandrod_spring_gate   Arankid (glorelthir)  -> Lilebogg  (domandrod)
domandrod_autumn_gate   Orachran (glorelthir) -> Anrachran (domandrod)
domandrod_winter_gate   Dungat (randrunnse)   -> Bastnadd  (domandrod)
domandrod_winter_gate2  Fogrim (randrunnse)   -> Bastnadd  (domandrod)
```

One gate per season, each from a different outer region, every endpoint `ANCIENT_FOREST` or `LAND`, plus
five `domandrod_fey_portal` rows and five gladeways inside. That is a **Seasonal Court** — the classic fey
Spring/Summer/Autumn/Winter structure — and Anbennar built the whole thing in map data.

**A gate that opens only in its season is nearly free here.** It is a date predicate on an adjacency, and
every input already exists: a real solar calendar, seasons, and hemisphere-aware winter (the explorer
levies already muster "every winter, by hemisphere" — `docs/explorer-caravan.md`). `LandRouter` already
traverses these edges; the mechanic is *gating an edge we already walk*, not building a system.

It also gives Aelantir a signature the way the Serpentspine gives Halcann one: **Halcann has an underworld;
Aelantir has a fey court that is only reachable a quarter of the year.** A caravan that misses its season
waits, or takes the long way — a real routing decision that costs nothing to author, because Anbennar
already authored it.

## Rejected

**The generated Feyrealm.** Anbennar's cosmology says the Core Planes are parallels — *"every planet in
the Prime Material Plane being reflected by a planet in the other Core Planes"* — which reads as licence
to generate a Feyrealm as a mirror of Halann: same geography, overgrown, drenched in positive energy.
Lore-true, and it sidesteps the unpainted-Hinuilands problem entirely.

**Rejected: no mirrored provinces, and the name "Feyrealm" is not used.** A mirror doubles the province
count, needs an id-offset scheme, and buys a plane nobody can play. The third realm is **Hinuilands**,
standing as itself — two real provinces — and treated with the same logic as Aelantir: a partition of
existing provinces, cropped, fogged, reached (eventually) by teleporter rather than by being conjured.

If this is ever revisited, do not conflate the two: Hinuilands is a *location on the planet Halann* (the
Titanoflora, Prime Material — Anbennar simply has not drawn it). A Feyrealm would be a *parallel plane*
of the whole world. Building one is not building the other.

**The fey content that is painted lives in Halcann** — the Deepwoods (`deepwoods_superregion`, 66
provinces: 44 `ANCIENT_FOREST`, 11 `GLADEWAY`, 8 `FEY_GLADEWAY`), inside continent `europe`, plus five
gladeways in Aelantir (`domandrod_region`). Anbennar groups them (`deepwoods_feytouched_gladeways`,
`deepwoods_outward_gladeways`, `deepwoods_inner_gladeways`). They stay where they are.

## Open

- **Where does the gamemaster's island live?** Province 1173 is **kept, not dropped** (decided) —
  reserved for a future **gamemaster's island**. It is a dev-1/1/1 uncolonised Ringlet Isles islet that
  Anbennar happens to have named **Halann**, the planet's own name — a single-map artifact like everything
  else here, and now also a name collision with the planet in our vocabulary (it is not Halcann, not the
  planet, just an islet). Its continent is `asia`, so today it falls into the
  Halcann realm and would be a settleable dev-1 islet like any other. Options: leave it there and gate it
  by role; or make it **its own admin-only realm** — a fourth dropdown entry visible only to
  `ROLE_ADMIN`/`civstudio.auth.admins`, which the realm dropdown makes nearly free. The second reads
  better (a GM vantage shouldn't be somewhere a player can sail to) but it is a v2 question; for now,
  just don't let Phase 1 quietly make it ordinary land.
- ~~**One land province has no continent**~~ — **resolved by the regeneration** (§post-`fb79aaa`). It was
  Atvatnstisðl (6264), and upstream now gives it `continent: africa`. It is also `IMPASSABLE` now, so it
  was never going to be a place anyone stands. No land province is continent-less today; the only
  realm-less land is the three deliberate quirks.
- **Does the plane button hide or grey out** in Aelantir/Hinuilands?
- **Does the band spine survive a 162px realm?** The nine bands (`js/bands.mjs`) and their three
  interaction regimes were calibrated against a 5632px world. Hinuilands' crop is 162×321px — portrait,
  tiny, and mostly empty. `fitView` on it lands somewhere the bands have never been asked about. Probably
  harmless (`clampAxis` already centres an axis smaller than the viewport, so it simply will not pan), but
  it is a screenshot, not an argument — check it at Phase 6.
- **`HALANN_TIP`** (`advisors.mjs:24`) — *"Halann is the center of the Material Plane, which is the
  center of all of the Planes of Existence."* — is planet lore on what becomes a realm entry. It is still
  *true*, just no longer about the thing it labels. Per-realm tips (Halcann has one: *earth-center*), or
  drop it?
- **Hinuilands' membership is settled** — both `Continent.OCEANIA` and `hinuilands_superregion` select the
  same two provinces (§Hinuilands is not painted), so there is no ambiguity left here. Recorded because an
  earlier draft implied the two sources disagreed.
