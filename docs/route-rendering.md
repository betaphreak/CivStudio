# Route rendering — the trail/road/rail network as vector ribbons

**Status (2026-07-27): THE ART BAKE IS GONE; ROUTES ARE RIBBONS.** Gap A (baking Civ4 route meshes
to per-tier WebP atlases) and the per-plot auto-tiling that consumed them have been **deleted** —
`tools/nifbake`'s top-down route projection, `bakeRoutes` in `web/build.mjs`, the three committed
`web/assets/routes/*.webp`, `web/js/route-tiling.mjs`, and `BUNDLE.routes`. The draw layer now
strokes **polylines between plot centres** (`web/js/route-ribbon.mjs` + `routes.mjs`).

Two reasons, and only the second is about looks:

1. **A stamped square cell only meets its neighbour while a plot is an axis-aligned square on
   screen.** Under the tilted 3D camera a plot is a trapezoid, so a rotated square sprite no longer
   lines up at the shared edge and the network came apart at exactly the joins the tiling existed to
   make. A ribbon meets its neighbours by *being continuous*, which no projection can break — and
   every vertex goes through `core.projectOn`, so it drapes on the terrain for free (P4).
2. **The atlases came out of the one projection in `nifbake` that was not a camera view of a model.**
   Deleting that path was the point; see [`terrain-3d.md`](terrain-3d.md) §The top-down projector
   goes, and routes become ribbons.

The engine→client channel is unchanged: per-plot `RouteType` still rides the viewport-windowed feed
(§Viewport-windowed route persistence), and `routes.mjs` maps a type onto a tier itself — a property
of the engine's route ladder rather than of any atlas. In the caravan demo the colony's own **winter
explorer levies** (no hand-seeded bands) still pioneer the trails.

**Gaps B and C remain BUILT** — the per-plot channel and the draw layer — in ribbon form.

**Update (2026-07-19):** gap B's snapshot channel is being **replaced by a viewport-windowed feed**
(see [§Viewport-windowed route persistence](#viewport-windowed-route-persistence-superseding-gap-b)
below). The snapshot's per-band `routePlots` window (a 512-plot rolling buffer per living band) does
not *persist* the network: a late-joining spectator never receives trails pioneered before it
connected, a page reload wipes the accumulated layer, and a dissolved band stops broadcasting its
still-existing trail. The fix moves the authoritative layer server-side (a session/province-scoped
registry) and serves it per province on viewport entry. **All three steps are BUILT** — engine
registry (1), endpoint + snapshot dirty-signal (2), client cache + cross-province fusion + contract
(3). The legacy `routePlots` broadcast has been removed; verified locally (a cold live shot fetches
every in-view province's layer and draws the network, no console errors). Not yet deployed.

This is the follow-through on the owner's Phase-3 decision (see `docs/explorer-caravan.md`
§Phase 3 "Route art"): **use the real Civ4 route art via `tools/nifbake`, not procedural
ribbons.** Background on the engine-side route model (tiers, per-plot `Plot.routeType`,
movement cost) is in `RouteType`/`routes.json` and `docs/explorer-caravan.md`.

## The art, and why roads need their own bake path

Each C2C route **style** (`UnpackedArt/art/terrain/routes/<style>/`) is a set of ~70 flat
segment `.nif` meshes (the Civ4 auto-tiling adjacency variants — `roada00`, `roadb03`, …)
that all UV-map onto **one small tiled surface texture** (`roadprimitive.dds` 64×32 for the
dirt path, `roadroman.dds` for the stone road, `railroad.dds` for rails). The road *look* is
that one strip repeated down a segment; the mesh only supplies the quad shape + UV.

`tools/nifbake` already renders feature `.nif`s (cactus, city) to billboard sprites, but roads
differ in two ways that needed a dedicated **`renderRouteNif`** (in `tools/nifbake/render.mjs`):

1. **Top-down projection, not front view.** `renderNif` projects X-right / Z-up (correct for
   upright billboards). Roads lie flat (the mesh spans X–Y at Z≈0), so `renderRouteNif`
   projects **X–Y looking down Z** (higher Z wins), with world +Y (North) mapped to image-up.
2. **Direct geometry location, bypassing `parseNif`'s resync.** A road's `NiTriShape` and its
   `NiTriShapeData` are separated by a 7-block run — `NiTexturingProperty` / `NiSourceTexture`
   / `NiAlphaProperty` / `NiMaterialProperty` plus an **animated-alpha**
   `NiAlphaController → NiFloatInterpolator → NiFloatData` chain that `nif.mjs` has no parser
   for. `parseNif` tries to brute-force resync past that gap, but its `sane()` UV bound (0..3,
   tuned for 0..1 billboards) **rejects the road's tiling UVs** (V repeats down a long
   segment). So `renderRouteNif` instead scans for the `NiTriShapeData` whose parse consumes
   **exactly to EOF** — a strong, self-contained lock needing no resync heuristic. The tiling
   UVs are wrapped by the sampler (that repeat *is* the road surface running down the segment).

## The build slice — `bakeRoutes()` in `web/build.mjs`

Three **tiers** are baked, each a C2C style, keyed so the engine's `Plot.routeType` maps on via
`byType`:

| tier | style dir | texture | `RouteType.type` |
|---|---|---|---|
| `trail` | `path` | `roadprimitive.dds` (dirt) | `ROUTE_TRAIL`, `ROUTE_PATH` |
| `road` | `roman roads` | `roadroman.dds` (stone) | `ROUTE_ROAD`, `ROUTE_PAVED_ROAD` |
| `rail` | `modrailroads` | `railroad.dds` | `ROUTE_RAILROAD` |

Rather than all ~70 adjacency variants, each tier bakes the **small connection set** a
square-grid auto-tiler needs — the pieces a 2D map actually uses, chosen by their Civ4
route-model connection (`route-models.json`):

| piece | connection | Civ4 stem | shape |
|---|---|---|---|
| `iso` | `-` | `a00` | isolated nub |
| `end` | `N` | `a01` | terminus |
| `straight` | `N S` | `b03` | │ through |
| `corner` | `N E` | `b05` | └ L-turn |
| `tee` | `N NE S` | `c07` | Y/T junction |
| `cross` | `N E S W` | `d01` | ✕/+ crossroads |

Each piece renders top-down into a **registered square cell** — every piece of a tier maps the
same world half-extent (`routeHalfExtent` of the tier's straight piece) into a `SIZE_ROUTE`×
`SIZE_ROUTE` cell, so a piece's connections always reach the same plot edges and a 90° rotation
stays aligned (this is what lets the draw layer stamp one cell per plot and rotate it). The
tier's cells pack into one horizontal-strip WebP (`web/assets/routes/routes-<tier>.webp`,
~8–12 KB each); the manifest records, per tier, `{ src, w, h, cellSize, cell:{ piece:[x,y,w,h] },
conn:{ piece:connString } }`, plus a top-level `byType:{ ROUTE_*: tier }`. Art is resolved
through `civ4.mjs resolveArt` (on-demand C2C fetch + `.civ4-cache`), warmed by `routeArtPaths()`
in the top-of-file prefetch. If a style/texture doesn't resolve, that tier is skipped (the map
just draws no road for it) — same degrade-to-fallback contract as the other bakes.

The manifest lands in `civstudio-server/.../map/web-asset-manifest.json`; `WorldBundle` passes
the `routes` key through to `/api/bundle`; `core.mjs` exposes it as `ROUTES`.

## The correct zoom band for roads

Roads are **per-plot ground detail**, exactly like tree/feature sprites and trade-good icons.
Those draw from **band 4 (`BAND.TERRAIN`, `cam.k = K_TEX = 16×`)** upward — the point where a
plot is large enough on screen to carry ground-detail art; below it the map is in the
atlas/overland-strategy regime where a single plot is ≈1 px and per-plot road art would be
sub-pixel noise. **So `drawRoutes` fades in over `bandAlpha([3.5, 4.5])`** (Province→Terrain,
the same envelope as the `city.mjs` markers) — effectively off below ~11× and full by 22×, in the
per-plot ground-detail band alongside `drawSurfacePlots`'s textures and `drawTradeGoodIcons`.
(A separate coarse *overland* schematic — a thin connecting line between settlements, drawn
earlier like the caravan trails in `overlays/live.mjs` — is a different, optional layer; it is
not these baked plot sprites.)

## The draw layer (gap C) — as built

`web/js/route-tiling.mjs` is the pure auto-tiler: `routePiece(mask)` maps a plot's 4-bit
orthogonal-neighbour mask (N/E/S/W) to `{piece, rot}` — one of the six baked pieces at a
90°-multiple rotation, covering all 16 masks (unit-tested in `route-tiling.test.mjs`; run
`node --test web/js/`).

`web/js/routes.mjs` (`drawRoutes`, in the `layers.mjs` registry after `tradeGoods`, before
`city`) walks each on-screen province's plots, indexes the routed ones by tier, and for each
stamps the tier atlas cell `routePiece(neighbourMask(...))` rotated about the plot centre —
gated `bandAlpha([3.5,4.5])`, fading in through Province→Terrain like the other per-plot ground
detail. It connects only same-tier neighbours (a trail doesn't fuse into a paved road). Verified
live against a local server: **805 route cells auto-tiled** across a region of city cores, correct
pieces/rotations (the grid + city harnesses render the exact output).

**Data source.** `plotTier(q)` prefers the engine's per-plot `RouteType` (`q.route` → tier via
`ROUTES.byType`) — that's gap B. Until it lands, city-core plots (`q.urban`, which the engine
founds pre-paved) stand in as paved road. **Caveat:** the urban core is already covered by the
`city.mjs` markers (mid-zoom) and the district hexes (deep-zoom), so the interim roads are
largely occluded; the visible payoff is gap B's countryside routes, where nothing else draws.

## Viewport-windowed route persistence (superseding gap B)

Gap B's first cut broadcast trails through the render snapshot: each marching band re-emits its last
`MAX_TRAILED_FOR_RENDER` (512) trailed plots every tick (`MarchingCaravan.trailedPlots()`), the
server dedupes them into `SessionSnapshot.routePlots`, and the client *accumulates* what it is sent.
That renders live trails but does **not persist the network**, because the emitted set is an
ephemeral per-band rolling window, not the authoritative layer:

1. **Late join** — a spectator connecting mid-run accumulates from empty and only ever receives the
   current rolling windows, so it never sees historical trails.
2. **Reload** — client accumulation is in-memory, so a page refresh wipes the visible network; most
   of it never re-emits (the band has moved > 512 plots on).
3. **Band death** — when a band dissolves, its trail stops broadcasting entirely, even though the
   plots still carry the route in-engine (movement truth is durable; only the *feed* forgot).

Meanwhile the authoritative full network already exists in-engine — `Plot.routeType` on every plot a
band ever crossed — but nothing serves it as a whole. Restore is unaffected either way:
`SessionHost.restore()` replays the sim day-by-day (`state = f(spec, log)`), so trails reconstruct
for free; the gap is purely in *serving* the standing network to clients, not in durable storage.

**The fix: a viewport-windowed feed that mirrors the per-province plot channel.** `GET
/api/plots/{id}` already serves one province's plot grid on demand as it enters view (static, baked,
immutably cached); the route layer copies that shape but is **session-scoped and mutable**:

```
GET /api/sessions/{sid}/routes/{provinceId}   → the routed plots in that province, this session
```

The client's viewport loop (`plots.mjs`, culling in-view provinces) fetches each in-view province's
route set alongside its plot grid. Because routes mutate, the SSE snapshot carries a compact
**freshness signal** — the province ids whose route layer changed recently (a `routeDirty` list;
bands touch only a handful of provinces per tick) — and the client refetches only provinces that are
*both dirty and in view*. Traffic scales with visible, changed area, not total network size.

This is strictly better than a full-network broadcast here: it fixes all three defects (the server
holds the authoritative layer and can serve any province), it is bounded by the viewport at any
network size, and it *shrinks* the snapshot (a short id list replaces the ≤512×N-band plot blob).

### The pieces, and phasing

- **Step 1 — engine registry (BUILT).** A province-scoped routed-plot registry on
  `ProvincePlotPool` (`routedPlots` + a monotonic `routeRev`), seeded from urban pre-paving in the
  pool constructor and fed by `recordRoute(plot)` from every route-laying site
  (`MarchingCaravan.layTrail`; urban pre-pave is captured by the constructor scan; future
  road-builders call `recordRoute`). The layer now lives on the pool, so it survives band death and
  is authoritative per province. Behavioural no-op: the existing `trailedPlots`/`routePlots`
  snapshot path is left in place until step 2 swaps the server over.
- **Step 2 — endpoint + dirty signal (BUILT).** `RouteController` serves `GET
  /api/sessions/{sid}/routes/{provinceId}` → a `ProvinceRoutes(provinceId, rev, plots)` JSON body,
  `no-cache` (routes are per-session mutable, unlike the immutably-cached plot grid), read off the
  engine registry via `GameSession.plotPoolIfPresent` — a province with no pool answers an empty
  layer rather than paying its generation. `ProvincePlotPool.routeSnapshot()` reads the plots and
  their `rev` atomically so a client deduping on `rev` never stores a version newer than the plots it
  holds. The engine tracks per-province dirtiness (`GameSession.markRouteDirty`, fed by
  `MarchingCaravan.layTrail` and by a pool born pre-paved) and `HostedSession.emit` drains it into
  the snapshot's `routeDirty` id list. Expand/contract: `SessionSnapshot.routePlots` and
  `collectRoutePlots` are **kept** so the current client still renders; step 3 removes them. Covered
  by `ServerApiTest.routeFeedServesAProvincesStandingLayerAndTheSnapshotFlagsItDirty`.
- **Step 3 — client cache + contract (BUILT).** `route-index.mjs` is the pure global `(x,y)→type`
  index (node-tested, `route-index.test.mjs`); `routefetch.mjs` fetches a province's layer on viewport
  entry (bounded by the draw band's early-return), dedupes on `rev`, and refetches only provinces the
  snapshot flags in `routeDirty` — session-scoped, cleared on a session switch. `routes.mjs`'s
  `plotTier` reads the index (with `q.urban` as the off-Live / pre-load stand-in) and its neighbour
  mask consults the **global** index so roads fuse across province seams. Contracted: `routePlots`,
  `collectRoutePlots`, the snapshot field, `mergeRoutePlots`, and `MarchingCaravan.trailedPlots` are
  gone. `RoutePlotView` is now the feed's element only.

### Roads must connect across province boundaries (like rivers)

The draw layer's auto-tiler (`route-tiling.mjs` `routePiece(mask)`) picks a segment from a plot's
4-bit N/E/S/W **neighbour mask**. At a province edge a plot's orthogonal neighbour lives in a
*different* province's plot field (a different pool, a separately-fetched route set), so a
naïve per-province `neighbourMask` sees no neighbour across the seam and draws a road **stub / dead
end** at every boundary — exactly the failure rivers avoid by being computed on the whole-world
raster, not per province. The per-province registry and feed are keyed by the shared packed `(x,y)`
world raster position (the same coordinate `RoutePlotView`/the plot feed already use), so the fix is
on the **client's `neighbourMask`**: resolve a boundary neighbour against the adjacent province's
loaded route set (all in-view provinces are already loaded), not only the current one — a
world-space neighbour lookup across the union of loaded route sets rather than a per-province one.
Two consequences to honour in step 3:

- The auto-tiler must index routed plots by **world `(x,y)`** across all loaded provinces (one
  merged spatial map), so a plot on province A's edge fuses with the trail entering from province B.
- A province coming into (or out of) view, or a neighbour's `routeRev` bumping, must re-evaluate the
  **boundary plots of adjacent already-loaded provinces** too (their masks change when the neighbour
  gains/loses a route), not just the province that changed. Cheapest correct rule: on any
  route-set change for province P, re-tile P **and** the edge plots of P's loaded neighbours.

(Trails still only fuse **same-tier** neighbours, boundary or not — a dirt trail entering a paved
city core does not weld into one road, matching the in-province rule `drawRoutes` already applies.)

Deploy note: engine + server + web, but **no `MAP_VERSION` bump and no CI plot-cache rebake** —
routes are not baked into `.map`, so the static grid and its immutable cache are untouched. Deploy
the server before the web auto-deploy (the client calls the new endpoint).

## Known follow-ups

- **Rail canonical orientation.** The `modrailroads` segments bake **90°-rotated** vs
  `path`/`roman roads` (rail `straight` is E–W, not N–S), so `routePiece`'s N/E/S/W convention
  places rail a quarter-turn off. Normalise per tier (rotate rail +90° in `stampCell`, or
  pre-rotate the rail pieces in `bakeRoutes`) once a rail tier carries live data.
- **`PAVED_ROAD` / higher tiers** currently reuse the `road` (roman) art; `modern roads` has only
  2 nifs (no connection set), so a distinct paved look would bake from a different style or a
  hand-authored texture.
