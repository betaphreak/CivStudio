"use strict";
// The COLONY composition panel (docs/caravan.md): click one of the live vitals figures in the top
// bar and the settlement's makeup fills the right rail — the colony's vitals, a colony-average skill
// profile across its household heads, and the full household roster (the ruler and nobles first, then
// the laborers). The settlement counterpart to the caravan panel (caravan-detail.mjs): the header +
// stats stay live off each snapshot's ColonyView, while the skills + roster lazy-fetch GET
// /api/sessions/{sid}/colony (ColonyController) and refetch only when the makeup changes. Reuses the
// advisor sheet's markup/classes (adv-*), written straight into the rail like openCaravanRail.
import { S, apiUrl } from "./core.mjs";
import { fmtNum, fmtPct, annualize } from "./num.mjs";
import { showRail } from "./rail.mjs";
import { prettyKey } from "./plotlabel.mjs";
import { liveSid, liveColony, liveCaravans } from "./overlays/live.mjs";

const railEl = () => document.getElementById("rail");

let open = false;        // is the colony panel the rail's subject?
let lastDetail = null;   // the last composition fetched, kept across live header refreshes
let lastFetchKey = "";   // (pop|nobles|pool) of the last roster fetch — refetch when it changes

/** Open (or toggle off) the POV colony's composition panel. */
export function openColonyRail() {
  if (open) { closeColonyRail(); return; }   // a re-click closes it
  open = true;
  S.selectedProv = null;   // a colony and a province are mutually exclusive rail subjects
  lastDetail = null;
  lastFetchKey = "";
  showRail(true);
  render();                // header immediately; the roster fills in after the fetch
  fetchAndRender();
}

/** Collapse the panel (an explicit deselect, or the colony is gone). */
export function closeColonyRail() {
  open = false;
  lastDetail = null;
  if (railEl() && railEl().querySelector(".colony-sheet")) showRail(false);
}

// each snapshot: keep the header/stats live, refetch the roster when the makeup changed, and drop the
// panel when the colony is gone or a province/band took the rail over.
function onSnapshot() {
  if (!open) return;
  if (!railEl() || !railEl().querySelector(".colony-sheet")) { open = false; lastDetail = null; return; }
  const c = liveColony();
  if (!c || !c.name) { open = false; lastDetail = null; showRail(false); return; }   // no live colony
  render();                // live header/stats
  fetchAndRender();        // refetch only if the makeup key changed (guarded within)
}

async function fetchAndRender() {
  const sid = liveSid();
  const c = liveColony();
  if (!sid || !c) return;
  const key = `${c.population}|${c.nobles}|${c.poolSize}`;
  if (key === lastFetchKey && lastDetail) return;   // unchanged makeup — the roster we have still stands
  lastFetchKey = key;
  let detail = null;
  try {
    const r = await fetch(apiUrl(`/api/sessions/${sid}/colony`), { cache: "no-store" });
    if (r.ok) detail = await r.json();
  } catch { /* keep the header-only view */ }
  if (!open) return;   // the panel closed while the fetch was in flight
  lastDetail = detail;
  render();
}

// paint the rail: the colony's header + vitals + skill profile + roster (or a "no colony" note when
// the session has none). Uses whatever composition has been fetched so far (lastDetail).
function render() {
  const el = railEl();
  if (!el) return;
  const c = liveColony();
  el.innerHTML = c && c.name ? sheetHtml(c, lastDetail) : goneHtml();
  const back = el.querySelector("#backColony");
  if (back) back.onclick = closeColonyRail;
}

function sheetHtml(c, d) {
  const tier = c.tier ? prettyKey(c.tier) : "—";
  const province = (d && d.province) || "";
  const rulerName = d && d.rulerName;
  const caravans = (liveCaravans() || []).length;
  const skills = d
    ? d.skills.slice().sort((a, b) => b.avg - a.avg).map(skillBar).join("")
    : `<div class="adv-dim">Reading the rolls…</div>`;
  const roster = d ? d.members.map(memberRow).join("") : "";
  const cell = (k, v) => `<div class="metacell"><div class="k">${k}</div><div class="v" style="font-size:13px">${v}</div></div>`;
  return `<div class="detail colony-sheet">
    <button class="backbtn" id="backColony">← Map</button>
    <div class="adv-head">
      <div class="adv-portrait" style="--h:42">🏛</div>
      <div class="adv-id">
        <div class="adv-name">${esc(c.name)}</div>
        <div class="adv-role">${esc(tier)} · ${c.population} household${c.population === 1 ? "" : "s"}</div>
        <div class="adv-sub">${rulerName ? esc(rulerName) + " rules" : "No ruler"}${province ? " · " + esc(province) : ""}</div>
      </div>
    </div>
    <div class="statrow" style="margin-top:12px">
      <div class="stat"><div class="k">Population</div><div class="v">${c.population}</div></div>
      <div class="stat"><div class="k">Pool</div><div class="v">${c.poolSize}</div></div>
      <div class="stat"><div class="k">Children</div><div class="v">${c.children}</div></div>
    </div>
    <div class="statrow" style="margin-top:8px">
      <div class="stat"><div class="k">Firms</div><div class="v">${c.firms}</div></div>
      <div class="stat"><div class="k">Nobles</div><div class="v">${c.nobles}</div></div>
      <div class="stat"><div class="k">Food price</div><div class="v">${fmtNum(c.necessityPrice || 0)}</div></div>
    </div>
    <div class="metagrid" style="margin-top:8px">
      ${cell("Tier", tier)}
      ${cell("Caravans afield", caravans)}
      ${cell("Plots worked", `${c.plotCount} / ${c.maxPlots}`)}
      ${cell("Inflation", fmtPct(annualize(c.cpi || 0)) + " <span class=\"unit\">/yr</span>")}
      ${cell("Tax · bank", fmtPct(c.bankProfitTax || 0))}
      ${cell("Tax · noble", fmtPct(c.nobleIncomeTax || 0))}
    </div>
    <div class="adv-sec">Skill profile <span class="adv-dim">colony avg</span></div>
    <div class="adv-skills">${skills}</div>
    ${d ? `<div class="adv-sec">Households <span class="adv-dim">by rank</span></div>
    <div class="adv-house">${roster}</div>` : ""}
  </div>`;
}

function goneHtml() {
  return `<div class="detail colony-sheet">
    <button class="backbtn" id="backColony">← Map</button>
    <div class="adv-head"><div class="adv-id">
      <div class="adv-name">No colony</div>
      <div class="adv-sub">This session has no live colony.</div>
    </div></div>
  </div>`;
}

// one aggregate skill bar (avg level 0..20 → a percentage bar, the average shown to a decimal) —
// identical to the caravan panel's, so the two sheets read the same
function skillBar(s) {
  const pct = Math.max(0, Math.min(100, Math.round((s.avg / 20) * 100)));
  return `<div class="adv-skill">
    <span class="adv-sk-name">${esc(cap(s.skill))}</span>
    <span class="adv-sk-bar"><span style="width:${pct}%"></span></span>
    <span class="adv-sk-lvl">${s.avg.toFixed(1)}</span>
  </div>`;
}

// one roster row (ruler/nobles first): the ruler badged, role · race · age, and the head's ablest
// skill (name + level) in the level slot
function memberRow(m) {
  const badge = m.topSkill ? `${cap(m.topSkill)} ${m.topSkillLevel}` : "—";
  const star = m.ruler ? '<span class="cv-lead">★</span> ' : "";
  return `<div class="adv-member">
    <span class="adv-m-name">${star}${esc(m.name)}</span>
    <span class="adv-m-rel">${esc(m.role)} · ${esc(cap(m.race))} · ${m.age}</span>
    <span class="adv-m-age" title="ablest skill">${esc(badge)}</span>
  </div>`;
}

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

window.addEventListener("civstudio:snapshot", onSnapshot);
// the vitals strip (#liveVitals) is rebuilt every snapshot by live.mjs, so bind a DELEGATED click on
// the persistent container rather than the throwaway chips: any figure opens (toggles) the panel; the
// connection-status placeholder (.lv-status) is not a figure, so it does not.
{
  const vitals = document.getElementById("liveVitals");
  if (vitals) vitals.addEventListener("click", e => {
    if (e.target.closest(".lv") && !e.target.closest(".lv-status")) openColonyRail();
  });
}
