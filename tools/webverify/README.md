# tools/webverify

Headless-browser checks for the `web/` static site, driven through the system
**Edge** (`msedge`) via `playwright-core`. Read-only — it never touches the engine
or the map resources, just loads the page like a visitor would.

## Setup (once)

```bash
cd tools/webverify
npm install          # pulls playwright-core; uses the already-installed system Edge
```

`node_modules/` is gitignored (regenerable via `npm install`).

## Scripts

### `verify.mjs` — screenshot + console-error report
```bash
node verify.mjs <url> <outPng> [waitMs] [w] [h]
# e.g. node verify.mjs http://localhost:8080/index.html shot.png 1600 1400 900
```
Loads a URL, waits for network idle, screenshots it, and prints any console/page
errors. Works against any served page (deep-link with `#p=<id>&z=<zoom>`).

### `mapshot.mjs` — screenshot the map viewport at a province/zoom (no throwaway scripts)
```bash
node mapshot.mjs <provId> [zoom=64] [out=shot.png] [WxH]
# e.g. node mapshot.mjs 412 256 p412.png 380x280
#      node mapshot.mjs 4411 256 --live=https://dev.civstudio.com
```
Serves `web/` over HTTP (with Range), points the page's bundle fetch at a live server via `?live=`
(default `http://localhost:8080`, override with `--live=` or `$LIVE`), deep-links to the province at
the given zoom, waits for the terrain to bake, and screenshots the viewport — optionally a centred
`WxH` crop. Prints console errors plus a province diagnostic (plot count, offscreen `w`/`h`, computed
`tpp`, whether the textured blend is active, snowy-plot count, and per-terrain counts + `LayerOrder`).
Use this to eyeball deep-zoom terrain/blend/feature changes instead of hand-rolling a Playwright
script each time. Needs a bundle server up (local `spring-boot:run`, or the deployed one via `--live=`).

### `realmsplit-verify.mjs` — the six realms, end to end
```bash
node realmsplit-verify.mjs [webBase=http://localhost:3000] [serverBase=http://localhost:8080]
```
Loads each of the six realms (docs/realms.md §The six realms) and asserts it crops to its own baked
background with the right province count and no console errors; then checks the retired `?realm=halcann`
key resolves to Cannor and is rewritten out of the URL, that the Overworld/Underworld toggle is gone,
and that a deep link to Marrhold lands in the Serpentspine. Exits non-zero on any failure, so it works
as a gate. Needs the local stack up (`pwsh tools/dev-local.ps1`).

### `seabed-shot.mjs` — screenshot a shelf (the water-terrain art)
```bash
node seabed-shot.mjs <provId> <zoom> <outPng> [waitMs] [base] [server]
# e.g. node seabed-shot.mjs 1270 26 shelf.png        # Anbenncost — temperate, at "polar" latitude
#      node seabed-shot.mjs 1361 26 tropical.png     # Gulf of Rahen — tropical
```
Same shape as `shot.mjs`, with the two deviations a Live page needs: `waitUntil: 'load'` (the SSE
stream means `networkidle` never fires, which is why `shot.mjs` times out here) and an `Escape` press
to dismiss the lobby. Point it at a **sea** province to fill the frame with shelf. Those two province
IDs are the useful pair: they differ only by climate band, so the water art should visibly differ.

### `verify-pack.mjs` — end-to-end `plots.pack` range-fetch check
```bash
node verify-pack.mjs <webDir> <provId> <outPng>
# e.g. node verify-pack.mjs ../../web 4411 shot.png
```
Serves `<webDir>` over HTTP **with Range support** (mirroring how the deployed
Static Web App serves `plots.pack`), deep-links to `<provId>` at deep zoom, and
reports: how many `plots.pack` requests returned **206**, whether the province's
plots populated (`_plots.length`), the index size, any real-asset 404s, and any
console errors. Use it after `node web/build.mjs` to confirm the per-plot terrain
zoom still resolves through the packed/range-fetched path.
```

### `boot-check.mjs` — server-gated bootstrap / Maintenance Mode check
```bash
node boot-check.mjs <liveBase> [waitMs]
# e.g. node boot-check.mjs http://localhost:8080 9000
```
Serves `web/` over HTTP, loads `index.html?live=<liveBase>`, and reports the boot outcome as
JSON: whether the app booted (`hasBundle`, province count, loading screen cleared) or held the
`Maintenance Mode` splash, plus console errors. Run it with the Spring Boot server **up** (expect
`maintenance:false`, bundle loaded) and **down** (expect `maintenance:true`) to verify the
health-gated bootstrap.

### `district-verify.mjs` — live vs abandoned district-chip tally
```bash
node district-verify.mjs [provId=4411] [zoom=220] [--live=<base>]
```
Checks the district view's core invariant (`docs/urban-plots.md`): the spectated colony lights
exactly as many urban plots as it has districts, and the rest of its core reads abandoned. It hooks
`drawImage` before the app boots and tallies one frame's neighborhood chips by baked variant, so it
observes the real render path rather than re-deriving the rule; the district count is read off the
same snapshot stream the renderer uses, since the demo colony collapses (and sheds districts) as it
ticks. Exits non-zero on a mismatch and writes `district-abandoned.png`. Needs the server **up** with
a live session (`pwsh tools/dev-local.ps1`); the pure ranking behind it is unit-tested in
`web/js/district-plots.test.mjs`.

## Studio admin checks

These drive the **Strapi admin** (`studio/`) rather than `web/`, through the same headless Edge.
They log in via `login.mjs`, which uses the stable local-dev super-admin `studio/src/index.ts` seeds
in development (`dev@local.dev` / `Devpass123!`, override with `STRAPI_ADMIN_EMAIL` /
`STRAPI_ADMIN_PASSWORD`). Start studio first: `cd studio && npm run develop`.

### `sessions-widget-verify.mjs` — the homepage "Live sessions" widget
```bash
node sessions-widget-verify.mjs [strapiBase]
```
Dumps the widget's rendered text and asserts the full session detail reaches the DOM (in-game date,
tick, watching, scenario, seed, realm) rather than the bare id+tick row it showed while its type was
stale. Writes `sessions-widget.png`.

### `sessions-page-verify.mjs` — the Sessions admin page
```bash
node sessions-page-verify.mjs [strapiBase]
```
Asserts the menu link is registered, the list renders live rows, and clicking one routes to
`/admin/civstudio-sessions/<id>`. Writes `sessions-page-list.png` / `sessions-page-detail.png`.

### `sessions-panels-verify.mjs` — the five detail panels
```bash
node sessions-panels-verify.mjs [strapiBase]
```
Clicks each tab (Colony, Court, Bands, Events, Commands) and dumps what it renders, so a panel whose
fetch fails shows up instead of passing quietly as an empty state. Writes one PNG per tab.

**The Commands tab needs a local server** — see below. Against the deployed dev server it reports
`405` (that endpoint postdates the deployment), and that is the correct, honest outcome.

### `sessions-commands-verify.mjs` — the Commands panel's success path
```bash
node sessions-commands-verify.mjs [strapiBase] [gameServer]
# e.g. node sessions-commands-verify.mjs http://localhost:1337 http://localhost:8080
```
The command log is the one **gated** session read, and it lives on an endpoint newer than the
deployed server — so this script does two things at the network layer rather than reconfiguring the
app: it rewrites game-server calls to the local server (fulfilling them itself, since Playwright
cannot rewrite `https`→`http`), and injects the `X-CivStudio-User` dev identity to get past the gate.

Run it against a **local server started with the dev identity trusted**:

```bash
# 1. the engine jar + parent pom must be in ~/.m2 (spring-boot:run resolves them from there)
mvn -o -N install && mvn -o -pl civstudio-engine install -DskipTests

# 2. the server. NOTE the world source: generated/ is no longer committed, so the default
#    `classpath` mode dies on boot with "Terrain resource not found" — boot from the fixture.
mvn -o -pl civstudio-server spring-boot:run -Dspring-boot.run.profiles=default \
  -Dspring-boot.run.arguments="--civstudio.world-source.mode=fixture \
    --civstudio.world-source.fixture=$PWD/civstudio-engine/src/test/resources/world-bundle.json.gz \
    --civstudio.auth.trust-dev-user-header=true --civstudio.auth.admins=dev-admin"

# (pwsh tools/dev-local.ps1 does the same and defaults to the fixture, but does not trust the
#  dev identity header — add --civstudio.auth.* yourself for the gated read.)

# 3. optional: give the log a row to render, then re-run the script
curl -s -X POST -H "X-CivStudio-User: dev-admin" -H "Content-Type: application/json" \
  -d '{"type":"setTaxRate","lever":"BANK_PROFIT","rate":0.25}' \
  http://localhost:8080/api/sessions/caravan-demo-7654321/commands
```

It PASSes only on a real render — an error state or the sign-in gate fails, since seeing the success
path is the whole point. Writes `sessions-panel-commands.png`.

> The site's terrain zoom range-fetches `plots.pack`, which `file://` blocks — so
> always verify through an HTTP server (either script's server, `npx serve web`,
> or `swa start ./web`), never by opening `index.html` off disk.
