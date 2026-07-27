# Design & plan: client/server — a session is a seed

**Status (by phase):**
- **Phase 0 — de-globalize the process singletons (per-`GameSession` logging and
  output routing).** ✅ **Implemented** (2026-07-09). *Prerequisite for everything below.*
- **Phase A — spectator server: authoritative sim + live state feed to the browser.**
  ✅ **Implemented** (2026-07-09). Factorio-shaped spine (tick authority + command-log
  seam + resume-by-replay), browser as thin render-client over SSE.
- **Phase B — interactive server: a client command channel + player action model,
  server-authoritative, persisted as an ordered command log.** Proposed / later.
- **Phase C — persistence, resume, and horizontal hosting (snapshotting, replay,
  multi-node).** Proposed / later.

**Date:** design 2026-07-09.

**Decision inputs (2026-07-09):** target is **spectator first, then interactive**;
hosting model is **many sessions per JVM**; this document is the deliverable (no code
yet).

**Depends on:** `GameSession` (the seed owner and per-colony RNG partitioning — see
`settlement/GameSession.java` and `util/RngSeed`); `Settlement`'s externally-drivable
step API (`start()` / `newDay()` / `isDead()` / `finishRun()`); `SessionRunner`'s
lockstep day-barrier (`simulation/SessionRunner.java`); the `SimLog` process-global
logging setup (`io/SimLog.java`); the printer/CSV output convention (`output/<seed>/`);
and the static web viewer that consumes it (`web/build.mjs` → `web/data.js`).

**Related:** `docs/architecture.md` §The step loop (the phase order this server drives),
§Goods, printers, utils (the reporting this feed replaces/augments); `docs/caravan-trade.md`
and `docs/village-founding.md` (the near-term gameplay the interactive phase will expose);
the project direction (playable game long-term, player seat deferred, stability-first).

---

## Motivation

The engine is already a headless, seed-reproducible authoritative simulation. A
`GameSession` owns a seed, derives every random stream off it (`RngSeed`), and holds the
cross-colony state (world map, tech tree, wandering bands, shared name pools). The same
seed yields a byte-identical run. `Settlement.newDay()` advances exactly one in-game day
and is already driven from an external loop (`SessionRunner`).

What is missing is not a simulation core — it is (1) **isolation** (the process assumes
one run at a time) and (2) a **live surface** (state is dumped to CSV at end-of-run and
read by a static web build; nothing streams incremental state to a subscriber, and no
serializable state snapshot exists).

The central design fact that makes this tractable:

> **Authoritative state is a pure function of the seed and the ordered input log.**
> Today the input log is empty, so state = *f*(seed, tick). Add player commands and
> state = *f*(seed, command-log). This gives cheap persistence (store the log, not the
> state), free replay, and natural spectate — *provided* the RNG discipline the codebase
> already enforces is never broken.

So the seed is the reproducibility root. It is **not**, on its own, the session identity:
two sessions with the same seed but a different founding config (era, province, scenario)
diverge on day 0. Identity is a small spec:

```
SessionSpec { long seed; Era era; FoundingConfig founding }   // hashes to a sessionId
```

`seed` is the deterministic salt underneath; `sessionId = hash(SessionSpec)` is the key a
client asks for. Two clients requesting the same spec land in the same world; "resume
session X" replays deterministically from its spec + log.

---

## What is already server-ready

- **The session object exists.** `GameSession` is the natural per-session unit — seed,
  RNG streams, shared reference data, cross-colony bands.
- **The step loop is externally drivable.** `Settlement.newDay()` is public; `start()`,
  `isDead()`, `finishRun()` complete a clean stepping API. `SessionRunner` already owns
  the loop instead of `Settlement.run()`.
- **Determinism is enforced as law.** Per-colony salted streams
  (`rngSeed.forColony(Stream.ECONOMIC, idx)`, …); "never consume from the economic RNG
  for a new feature" is a standing convention. This is exactly the invariant a
  server-authoritative + replay design needs.
- **In-session concurrency is solved.** One thread per colony, `Phaser` day-barrier,
  per-colony RNG/name/mortality partitioning, synchronized cross-colony seams. A single
  hosted session with N colonies works today.

## What blocks it (ranked by cost)

1. **Process-global singletons — the #1 refactor.** `SimLog` is `static`, init-once-
   per-process, hard-wired to one `output/<seed>/`. Tests already run
   `reuseForks=false` *because* of this. With **many sessions per JVM** (the chosen
   hosting model), two sessions collide on the log handler and output directory.
   Everything session-scoped — logging, output routing, the `output/<seed>/` convention —
   must move from process-global to per-`GameSession`. Mechanical but pervasive; this is
   Phase 0 and gates all of A/B/C.
2. **Output is batch file I/O, not a live stream.** Printers write CSV at end-of-run; the
   web reads a *static* `data.js` (`web/build.mjs`). There is no "state after tick N"
   surface and **no serializable state snapshot** — state is a live object graph across
   agents/markets/banks. A live client needs a snapshot/delta DTO layer that does not
   exist yet.
3. **No serialization / no save-load.** A running session cannot be persisted or resumed.
   Determinism *partially* covers this (spec + log → replay), but replay cost grows with
   game length, so long sessions eventually need real snapshotting (Phase C).
4. **Run-to-completion, collapse-by-design mindset.** Scenarios are `static run()` that
   build → run → exit, and ruler colonies deliberately collapse (`docs/food-balance.md`).
   A playable session needs an open-ended, pausable, server-owned loop and colonies that
   persist. This is a *prerequisite for B*, not for A: a spectator server can happily
   stream a colony that collapses.
5. **No player-input surface.** Everything is autonomous agents; there is no command/
   action model. Until one exists, client/server can only be **spectator**. The player
   seat is deferred by project direction — so it is deferred to Phase B here too.

---

## Phase 0 — de-globalize the singletons

Goal: `N` `GameSession`s coexist in one JVM with no shared mutable process state.

- **`SimLog` → per-session.** Replace the `static initialized` / single file handler
  with a logging context owned by (or keyed by) the `GameSession`. The per-thread `Ctx`
  ThreadLocal already scopes *which colony* prefixes a record; what remains global is the
  *handler + output file*. Route each session's records to its own `output/<sessionId>/`
  (see below). Options, cheapest first: (a) a per-session `Logger` name hierarchy with a
  per-session file handler attached; (b) an MDC-style session key on the ThreadLocal that
  a single handler demultiplexes to per-session files. (a) is closest to the current
  design.
- **Output directory → per-session.** Everything currently under `output/<seed>/`
  (CSVs, the `.log`, the merged tables from `CsvMerger`) becomes `output/<sessionId>/`.
  For the spectator server the CSVs may become optional (the live feed supersedes them),
  but keep them behind a flag — they are the current viewer's data source and the natural
  audit trail.
- **Audit for other statics.** Sweep for `static` mutable state on the hot path before
  declaring isolation (grep for `static` non-`final` fields under `agent/`, `market/`,
  `bank/`, `io/`). The RNG streams are already per-session; the risk is incidental caches.

Deliverable: two sessions run concurrently in one JVM to completion, each writing a clean,
non-interleaved `output/<sessionId>/`. This is independently valuable — it also lets the
test suite drop `reuseForks=false`.

**As built (2026-07-09).** The audit found `SimLog.initialized` + its single root file
handler to be the *only* mutable process-global state on the output path across
`agent/market/bank/io/settlement/simulation` — RNG is already per-session (via
`GameSession`/`RngSeed`), and CSV output is already per-session (each `Settlement` owns a
`CsvRowSinkFactory` scoped to `output/<seed>/`, installed by `Settlement.setSession`). So
Phase 0 was one contained refactor of `io/SimLog.java`: the single global file handler
became a **session-demultiplexing** handler that routes each record to a per-session file
sink (keyed by the log path, so a session's colonies share one file and distinct sessions
in one JVM stay separate), resolved from the colony bound on the emitting thread. Process
handlers install once; per-session sinks open lazily and are released by a new
`SimLog.closeSession(Settlement)` (the host's session-teardown seam). The console handler
(WARNING+ to stderr) stays genuinely shared. Directory naming stays `output/<seed>/` for
now (distinct seeds → distinct dirs); the `output/<sessionId>/` rename is deferred to when
same-seed/different-spec sessions become real (see the `SessionSpec` note above).
Regression test: `io/SimLogSessionRoutingTest` runs two sessions in one JVM and asserts
each log holds only its own records. Dropping `reuseForks=false` is now *possible* but was
left as a separate change (it touches the Surefire config, not the engine).

## Phase A — the spectator server

Server runs the authoritative sim; browsers watch live. This upgrades the web viewer from
static-snapshot to live feed and, not incidentally, forces the isolation + snapshot work
that B also needs.

**Components:**

- **`SessionHost`** — owns a registry of `GameSession`s keyed by `sessionId`, a tick
  scheduler, and the transport. Creating a session = resolve/validate a `SessionSpec`,
  build the `GameSession` + its colonies (the existing harness founding sequence), and
  register it. Virtual threads (`Thread.ofVirtual`) fit the existing one-thread-per-colony
  model well and make many-sessions-per-JVM cheap; the `Phaser` day-barrier is reused
  per session.
- **Tick scheduler.** A server owns the loop `SessionRunner` owns today, but ticks on a
  clock (e.g. configurable in-game-days per wall-second) or on demand (pause/resume/step),
  instead of running flat-out to collapse. This is a variation on
  `SessionRunner.runConcurrently` with (a) a rate limiter and (b) a pause gate at the
  day-barrier.
- **State snapshot DTO.** The real new work: a serializable projection of a colony's
  state at a tick — the same shape a save file would later take. Derive it from what the
  printers already read (prices, volumes, banks, population, plots, POIs, band positions).
  Emit a full snapshot on client join and per-tick (or per-in-game-month) **deltas**
  after. Keep it a *projection*, never the live graph — the sim must not be reachable
  from the wire.
- **Transport.** WebSocket to the browser you already have (`web/`). Protocol:
  `subscribe(sessionId) → {full snapshot} then {delta}*`. Control messages
  (`pause`/`resume`/`setRate`/`step`) are spectator-scoped in this phase (they affect
  playback/hosting, not the sim's decisions).

**Web-side:** `web/app.js` gains a live-feed data source alongside the static `data.js`
one — the map/caravan replay it already renders, fed by the socket instead of the baked
file. `web/build.mjs` stays for offline/static viewing.

Deliverable: open the site, pick a session (seed+spec), watch it advance live.

**As built (2026-07-09).** The `com.civstudio.server` package:
- **`SessionSpec`** {seed, scenario, provinceId} → `id()` = `<scenario>-<seed>`. The
  savegame key: state = *f*(spec, command log), so the spec + log *is* the resume format
  (no object-graph serializer built — replay is the resume path; a bit-serialized
  fast-resume snapshot stays the Phase C optimization).
- **`HostedSession`** — the tick authority. One virtual thread runs a lockstep loop
  advancing each colony one in-game day per tick <em>sequentially</em> (bit-identical to
  `SessionRunner`'s concurrent lockstep, since colonies never read each other mid-day —
  disjoint RNG/name/mortality partitions), plus `tickBands` for the wandering caravans.
  Pause/resume/step/rate gate only wall-clock timing, never results. Commands drain at the
  deterministic top-of-tick. Snapshots are assembled on the session thread between ticks
  and cached, so the projection never races `newDay` and a slow subscriber never stalls
  the sim.
- **`command.GameCommand` / `CommandLog`** — the tick-stamped input spine (empty during
  spectator; the ordered applied history is the replay log). Verified: a command scheduled
  for tick N applies at exactly tick N.
- **`render.{SessionSnapshot,ColonyView,CaravanView,Snapshots}`** — the read-only render
  projection (colony aggregates + caravan positions/vitals), never the live graph.
- **`http.FeedServer`** — the transport. *(Superseded 2026-07-10: migrated to **Spring Boot 4
  MVC controllers** — `web.SessionController`/`BundleController`/`PageController` on `SseEmitter`,
  running on virtual threads. The endpoints, the SSE drop-oldest queue, and the "never stall the
  sim" contract below are unchanged; only the HTTP machinery moved. See
  [`spring-boot-migration.md`](spring-boot-migration.md).)* **SSE over the JDK `HttpServer`, not
  WebSocket**:
  a spectator feed is one-way server→client, so SSE fits and keeps the zero-runtime-
  dependency ethos (JDK + the already-present Jackson; the JDK has no WS server). Each SSE
  connection has its own bounded queue the session thread offers into (drop-oldest if the
  client lags), drained by the connection's own virtual thread — so a slow spectator can
  never stall the simulation. Endpoints: list/create sessions, `…/stream` (SSE),
  `…/control` (pause/resume/step/rate), `…/commands` (the Phase-B seam, a 202 no-op today).
- **`ServerMain`** + **`web/live.html`** — launcher and a self-contained thin client
  (`EventSource` → canvas map of the caravans with trails + a live colony/caravan panel +
  the controls). The demo hosts one caravan-demo session (a standard colony founded into
  Dhenijansar plus **six directed caravans** marching to distant graph-reachable
  provinces) and ticks it ~one in-game day per second.

Verified end-to-end: `HostedSessionTest` (snapshot shape, caravans march over 40 days,
tick-exact command application, pause holds the clock), `FeedServerTest` (SSE round-trip),
and a live run — the six caravans fan out across the map and the pause/resume/rate controls
drive the running session.

## Deployment (Phase A)

The site and the server are **two deployables** that talk over HTTPS — because they are
opposite shapes:

```
   civstudio.com  ──────────  Azure Static Web Apps          (unchanged: web/ → deploy-web.yml)
   (index.html, app.js, data.js, baked map assets — a prebuilt static folder)
          │
          │  EventSource (SSE) + fetch (control)
          ▼
   dev.civstudio.com  ──────  Azure Container App           (new: Dockerfile → deploy-server.yml)
   (the fat jar: HostedSessions + FeedServer, one always-on replica)
```

The static viewer stays on Static Web Apps exactly as before. The spectator server is a
**stateful, always-on JVM** (sessions live in memory, tick on threads, stream over SSE), so
it cannot run on Static Web Apps or serverless Functions — it needs a persistent compute
host. **Azure Container Apps** with **min-replicas = 1** (no scale-to-zero, so sessions
survive) is the target; SSE works over its ingress out of the box.

**Build artifact.** `mvn package` produces a self-contained executable fat jar
(`maven-shade-plugin`, `Main-Class = com.civstudio.server.ServerMain`, Jackson folded in) —
it does not affect `mvn test`/`exec:exec`. The `Dockerfile` builds that jar and copies, onto
a slim JRE 25, the two things the engine reads **from disk at runtime**: `data/anbennar/`
(the province-raster BMPs, ~95 MB — the JSON/name tables are already on the classpath inside
the jar) and `web/live.html` (the page the server serves). `data/civ4` is excluded
(`.dockerignore`) — it feeds only the web asset baker, never the Java runtime.

**Where it lives (as deployed).** The project subscription (`CivStudio`) already has the
pieces we reuse, so there is almost no greenfield infra:

| Resource | Name | Region | Note |
|---|---|---|---|
| Resource group | `civstudio` | belgiumcentral | shared |
| Container registry | **GitHub Container Registry** (`ghcr.io/betaphreak/*`) | — | public images; not an Azure resource |
| Managed environment | `civstudio-managed-env` | West Europe | shared |
| **Container App** | **`civstudio-server`** | West Europe | port 8080, external ingress, min/max-replicas 1, 1 CPU / 2 GiB |

The same environment also hosts the Strapi backend (`civstudio-backend-app`, port 1337); the
spectator server is a separate app on port 8080 and does not touch it. As deployed the app
answers at `civstudio-server.<env-hash>.westeurope.azurecontainerapps.io` and pulls its image
from **GHCR** (`ghcr.io/betaphreak/civstudio-server`). The package is **public**, so the Container
App pulls it with **no registry credentials at all** (no ACR, no managed-identity role assignment,
no stored PAT) — which sidesteps the identity constraint below for the *pull* path.

**The identity constraint that shapes everything.** The `CivStudio` subscription is accessed
by a **guest** account (`…#EXT#@…`) that holds **Contributor, not Owner/User Access
Administrator**. It can create and manage *resources* (it created all of the above) but it
**cannot create role assignments** — every `az role assignment …` returns a misleading
`MissingSubscription`. Consequences:
- **No CI service principal.** An SP can be *created* but not *granted a role*, so it's
  useless for ARM. Automated deploy-from-CI is therefore not possible from this identity;
  a subscription **Owner** would have to grant a role (or grant the guest User Access
  Administrator) to enable it.
- **Deploy is done from an authenticated `az` session**, not CI. Creating/updating the
  Container App and binding the hostname are *resource* ops the guest can do.

**Building & pushing the image.** The image goes to **GHCR** (`ghcr.io/betaphreak/civstudio-server`)
— any Docker host can build and push. Two paths:
- **Local:** `tools/deploy-server.ps1` (`docker login ghcr.io` with `$env:GHCR_TOKEN` or the gh CLI
  token → `docker build` → push → roll → post-roll verify).
- **CI (`deploy-server.yml`) — build & push only:** builds on the GitHub runner and pushes with the
  **built-in `GITHUB_TOKEN`** (`permissions: packages: write`) — no stored registry secrets. It does
  **not** deploy; it prints the `az containerapp update` one-liner to run.

> **One-time:** the first push creates the GHCR package as **private** — set it to **Public** (repo →
> Packages → the package → Package settings → Change visibility) so the Container App can pull it
> credential-free. Do this once per image (`civstudio-server`, `civstudio-backend`).

The old ACR path (`civstudio.azurecr.io`) is retired: it needed a **throwaway West-Europe ACR** to
build (Tasks are absent in belgiumcentral) and stored `ACR_USERNAME`/`ACR_PASSWORD` admin secrets.
GHCR removes both — no Azure registry, no registry secrets.

**Updating (roll the app — still from an authenticated `az` session).**
```bash
# build+push a new image (tools/deploy-server.ps1, CI, or any Docker host), then:
az containerapp update -n civstudio-server -g civstudio \
  --image ghcr.io/betaphreak/civstudio-server:<tag>
```

**Deployment runbook — the correct order and actions.** A change can touch three surfaces
(the static site, the server bundle baked into the image, and the plots the server *generates*).
Do them in this order so they stay in sync — skipping a step makes the surfaces drift and the
map silently break:

1. **Rebake the web bundle** — *only if the change touched terrain / feature / bundle assets or
   `web/build.mjs`.* Run `node web/build.mjs`. It regenerates
   `civstudio-server/src/main/resources/map/web-asset-manifest.json` (baked **into the server
   image**, served at `/api/bundle`) plus `web/assets/*.webp`. Do this **before** building the
   server image, or the server serves a stale bundle. Commit the regenerated manifest + assets.
2. **Rebake the plot cache** — *only if the change altered plot **generation***
   (`ProvincePlotField` / `TerrainGenerator` / `RiverFlow` / `CityPlacement` / bonuses / a
   `terrains.json` yield, …). Such a change means a **`ProvincePlotStore.MAP_VERSION` bump**, and
   the bump *is* the invalidation: the cache lives at `<share>/map/v<MAP_VERSION>`, so a new
   version simply points the server at a fresh directory. **Do NOT delete anything.**

   > **Never `rm` the plot cache.** An older revision of this runbook said to clear
   > `/mnt/anbennar/map/*.json.gz`. That command is a **no-op** (it predates the versioned dirs —
   > the files live under `map/v<N>/`), and "fixing" it to match would be **destructive**:
   > `map/v<N>` holds the GeoNames place names, which **production cannot regenerate** (there is
   > no GeoNames dump on the server). Deleting it leaves prod serving nameless plots until the
   > next CI bake. The only thing a version bump needs is that `map/v<new>` **exists**.

   Bake it in CI — **`regenerate-map.yml`** (~18 min end to end — bake 2.5 min, azcopy upload 1.5, and the
   rest is the prune of old cache versions; bakes the whole world with names via
   `WorldPlotGenerator`, then azcopy-uploads to `<share>/map/v<new>` and prunes old versions).
   It triggers on a master push touching `ProvincePlotStore.java`, and its guard compares
   `MAP_VERSION` against **the commit the branch was at before the push** — not `HEAD~1`, which
   silently skipped the v9 bake when the bump was pushed alongside later commits (2026-07-16).
   **Verify the run actually baked** rather than assuming: a skip finishes in ~11 s.
   `workflow_dispatch` always bakes, and is the fix if a push ever skips wrongly.

   **Order matters: bake BEFORE rolling the image.** The server serves `v<MAP_VERSION>`; roll a
   bumped image while `map/v<new>` is still empty and prod regenerates every province on demand —
   **without names**.

   `pwsh tools/deploy-plot-cache.ps1` is the local fallback (bakes on the dev box and uploads the
   same way) for when CI is unavailable; CI is the normal path — the point of moving it there was
   to get the whole-world bake off the dev box.

   Skip this step entirely for a pure server-code or web-JS change (generation unchanged).

3. **Deploy the server** — `pwsh tools/deploy-server.ps1` (Docker build → push to
   `ghcr.io/betaphreak/civstudio-server` → `az containerapp update` → poll `/actuator/info`). Picks up new
   engine resources, server code, and the rebaked manifest. Do it **after** the bake (step 2),
   never before: the image serves `v<MAP_VERSION>`, so rolling it while `map/v<new>` is still
   empty makes prod regenerate every province on demand — nameless.

   **That ordering is now enforced, not remembered.** `Assert-PlotCacheBaked` runs before the build:
   it reads `MAP_VERSION` out of `ProvincePlotStore.java` and refuses to roll unless
   `<share>/map/v<N>` exists on the Azure Files share *and* holds a plausible world (≥ 4000
   province files, so an interrupted upload is caught too). It **fails closed**, including when the
   check cannot be determined (no az permission, CLI error) — a credential hiccup blocking a deploy
   is far cheaper than prod regenerating 5268 provinces live. `-SkipCacheCheck` is the documented
   way past, for a deploy that genuinely does not depend on the cache.

   The server reports the same thing from the other side: `ProvincePlotStoreConfigurer` logs
   `PLOT CACHE MISSING` (error) or `PLOT CACHE INCOMPLETE` (warn) at startup. A missing cache is not
   a crash — the store just regenerates on demand — which is exactly why it needs saying out loud:
   the symptom is "the map got slow", minutes after a deploy, with nothing tying it to a bake that
   never ran.
4. **Deploy the web static site** — *only if `web/` (JS, `index.html`, committed assets) changed,
   and normally **automatic**.* `deploy-web.yml` triggers on every master push touching `web/**`:
   it runs the web unit tests (`npm test`) and then ships the prebuilt `web/` folder to SWA. Only
   reach for the manual path (`npx @azure/static-web-apps-cli deploy ./web --env production` with
   the deployment token) if that run failed or CI is unavailable.

5. **Reseed the content store** — *only if the change touched world CONTENT* (anything the
   committed `world-bundle.json.gz` carries: provinces, terrains, techs, buildings, balance…).
   Run the **Seed Studio** workflow, then **`pwsh tools/refresh-content.ps1`**.

   **The seed alone changes nothing anyone can see**, and this is the step that bit hardest
   (2026-07-27). The bundle is cached *twice* on the way out, and both caches are process-scoped:

   - **Strapi** caches the assembled projection **keyed by `contentVersion`**
     (`studio/src/api/world-bundle/services/world-bundle.ts`). A reseed whose *data* changed but
     whose `contentVersion` did not leaves it serving the old bytes — an identical
     `Content-Length` across reseeds is the tell.
   - **civstudio-server** caches the bundle in a static field ("static per deploy" — `WorldBundle`),
     so it re-reads upstream only at boot.

   `refresh-content.ps1` restarts both revisions **in that order** (server-first only makes it
   re-fetch the bytes Strapi is still serving) and then re-runs the world invariants. The Seed
   Studio workflow cannot do this itself — the subscription is reached by a guest identity with no
   CI service principal — so it checks the live world and writes the command into its job summary
   when the caches are still stale.

   > **Bump `meta.contentVersion` whenever bundle data changes.** The version string *is* the cache
   > key, so leaving it untouched makes a data change undetectable by construction. The six-realm
   > split changed every province's `realm` and left it at `seed-2026-07-23`; a clean reseed
   > (5,268 provinces, 0 errors) then changed nothing, and prod served "Cannor: 0 provinces".

**Identity is not health.** Every gate above proves the right *bits* landed — `/actuator/info`
serves the expected commit, the seed wrote the expected rows. None of that says the world is
usable, and on 2026-07-27 all of them passed green while the live map was unreachable.
**`tools/verify-world.mjs`** closes that gap: it reads `/api/bundle` and asserts the world
invariants (`tools/world-invariants.mjs`, unit-tested) — every province names a realm that exists,
no realm the picker offers is empty, the province count clears its floor, realm-less provinces stay
a small minority. `deploy-server.ps1` runs it after the build-identity verify (`-SkipWorldCheck` to
bypass), `refresh-content.ps1` runs it after dropping the caches, and Seed Studio runs it to decide
what to tell you. Run it by hand any time: `node tools/verify-world.mjs https://dev.civstudio.com`.

**…and a usable world may still be the wrong one.** The suites run against the committed snapshot
while production runs against Strapi — two content stores, each internally consistent, never
compared. That is why 501 + 132 + 235 tests were green through the outage: both were right about
their own world. `contentVersion` is now **derived from the content** (`tools/content-hash.cjs`), so
the comparison is a string equality and needs no credentials: the server publishes it on
`/api/bundle`, and **`tools/verify-content-parity.mjs`** hashes the committed snapshot and asks the
server what it serves. `--restamp` fixes the snapshot when *it* is the stale one; `--settle <s>`
polls until two readings agree, which a rolling replica restart otherwise makes look like drift.
**`.github/workflows/verify-prod.yml`** runs both checks every 6 hours and on any push touching them
or the snapshot.

> **`contentVersion` is a cache key, not a label.** Deriving it is what makes "the version travels
> with the content" a fact rather than a convention — you cannot change the content without changing
> the key, so the 2026-07-27 stale-cache failure is no longer expressible. It also strengthens the
> reproducibility stamp: two runs sharing a `contentVersion` genuinely saw the same world.

**Rule of thumb:** a **generation** change → bump `MAP_VERSION` → **CI rebake, then the server
roll** (never a cache delete — see step 2); a plain engine-resource / server-code change → **server
deploy** alone; a `web/` change → **SWA deploy** (automatic); a bundle/terrain change → **rebake the
bundle first, then the server**; a **content** change → **seed, then `refresh-content.ps1`**.

**Custom domain (`dev.civstudio.com`).** `civstudio.com` DNS is **not** in Azure DNS
(no zone in the subscription), so the two validation records are added at the external DNS
provider by hand, then bound:

```bash
# after the app exists, read its verification id and default FQDN:
az containerapp show -n civstudio-server -g civstudio \
  --query "{fqdn:properties.configuration.ingress.fqdn, verify:properties.customDomainVerificationId}" -o json
# add at the DNS provider:  CNAME  dev       -> <fqdn>
#                           TXT    asuid.dev -> <verify>
# then bind + provision a managed cert:
az containerapp hostname add  -n civstudio-server -g civstudio --hostname dev.civstudio.com
az containerapp hostname bind -n civstudio-server -g civstudio --hostname dev.civstudio.com \
  --environment civstudio-managed-env --validation-method CNAME
```

**Notes / limits.**
- **Instance affinity.** A session's state is in one replica's memory, so a spectator must
  reach the replica hosting it — fine at one replica; scaling out later needs sticky routing
  by session id (the Factorio "a game lives on one host" constraint).
- **Memory.** Each session loads its own `WorldMap` (~1 MB) + rasters; 2 GiB comfortably
  holds the demo. Cap/evict idle sessions once many-per-JVM is real (`SessionHost.remove`).
- **Ephemerality.** Sessions and their in-memory command logs don't survive a restart;
  `ServerMain` re-creates the demo session on boot. Durable sessions (persist the command
  log → replay) is Phase C.
- **Cross-origin.** The demo is same-origin (the server serves `live.html`). Wiring the
  SWA-hosted `app.js` to the feed (Phase B) needs CORS headers on the server, or an SWA route
  proxying `/api/*` to the Container App.

## Phase B — the interactive server

Add a client → server command channel and a player action model on top of A's
infrastructure.

**✅ Command channel + first action — taxation (Implemented, 2026-07-10).** The interactive
seam is live end to end: `POST /api/sessions/{id}/commands` with
`{type:"setTaxRate", lever:"bankProfit"|"nobleIncome", rate:0..1}` builds a {@link
SetTaxRateCommand} and `HostedSession.submit`s it; it applies at the deterministic top of the
**next** tick (never retro-mutating the in-flight day), moving the ruler's now-mutable tax
levers (clamped to [0,1], inherited by a successor). The rates ride the render snapshot
(`ColonyView.bankProfitTax`/`nobleIncomeTax`), and `web/live.html` gained a *Policy* panel
(two inputs + Apply) that shows the live rates and posts the command. Covered by
`SetTaxRateCommandTest` (apply/clamp/snapshot) and `FeedServerTest` (the HTTP path). This is
the whole Factorio spine exercised for real: authoritative state = *f*(spec, command log).

**✅ Real map viewer on the live feed (Implemented, 2026-07-10).** The full `web/app.js`
**WorldMap** (real Anbennar terrain) has a **Caravans** overlay (`web/js/overlays/live.mjs`, on
the World/Political/Caravans toggle) that subscribes to the SSE feed and draws the running
session over the terrain: the colony marker + the marching caravans (with trails), placed by the
map's existing `px`/`py` lon-lat projection — the feed already carries every entity's
`latitude`/`longitude`, so no new geometry. A floating HUD shows session state / tick / date /
colony stats and carries the **taxation command**, and the top-bar **clock/play/speed** drive the
*hosted session* over `/control` while the view is active (reflecting the server's state back).
This **replaced** the old recorded-caravan replay entirely: the caravans come live from the
server, so the site's `build.mjs` is now **run-independent** (no `output/<seed>` run,
no baked journeys). Cross-origin is handled by **CORS on `FeedServer`**
(option A): responses carry `Access-Control-Allow-Origin` for the site origin and the JSON POST
is preflighted; the allowed origins default to the production site + localhost, overridable via
`EOS_CORS_ORIGINS`. The base feed URL defaults to `https://dev.civstudio.com` (override with
`?live=<url>` for local testing). Verified headless (`tools/webverify/live-shot.mjs`).

**✅ `window.BUNDLE` served from the server — `data.js` retired (Implemented, 2026-07-10).** The
map/geo backbone the viewer loads at boot (provinces + polygon rings + label baselines, the geo
label tiers, `geoNames`, `adjacencies` — the ~2.2 MB bulk) is no longer a Node-built committed
`web/data.js`; the browser fetches it from **`GET /api/bundle`**, assembled by
`com.civstudio.server.web.WorldBundle` from the same committed map resources
(`provinces.json`/`borders.json`/`adjacencies.json`/the hierarchy) — so the engine is the single
source of truth for that data instead of a snapshot that could drift. The bundle mixes engine
geometry with a handful of **asset-coupled** descriptors the server can't regenerate (the baked
tiles/atlas geometry, `terrainColors`/`seaBands`, the `plots.pack` byte index, the ring-less
provinces' cull boxes): `build.mjs` still bakes the binaries and now emits a small
`src/main/resources/map/web-asset-manifest.json` (on the classpath → inside the jar) that
`WorldBundle` merges in. The endpoint gzips (~2.4 MB → ~0.6 MB) and caches the assembled bundle;
CORS already covers it. `index.html` gained an inline **bootstrap** — resolve the server base
(`?live=<url>` → default `dev.civstudio.com`), fetch the bundle, set `window.BUNDLE`, then
dynamically `import('./app.js')` (needed because `core.mjs` reads the global synchronously at
module-eval time). This makes the map a **hard dependency** on the server: if the fetch fails the
loading splash stays up with a *Maintenance Mode* notice. A golden-parity test
(`WorldBundleGoldenTest`) pins `WorldBundle` byte-for-byte against the last committed `data.js`
(captured gzipped under `src/test/resources/web/`); the `labelBaseline` PCA port reproduces it
exactly (0 pixel drift across 1085 baselines). Deploy ordering: the server (with the endpoint +
manifest, both under `src/`) must ship before a web deploy that expects it. Verified headless
end-to-end (world render + deep-zoom `plots.pack` + the Maintenance Mode path).

Still open on the action side:
- **More actions.** Extend the action model beyond taxation. The natural next targets align
  with project direction: caravan/trade sponsorship (`docs/caravan-trade.md` Phase B). Each
  action is a small, validated, serializable command on the same seam.
- **The command log is the persistence format.** Commands append to a per-session ordered
  log, consumed at a **single deterministic point** in `newDay()` (before agents act, so
  the effect is reproducible). state = *f*(spec, command-log) holds, so the log *is* the
  save file and the replay/spectate stream.
- **Authority + validation.** The server is authoritative; a command is validated against
  session state before it enters the log. Determinism means a spectator can be promoted to
  a replay of any past tick, and a reconnecting client re-derives state from spec + log
  (bounded by snapshot cadence from Phase C).
- **Prerequisite:** colonies that *persist* rather than collapse-by-design — i.e. the
  food/survival calibration flagged in project memory (`docs/food-balance.md`,
  `docs/births.md`). Spectating a doomed colony is fine; *playing* one is not.

## Phase C — persistence, resume, horizontal hosting

- **Snapshotting.** Real serialization of session state so resume/reconnect doesn't replay
  from tick 0. The Phase A snapshot DTO is the starting point; a *full* save additionally
  needs the RNG cursor positions and any state the projection omits.
- **Resume = snapshot + tail of the command log.** Restore nearest snapshot, replay the
  log tail. Determinism guarantees correctness.
- **Multi-node.** Sessions are independent (share only immutable reference data), so
  hosting shards cleanly across nodes by `sessionId` once state is serializable.
- **Per-player session quota — 5 saves + 1 ranked play.** A player may hold **up to five**
  single-player sessions, which function as **save slots**, plus **a single ranked play**. The
  ranked run being singular is the point: five ranked branches you could pick the winner from
  would not be worth ranking. This is what the persistence above is *for* — a save slot is a
  persisted `SessionSpec` + `CommandLog`, not a memory dump, and sessions already carry an owner
  (see `SessionOwnershipTest` and the owner cookie `/control` checks). Still to build: the quota
  itself, slot persistence across restarts, and whatever marks a session ranked and stops it being
  branched or reloaded. Single-player play itself is described in `docs/notifications.md`
  §"This is how single-player works" — you start at the bottom of the `Rank` ladder as an
  adventurer company and climb, seeing one rung either way.

---

## Key decisions still open

- **Snapshot granularity & cadence** — per-tick vs per-in-game-month deltas; how much of
  the colony state the projection carries (drives both wire cost and how much a Phase-C
  save must add).
- **Tick-rate policy** — fixed in-game-days/second, client-adjustable, or catch-up-on-
  join (replay fast to present, then live).
- **Transport & format** — WebSocket + JSON is the low-friction default for the existing
  browser client; a binary framing is a later optimization.
- **Session lifecycle & GC** — when an idle session is evicted, snapshotted, or torn down;
  the eviction policy for many-sessions-per-JVM.
- **Where the command log lives** (Phase B) — in-memory + append-only file per session,
  vs a shared store; ties into the Phase C persistence choice.
