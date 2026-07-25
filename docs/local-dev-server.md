# Local dev server — one command, fully offline

**Status:** built (2026-07-14).

Run the whole stack locally — the Spring Boot server **and** the real `web/` map site, opened in
your browser — with a single command, and **with no internet connection**. This exists for local
debugging (including automated agent testing): iterate on the map against a live local server
without a manual `npx serve` step or any network round-trip.

## Run it

```powershell
pwsh tools/dev-local.ps1
```

That's it. It installs a fresh engine jar, starts the server offline, and — once the server is
**fully started** — serves `web/` and opens `http://localhost:3000/?live=http://localhost:8080` in
the URL logged for you to open (nothing opens itself — starting a server should not seize the screen).

Equivalently, the plain Maven command does the frontend part on its own — but it needs the world
source spelled out, which is the main thing the script adds beyond the engine-jar refresh and the
offline flag (see [World data](#world-data-the-fixture-not-the-classpath) below):

```powershell
mvn -o -pl civstudio-server spring-boot:run `
  "-Dspring-boot.run.arguments=--civstudio.world-source.mode=fixture --civstudio.world-source.fixture=civstudio-engine/src/test/resources/world-bundle.json.gz"
```

Useful flags:

```powershell
pwsh tools/dev-local.ps1 -WebPort 4000          # serve the site on :4000
pwsh tools/dev-local.ps1 -SkipEngineBuild       # engine unchanged since last install (faster)
pwsh tools/dev-local.ps1 -Online                # let Maven reach the network
```

Stop everything with `Ctrl-C` in the terminal — the node frontend is a child of the server JVM and
is torn down on shutdown.

## Running a dev tool: `tools/run.ps1`

`mvn exec:exec` **cannot pass program arguments** — `civstudio-engine/pom.xml` hardcodes the JVM
argument list and it ends at `${sim.main}`, so a tool that takes arguments has no way in. The
workaround was `mvn dependency:build-classpath` plus a hand-written `java` invocation with the
world-source flags, every time. `tools/run.ps1` is that, as one command: it compiles, resolves and
**caches** the classpath (rebuilt only when a pom is newer), and passes the same world-source flags
and `-ea` that `exec:exec` does.

```powershell
pwsh tools/run.ps1 TerrainPreviewExporter lencenor_region out.png 3   # short name → geo.export
pwsh tools/run.ps1 WorldPlotGenerator western_cannor_superregion      # bake ONE region
pwsh tools/run.ps1 -Heap 6g com.civstudio.geo.export.WorldPlotGenerator
```

## Looking at a generation change locally

Two tools, in increasing fidelity:

- **`TerrainPreviewExporter <region> <out.png> [scale]`** — renders a whole region's generated plot
  field straight to a PNG and prints the terrain mix, the **seam score** (cross-border vs interior
  terrain-change ratio; 1.0 = seamless) and the border relief/vegetation ratios. Seconds, no server,
  no cache. This is how the province-seam bug was found and measured — a discontinuity at a border
  is obvious in a region render and invisible in a single-province test.
- **`WorldPlotGenerator <region>`** — bakes just that region into the local `.map/v<MAP_VERSION>`,
  so `dev-local.ps1` serves it in the **real viewer** immediately. A scoped bake is byte-identical
  to those provinces in a full-world bake (generation is a pure function of world position and the
  province's own canonical stream), so it is a prefix of the same work, not an approximation — it
  just skips the whole-world place-naming pass, leaving those plots nameless.

Both take an area / region / super-region `raw_key` (`venail_area`, `lencenor_region`,
`western_cannor_superregion`); `WorldPlotGenerator` also takes a comma-separated province-id list.
See `docs/plot-generator.md`.

## World data: the fixture, not the classpath

`generated/` is **no longer committed** — studio is the authoritative content store (see
[`docs/architecture.md`](architecture.md) §Where world data comes from). So the engine's default
`classpath` world source has nothing to read, and a plain `spring-boot:run` dies on boot with:

```
java.lang.IllegalStateException: Terrain resource not found: /terrains.json
```

This is not a broken checkout; it is the de-vendoring working as designed. Local runs therefore boot
from the **committed world-bundle fixture** — the same snapshot `mvn test` uses, and the only copy of
the world in the repo:

```
civstudio-engine/src/test/resources/world-bundle.json.gz
```

`tools/dev-local.ps1` defaults to it and fails early with the regeneration command if it is missing.
Override with `-WorldSource`:

```powershell
pwsh tools/dev-local.ps1                                   # fixture (default)
pwsh tools/dev-local.ps1 -WorldSource strapi               # a studio you are running locally
pwsh tools/dev-local.ps1 -WorldSource strapi -WorldSourceUrl https://civstudio.com/api/world-bundle `
                         -WorldSourceToken $env:WORLD_BUNDLE_TOKEN
```

Refresh the fixture against a seeded studio with `node tools/make-world-bundle.mjs`.

> The fixture is a **test** resource being used by a dev run. That is deliberate — it is the one
> committed world bundle — but it means a stale fixture shows up as a stale local world, not as a
> test failure.

## Exercising the gated endpoints

Most session reads are public, but a few are not (the command log is owner-or-admin), and signing in
with Steam locally is not practical. `-TrustDevUser` makes the server trust the `X-CivStudio-User`
header so you can act as an admin:

```powershell
pwsh tools/dev-local.ps1 -TrustDevUser                     # grants admin to "dev-admin"
curl -H "X-CivStudio-User: dev-admin" http://localhost:8080/api/sessions/caravan-demo-7654321/commands
```

Dev-only by construction: the header is ignored unless `civstudio.auth.trust-dev-user-header` is on.

## How it works

- **`web/dev-server.mjs`** — a zero-dependency Node static server for `web/` (no `npx serve`, so no
  network). Correct MIME types, `no-cache` for edit-reload, and HTTP **byte-range** support. Prints
  `DEV-SERVER-READY …` on its listen callback.
- **`DevFrontendLauncher`** (`server.dev`, `@Profile("dev")`) — on `ApplicationReadyEvent` (i.e.
  after the context is up **and** `DemoSessionSeeder` has founded the demo) it spawns
  `node web/dev-server.mjs`, waits for the ready line, then logs the site URL at
  `…/?live=http://localhost:<server port>`. The node process is destroyed on shutdown.
- **The `dev` profile** is activated for `spring-boot:run` only, via the `spring-boot-maven-plugin`
  `<profiles>` config in `civstudio-server/pom.xml` — so it never ships in the packaged production
  jar. Per-run overrides: `-Dcivstudio.dev.frontend.enabled=false`,
  `-Dcivstudio.dev.frontend.web-port=…`.

## Auto-restart on code change (DevTools)

`spring-boot-devtools` is a dev-scoped (`optional`) dependency of `civstudio-server`. While a
`spring-boot:run` server is running, DevTools watches this module's **compiled classes** and
hot-restarts the app context in place whenever they change — so recompiling the server module (an
IDE auto-build, or a plain `mvn -pl civstudio-server compile` from another terminal) bounces the
running server automatically, and `/mcp` + the SSE feed come right back on `:8080` with no manual
stop/start. You'll see the restart happen on the `restartedMain` thread in the log.

**Scope — server module only.** DevTools reloads only classes on its *restart* classloader (this
module's `target/classes`). The **engine** is a base-classloader jar, so **engine edits are not
picked up by a hot restart** — those still need `mvn -pl civstudio-engine install` plus a full
server restart (kill the `:8080` JVM first — `spring-boot:run` leaves a lingering listener).

`optional=true` keeps DevTools off downstream classpaths, and Boot excludes it from the repackaged
fat jar, so the production deploy is unaffected.

## Why offline works

- **Maven** runs with `-o`, so every dependency comes from `~/.m2` (nothing is fetched).
- **The engine** resolves its Anbennar/Civ4 mod sources from the local caches — the
  `.anbennar-cache` / `.civ4-cache` junctions to local clones (see `CLAUDE.md` §Local source
  caches). Founding the demo colony and generating its plot field therefore need no network.
- **The frontend** is a plain static folder served by the dependency-free node server; the browser
  fetches `window.BUNDLE` and `/api/*` from the local server, all same-machine.

The one prerequisite: the caches must be warm (the junctions present). A cold `~/.m2` or missing
junction needs a single online run first.

## Related

- [`client-server.md`](client-server.md) — the server this launches (SSE feed, `/api/bundle`, plot
  serving).
- [`web/README.md`](../web/README.md) — the site being served.
- [`plot-serving.md`](plot-serving.md) — per-province plot grids (`/api/plots/{id}`, the
  `.map/v<MAP_VERSION>` cache). Note the sim's own persisted fields are versioned the same
  way now — `map/provinces/v<MAP_VERSION>/` — so a generation bump keeps both in sync (see
  [`province-plots.md`](province-plots.md)).
