"use strict";
// The RAIL: the right sidebar. It answers "tell me about this place" — the world overview when
// nothing is selected, a province's full terrain/politics breakdown when one is, a city's when
// that province is a city — plus the panel's own chrome (open/collapse, the drag-resize handle).
//
// The last and largest seam out of panel.mjs (see clock.mjs's header): ~220 lines of the 690 it
// started at. It depends outward only — core/plots/politics — and nothing here imports panel, so
// the panel<->techtree and panel<->plotfetch cycles go with it. panel keeps setOverlay
// (the mode toggles that DRIVE the rail) and re-exports renderRail/showRail/selectProvince, which
// plotfetch.mjs, techtree.mjs and advisor-detail.mjs already import from it.
import { P, provGeo, terrainRgb, TRADE_GOODS, S, isPolitical } from "./core.mjs";
import { draw } from "./repaint.mjs";
import { loadPlots } from "./plotfetch.mjs";
import { politicsBlock, ensurePolitical, politicalReady } from "./overlays/political.mjs";
import { fillLore } from "./lore.mjs";
import { liveColony } from "./overlays/live.mjs";
import { prettyKey } from "./plotlabel.mjs";
import { selectionUrl } from "./deeplink.mjs";

// ---- rail ----
const rail=document.getElementById("rail");
const railwrap=document.getElementById("railwrap");
const appEl=document.querySelector(".app");
// open/collapse the right sidebar. `.rail-open` on .app pushes the stage's right edge in so the map
// RESIZES to fit beside the panel (styles.css) instead of being covered; the ResizeObserver below
// refits the canvas as it animates.
function showRail(open){ railwrap.classList.toggle("open", !!open); appEl.classList.toggle("rail-open", !!open); }

// --- user-resizable panel width: drag the .rail-resize handle on the panel's left edge. The map
// (the stage) shrinks/grows with it live; the chosen width persists across sessions. ---
(function initRailResize(){
  const handle=document.getElementById("railResize");
  if(!handle) return;
  const MIN=300, MAX=680;
  const saved=parseInt(localStorage.getItem("railWidth")||"",10);
  if(saved>=MIN && saved<=MAX) appEl.style.setProperty("--rail-w", saved+"px");
  let startX=0, startW=0;
  function onMove(e){
    const w=Math.max(MIN, Math.min(MAX, startW + (startX - e.clientX)));   // drag left → wider
    appEl.style.setProperty("--rail-w", w+"px");
  }
  function onUp(){
    appEl.classList.remove("rail-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    localStorage.setItem("railWidth", String(Math.round(railwrap.getBoundingClientRect().width)));
  }
  handle.addEventListener("pointerdown", e=>{
    e.preventDefault();
    startX=e.clientX; startW=railwrap.getBoundingClientRect().width;
    appEl.classList.add("rail-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
})();
function worldRail(){
  return `<div class="runmeta">
    <div class="rm-title serif" style="font-size:16px">WorldMap</div>
    <div class="rm-sub">Anbennar · the whole world, real Civ4 terrain</div>
    <div class="metagrid">
      <div class="metacell"><div class="k">Land provinces</div><div class="v">${P.length}</div></div>
      <div class="metacell"><div class="k">Zoom</div><div class="v" style="font-size:15px">to the plot</div></div>
    </div></div>
    <p class="footnote">The full world, rendered from the engine's real terrain. Drag to pan, scroll to zoom — keep zooming past the continent view to resolve any province into its terrain plot by plot (textures, hillshade from the heightmap, rivers, features). Hover the map to read a province. Switch to <b>Caravans</b> to watch the live server session — the colony and its marching bands — in real time.</p>`;
}

// ---- province detail: the full-information sidebar for a selected province ----
// aggregate a province's per-plot data into a terrain breakdown once its plots are loaded
function provinceStats(plots) {
  const terr = {}, feat = {}, res = {};
  let flat=0, hill=0, peak=0, rivers=0, eMin=255, eMax=0, eSum=0;
  for (const q of plots) {
    terr[q.terrain] = (terr[q.terrain]||0) + 1;
    if (q.plotType==="HILL") hill++; else if (q.plotType==="PEAK") peak++; else flat++;
    if (q.river) rivers++;
    if (q.feature) feat[q.feature] = (feat[q.feature]||0) + 1;
    if (q.bonus) res[q.bonus] = (res[q.bonus]||0) + 1;
    const e = q.elevation|0; if (e<eMin) eMin=e; if (e>eMax) eMax=e; eSum+=e;
  }
  const desc = o => Object.entries(o).sort((a,b)=> b[1]-a[1]);
  return { n:plots.length, terr:desc(terr), feat:desc(feat), res:desc(res), flat, hill, peak,
    rivers, eMin: plots.length?eMin:0, eMax, eMean: plots.length?Math.round(eSum/plots.length):0 };
}
// prettify a Civ4 TERRAIN_/FEATURE_/BONUS_ id (or a bare key like "mild"): strip prefix, Title Case
function prettyId(s) {
  return String(s).replace(/^(TERRAIN|FEATURE|BONUS)_/,"").toLowerCase().replace(/_/g," ")
    .replace(/\b\w/g, c=>c.toUpperCase());
}
function selectProvince(p) {
  S.selectedProv = p;
  if (p && !p._plots) loadPlots(p);   // stream in the server-generated terrain for the breakdown
  showRail(!!p);                     // selecting opens the info panel; deselecting collapses it
  renderRail(); draw();
  writeSelectionToUrl(p);
}
/**
 * Mirror the selection into ?p= so what you are looking at is always a shareable link
 * (docs/studio-control-plane-plan.md §D3). Until now only switchRealm and the lobby wrote the query
 * string, so selecting a province — the most common thing anyone does here — left the URL stale and
 * a "look at this" link impossible to produce without hand-editing it.
 *
 * replaceState, not pushState: clicking through provinces is browsing, not navigation, and pushing
 * would make Back walk every glance instead of leaving the map. `z` is deliberately NOT written —
 * zoom changes continuously, and capturing whatever it happened to be at click time would be
 * arbitrary; without it a reload frames the whole province (focusProvinceFit), which is the useful
 * landing. The rest of the query (realm, session, live) is preserved by mutating the current URL.
 */
function writeSelectionToUrl(p) {
  try {
    const next = selectionUrl(location.href, p);
    if (next !== location.href) history.replaceState(history.state, "", next);
  } catch { /* no history API (file://) — selection still works, it just isn't linkable */ }
}
function provinceRail(p) {
  const g = provGeo(p);
  // each tier is [displayName, rawClausewitzKey]; show the key in parentheses after the name
  const crumbs = [g.continent, g.superRegion, g.region, g.area].filter(t => t && t[0])
    .map(t=>`<span>${t[0]}${t[1]?` <span class="pv-key">(${t[1]})</span>`:''}</span>`)
    .join('<span class="crumb-sep">›</span>');
  // In a political overlay the rail is a POLITICAL panel (owner/culture/faith + lore) — the physical
  // terrain/plots/elevation breakdown below belongs to the World/physical view, not here.
  if (isPolitical()) { renderPoliticalRail(p, crumbs); return; }
  const coord = `${Math.abs(p.lat).toFixed(2)}°${p.lat>=0?"N":"S"}, ${Math.abs(p.lon).toFixed(2)}°${p.lon>=0?"E":"W"}`;
  let terrainHtml;
  if (p._plots && p._plots.length) {
    const s = provinceStats(p._plots);
    const bars = s.terr.map(([k,n])=>{
      const pct = Math.round(n/s.n*100), c = terrainRgb(k);
      return `<div class="pv-bar-row"><span class="pv-bar-lab" title="${prettyId(k)}">${prettyId(k)}</span>
        <span class="pv-bar"><i style="width:${pct}%;background:rgb(${c[0]},${c[1]},${c[2]})"></i></span>
        <span class="pv-bar-val">${pct}%</span></div>`;
    }).join("");
    const chips = o => o.length ? o.map(([k,n])=>`<span class="pv-chip">${prettyId(k)}<b>${n}</b></span>`).join("") : '<span class="pv-none">—</span>';
    terrainHtml = `
      <p class="sectlabel">Terrain · ${s.n} plots</p>
      <div class="pv-bars">${bars}</div>
      <div class="statrow" style="margin-top:10px">
        <div class="stat"><div class="k">Flat</div><div class="v">${s.flat}</div></div>
        <div class="stat"><div class="k">Hill</div><div class="v">${s.hill}</div></div>
        <div class="stat"><div class="k">Peak</div><div class="v">${s.peak}</div></div>
      </div>
      <div class="statrow" style="margin-top:8px">
        <div class="stat"><div class="k">Elevation</div><div class="v">${s.eMin}–${s.eMax}<small style="font-size:11px;color:var(--ink-soft)"> µ${s.eMean}</small></div></div>
        <div class="stat"><div class="k">River plots</div><div class="v">${s.rivers}</div></div>
      </div>
      <p class="sectlabel" style="margin-top:14px">Features</p>
      <div class="pv-chips">${chips(s.feat)}</div>
      <p class="sectlabel" style="margin-top:12px">Resources</p>
      <div class="pv-chips">${chips(s.res)}</div>`;
  } else if (p._plots) {   // loaded but empty (deep ocean with no shelf)
    terrainHtml = `<p class="footnote">No per-plot terrain for this province.</p>`;
  } else {
    terrainHtml = `<p class="footnote">Loading terrain…</p>`;
  }
  rail.innerHTML = `
    <button class="backbtn" id="backProv">← Back</button>
    <div class="detail">
      <div class="d-head"><h2 class="serif">${p.name}</h2></div>
      <div class="rm-sub" style="color:var(--ink-soft);margin-top:-6px"><span class="r">${p.type.toLowerCase()}</span> · province ${p.id}</div>
      ${crumbs ? `<div class="pv-crumbs">${crumbs}</div>` : ""}
      <div class="statrow" style="margin-top:12px">
        ${p.type==="SEA"||p.type==="LAKE"
          ? `<div class="stat"><div class="k">Water area</div><div class="v">${p.plots}</div></div>
             <div class="stat"><div class="k">Shelf plots</div><div class="v">${p._plots?p._plots.length:"—"}</div></div>`
          : `<div class="stat"><div class="k">Land plots</div><div class="v">${p.plots}</div></div>
             <div class="stat"><div class="k">Water plots</div><div class="v">${p.waterPlots||0}</div></div>`}
        <div class="stat"><div class="k">Neighbours</div><div class="v">${(p.nb||[]).length}</div></div>
      </div>
      <div class="metagrid" style="margin-top:8px">
        <div class="metacell"><div class="k">Coordinates</div><div class="v" style="font-size:13px">${coord}</div></div>
        <div class="metacell"><div class="k">Winter</div><div class="v" style="font-size:13px">${p.winter?prettyId(p.winter):"—"}</div></div>
      </div>
      ${politicsBlock(p)}
      ${colonyBlock(p)}
      ${terrainHtml}
    </div>`;
  document.getElementById("backProv").onclick = ()=>{ S.selectedProv=null; showRail(false); renderRail(); draw(); };
}
// The Political-view province rail (P4): political info + the lore for the ACTIVE overlay dimension,
// and NO physical terrain breakdown (that lives in the World/physical view).
function renderPoliticalRail(p, crumbs) {
  rail.innerHTML = `
    <button class="backbtn" id="backProv">← Back</button>
    <div class="detail">
      <div class="d-head"><h2 class="serif">${p.name}</h2></div>
      <div class="rm-sub" style="color:var(--ink-soft);margin-top:-6px"><span class="r">${p.type.toLowerCase()}</span> · province ${p.id}</div>
      ${crumbs ? `<div class="pv-crumbs">${crumbs}</div>` : ""}
      ${politicsBlock(p)}
      <div id="loreBox" class="lore-box"></div>
      ${colonyBlock(p)}
    </div>`;
  document.getElementById("backProv").onclick = ()=>{ S.selectedProv=null; showRail(false); renderRail(); draw(); };
  fillProvinceLore(p);
}
// Fill the lore box with the article for the province's value on the active political dimension
// (nation→country, culture→culture, faith→religion). ensurePolitical()/lore fetches both cache.
async function fillProvinceLore(p) {
  await ensurePolitical();                            // populates p.owner / p.culture / p.religion
  if (S.selectedProv !== p || !isPolitical()) return; // selection or mode changed while loading
  const dim = { nation: ["country", p.owner], culture: ["culture", p.culture], faith: ["religion", p.religion] }[S.overlay];
  const box = document.getElementById("loreBox");
  if (!box || S.selectedProv !== p) return;
  if (dim && dim[1]) fillLore(box, dim[0], dim[1]);
  else box.innerHTML = "";                            // province has no value on this dimension (e.g. unowned)
}
// The live colony's detail, inline, when the selected province is the one it sits in — replacing the
// bespoke live HUD that used to take the whole rail over in Zeitgeist mode. Empty for every other
// province, so a spectator sees the colony where the colony actually is rather than wherever they
// happen to be looking. Keyed on ColonyView.provinceId: the snapshot ships lat/lon too, but turning
// those back into a province would mean inverting the map projection client-side.
function colonyBlock(p) {
  const c = liveColony();
  if (!c || !c.name || !c.provinceId || c.provinceId !== p.id) return "";
  const tier = c.tier ? prettyKey(c.tier) : "—";
  const cell = (k, v) => `<div class="metacell"><div class="k">${k}</div><div class="v" style="font-size:13px">${v}</div></div>`;
  return `
    <div class="pv-sec" style="margin-top:14px">
      <div class="pv-sec-h"><span class="live-dot"></span>Live colony</div>
      <div class="statrow" style="margin-top:8px">
        <div class="stat"><div class="k">Population</div><div class="v">${c.population}</div></div>
        <div class="stat"><div class="k">Pool</div><div class="v">${c.poolSize}</div></div>
        <div class="stat"><div class="k">Children</div><div class="v">${c.children}</div></div>
      </div>
      <div class="metagrid" style="margin-top:8px">
        ${cell("Tier", tier)}
        ${cell("Firms · nobles", `${c.firms} · ${c.nobles}`)}
        ${cell("Food price", (c.necessityPrice || 0).toFixed(2))}
        ${cell("Plots worked", `${c.plotCount} / ${c.maxPlots}`)}
        ${cell("Tax · bank", (c.bankProfitTax || 0).toFixed(3))}
        ${cell("Tax · noble", (c.nobleIncomeTax || 0).toFixed(3))}
      </div>
    </div>`;
}
// The city info panel — shown in the rail when a city (an Anbennar city_terrain province,
// e.g. Dhenijansar) is selected, in place of the generic province detail. Reuses the same
// markup vocabulary as provinceRail (.detail / .d-head / .statrow / .metagrid / politicsBlock)
// so it matches the panel's look. See docs/urban-plots.md.
function cityRail(p) {
  const g = provGeo(p);
  const crumbs = [g.continent, g.superRegion, g.region, g.area].filter(t => t && t[0])
    .map(t => `<span>${t[0]}${t[1] ? ` <span class="pv-key">(${t[1]})</span>` : ''}</span>`)
    .join('<span class="crumb-sep">›</span>');
  const coord = `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? "N" : "S"}, ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? "E" : "W"}`;
  const dev = p.dev || 0;
  const rank = dev >= 30 ? "Metropolis" : dev >= 15 ? "City" : "Town";
  const tgKey = TRADE_GOODS && TRADE_GOODS.prov[p.id];
  const tg = tgKey && TRADE_GOODS.goods[tgKey];
  const tgHtml = tg ? `<span class="dot" style="background:${tg.color}"></span>${tg.name}` : "—";
  // the urban core size, once the province's plots have streamed in
  let coreHtml = "";
  if (p._plots && p._plots.length) {
    const urban = p._plots.filter(q => q.urban).length;
    coreHtml = `<div class="stat"><div class="k">Urban core</div><div class="v">${urban}<small style="font-size:11px;color:var(--ink-soft)"> plots</small></div></div>`;
  }
  rail.innerHTML = `
    <button class="backbtn" id="backProv">← Back</button>
    <div class="detail">
      <div class="d-head"><h2 class="serif">${p.name}</h2></div>
      <div class="rm-sub" style="color:var(--ink-soft);margin-top:-6px"><span class="r" style="color:var(--gold,#c9a24a)">${rank}</span> · city · province ${p.id}</div>
      ${crumbs ? `<div class="pv-crumbs">${crumbs}</div>` : ""}
      <div class="statrow" style="margin-top:12px">
        <div class="stat"><div class="k">Development</div><div class="v" style="color:var(--gold,#c9a24a)">${dev}</div></div>
        ${coreHtml}
        <div class="stat"><div class="k">Land plots</div><div class="v">${p.plots}</div></div>
      </div>
      <div class="metagrid" style="margin-top:8px">
        <div class="metacell"><div class="k">Trade good</div><div class="v" style="font-size:13px">${tgHtml}</div></div>
        <div class="metacell"><div class="k">Coordinates</div><div class="v" style="font-size:13px">${coord}</div></div>
      </div>
      ${politicsBlock(p)}
      ${colonyBlock(p)}
      <p class="footnote">A city of Anbennar — its EU4 development (ADM + DIP + MIL) concentrated in the province's built-up urban core. Zoom in to the plot to see the city itself.</p>
    </div>`;
  document.getElementById("backProv").onclick = () => { S.selectedProv = null; showRail(false); renderRail(); draw(); };
  // owner/culture/faith load lazily with the political layer — refresh once it's ready
  if (!politicalReady()) ensurePolitical().then(() => { if (S.selectedProv === p) renderRail(); });
}
function renderRail(){
  // a province-focus change (select/deselect) — let the Religion advisor segment retrack the focused
  // province's faith (advisors.mjs listens; refreshDynamicSegments). Cheap: it only repaints a label.
  window.dispatchEvent(new CustomEvent("civstudio:focus"));
  showRail(!!S.selectedProv);
  if (S.selectedProv) {
    if (S.selectedProv.city) { cityRail(S.selectedProv); return; }
    provinceRail(S.selectedProv); return;
  }
  rail.innerHTML = worldRail();
}

/** Is the sidebar currently open? Exposed as a predicate rather than the element, so callers
  * (closePanel) can ask without reaching into the rail's DOM. */
const railOpen = () => railwrap.classList.contains("open");

export { showRail, renderRail, selectProvince, worldRail, railOpen };
