import { BUNDLE, MAP, VIEW, cam, ctx, cv, stage, P, provPath, provOnScreen, px, py, pxr, pyr, clampPan, centerOn, sxSrc, sySrc, baseXr, baseYr, fitView, provSrcBox, K_PLOT, K_TEX, K_MAX, isPolitical, isUnderground, cssVar, S, ACTIVE_REALM, LABEL_FONT, switchRealm } from "./core.mjs";
import { bandAlpha, kBand, band, bandName, regime, REGIME_INFO } from "./bands.mjs";
import { drawPlots } from "./plots.mjs";                       // still used directly by drawCavernPlots
import { scheduleLegendRefresh } from "./overlays/political.mjs";
import { ensureTiers } from "./overlays/tiers.mjs";
import { renderLayers, renderScreenLayers } from "./layers.mjs";   // the ordered scene registries (draw order + gating)
import { initSea } from "./sea.mjs";                           // the screen-space ocean base + polar ice
import { initMinimap, drawMinimap } from "./minimap.mjs";
import { currentCaption, scheduleCaptionRefresh, refreshCaptionNow } from "./bandcaption.mjs";   // the chip's viewport-context text
import { escHtml } from "./plotlabel.mjs";
import { draw, setFrame } from "./repaint.mjs";   // the repaint scheduler owns draw(); we install the frame body
import { initPixi, resizePixi, renderPixi, syncCamera } from "./pixi.mjs";   // the second (Pixi) canvas — docs/pixi-migration-plan.md
import { pixiPlotsEnabled, pixiOwnsBackground } from "./pixi-plots.mjs";   // P2 spike flag (?pixiPlots=1)
import { noteFrame } from "./diag.mjs";                        // the top bar's fps readout times real paints
// the baked terrain raster (a real image asset), drawn over the water; its ocean pixels are
// transparent so the sea layer below shows through, land is opaque.
// loading screen: show a random Anbennar splash (1:1, stage-cropped) until the map's first paint,
// then hide immediately (no minimum hold). The splash now doubles as index.html's "waiting for
// the server" screen (its health poll holds it while the server is down), so once the map is
// ready it should clear right away rather than lingering.
const loadEl = document.getElementById("loading");
let loadingActive = false;
if (loadEl) loadingActive = true;              // always manage it so first paint hides it (below)
// (The cycling splash art AND the "Did you know?" tip are driven by the index.html bootstrap so they
// run from page load — the picker phase too — not only after the app module connects.)
// hide on first paint but KEEP the element in the DOM — the title (js/panel.mjs) re-opens its
// server picker as a dismissable overlay, so the markup must survive. Just fade it out.
function hideLoading() {
  if (!loadingActive) return;
  loadingActive = false;
  loadEl.classList.add("gone");   // first paint is ready — clear the splash immediately, no minimum hold
}

const mapImg = new Image();
let mapReady = false;
mapImg.onload = () => { mapReady = true; draw(); hideLoading(); };
mapImg.src = MAP.src;
// realm fog-of-war: a hatch tile (BUNDLE.fow) laid over the VOID beyond the active realm's crop, so
// "off the edge of this map" reads as fogged unknown rather than flat black. Only in a realm, and only
// where there IS void (it vanishes once the map fills the viewport at depth), so it never clutters the
// deep view the way a full-scene hatch did.
const fowImg = new Image();
let fowPat = null;
const _fowTile = BUNDLE.fow && (BUNDLE.fow.PARCHMENT || BUNDLE.fow.HATCH_MED);   // EU4 terra-incognita parchment
if (ACTIVE_REALM && _fowTile) {
  fowImg.onload = () => { fowPat = ctx.createPattern(fowImg, "repeat"); draw(); };
  fowImg.src = _fowTile.src;
}
// The ocean base + polar ice cap used to live here as ~60 lines of hardcoded paint() calls — the
// last draws in the scene that weren't in a registry. They now live in js/sea.mjs and are ordered by
// the SCREEN_LAYERS stack (layers.mjs); initSea wires their async art loads to a repaint.
initSea(draw);
// Boot the #gl renderer (background, never fatal — js/pixi.mjs). When the P2 plot layer is driving,
// Pixi also takes over the VOID FILL: the 2D canvas's opaque `#070a10` covers the whole viewport and
// would otherwise occlude everything on #gl (see initPixi's clear-colour note and paintScene below).
initPixi(pixiPlotsEnabled() ? { backgroundAlpha: 1 } : {});
function resize() {
  const r = stage.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio||1, 2);
  if (!(r.width > 0) || !(r.height > 0)) return;   // ignore degenerate sizes (mid-layout / panel drag)
  cv.width = r.width*dpr; cv.height = r.height*dpr; VIEW.dpr = dpr;
  resizePixi(r.width, r.height, dpr);   // ONE viewport size for both canvases — they must never disagree
  // Preserve the geographic point at the viewport centre AND the on-screen magnification across the
  // resize, so opening/closing/dragging the info panel beside the map (which shrinks/grows the stage)
  // never moves or rescales the world. fitView recomputes the base fit scale from the new size; we
  // then rebind cam.k/x/y to hold the same centre point at the same pixel scale — but only if the
  // result is finite (a transient zero dimension would otherwise poison cam with Infinity/NaN and
  // blank the map).
  const prev = (VIEW.w && VIEW.dw && cam.k) ? {
    fx: ((VIEW.w/2 - cam.x)/cam.k - VIEW.dx)/VIEW.dw,   // normalised map fraction at screen centre
    fy: ((VIEW.h/2 - cam.y)/cam.k - VIEW.dy)/VIEW.dh,
    mag: cam.k * VIEW.dw,                               // on-screen world size (dw/dh scale together)
  } : null;
  fitView(r.width, r.height);
  if (prev && VIEW.dw > 0 && VIEW.dh > 0) {
    const k = Math.max(1, Math.min(K_MAX, prev.mag / VIEW.dw));
    const x = VIEW.w/2 - k*(VIEW.dx + prev.fx*VIEW.dw);
    const y = VIEW.h/2 - k*(VIEW.dy + prev.fy*VIEW.dh);
    if (Number.isFinite(k) && Number.isFinite(x) && Number.isFinite(y)) { cam.k = k; cam.x = x; cam.y = y; }
  }
  clampPan();
  // Repaint SYNCHRONOUSLY, not via the RAF-coalesced draw(): setting cv.width/height above cleared the
  // canvas this frame, so deferring the paint to the next frame leaves the browser compositing a blank
  // canvas — which shows as the map blanking out while the side panel animates its size (the
  // ResizeObserver fires every frame). Painting now fills the freshly-sized canvas in the same frame.
  paint();
}
const regimePulseEl = document.getElementById("regimePulse");
let _sigRegime = null, _sigBand = null, _sigPlane = null, _sigEl = null, _sigCtx = null;
// The top-bar readout shows the current BAND NAME (nearest band) tinted + iconed by the interaction
// REGIME, followed by the live viewport CONTEXT for that band ("Terrain · Sea Tropical" —
// bandcaption.mjs). It doubles as the mode signal: it stamps the regime on #stage (→ the regime
// cursor) and flashes an accent vignette (#regimePulse) once whenever you cross a regime boundary.
// regime() is hysteretic (bands.mjs), so a scroll-tick on a seam can't strobe it. Runs every paint;
// the DOM is rebuilt only when the band/regime/plane/context actually changes.
//
// The context text is READ here, never computed here: currentCaption() is a free getter over a value
// recomputed only once the camera settles (scheduleCaptionRefresh, called from draw()). Computing it
// inline would hit-test P twice per frame.
function updateRegimeSignal() {
  const r = regime(), bn = bandName(), ctxText = currentCaption();
  stage.dataset.regime = r;                        // drives the regime cursor (styles.css) + input awareness
  // the Main Map advisor segment doubles as the zoom-band readout (advisors.mjs builds it as
  // #zoomLevel after this module loads, so resolve it lazily and re-render when it first appears)
  const zoomLabelEl = document.getElementById("zoomLevel");
  if (r === _sigRegime && bn === _sigBand && S.plane === _sigPlane && zoomLabelEl === _sigEl
      && ctxText === _sigCtx) return;
  const info = REGIME_INFO[r];
  if (zoomLabelEl) {
    zoomLabelEl.dataset.regime = r;
    const plane = S.plane === "underworld" ? ` <span class="rg-plane">· Underworld</span>` : "";
    // the caption is external data (province/plot/colony names) — escape it, never interpolate raw
    const ctx = ctxText ? ` <span class="rg-ctx">· ${escHtml(ctxText)}</span>` : "";
    zoomLabelEl.innerHTML = `<span class="rg-ico">${info.icon}</span><span class="rg-name">${bn}</span>${ctx}${plane}`;
    zoomLabelEl.dataset.tip = `${info.name} regime · ${bn} band · ${Math.round(cam.k)}×`
      + (ctxText ? ` — ${ctxText}` : "");
  }
  if (r !== _sigRegime && _sigRegime !== null && regimePulseEl) {   // pulse only on a real crossing, not first paint
    regimePulseEl.dataset.regime = r;
    regimePulseEl.classList.remove("pulsing");
    void regimePulseEl.offsetWidth;                // reflow so the animation restarts on repeat crossings
    regimePulseEl.classList.add("pulsing");
  }
  _sigRegime = r; _sigBand = bn; _sigPlane = S.plane; _sigEl = zoomLabelEl; _sigCtx = ctxText;
}
// What one frame does. The SCHEDULING of frames (coalescing + the fps cap) lives in repaint.mjs,
// which owns draw(); this is only the body it runs. The split is what lets the six modules that want
// nothing but draw() stop importing this one — see repaint.mjs's header.
setFrame(() => {
  paint();
  scheduleLegendRefresh();
  // The viewport-context readouts, recomputed once the camera settles: the band chip's caption
  // (repaint only if its text actually moved) and — via civstudio:viewport — the top-bar advisor
  // segments that name the nation/religion under the crosshair (advisors.mjs). The event is the
  // seam that keeps this module from importing advisors.mjs.
  scheduleCaptionRefresh(changed => {
    if (changed) draw();
    window.dispatchEvent(new Event("civstudio:viewport"));
  });
});
// Time each real paint for the top bar's fps readout (js/diag.mjs). The app renders on demand, so
// this — not a free-running rAF loop — is the only place that knows a frame happened and what it cost.
// The techOpen bail-out is deliberately outside the timing: a suppressed paint is not a fast frame.
function paint() {
  if (S.techOpen || S.cityOpen) return;   // a full-canvas modal is in front — don't spend frames drawing the hidden map
  const t0 = performance.now();
  paintScene();
  noteFrame(performance.now() - t0);
}
function paintScene() {
  // The Pixi camera, first: `world`'s transform IS cam (js/pixi-cam.mjs), so from here on anything
  // added under it is placed in BASE space and needs no per-point camera arithmetic. The 2D path
  // below still does that by hand — the two agree, asserted by tools/webverify/pixi-p1-verify.mjs.
  syncCamera(cam, VIEW);
  updateRegimeSignal();   // top-bar band-name chip + regime cursor + boundary pulse (replaces the raw × readout)
  S.markers = [];   // cave-entrance / teleporter hit-targets, repopulated this frame (hover reads them)
  const w=VIEW.w, h=VIEW.h, dpr=VIEW.dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  // The void beyond the rendered latitude band. OPAQUE — and the first of the four full-area fills that
  // make up the back of this frame, all of which hide anything drawn on #gl beneath it. When Pixi owns
  // the background they all stand down and its clear colour supplies the void instead; see
  // pixi-plots.pixiOwnsBackground for why, and initPixi for the handoff.
  const pixiBack = pixiOwnsBackground();
  if (!pixiBack) { ctx.fillStyle = "#070a10"; ctx.fillRect(0,0,w,h); }

  // clip the whole scene to the imported map's own raster extent — BOTH axes — rather than out to
  // ±89° / the full viewport width. Beyond the mapped land there is no real data, so the polar
  // "arctic" ocean/ice fill was useless, and (once a realm crops smaller than the viewport aspect)
  // the sea would otherwise paint the left/right letterbox void blue. Leave plain dark void there.
  const yTop = cam.y + cam.k * VIEW.dy, yBot = cam.y + cam.k * (VIEW.dy + VIEW.dh);
  const xLeft = cam.x + cam.k * VIEW.dx, xRight = cam.x + cam.k * (VIEW.dx + VIEW.dw);
  ctx.save();
  ctx.beginPath();
  ctx.rect(Math.min(xLeft, xRight), Math.min(yTop, yBot), Math.abs(xRight - xLeft), Math.abs(yBot - yTop));
  ctx.clip();

  // the ocean base behind everything (the land raster's sea is transparent, so this shows through
  // it), then the polar ice cap over the open water. Screen-space, so drawn ONCE here rather than
  // inside the per-world-copy wrap loop below — see js/sea.mjs.
  // …fills 2 and 3 of the back prefix (see the void fill above): the sea base covers the whole
  // viewport and the fog-under covers the whole map region, both opaque.
  if (!pixiBack) {
    renderScreenLayers();
    drawRealmFogUnder();   // parchment between the sea and the land raster → the outer ocean reads as fog
  }

  // one world copy: the map is a finite sheet, not a cylinder, so there is no east-west wrap to tile
  // (docs/realms.md §Delete the wrap). renderScene's own viewport culling and provPath cache do the
  // rest; the camera is clamped to the map edges by clampPan.
  S.viewVersion = S.baseVersion * 16;
  renderScene();
  ctx.restore();
  drawRealmFog();  // hatch the void beyond the realm (screen-space, over the dark fill, under the minimap)
  drawMinimap();   // the bottom-left world thumbnail + viewport rectangle tracks pan/zoom
  // …and the same frame on the Pixi canvas beneath (js/pixi.mjs). Empty as of P0, so this costs a
  // no-op call; it is here now so the two renderers share ONE frame trigger from the outset —
  // repaint.draw() stays the only thing that decides a frame happens.
  renderPixi();
}

// The realm's fog of war: EVERY space not covered by one of the realm's provinces — the outer ocean
// and the void beyond the crop — washed with the hatch tile, so the realm reads as land + its own
// waters in a sea of fog (docs/realms.md §Ocean and fog).
//
// Two cheap passes, and no per-frame province geometry (so no gaps between the simplified rings, and
// nothing to cache):
//  - drawRealmFogUnder runs INSIDE the map clip, between the sea and the land raster: it lays parchment
//    over the whole map region (i.e. over the sea). drawRaster then paints the realm's opaque LAND over
//    it — clearing land pixel-perfectly — while the raster's transparent/soft-alpha ocean lets the
//    parchment show through (the deep-water tint just darkens it). So the outer sea reads as unknown
//    paper with no land bleed. The province borders/labels/portals are drawn AFTER, so they stay on top.
//  - drawRealmFog runs AFTER the scene and fills the VOID beyond the crop (viewport minus the map rect)
//    with the same parchment, so the letterbox is unknown too.
// The fog fades out as you zoom in past the region view: the outer sea is "unknown" at a glance, but
// up close you should see the coastal plots, not paper. Full below K_PLOT, gone by K_TEX.
function realmFogFade() { return Math.max(0, Math.min(1, (K_TEX - cam.k) / (K_TEX - K_PLOT))); }
function _fogFill(a) {
  ctx.globalAlpha = 0.9 * a; ctx.fillStyle = fowPat; ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  ctx.globalAlpha = 0.14 * a; ctx.fillStyle = "#3a2c18"; ctx.fillRect(0, 0, VIEW.w, VIEW.h);   // sepia deepening
  ctx.globalAlpha = 1;
}
function drawRealmFogUnder() {
  const a = fowPat ? realmFogFade() : 0;
  if (a > 0.01) _fogFill(a);   // called inside the map clip, before drawRaster
}
function drawRealmFog() {
  if (!fowPat || realmFogFade() <= 0.01) return;
  const xL = cam.x + cam.k * VIEW.dx, xR = cam.x + cam.k * (VIEW.dx + VIEW.dw);
  const yT = cam.y + cam.k * VIEW.dy, yB = cam.y + cam.k * (VIEW.dy + VIEW.dh);
  const mx = Math.min(xL, xR), my = Math.min(yT, yB), mw = Math.abs(xR - xL), mh = Math.abs(yB - yT);
  if (mx <= 0 && my <= 0 && mx + mw >= VIEW.w && my + mh >= VIEW.h) return;   // map fills the viewport → no void
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, VIEW.w, VIEW.h); ctx.rect(mx, my, mw, mh); ctx.clip("evenodd");
  _fogFill(realmFogFade());
  ctx.restore();
}
// deterministic 0..1 per province id — a stable per-cell jitter (no Math.random, survives redraws)
const pjit = id => ((Math.imul(id | 0, 2654435761) >>> 0) % 1000) / 1000;
// A faint water wash over each SEA province's polygon, its lightness nudged per-province so adjacent
// seas read as distinct cells over the climate gradient (the deep-ocean provinces now ship outlines,
// so the whole ocean tessellates). Kept low-alpha so the gradient still shows through.
function drawSeaCells() {
  ctx.save();
  for (const p of P) {
    if (p.type !== "SEA" || !p.rings || !provOnScreen(p)) continue;
    const j = pjit(p.id);
    ctx.fillStyle = `rgba(${52 + (j * 26 | 0)},${84 + (j * 26 | 0)},${112 + (j * 22 | 0)},0.13)`;
    ctx.fill(provPath(p));
  }
  ctx.restore();
}
// A faint grey wash over each impassable province (its terrain shows through the raster below), so
// wasteland reads as a slightly distinct "you can't settle here" cell — without the busy diagonal
// hatch it used to carry (removed: the hashing over these unused areas read as clutter at deep zoom).
function drawImpassable() {
  ctx.save();
  for (const p of P) {
    if (p.type !== "IMPASSABLE" || !p.rings || !provOnScreen(p)) continue;
    ctx.fillStyle = "rgba(62,64,71,0.22)"; ctx.fill(provPath(p));
  }
  ctx.restore();
}
// ---- per-world-copy scene layers ----
// The old imperative renderScene body is now a set of named layer functions; their draw ORDER and
// gating live in the LAYERS registry (layers.mjs), which renderScene runs. These stay defined here
// because they close over main's raster/camera state and the province-polygon helpers.

// the baked terrain raster, scaled by the camera — the base of every band
function drawRaster() {
  if (!mapReady) return;
  // …fill 4 of the back prefix (see paintScene's void fill): the land raster is opaque over exactly
  // the area the plot layer covers, so it hides the migrated plots. Stand down where the plot layer is
  // at full alpha (no fade in progress), which keeps the flagged view coherent without blanking the
  // zoomed-out map. Flag-only scaffolding; dies when P3 migrates the prefix.
  if (pixiOwnsBackground() && bandAlpha(kBand([K_PLOT, 6.5])) >= 0.999) return;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(mapImg, 0, 0, MAP.dw, MAP.dh,
    cam.x + cam.k * VIEW.dx, cam.y + cam.k * VIEW.dy, cam.k * VIEW.dw, cam.k * VIEW.dh);
}
// freshwater lakes: EU4 paints them with the ocean indices, so the raster leaves them the blue sea
// gradient — tint each lake polygon a distinct green-teal so lakes read as fresh water, not ocean.
function drawLakes() {
  ctx.save(); ctx.fillStyle = "rgba(74,150,128,0.42)";
  for (const p of P) if (p.type === "LAKE" && p.rings && provOnScreen(p)) ctx.fill(provPath(p));
  ctx.restore();
}
// surface plots only — underground provinces are relit by drawUnderworld on the Underworld plane.
// (the `true` opts this call site — and only this one — into the Pixi plot layer when its flag is on;
// docs/pixi-migration-plan.md P2. drawCavernPlots below deliberately does not.)
function drawSurfacePlots() { drawPlots(isSurface, true); }
// province outlines (surface only; underground gets its lit rim from drawUnderworld). They FADE OUT
// below the province zoom so the coarser tier boundaries take over: gone below ~7.5×, full by ~10×.
function drawProvinceBorders() {
  const pbA = bandAlpha(kBand([7.5, 10]));
  if (pbA <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = pbA;
  ctx.strokeStyle = "rgba(190,205,230,.18)"; ctx.lineWidth = 0.8;
  for (const p of P) if (isSurface(p) && p.rings && provOnScreen(p)) ctx.stroke(provPath(p));
  ctx.restore();
}
// selection/hover stroke thins as you dive — a 2px slab reads heavy against a city block; full ≤ band 3
const hlScale = () => 1 - Math.min(0.5, Math.max(0, (band() - 3) / 8));
// hovered province highlight (polygon if we have one, else a centroid ring for seas)
function drawHoverHighlight() {
  if (!S.hoverProv) return;
  const s = hlScale();
  if (S.hoverProv.rings) {
    const hp = provPath(S.hoverProv);
    ctx.fillStyle = "rgba(231,236,244,.12)"; ctx.fill(hp);
    ctx.strokeStyle = "#eef2f8"; ctx.lineWidth = 1.6 * s; ctx.stroke(hp);
  } else {
    ctx.beginPath(); ctx.arc(px(S.hoverProv.lon), py(S.hoverProv.lat), 6, 0, 7);
    ctx.strokeStyle = "#eef2f8"; ctx.lineWidth = 1.4 * s; ctx.stroke();
  }
}
// selected province: a persistent accent outline while its detail fills the sidebar
function drawSelectedHighlight() {
  if (!S.selectedProv) return;
  const s = hlScale();
  if (S.selectedProv.rings) {
    const sp = provPath(S.selectedProv);
    ctx.fillStyle = "rgba(232,183,106,.12)"; ctx.fill(sp);
    ctx.strokeStyle = cssVar("--accent") || "#e8b76a"; ctx.lineWidth = 2.2 * s; ctx.stroke(sp);
  } else {
    ctx.beginPath(); ctx.arc(px(S.selectedProv.lon), py(S.selectedProv.lat), 7, 0, 7);
    ctx.strokeStyle = cssVar("--accent") || "#e8b76a"; ctx.lineWidth = 2 * s; ctx.stroke();
  }
}
// Render one world-copy: lazily pull the tier geometry as we approach its zoom, then paint the
// LAYERS registry in order. The registry (layers.mjs) is the single place to change draw order,
// gating, or band mapping — this function just runs it.
function renderScene() {
  if (cam.k < 10) ensureTiers(draw);   // tier geometry lazy-load (data, not a draw layer)
  renderLayers();
}

// The Underworld plane (docs/underworld.md), folded into the z=−1 layer set (docs/zoom-bands.md
// §Z-levels): each of these is a first-class registry entry gated z:[-1] in layers.mjs, so the
// underground gets the same reorder/regate seam as the surface. Order preserved from the old
// monolithic drawUnderworld: veil → cave floors → per-plot cave terrain → amber rims. Per
// world-copy, the veil is the raster's own rect, so adjacent copies abut (no double-darkening).

// veil this copy's map extent so the surface above recedes to a faint ghost
function drawUnderworldVeil() {
  ctx.save();
  ctx.fillStyle = "rgba(6,5,11,0.72)";
  ctx.fillRect(cam.x + cam.k*VIEW.dx, cam.y + cam.k*VIEW.dy, cam.k*VIEW.dw, cam.k*VIEW.dh);
  ctx.restore();
}
// a warm flat cave floor on every underground polygon — the overview look, and the fallback beneath
// the per-plot layer for provinces whose plots haven't streamed in yet
function drawCavernFloors() {
  ctx.save();
  ctx.fillStyle = "rgba(60,46,40,0.92)";
  for (const p of P) if (isUnderground(p) && p.rings && provOnScreen(p)) ctx.fill(provPath(p));
  ctx.restore();
}
// zoomed in: relight the underground provinces' real per-plot cave terrain over the veil (physical
// view only — the political overlays suppress plots, same as the surface)
function drawCavernPlots() {
  if (cam.k >= K_PLOT && !isPolitical()) drawPlots(isUnderground);
}
// an amber rim on every underground province, at all zooms, so the caves read as lit
function drawCavernRims() {
  ctx.save();
  ctx.strokeStyle = "rgba(230,180,120,0.6)"; ctx.lineWidth = 1.0;
  for (const p of P) if (isUnderground(p) && p.rings && provOnScreen(p)) ctx.stroke(provPath(p));
  ctx.restore();
}
const isSurface = p => !isUnderground(p);

// On the Overworld, underground provinces are hidden — so mark the cave entrances: where a
// surface province borders a hidden underground one (a descent point / gate-hold like Marrhold),
// draw a small amber cave-mouth glyph on their shared border. Lets you see, from the surface,
// that a neighbour lies underground. See docs/underworld.md.
// cave entrance/exit glyph: an outer disc with a dark mouth. The teleporter marker reuses these
// radii at TELEPORT_SCALE× so a portal reads as a much larger version of the same cave-mouth motif.
const CAVE_MOUTH_R = 4.5, CAVE_MOUTH_IN = 1.9, TELEPORT_SCALE = 4;
function drawCaveEntrances() {
  ctx.save();
  for (const p of P) {
    if (isUnderground(p) || !p.nb || !p.rings || !provOnScreen(p)) continue;
    for (const nbId of p.nb) {
      const nb = Pby.get(nbId);
      if (!nb || !isUnderground(nb)) continue;
      // the shared border is ~midway between the two centroids; bias toward the cave side
      const mx = px(p.lon) * 0.45 + px(nb.lon) * 0.55, my = py(p.lat) * 0.45 + py(nb.lat) * 0.55;
      ctx.beginPath(); ctx.arc(mx, my, CAVE_MOUTH_R, 0, 7);
      ctx.fillStyle = "rgba(232,183,106,0.9)"; ctx.fill();
      ctx.beginPath(); ctx.arc(mx, my, CAVE_MOUTH_IN, 0, 7);
      ctx.fillStyle = "rgba(18,10,6,0.92)"; ctx.fill();   // the dark cave mouth
      S.markers.push({ x: mx, y: my, r: CAVE_MOUTH_R + 4,
        label: `<b>Cave entrance</b><br><span class="r">↧ ${nb.name}</span>` });
    }
  }
  ctx.restore();
}

// EU4-style red dotted connection lines for the special adjacencies (straits, canals, lake
// crossings, Dwarovar tunnels) between provinces that are not visually adjacent. Surface
// adjacencies draw on the Overworld; tunnels (an underground endpoint) draw on the Underworld,
// where the caves they link are lit. The dotted line spans each pair's NEAREST coasts (closest
// ring vertices), not their centroids, so a strait touches the two shores it bridges. See docs.
const ADJ_RED = "rgba(224,66,52,0.9)";   // EU4 strait/connection red
const ADJ_MIN_ZOOM = 10;                 // only draw connection lines once zoomed to a region
// closest pair of ring vertices between two provinces, in SOURCE px, cached per pair (camera-
// independent). A brute-force nearest-vertex search over the (simplified) rings; ring-less pairs
// return null and fall back to centroids.
const adjEndsCache = new Map();
function nearestEdgePair(a, b) {
  const key = a.id < b.id ? a.id + "_" + b.id : b.id + "_" + a.id;
  if (adjEndsCache.has(key)) return adjEndsCache.get(key);
  let best = Infinity, ax = 0, ay = 0, bx = 0, by = 0;
  if (a.rings && b.rings)
    for (const ra of a.rings) for (const pa of ra)
      for (const rb of b.rings) for (const pb of rb) {
        const dx = pa[0] - pb[0], dy = pa[1] - pb[1], d = dx * dx + dy * dy;
        if (d < best) { best = d; ax = pa[0]; ay = pa[1]; bx = pb[0]; by = pb[1]; }
      }
  const e = best < Infinity ? { ax, ay, bx, by } : null;
  adjEndsCache.set(key, e);
  return e;
}
function drawAdjacencies() {
  const adj = BUNDLE.adjacencies;
  if (!adj || !adj.length) return;
  const aA = bandAlpha(kBand([ADJ_MIN_ZOOM - 2, ADJ_MIN_ZOOM + 2]));   // fade in around ~10× (was a hard pop)
  if (aA <= 0.01) return;
  const under = S.plane === "underworld";
  ctx.save();
  ctx.globalAlpha = aA;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = ADJ_RED;
  for (const [fromId, toId, , teleport] of adj) {
    const a = Pby.get(fromId), b = Pby.get(toId);
    if (!a || !b) continue;
    const tunnel = isUnderground(a) || isUnderground(b);
    if (under ? !tunnel : tunnel) continue;   // show tunnels only underground, straits only above
    if (teleport) {
      // too far for a sensible line — a teleporter: mark each endpoint instead (cave-entrance style),
      // each labelled with the province it warps to
      teleportMark(px(a.lon), py(a.lat), b.name);
      teleportMark(px(b.lon), py(b.lat), a.name);
      continue;
    }
    // span the two provinces' nearest coasts; centroids only if a ring is missing
    const e = nearestEdgePair(a, b);
    const x1 = e ? pxr(e.ax) : px(a.lon), y1 = e ? pyr(e.ay) : py(a.lat);
    const x2 = e ? pxr(e.bx) : px(b.lon), y2 = e ? pyr(e.by) : py(b.lat);
    if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > VIEW.w
        || Math.max(y1, y2) < 0 || Math.min(y1, y2) > VIEW.h) continue;   // off-screen cull
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}
// a teleporter endpoint marker — the cave-mouth motif at TELEPORT_SCALE× (a large red disc with a
// dark centre), so a portal reads as a much bigger version of an underworld entrance/exit.
function teleportMark(x, y, dest) {
  const R = CAVE_MOUTH_R * TELEPORT_SCALE, m = R + 4;
  if (x < -m || x > VIEW.w + m || y < -m || y > VIEW.h + m) return;
  ctx.beginPath(); ctx.arc(x, y, R, 0, 7);
  ctx.fillStyle = ADJ_RED; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, CAVE_MOUTH_IN * TELEPORT_SCALE, 0, 7);
  ctx.fillStyle = "rgba(18,6,6,0.92)"; ctx.fill();
  if (dest) S.markers.push({ x, y, r: R, label: `<b>Portal</b><br><span class="r">⇄ ${dest}</span>` });
}

// ---- realm arrows: a cross-realm teleporter, promoted to a labelled arrow into the fog ----
// docs/realms.md §The fog must not be mute. With P filtered to the active realm, drawAdjacencies drops
// a cross-realm teleporter (its far endpoint is gone from Pby); we redraw it here as a red arrow at the
// in-realm endpoint, pointing the way to the realm on the other side and naming it — so the fog is a
// signpost, not an absence. Only on a cropped realm; the whole-world view has no "elsewhere" to point
// at. The click that actually crosses realms is Phase 5 (this is the marker, not yet the affordance).
const provAllById = BUNDLE.realms ? new Map(BUNDLE.provinces.map(p => [p.id, p])) : null;
const realmNameOf = key => (BUNDLE.geoNames && BUNDLE.geoNames.realm && BUNDLE.geoNames.realm[key]) || key;

function drawRealmArrows() {
  if (!ACTIVE_REALM || !provAllById) return;
  const adj = BUNDLE.adjacencies;
  if (!adj || !adj.length) return;
  // group cross-realm teleporters by their in-realm endpoint, averaging the direction to the far side —
  // Domancadh has six portals to Halcann, so on Aelantir they collapse to one arrow, not six.
  const arrows = new Map();
  for (const [fromId, toId, , teleport] of adj) {
    if (!teleport) continue;
    const pf = provAllById.get(fromId), pt = provAllById.get(toId);
    if (!pf || !pt) continue;
    let near, far;
    if (pf.realm === ACTIVE_REALM && pt.realm && pt.realm !== ACTIVE_REALM) { near = pf; far = pt; }
    else if (pt.realm === ACTIVE_REALM && pf.realm && pf.realm !== ACTIVE_REALM) { near = pt; far = pf; }
    else continue;   // both in this realm (the 86 Deepwoods rows) — not a crossing
    let a = arrows.get(near.id);
    if (!a) { a = { p: near, otherRealm: far.realm, farId: far.id, fx: 0, fy: 0, n: 0 }; arrows.set(near.id, a); }
    a.fx += px(far.lon); a.fy += py(far.lat); a.n++;   // far endpoint projects off-crop → a direction
  }
  if (!arrows.size) return;
  ctx.save();
  ctx.font = "700 12px " + LABEL_FONT;   // set once, for measureText and the labels
  const placed = [];                      // label rects already drawn — de-clutters the Deepwoods cluster
  for (const a of arrows.values()) {
    const ox = px(a.p.lon), oy = py(a.p.lat);
    if (ox < -40 || ox > VIEW.w + 40 || oy < -40 || oy > VIEW.h + 40) continue;
    let dx = a.fx / a.n - ox, dy = a.fy / a.n - oy;
    const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    const label = "to " + realmNameOf(a.otherRealm);
    // every crossing gets an arrow, but a label only if it clears the ones already placed — so the six
    // clustered Deepwoods portals read as one "to Aelantir" at world zoom, separating as you zoom in.
    const lx0 = ox + dx * 22, ly0 = oy + dy * 22, w = ctx.measureText(label).width;   // label sits past the glyph
    const rx = dx >= 0 ? lx0 : lx0 - w;
    const rect = { x0: rx, y0: ly0 - 8, x1: rx + w, y1: ly0 + 8 };
    const show = !placed.some(r => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0);
    if (show) placed.push(rect);
    drawRealmPortal(ox, oy, dx, dy, show ? label : null);
    // a click target over the portal glyph — maptip.mjs turns a hit into switchRealm(otherRealm, far
    // portal), so clicking crosses and lands on the far end (docs/realms.md §The fog... one switch-realm
    // action). `realm`/`prov` mark it; `label` gives the hover affordance.
    S.markers.push({ x: ox, y: oy, r: 16,
      label: `<b>⇄ Cross to ${realmNameOf(a.otherRealm)}</b>`, realm: a.otherRealm, prov: a.farId });
  }
  ctx.restore();
}

// The crossing to another realm is a FEY PORTAL, not a military arrow — so it reads as gladeway magic:
// a soft teal glyph at the in-realm endpoint (a glowing ring with a dark eye), a chevron nodding toward
// the fog it opens into, and an optional teal label. ctx.font is set by the caller (drawRealmArrows).
const PORTAL_R = 8;
function drawRealmPortal(ox, oy, dx, dy, label) {
  const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, PORTAL_R * 2.4);
  glow.addColorStop(0, "rgba(120,236,214,0.5)");
  glow.addColorStop(0.55, "rgba(90,200,186,0.18)");
  glow.addColorStop(1, "rgba(90,200,186,0)");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(ox, oy, PORTAL_R * 2.4, 0, 7); ctx.fill();
  ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#7cf0dc";
  ctx.beginPath(); ctx.arc(ox, oy, PORTAL_R, 0, 7); ctx.stroke();                       // the portal ring
  ctx.fillStyle = "rgba(10,20,22,0.9)"; ctx.beginPath(); ctx.arc(ox, oy, PORTAL_R * 0.45, 0, 7); ctx.fill();
  // a chevron just outside the ring, nodding the way to the other realm
  const cx = ox + dx * (PORTAL_R + 7), cy = oy + dy * (PORTAL_R + 7), nx = -dy, ny = dx, s = 5;
  ctx.beginPath();
  ctx.moveTo(cx - dx * s + nx * s, cy - dy * s + ny * s);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx - dx * s - nx * s, cy - dy * s - ny * s);
  ctx.stroke();
  if (!label) return;
  ctx.textAlign = dx >= 0 ? "left" : "right"; ctx.textBaseline = "middle";
  const lx = cx + dx * 7, ly = cy + dy * 7;
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(6,12,14,0.92)"; ctx.strokeText(label, lx, ly);
  ctx.fillStyle = "#a6f7e6"; ctx.fillText(label, lx, ly);
}

// place province name labels over the map with a halo, skipping any that would
// overflow the stage or collide with one already placed (priority: origin first,
// then destinations, then the largest context provinces).
function zoomAt(mx, my, factor) {
  const k2 = Math.max(1, Math.min(K_MAX, cam.k * factor));   // deep enough to read individual plots
  if (k2 === cam.k) return;
  const f = k2 / cam.k;
  cam.x = mx - f * (mx - cam.x);     // keep the point under (mx,my) fixed
  cam.y = my - f * (my - cam.y);
  cam.k = k2;
  clampPan(); S.baseVersion++; draw();
}
// ---- deep link: index.html#p=<provinceId>&z=<zoom> focuses a province at a zoom ----
const Pby = new Map(P.map(p => [p.id, p]));
function focusProvince(id, k) {
  const p = Pby.get(id); if (!p) return;
  centerOn(baseXr(sxSrc(p.lon)), baseYr(sySrc(p.lat)), k || 18);
  draw();
}
// Zoom so the WHOLE province fits the viewport (double-click), centred on its bounding box:
// pick the scale that fits the box's screen extent within a margin, clamped to the zoom range,
// and centre on the box centre. Falls back to a fixed zoom when the province has no polygon.
function focusProvinceFit(id) {
  const p = Pby.get(id); if (!p) return;
  const box = provSrcBox(p);
  if (!box) return focusProvince(id, 40);                               // ring-less province: a deep fixed zoom
  const m = 0.9;                                                         // fill most of the canvas, a sliver of air
  const wSrc = Math.max(1, (box.x1 - box.x0) / (MAP.x1 - MAP.x0) * VIEW.dw);   // province width in base screen px
  const hSrc = Math.max(1, (box.y1 - box.y0) / (MAP.y1 - MAP.y0) * VIEW.dh);
  centerOn(baseXr((box.x0 + box.x1) / 2), baseYr((box.y0 + box.y1) / 2),
    Math.min(VIEW.w * m / wSrc, VIEW.h * m / hSrc));
  draw();
}
// Deep link: focus a province from the URL. Accepts a QUERY string (?p=<id>&z=<zoom> — the
// production/shareable form; on Azure SWA the navigationFallback rewrites /worldmap → index.html
// so the pretty path works too) OR the #p=<id>&z=<zoom> hash (back-compat). The query wins when
// both are present. z is optional (defaults to a deep texture zoom).
function readDeepLink() {
  const qs = new URLSearchParams(location.search);
  let p = qs.get("p"), z = qs.get("z");
  if (p == null) { const m = /(?:^|[#&])p=(\d+)/.exec(location.hash); if (m) p = m[1]; }
  if (z == null) { const m = /(?:^|[#&])z=(\d+(?:\.\d+)?)/.exec(location.hash); if (m) z = m[1]; }
  return { p: p == null || p === "" ? null : +p, z: z == null || z === "" ? null : +z };
}
function hasDeepLink() { return readDeepLink().p != null; }
function applyHash() {
  const { p, z } = readDeepLink();
  if (p == null || Number.isNaN(p)) return;
  // a deep link to another realm's province auto-switches the realm under it (docs/realms.md §Deep
  // links need a realm) — otherwise focusProvince silently misses, since the province isn't in this
  // realm's P. The reload lands here again with the realms matching, so it doesn't loop.
  const dp = provAllById && provAllById.get(p);
  if (dp && dp.realm && dp.realm !== ACTIVE_REALM && BUNDLE.realms && BUNDLE.realms[dp.realm]) {
    switchRealm(dp.realm, { province: p, zoom: z });
    return;
  }
  if (z != null && !Number.isNaN(z)) focusProvince(p, z);   // explicit ?z= → that exact zoom
  else focusProvinceFit(p);                                 // no zoom given → frame the whole province, centred
}
window.addEventListener("hashchange", applyHash);
window.addEventListener("popstate", applyHash);   // browser back/forward between deep links
initMinimap(draw);   // bottom-left minimap; drawMinimap() (called from paint) keeps it in sync
// The Terrain/Locale/Plot captions need a province's plots, which stream in AFTER the camera settles
// — so the debounced refresh has already run and parked a provisional "Surveying…" string by the
// time the data exists. Recompute when plots land (plots.mjs announces it), and repaint only if the
// text actually changed. refreshCaptionNow bypasses the debounce: this is already an arrival event,
// not a movement burst.
window.addEventListener("civstudio:plots", () => { if (refreshCaptionNow()) draw(); });
// Canvas text does not trigger webfont loading the way laid-out DOM text does, so the first
// paint would use the sans fallback until some later redraw. Explicitly fetch the bundled
// map-label faces (see core.LABEL_FONT / styles.css) and redraw once they are ready. Guarded
// for browsers without the Font Loading API (they just keep the CSS fallback).
if (typeof document !== "undefined" && document.fonts && document.fonts.load) {
  Promise.all([
    document.fonts.load('400 16px "Jost"'),
    document.fonts.load('700 16px "Jost"'),
  ]).then(() => draw()).catch(() => {});
}

export { zoomAt, resize, focusProvince, focusProvinceFit, applyHash, hasDeepLink };
// scene-layer draw fns, consumed by the LAYERS registry in layers.mjs (they stay here because they
// close over main's raster/camera state and the Pby/hatch helpers)
export { drawRaster, drawLakes, drawSeaCells, drawImpassable, drawSurfacePlots,
         drawProvinceBorders, drawUnderworldVeil, drawCavernFloors, drawCavernPlots, drawCavernRims,
         drawCaveEntrances, drawAdjacencies, drawRealmArrows,
         drawHoverHighlight, drawSelectedHighlight };
