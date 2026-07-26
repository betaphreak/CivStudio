"use strict";
// The Privy Council — a Civ4-style advisor-mode selector layered ABOVE the existing render
// states. Each advisor is a top-bar segment that fills/recolours the canvas and swaps a
// second-row sub-control strip. Choosing one maps onto the low-level S.overlay / S.plane /
// S.techOpen states the LAYERS registry already gates on (layers.mjs) — the render pipeline is
// unchanged; this only groups the controls and drives the existing panel.mjs handlers.
// See docs/privy-council.md.
import { S, BUNDLE, RELIGIONS, COUNTRIES, ACTIVE_REALM, switchRealm } from "./core.mjs";
import { setOverlay, setPlane, updateSearchContext } from "./panel.mjs";
import { viewportFocus } from "./bandcaption.mjs";
import { prettyKey } from "./plotlabel.mjs";
import { openTech, closeTech } from "./techtree.mjs";
import { advisorSeat, openAdvisorRail, noteRoster, closeAdvisorRail } from "./advisor-detail.mjs";
import { onLiveRoster, liveColony, liveResearch } from "./overlays/live.mjs";

import { ensurePolitical, politicalReady } from "./overlays/political.mjs";
import { advisorPortrait, initPortraits } from "./portraits.mjs";

// The physical-world (globe) segment is labelled with the world name + current map version
// (ProvincePlotStore.MAP_VERSION, shipped in the bundle as mapVersion) — e.g. "Halann v8" — so the
// generation of the imported world is visible at a glance where the old "Globe" label sat; its
// tooltip (`label` → data-tip) carries the world lore.
// The globe segment names the active REALM (docs/realms.md §UI) — e.g. "Halcann v9" — and is now a
// dropdown (Lobby + the realms). When the server ships no realms block it falls back to the planet name
// "Halann" over the whole-world map. The generation (mapVersion) rides after it as before.
const REALM_NAME = (ACTIVE_REALM && BUNDLE?.geoNames?.realm?.[ACTIVE_REALM]) || "Halann";
const HALANN = REALM_NAME + " v" + (BUNDLE?.mapVersion ?? "?");
const HALANN_TIP = "Switch realm — you are looking at " + REALM_NAME + ", on the planet Halann.";

// The advisor table — the single extensible source (a future advisor is one more row). `future`
// advisors render as greyed placeholders with their reserved Civ4 F-key; `role` names the court
// seat whose portrait/name labels the advisor (from the live roster, filled in a later step).
export const ADVISORS = [
  // Globe leads the bar: the world name + generation ("Halann v8") is the page's masthead, so it sits
  // leftmost — ahead of the zoom band — rather than trailing the political advisors.
  { id: "globe",      label: HALANN_TIP,           short: HALANN,      key: "F11", icon: "🌐" },
  // Main Map is special: its segment IS the live zoom-band readout (filled by main.mjs), not a label.
  { id: "mainmap",    label: "Main Map",           short: "Map",        key: "`",  zoom: true },
  { id: "domestic",   label: "Domestic Advisor",   short: "Domestic",   key: "F1", future: true },
  { id: "financial",  label: "Financial Advisor",  short: "Financial",  key: "F2", future: true },
  { id: "civics",     label: "Civics Advisor",     short: "Civics",     key: "F3", future: true },
  { id: "foreign",    label: "Foreign Advisor",    short: "Foreign",    key: "F4", role: "foreign",    icon: "🕊" },
  { id: "military",   label: "Military Advisor",   short: "Military",   key: "F5", future: true },
  { id: "technology", label: "Technology Advisor", short: "Technology", key: "F6", role: "technology", icon: "🔬" },
  { id: "religion",   label: "Religion Advisor",   short: "Religion",   key: "F7", role: "religion",   icon: "🛐" },
  { id: "zeitgeist",  label: "Zeitgeist",          short: "Zeitgeist",  key: "Z",  live: true, icon: "📡" },
];
const byId = id => ADVISORS.find(a => a.id === id);

// Foreign remembers its last sub-view (Nation vs Culture) so re-entering restores it.
let foreignSub = "nation";
let selectorEl, subbarEl;

/**
 * Switch to advisor `id`, mapping it onto the render states the LAYERS gates honour. Modelled on
 * panel.mjs setOverlay: it drives the existing handlers (setOverlay / setPlane / openTech), so all
 * their side effects (live SSE connect/disconnect, clock, search context, rail) are reused.
 */
export function setAdvisor(id) {
  const a = byId(id);
  if (!a || a.future) return;
  closeAdvisorRail();     // a prior advisor's character sheet shouldn't linger under the new one
  S.advisor = id;
  // leaving Technology returns the map (paint() resumes); entering it suspends the map behind the tree
  if (id !== "technology" && S.techOpen) closeTech();
  switch (id) {
    // clicking the research pill means "show me THAT" — hand the tree the tech being researched so it
    // opens centred on it, rather than at the origin of a 292-node graph
    case "technology": openTech(liveResearch()?.type); break;
    case "foreign":    setOverlay(foreignSub); break;   // nation | culture
    case "religion":   setOverlay("faith"); break;
    case "zeitgeist":  setOverlay("live"); break;
    case "globe":                                        // Globe = physical map + plane sub-control
    case "mainmap":    setOverlay("none"); break;
  }
  paintSelector();
  showSub(id);
  updateSearchContext();   // §5: swap the top-bar search corpus/placeholder (techs in Technology)
}

// build the advisor selector buttons into #advisorToggle (a .segToggle group). Portraits replace
// the text labels once the portrait bake lands (docs/privy-council.md §3); for now: short label for
// implemented advisors, the F-key for greyed future ones.
function buildSelector() {
  selectorEl.innerHTML = "";
  for (const a of ADVISORS) {
    if (a.future) continue;   // future advisors are collapsed (not shown until they're built)
    const b = document.createElement("button");
    b.dataset.advisor = a.id;
    b.setAttribute("aria-pressed", "false");
    const keyHint = a.key === "`" ? "` / Esc" : a.key;
    b.setAttribute("data-tip", `${a.label} (${keyHint})`);
    if (a.live) b.classList.add("advisor-live");
    if (a.zoom) {
      // the Main Map segment is the live zoom-band readout — main.mjs fills #zoomLevel with the
      // band name + regime icon and updates it as you zoom
      b.id = "zoomLevel"; b.classList.add("adv-zoom");
    } else {
      b.innerHTML = `<span class="adv-ico">${a.icon || ""}</span>${a.short}`;
    }
    if (a.id === "globe") wireGlobeDropdown(b);   // the masthead realm selector (Lobby + realms)
    else b.addEventListener("click", () => setAdvisor(a.id));
    selectorEl.appendChild(b);
  }
  refreshDynamicSegments();   // paint the live-labelled segments (Technology / Religion) over their defaults
}

// The globe segment doubles as the realm dropdown (docs/realms.md §UI): clicking it opens a menu of
// Lobby + the realms, and still selects the globe advisor so the plane sub-bar shows (Halcann only).
let _realmMenu = null;
function realmMenu() {
  if (_realmMenu) return _realmMenu;
  const menu = document.createElement("div");
  menu.className = "realm-menu";
  menu.hidden = true;
  const lobby = document.createElement("button");
  lobby.className = "rm-lobby";
  lobby.textContent = "Lobby";
  lobby.onclick = () => { menu.hidden = true; openLobby(); };
  menu.appendChild(lobby);
  const sep = document.createElement("div"); sep.className = "rm-sep"; menu.appendChild(sep);
  const ver = " v" + (BUNDLE?.mapVersion ?? "?");
  for (const key of (BUNDLE?.realms ? Object.keys(BUNDLE.realms) : [])) {
    const item = document.createElement("button");
    const name = (BUNDLE.geoNames?.realm?.[key]) || key;
    item.innerHTML = `${name}<span class="rm-ver">${ver}</span>`;
    if (key === ACTIVE_REALM) item.classList.add("rm-current");
    item.onclick = () => { menu.hidden = true; if (key !== ACTIVE_REALM) switchRealm(key); };  // dropdown → fit the realm
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  _realmMenu = menu;
  return menu;
}
function openLobby() {
  if (window.__lobby && window.__lobby.open) window.__lobby.open();
  else if (window.__picker && window.__picker.open) window.__picker.open();
}
// The globe segment opens the FULL realm selector (index.html `window.__realms`) rather than the
// little masthead dropdown it used to. One chooser, the same rows and province counts, whether it is
// the first-run question or a deliberate switch — a realm is a world, and a 3-item text menu tucked
// under the top bar undersold the choice. The dropdown remains as the fallback for a page whose
// bootstrap predates the selector (`realmMenu`, below), and keeps the Lobby entry either way: the
// selector is realms only, so Lobby moves back to the brand, which has always opened it.
function wireGlobeDropdown(btn) {
  btn.insertAdjacentHTML("beforeend", '<span class="adv-caret">▾</span>');   // signal it opens a chooser
  btn.addEventListener("click", e => {
    e.stopPropagation();
    setAdvisor("globe");   // still reveal the plane sub-bar (Halcann)
    if (window.__realms && window.__realms.open) { window.__realms.open(); return; }
    const menu = realmMenu(), open = menu.hidden;
    menu.hidden = true;   // (re)position then reveal, so it tracks the button
    if (open) {
      const r = btn.getBoundingClientRect();
      menu.style.left = Math.round(r.left) + "px";
      menu.style.top = Math.round(r.bottom + 4) + "px";
      menu.hidden = false;
    }
  });
  document.addEventListener("click", () => { if (_realmMenu) _realmMenu.hidden = true; });
}

function paintSelector() {
  selectorEl.querySelectorAll("button").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.advisor === S.advisor)));
}

// ---- dynamic advisor segments: some segments show live state in place of a static label ----
// prettify a tech id into a title-cased display name (the frontend has no tech-name map until the
// tech tree loads /api/techs; the id prettifies cleanly, e.g. TECH_BRONZE_WORKING -> "Bronze Working")
function techName(id) {
  return id.replace(/^TECH_/, "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
// the Technology segment's live text: the POV colony's current research + progress %, else the static
// label. The research rides the live snapshot (ColonyView.researchingTech / researchProgress).
function technologyLabel() {
  const r = liveResearch();
  return r ? `${techName(r.type)} (${Math.round(r.progress * 100)}%)` : "Technology";
}
// Fill the Technology segment like a progress bar: --research (0..1) drives a hard-stop gradient
// across the button (see .adv-research in styles.css), so the segment IS the research bar rather than
// a label that happens to mention a percentage. Off when nothing is being researched, so the segment
// falls back to a plain "Technology" button.
function paintResearchFill() {
  const b = selectorEl && selectorEl.querySelector('button[data-advisor="technology"]');
  if (!b) return;
  const r = liveResearch();
  b.classList.toggle("adv-research", !!r);
  if (r) {
    b.style.setProperty("--research", r.progress.toFixed(3));
    b.setAttribute("data-tip", `Researching ${techName(r.type)} — ${Math.round(r.progress * 100)}% done. Click to show it in the tech tree.`);
  } else {
    b.style.removeProperty("--research");
    b.setAttribute("data-tip", "Technology Advisor (F6)");
  }
}
// The province a political segment speaks for: an explicit SELECTION wins over the viewport, because
// clicking a province is a deliberate "tell me about this one" that panning shouldn't silently
// override. With nothing selected we fall back to what's under the crosshair (bandcaption.viewportFocus).
const subjectProv = () => S.selectedProv || viewportFocus();
// resolve a political key through its name table, falling back to the prettified raw key — the
// tables (COUNTRIES/RELIGIONS) arrive with the lazy political layer, so until ensurePolitical()
// lands, the raw key is the honest answer rather than a blank segment
const polName = (table, key) => (key ? ((table[key] && table[key].name) || prettyKey(key)) : null);
// the Foreign segment's live text: the subject province's owning nation, else the static label
function nationLabel() {
  const p = subjectProv();
  return (p && polName(COUNTRIES, p.owner)) || "Foreign";
}
// the Religion segment's live text: the subject province's religion name, else the static label
function religionLabel() {
  const p = subjectProv();
  return (p && polName(RELIGIONS, p.religion)) || "Religion";
}
// the Zeitgeist segment's live text: the live session's colony. Unlike the band caption's Settlement
// row this needs NO locality gate — the segment is about the live SESSION, not about what's under
// the camera, so naming its colony is correct wherever you happen to be looking.
function zeitgeistLabel() {
  const c = liveColony();
  return (c && c.name) || "Zeitgeist";
}
// repaint one dynamic segment's text (keeping its icon); a no-op for the zoom segment / an absent button
function setSegmentText(id, text) {
  const b = selectorEl && selectorEl.querySelector(`button[data-advisor="${id}"]`);
  if (!b || b.classList.contains("adv-zoom")) return;
  b.innerHTML = `<span class="adv-ico">${byId(id).icon || ""}</span>${text}`;
}
// refresh every live-labelled segment: Technology (from the snapshot), Foreign/Religion (from the
// selected-or-viewport province) and Zeitgeist (from the live colony). Called on build, on each live
// snapshot, on a province-focus change, and once the camera settles (see initAdvisor).
//
// Each of these REPLACES the segment's mode name with live data — the emoji icon and the
// "Foreign Advisor (F4)" tooltip carry the mode identity instead, matching the Technology segment
// that already shipped this way.
export function refreshDynamicSegments() {
  setSegmentText("technology", technologyLabel());
  paintResearchFill();   // after the text: setSegmentText rewrites the button's innerHTML
  setSegmentText("foreign", nationLabel());
  setSegmentText("religion", religionLabel());
  setSegmentText("zeitgeist", zeitgeistLabel());
}
// The nation/religion names ride the lazily-loaded political layer (owner/religion are only stamped
// onto the provinces by ensurePolitical). The Foreign/Religion segments now want them from the first
// paint — not just after a click — so warm the layer once a subject province exists, then repaint the
// segments with the resolved names. One-shot: ensurePolitical is idempotent and politicalReady()
// short-circuits every later call.
function warmPolitical() {
  if (politicalReady() || !subjectProv()) return;
  ensurePolitical().then(refreshDynamicSegments);
}

// show only the active advisor's sub-control strip; the standalone cost button (top-right) belongs
// to Main Map alone.
function showSub(id) {
  subbarEl.querySelectorAll("[data-sub]").forEach(el => { el.hidden = el.dataset.sub !== id; });
  renderCourt(id);
}

// fill the active role-bearing advisor's court chip with its court member's name (from the live
// roster, §0) — clicking it opens the character sheet in the rail (advisor-detail.mjs §2b). Hidden
// when there's no seated member (no feed / role unfilled). Re-runs on roster change (succession).
function renderCourt(id) {
  const slot = subbarEl.querySelector(`[data-sub="${id}"]`);
  const chip = slot && slot.querySelector(".advisor-court");
  if (!chip) return;
  const seat = advisorSeat(id);
  if (!seat) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.title = `${seat.name} — ${seat.race}. Open the character sheet.`;
  chip.onclick = () => openAdvisorRail(id);
  // name now, with a small culture portrait prepended once it resolves (art-less → no pic)
  chip.replaceChildren();
  const pic = document.createElement("span"); pic.className = "court-pic"; pic.hidden = true;
  const nm = document.createElement("span"); nm.textContent = seat.name;
  chip.append(pic, nm, document.createTextNode(" ▸"));
  advisorPortrait({ race: seat.race, culture: seat.culture, advisorId: id, gender: seat.gender }, 18)
    .then(port => { if (S.advisor === id && port) { pic.style.cssText = port.style; pic.hidden = false; } });
}

// wire the sub-bar's Nation/Culture buttons (Foreign). The Globe plane buttons are the relocated
// #planeToggle, already wired by panel.mjs; setPlane/setOverlay repaint aria-pressed by data-* attr.
function wireSubbar() {
  subbarEl.querySelectorAll('[data-sub="foreign"] [data-ov]').forEach(b =>
    b.addEventListener("click", () => { foreignSub = b.dataset.ov; setOverlay(foreignSub); }));
}

// derive the initial advisor from the render state boot() already applied — no re-apply (avoids a
// second live-feed connect); subsequent user clicks go through setAdvisor.
function deriveAdvisor() {
  if (S.techOpen) return "technology";
  if (S.plane === "underworld") return "globe";
  switch (S.overlay) {
    case "live":   return "zeitgeist";
    case "nation":
    case "culture": foreignSub = S.overlay; return "foreign";
    case "faith":  return "religion";
    default:       return "mainmap";
  }
}

export function initAdvisor() {
  selectorEl = document.getElementById("advisorToggle");
  subbarEl = document.getElementById("advisorSubbar");
  if (!selectorEl || !subbarEl) return;
  buildSelector();
  wireSubbar();
  initPortraits();   // warm the portrait manifest so court chips / character sheets paint promptly
  // the roster arrives on the live feed — re-render the active advisor's court chip on each update
  // (and on succession, when the name/race behind a role changes)
  onLiveRoster(roster => { noteRoster(roster); renderCourt(S.advisor); });
  // live-labelled segments: Technology tracks each snapshot's research; Religion tracks the focused
  // province (panel.mjs dispatches civstudio:focus on select/deselect). See refreshDynamicSegments.
  window.addEventListener("civstudio:snapshot", refreshDynamicSegments);
  // the camera settled on somewhere new — the Foreign/Religion segments name the province under the
  // crosshair, so they track panning too (main.draw fires this off bandcaption's debounce, so it is
  // once-per-settle, not per-frame)
  window.addEventListener("civstudio:viewport", () => {
    refreshDynamicSegments();
    warmPolitical();
  });
  window.addEventListener("civstudio:focus", () => {
    refreshDynamicSegments();
    warmPolitical();
  });
  S.advisor = deriveAdvisor();
  paintSelector();
  showSub(S.advisor);
}
