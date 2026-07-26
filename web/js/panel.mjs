"use strict";
// panel.mjs — what is LEFT after the split: the mode toggles (plane / overlay) that drive
// everything else, the province search, the brand/home button, a shared spinner, the theme hook,
// and boot(). The eight jobs it used to hold now live beside it: clock.mjs (the transport),
// input.mjs (map gestures), maptip.mjs (hover + picking), btntip.mjs (button tooltips) and
// rail.mjs (the sidebar). 690 -> ~240 lines.
//
// It still re-exports their entry points, because shortcuts.mjs, techtree.mjs, plotfetch.mjs and
// advisor-detail.mjs already import them from here — the split cost no caller a change.
import { P, VIEW, stage, px, provGeo, isPolitical, S, ACTIVE_REALM } from "./core.mjs";
import { draw } from "./repaint.mjs";
import { bindOverlaySetter } from "./bands.mjs";
import { resize, focusProvinceFit, applyHash } from "./main.mjs";
import { renderPolLegend, focusEntity, coverage, overlayEntity, ensurePolitical, politicalReady } from "./overlays/political.mjs";
import { startLive, liveToBackground, liveColony } from "./overlays/live.mjs";
import { createSearchBox } from "./searchbox.mjs";
import { techBuildingMatches, searchRowHtml, pickSearchResult } from "./techtree.mjs";
// the top bar's transport (date/play/speed) — its own module now; panel only wires it to the
// overlay switch and re-exports the two entry points the shortcuts/tech-tree already import
import { togglePlay, syncLiveTransport, showClock, resetSpeed } from "./clock.mjs";
// map gestures (wheel/drag/pinch, zoom buttons, reset, fullscreen) — their own module now. panel
// re-exports resetView/toggleFullscreen for shortcuts.mjs, and asks consumePanMoved() whether a
// click was really the end of a drag.
import { resetView, toggleFullscreen } from "./input.mjs";
// the sidebar; panel drives it from the mode toggles and re-exports its entry points
import { showRail, renderRail, selectProvince, railOpen } from "./rail.mjs";
// imported for their side effects: each wires its own listeners at module eval
import "./maptip.mjs";
import "./btntip.mjs";

// the app shell — panel sets --bar-total on it from the top bar's height (the rail owns its own DOM)
const appEl = document.querySelector(".app");
// The title acts as "home": reset to the world view and open the SPECTATOR LOBBY over the live map
// (docs/spectator-lobby.md) — Esc or a click outside returns to the map. The lobby is where you now
// land, because "what is running, and what do I want to play" is the question home actually asks;
// choosing a SERVER is the rarer act, and lives on the picker the lobby links to (window.__picker,
// exposed by index.html's boot flow). Falls back to the picker, then to a reload, if the lobby
// module is unavailable (defensive; it always is after boot).
const brandEl = document.getElementById("brand");
if (brandEl) {
  const home = () => {
    resetView();
    if (window.__lobby && window.__lobby.open) window.__lobby.open();
    else if (window.__picker && window.__picker.open) window.__picker.open();
    else location.href = location.pathname;
  };
  brandEl.onclick = home;
  brandEl.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); home(); } };
}
document.addEventListener("fullscreenchange", resize);
// The global keyboard shortcuts (pan / zoom / reset / fullscreen / play / Escape) are
// dispatched centrally by js/shortcuts.mjs, which calls the actions exported below.
// ---- a small reusable spinner for secondary async loads ----
const spinnerEl=document.getElementById("spinner");
function showSpinner(text){ if(!spinnerEl) return; spinnerEl.querySelector(".sp-txt").textContent = text||"Loading…"; spinnerEl.hidden=false; }
function hideSpinner(){ if(spinnerEl) spinnerEl.hidden=true; }

// (the movement-cost dev overlay toggle + its legend were removed from the UI; S.showCost stays
//  false, so the cost layer stays dormant.)

// (setPlane and the Overworld/Underworld toggle are gone. The Serpentspine is a realm, reached
//  through the realm selector or by clicking a cave mouth — docs/realms.md §The Serpentspine was
//  never a plane.)

// the overlay (None / Nation / Culture / Faith / Caravans) — one at a time over the map.
// "Caravans" is the live server view (S.overlay === "live"): the running colony + its caravans.
//
// `keepSelection` is for the one caller that is not a user choosing an overlay: the band spine
// releasing political on the way into the 3D terrain (bands.syncOverlayToZoom). Clearing the
// selection is right when someone PICKS a different overlay — each one has its own overview to start
// from — but zooming in is not picking, and slamming the rail shut on the province you just zoomed
// into is the opposite of what the zoom asked for.
function setOverlay(ov, { keepSelection = false } = {}){
  const was = S.overlay;
  const live = ov === "live";
  S.overlay = ov;
  // repaint every overlay button (data-ov) wherever it lives — the Foreign advisor's sub-control
  // strip carries the Nation/Culture buttons now (see advisors.mjs), not the old #overlayToggle
  document.querySelectorAll("[data-ov]").forEach(b=> b.setAttribute("aria-pressed", b.dataset.ov===ov));
  const pol = isPolitical();
  S.polHi = null;
  // the clock/play/speed only mean something in the live Caravans view — show them there, drive
  // the hosted session (togglePlay/onSpeed); connect/disconnect the SSE feed on enter/leave.
  showClock(live);
  // leaving the live overlay keeps the SSE feed alive in the background (its HUD/dots/clock go away)
  // so the advisor roster stays live in every advisor; only a server switch / full reset stops it
  if (was === "live" && !live) liveToBackground();
  if (live) { resetSpeed(); startLive(draw, syncLiveTransport); }
  if (!keepSelection) { S.selectedProv = null; showRail(false); }   // start each overlay on its own overview
  updateSearchContext();                            // the search box searches provinces / nations / cultures / faiths
  if (pol) {
    if (!politicalReady()) showSpinner("Loading political data…");  // the lazy political.js fetch
    ensurePolitical().then(() => { hideSpinner(); renderPolLegend(); renderRail(); draw(); })
      .catch(() => hideSpinner());
  } else {
    renderPolLegend();                              // not political → hide the political legend
  }
  renderRail(); draw();
}
// ---- theme toggle (button retired; wire only if present — the site defaults to dark) ----
const themeBtn=document.getElementById("themeBtn");
if(themeBtn) themeBtn.onclick=()=>{
  const cur=document.documentElement.getAttribute("data-theme")
    || (matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
  document.documentElement.setAttribute("data-theme", cur==="dark"?"light":"dark");
  draw(); if(S.selected!==null) renderRail();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", ()=>{ draw(); });
// ---- province search (by name or id → zoom to it) ----
const searchInput = document.getElementById("search");
const searchResults = document.getElementById("searchResults");
const searchClear = document.getElementById("searchClear");
function goToProvince(p) {
  focusProvinceFit(p.id);         // frame the whole province (centred, filling most of the canvas)
  selectProvince(p);              // and open its detail panel
}
// Esc / close button: collapse the sidebar and drop any selection. The camera stays put — closing
// the panel never moves or rezooms the map (selecting/deselecting is decoupled from the camera).
// Returns true if it actually did something (so the caller can swallow the key).
function closePanel() {
  const acted = railOpen() || S.selectedProv || S.selected != null;
  S.selectedProv = null; S.selected = null;
  showRail(false); renderRail(); draw();
  return !!acted;
}
document.getElementById("railClose").onclick = closePanel;
// the top-bar search: provinces by name/id, or — in a political overlay — nations / cultures /
// faiths. Behaviour (keyboard nav, dropdown, clear, blur) lives in the shared searchbox widget;
// here we supply just the query, the row markup and what a pick does.
const provinceSearch = createSearchBox({
  input: searchInput, results: searchResults, clear: searchClear,
  search(q) {
    if (S.advisor === "technology")                     // §4a: the Technology advisor searches techs + buildings
      return techBuildingMatches(q);
    q = q.toLowerCase();
    const ent = overlayEntity();
    if (ent) {                                          // nations / cultures / religions
      if (!Object.keys(ent.table).length) return [];    // political layer still loading (see renderEmpty)
      const cov = coverage(), scored = [];
      for (const [key, e] of Object.entries(ent.table)) {
        const name = e.name.toLowerCase(); let score = -1;
        if (name === q) score = 90; else if (name.startsWith(q)) score = 70; else if (name.includes(q)) score = 40;
        if (score >= 0) scored.push({ kind: ent.kind, key, name: e.name, color: e.color, n: cov.get(key) || 0, score });
      }
      scored.sort((a, b) => b.score - a.score || b.n - a.n || a.name.localeCompare(b.name));
      return scored.slice(0, 12);
    }
    const isNum = /^\d+$/.test(q), scored = [];        // province search (by name or id)
    for (const p of P) {
      if (p.type !== "LAND") continue;
      let score = -1;
      if (isNum) { const ids = String(p.id); if (ids === q) score = 100; else if (ids.startsWith(q)) score = 55; }
      if (score < 0) { const name = p.name.toLowerCase(); if (name === q) score = 90; else if (name.startsWith(q)) score = 70; else if (name.includes(q)) score = 40; }
      if (score >= 0) scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score || b.p.plots - a.p.plots || a.p.name.localeCompare(b.p.name));
    return scored.slice(0, 12).map(s => ({ kind: "province", p: s.p }));
  },
  renderRow(m, i, active) {
    if (m.kind === "tech" || m.kind === "building" || m.kind === "unit") return searchRowHtml(m, i, active);
    const act = active ? " active" : "";
    if (m.kind === "province") {
      const reg = (provGeo(m.p).region || [])[0] || "";
      return `<div class="search-row${act}" role="option" data-i="${i}">
        <span class="sr-name">${m.p.name}</span><span class="sr-id">#${m.p.id}</span>
        <span class="sr-meta">${reg}</span></div>`;
    }
    return `<div class="search-row${act}" role="option" data-i="${i}">
      <span class="sw" style="background:${m.color}"></span><span class="sr-name">${m.name}</span>
      <span class="sr-meta">${m.n} prov</span></div>`;
  },
  onPick(m) {
    if (m.kind === "tech" || m.kind === "building" || m.kind === "unit") { pickSearchResult(m); return; }  // §4a
    if (m.kind === "province") goToProvince(m.p);
    else focusEntity(m.key);                           // zoom to the polity's largest province + spotlight it
  },
  renderEmpty() {
    const ent = overlayEntity();
    if (ent && !Object.keys(ent.table).length) return `<div class="search-empty">Loading…</div>`;
    return `<div class="search-empty">No matches.</div>`;
  },
  // first Esc collapses the panel / returns the camera; otherwise clear the box and blur
  onEscape(e, api) {
    if (closePanel()) { e.preventDefault(); return; }
    api.reset(); searchInput.blur();
  },
});
function updateSearchContext() {
  searchInput.placeholder = S.advisor === "technology" ? "Find a tech or building…"
    : (overlayEntity() || {}).ph || "Find a province…";
  provinceSearch.refresh();
}
// ---- camera POV toggle (God / Timeline) ----
// the camera POV is always God today (Timeline is a future mode); the old #povToggle group was
// retired with the advisor-selector restructure, so this is a guarded no-op kept for boot()/parity.
const povToggle = document.getElementById("povToggle");
function setPov(pov){
  S.pov = pov;
  if (povToggle) povToggle.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.pov === pov));
  draw();
}
if (povToggle) povToggle.querySelectorAll("button").forEach(b =>
  b.addEventListener("click", () => { if (!b.disabled) setPov(b.dataset.pov); }));

// (The mobile hamburger drawer + phone bar-reshuffle were removed — one content-width top bar now
// serves both landscape and portrait; see styles.css.)

// ---- overlay toggles ----
document.querySelectorAll("#overlayToggle button").forEach(b =>
  b.addEventListener("click", () => setOverlay(b.dataset.ov)));
// (the top bar's [data-tip] buttons are wired by btntip.mjs, alongside the map controls)

export { resetView, toggleFullscreen, togglePlay, closePanel, setOverlay, updateSearchContext };

export function boot() {
  // Hand the band spine the overlay setter, so zooming past band 5 can set the political overlay
  // aside for the 3D terrain and put it back on the way out (bands.syncOverlayToZoom). Injected
  // rather than imported: bands.mjs is a leaf that everything drawing depends on, and importing this
  // module from it would close a cycle through main.mjs.
  bindOverlaySetter(setOverlay);
  // Keep a selected province's inline live-colony block current: it reads the snapshot, so it has to
  // repaint when a new one lands or it freezes at whatever was true when you clicked. Only for the
  // colony's own province — every other selection renders no colony block, so re-rendering its rail
  // on every tick would be pure churn.
  window.addEventListener("civstudio:snapshot", () => {
    const c = liveColony();
    if (c && S.selectedProv && c.provinceId === S.selectedProv.id) renderRail();
  });
  // Refit the canvas whenever the stage's box changes — window resize, fullscreen, AND the panel
  // opening/closing or being drag-resized (all of which shrink/grow the stage). One observer covers
  // every case, including live tracking during the width transition. (Replaces the window resize
  // listener; fullscreenchange still calls resize directly above as a belt-and-braces.)
  new ResizeObserver(() => resize()).observe(stage);
  // track the floating top bar's height in --bar-total so the Technology tree starts just below it
  // (the bar wraps its sub-control strip to a second line when it doesn't fit — §4)
  const topbar = document.querySelector(".topbar");
  if (topbar) {
    const setBarH = () => appEl.style.setProperty("--bar-total", topbar.offsetHeight + "px");
    new ResizeObserver(setBarH).observe(topbar); setBarH();
  }
  resize();
  // floating controls over the map (zoom buttons, cost key, political legend) must not fall through
  // to the stage's pan/zoom/pick handlers — the same guard the minimap and live HUD/log bar use.
  document.querySelectorAll(".zoomctl, #costKey, #polLegend, #brand").forEach(elm =>
    ["pointerdown", "mousedown", "click", "touchstart", "wheel"].forEach(t =>
      elm.addEventListener(t, e => e.stopPropagation(), { passive: true })));
  setPov(S.pov);              // paints the camera-POV toggle (default: God)
  setOverlay(S.overlay);      // paints the overlay chrome/rail (default: none → the plain map)
  // apply the ?p=/#p= deep link AFTER first layout — focusProvince needs a sized VIEW, so calling
  // it inline at boot (before the stage has laid out) silently no-ops
  requestAnimationFrame(() => requestAnimationFrame(applyHash));
}
