"use strict";
// Political overlay — the map render for the Nation/Culture/Faith overlays: province polygons
// coloured by the active dimension (core.polOf / S.overlay), zoom-banded so the map yields to the
// physical terrain as you dive in, plus the legend/search spotlight. The chrome (legend, entity
// search, sidebar Politics block) lives in panel.mjs; this module owns only the canvas render.
import { ctx, cam, P, provPath, provOnScreen, polOf, isPolitical, COUNTRIES, CULTURES, RELIGIONS, K_PLOT, K_TEX, lerp, VIEW, provSrcBox, pxr, pyr, LABEL_FONT, S } from "../core.mjs";
import { draw } from "../repaint.mjs";
import { loadArt } from "../plotcanvas.mjs";
import { focusProvinceFit } from "../main.mjs";
import { bandAlpha, kBand } from "../bands.mjs";

// "#rrggbb" + alpha -> an rgba() string, memoised (the nation/culture/faith fills)
const _rgbaCache = {};
export function hexA(hex, a) {
  const key = hex + "|" + a.toFixed(3);
  return _rgbaCache[key] || (_rgbaCache[key] =
    `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a.toFixed(3)})`);
}

// Draw the active political overlay. Called by main.renderScene only while isPolitical() is true.
// Below K_PLOT it is a full-opacity overview; through K_PLOT→K_TEX the fill fades as the terrain
// plots appear; past K_TEX only coloured borders remain (plus the hovered province), letting the
// per-plot terrain read underneath. A province with no value for the dimension never fills.
export function drawPolitical() {
  // Political overlays no longer fade to reveal per-plot terrain (main.renderScene suppresses plots
  // under them), so the fill stays readable at EVERY zoom — a gentle taper past K_PLOT keeps some
  // terrain context — and crisp coloured borders are added once zoomed in for province legibility.
  const a = cam.k < K_PLOT ? 0.58 : lerp(0.52, 0.42, bandAlpha(kBand([K_PLOT, K_TEX])));
  for (const p of P) if (p.rings && provOnScreen(p)) {
    const e = polOf(p).e;
    if (e) { ctx.fillStyle = hexA(e.color, a); ctx.fill(provPath(p)); }
  }
  if (cam.k >= K_PLOT) {
    ctx.lineWidth = 1.4;
    for (const p of P) if (p.rings && provOnScreen(p)) {
      const e = polOf(p).e;
      if (e) { ctx.strokeStyle = hexA(e.color, 0.9); ctx.stroke(provPath(p)); }
    }
  }
  // spotlight one polity (hovered in the legend / picked from search): brighten its provinces
  if (S.polHi) {
    ctx.save(); ctx.lineWidth = 2;
    for (const p of P) if (p.rings && provOnScreen(p) && polOf(p).key === S.polHi) {
      ctx.fillStyle = "rgba(255,255,255,.16)"; ctx.fill(provPath(p));
      ctx.strokeStyle = "#fff"; ctx.stroke(provPath(p));
    }
    ctx.restore();
  }
  drawCountryLabels();
}

// ---- country flags (window.FLAGS, baked by build-flags.mjs): the Nations-legend chips and the
// on-map country labels. The atlas image loads lazily on the first political draw; an absent FLAGS
// (404 → feature off) or a not-yet-loaded image simply draws no flag. ----
const FLAGS = window.FLAGS || null;
let flagImg = null, flagReady = false;
function flagAtlas() {
  if (!FLAGS) return null;
  if (!flagImg) flagImg = loadArt(FLAGS, () => { flagReady = true; });
  return flagReady ? flagImg : null;
}

// Inline CSS background-sprite for one flag cell at D px — the legend chip. "" when the tag has no
// flag or the atlas is absent (falls back to the colour swatch alone).
function flagChipHtml(tag, D = 18) {
  if (!FLAGS || FLAGS.index[tag] === undefined) return "";
  const i = FLAGS.index[tag];
  const sheetW = FLAGS.cols * D, sheetH = Math.ceil(FLAGS.count / FLAGS.cols) * D;
  const x = -(i % FLAGS.cols) * D, y = -Math.floor(i / FLAGS.cols) * D;
  return `<span class="flagchip" style="width:${D}px;height:${D}px;`
    + `background-image:url(${FLAGS.src});background-size:${sheetW}px ${sheetH}px;`
    + `background-position:${x}px ${y}px"></span>`;
}

// Per-country label anchor: the bbox-area-weighted centroid of the country's owned provinces (source
// px), built once (ownership is static, and `P` is fixed to the active realm for the page's life).
// Area-weighting sits the label over the country's bulk rather than the midpoint of a sprawling
// exclave pair.
let _anchors = null;
function countryAnchors() {
  if (_anchors) return _anchors;
  const acc = new Map();
  for (const p of P) {
    if (!p.owner) continue;
    const box = provSrcBox(p);
    if (!box) continue;
    const area = Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0));
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const a = acc.get(p.owner) || { sx: 0, sy: 0, area: 0 };
    a.sx += cx * area; a.sy += cy * area; a.area += area;
    acc.set(p.owner, a);
  }
  const map = new Map();
  for (const [tag, a] of acc) map.set(tag, { sx: a.sx / a.area, sy: a.sy / a.area, area: a.area });
  _anchors = map;
  return map;
}

// On-map country labels for the Nations overlay: a flag chip + name at each country's anchor. Shown
// only in the overview (below K_PLOT, where the fills read as territory rather than terrain), fading
// out as you zoom toward plot detail, and greedily de-collided — biggest countries claim the space
// first — so the map never drowns in labels. Nation overlay only (cultures/faiths have no flag).
const LBL_FLAG_PX = 16, LBL_FONT_PX = 12, LBL_GAP = 5, LBL_PAD = 3, LBL_MAX = 140;
function drawCountryLabels() {
  if (S.overlay !== "nation") return;
  const img = flagAtlas();
  if (!img) return;
  const alpha = Math.max(0, Math.min(1, (K_PLOT - cam.k) / (K_PLOT * 0.4)));
  if (alpha <= 0.01) return;

  const cand = [];
  for (const [tag, a] of countryAnchors()) {
    const e = COUNTRIES[tag];
    if (!e || FLAGS.index[tag] === undefined) continue;
    const x = pxr(a.sx), y = pyr(a.sy);
    if (x < -80 || x > VIEW.w + 80 || y < -40 || y > VIEW.h + 40) continue;
    cand.push({ tag, name: e.name, x, y, area: a.area });
  }
  cand.sort((p, q) => q.area - p.area);   // largest nations win the collision space

  ctx.save();
  ctx.font = `600 ${LBL_FONT_PX}px ${LABEL_FONT}`;
  ctx.textBaseline = "middle";
  ctx.globalAlpha = alpha;
  const placed = [];
  for (const c of cand) {
    if (placed.length >= LBL_MAX) break;
    const w = LBL_FLAG_PX + LBL_GAP + ctx.measureText(c.name).width;
    const h = Math.max(LBL_FLAG_PX, LBL_FONT_PX);
    const x0 = c.x - w / 2, y0 = c.y - h / 2, x1 = x0 + w, y1 = y0 + h;
    if (placed.some(r => x0 < r.x1 + LBL_PAD && x1 > r.x0 - LBL_PAD && y0 < r.y1 + LBL_PAD && y1 > r.y0 - LBL_PAD))
      continue;
    placed.push({ x0, y0, x1, y1 });
    const i = FLAGS.index[c.tag];
    const sx = (i % FLAGS.cols) * FLAGS.cell, sy = Math.floor(i / FLAGS.cols) * FLAGS.cell;
    const fx = x0, fy = c.y - LBL_FLAG_PX / 2;
    ctx.drawImage(img, sx, sy, FLAGS.cell, FLAGS.cell, fx, fy, LBL_FLAG_PX, LBL_FLAG_PX);
    ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = 1;
    ctx.strokeRect(fx + 0.5, fy + 0.5, LBL_FLAG_PX - 1, LBL_FLAG_PX - 1);
    const tx = fx + LBL_FLAG_PX + LBL_GAP;
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.strokeText(c.name, tx, c.y);
    ctx.fillStyle = "#fff"; ctx.fillText(c.name, tx, c.y);
  }
  ctx.restore();
}

// ---- political chrome: legend, entity search, sidebar block, and the lazy political.js loader.
// The panel (panel.mjs) orchestrates when these run (setOverlay/search/provinceRail); this module
// owns the political UI itself. draw/focusProvinceFit come from main.mjs (hoisted — the main<->overlay
// import cycle is safe). ----
const polLegend = document.getElementById("polLegend");

// per-overlay province coverage counts (key -> #provinces), cached until the overlay changes;
// shared by the legend and the entity search so neither rescans P on every keystroke. `P` is the
// active realm's provinces, so the ledger is already this map's polities and nobody else's.
let _cov = { overlay: null, map: null };
export function coverage() {
  if (_cov.overlay === S.overlay && _cov.map) return _cov.map;
  const m = new Map();
  for (const p of P) { const k = polOf(p).key; if (k) m.set(k, (m.get(k) || 0) + 1); }
  _cov = { overlay: S.overlay, map: m };
  return m;
}
const polTable = () => S.overlay === "culture" ? CULTURES : S.overlay === "faith" ? RELIGIONS : COUNTRIES;

// whether a province's polygon is at least partly on-screen right now (its source-pixel bbox,
// projected through the camera, intersects the viewport). One world copy — no east-west wrap now the
// map is a finite sheet (docs/realms.md §Delete the wrap).
function inViewport(p) {
  const box = provSrcBox(p);
  if (!box) return false;
  const x0 = pxr(box.x0), x1 = pxr(box.x1), y0 = pyr(box.y0), y1 = pyr(box.y1);
  const sy0 = Math.min(y0, y1), sy1 = Math.max(y0, y1);
  if (sy1 < 0 || sy0 > VIEW.h) return false;
  const sx0 = Math.min(x0, x1), sx1 = Math.max(x0, x1);
  return sx1 >= 0 && sx0 <= VIEW.w;
}

// province coverage counts restricted to the current viewport (the ledger lists only what's visible)
function viewportCoverage() {
  const m = new Map();
  for (const p of P) { const k = polOf(p).key; if (k && inViewport(p)) m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

// rebuild the legend a beat after the camera settles (called from main.draw on every paint); the
// timer resets while panning so the (DOM-heavy) rebuild runs once movement stops. Gated on
// baseVersion: the ledger's rows depend only on the VIEWPORT (which polities are visible), so a
// redraw that didn't move the camera — e.g. spotlighting a row on hover — must NOT rebuild the DOM.
// Rebuilding under the cursor re-fires the row's mouseleave/mouseenter, which draw()s again, which
// would reschedule this — the runaway redraw loop this guard breaks.
let legendTimer = 0, legendVersion = -1;
export function scheduleLegendRefresh() {
  if (!isPolitical() || polLegend.hidden) return;
  if (S.baseVersion === legendVersion) return;   // viewport unchanged since the last build → nothing to redo
  clearTimeout(legendTimer);
  legendTimer = setTimeout(renderPolLegend, 140);
}

// collapsed state persists across re-renders; defaults collapsed on small screens (a docked bottom
// sheet there) so the polity list doesn't cover the map — expand it by tapping the header
let legendCollapsed = null;

// the coverage-ranked (province count, descending), scrollable, collapsible legend
// (Nations/Cultures/Religions); hides when not political
export function renderPolLegend() {
  if (!isPolitical()) { polLegend.hidden = true; return; }
  legendVersion = S.baseVersion;                        // the legend now reflects this viewport (see scheduleLegendRefresh)
  const table = polTable();
  // the ledger LISTS the polities visible in the viewport, but the count shown per row is each
  // polity's TOTAL province count across the whole map (coverage()), not just the visible tally —
  // so a nation you've zoomed in on still reads its true size, not "1 of the 50 it owns".
  const vis = viewportCoverage(), total = coverage();
  const rows = [...vis.keys()].filter(k => table[k])
    .map(k => [k, total.get(k) || 0])
    .sort((a, b) => b[1] - a[1] || table[a[0]].name.localeCompare(table[b[0]].name));
  const title = S.overlay === "culture" ? "Cultures" : S.overlay === "faith" ? "Religions" : "Nations";
  if (legendCollapsed === null) legendCollapsed = matchMedia("(max-width: 640px)").matches;
  let html = `<button class="lg-h lg-toggle" aria-expanded="${!legendCollapsed}">${title} · ${rows.length}<span class="lg-caret" aria-hidden="true">▾</span></button><div class="leg-scroll">`;
  for (const [k, n] of rows) { const e = table[k];
    const flag = S.overlay === "nation" ? flagChipHtml(k) : "";
    html += `<button class="legrow" data-key="${k}"><span class="sw" style="background:${e.color}"></span>${flag}<span class="leg-nm">${e.name}</span><span class="km">${n}</span></button>`;
  }
  polLegend.innerHTML = html + `</div>`;
  polLegend.hidden = false;
  polLegend.classList.toggle("collapsed", legendCollapsed);
  const toggle = polLegend.querySelector(".lg-toggle");
  toggle.addEventListener("click", () => {
    legendCollapsed = !legendCollapsed;
    polLegend.classList.toggle("collapsed", legendCollapsed);
    toggle.setAttribute("aria-expanded", !legendCollapsed);
  });
  polLegend.querySelectorAll(".legrow").forEach(b => {
    b.addEventListener("mouseenter", () => { S.polHi = b.dataset.key; draw(); });
    b.addEventListener("mouseleave", () => { if (S.polHi === b.dataset.key) { S.polHi = null; draw(); } });
    b.addEventListener("click", () => focusEntity(b.dataset.key));
  });
}

// frame a polity: focus its largest province and keep it spotlighted
export function focusEntity(key) {
  let best = null; for (const p of P) if (polOf(p).key === key && p.rings && (!best || p.plots > best.plots)) best = p;
  S.polHi = key;
  if (best) { S.camBeforeFocus = { ...cam }; focusProvinceFit(best.id); }
  draw();
}

// the entity-search context for the active overlay (or null → the province search), used by panel.search
export function overlayEntity() {
  if (S.overlay === "nation")  return { table: COUNTRIES, kind: "nation",  ph: "Find a nation…" };
  if (S.overlay === "culture") return { table: CULTURES,  kind: "culture", ph: "Find a culture…" };
  if (S.overlay === "faith")   return { table: RELIGIONS, kind: "faith",   ph: "Find a religion…" };
  return null;
}

// the political metagrid (nation / culture / faith) for a province's detail panel; empty for an
// unowned province (sea, uncolonized wasteland)
export function politicsBlock(p) {
  const owner = p.owner && COUNTRIES[p.owner];
  const cult = p.culture && CULTURES[p.culture];
  const relig = p.religion && RELIGIONS[p.religion];
  if (!owner && !cult && !relig) return "";
  const dot = c => `<span class="dot" style="background:${c.color}"></span>`;
  const cell = (k, v) => `<div class="metacell"><div class="k">${k}</div><div class="v" style="font-size:13px">${v}</div></div>`;
  return `<p class="sectlabel" style="margin-top:12px">Politics</p>
    <div class="metagrid">
      ${owner ? cell("Nation", `${dot(owner)}${owner.name}`) : cell("Nation", "Unclaimed")}
      ${cult ? cell("Culture", `${dot(cult)}${cult.name}`) : ""}
      ${relig ? cell("Faith", `${dot(relig)}${relig.name}`) : ""}
    </div>`;
}

// the political layer (owner/culture/religion + the country/culture/religion tables) lives in a
// separate web/political.js, fetched only the first time a political overlay is entered — so World
// and Caravan never download it. Once loaded it enriches the province objects in place, so the
// sidebar's nation/culture/faith detail then works in every overlay too.
let politicalLoaded = false, politicalLoading = null;
export function politicalReady() { return politicalLoaded; }
export function ensurePolitical() {
  if (politicalLoaded) return Promise.resolve();
  if (politicalLoading) return politicalLoading;
  politicalLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "political.js";
    s.onload = () => { applyPolitical(window.POLITICAL || {}); politicalLoaded = true; resolve(); };
    s.onerror = () => { politicalLoading = null; reject(new Error("failed to load political.js")); };
    document.head.appendChild(s);
  });
  return politicalLoading;
}
function applyPolitical(POL) {
  Object.assign(COUNTRIES, POL.countries || {});
  Object.assign(CULTURES, POL.cultures || {});
  Object.assign(RELIGIONS, POL.religions || {});
  const byId = new Map(P.map(p => [p.id, p]));
  for (const r of (POL.provinces || [])) {
    const p = byId.get(r.id); if (!p) continue;
    p.owner = r.o; p.controller = r.ct || r.o; p.culture = r.c; p.religion = r.r;
  }
  _cov = { overlay: null, map: null };   // province keys just changed — invalidate the coverage cache
  _anchors = null;                       // ...and the label anchors, which are built from p.owner
}
