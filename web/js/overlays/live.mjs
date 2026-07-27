"use strict";
// Live overlay — the real WorldMap driven by the running server's SSE feed (see
// docs/client-server.md). Where the Caravan overlay replays a recorded run from data.js,
// this subscribes to the live spectator server (a Container App) and renders the current
// session over the real terrain: the colony, the marching caravans (with trails), and a
// compact HUD that also carries the taxation command (the Phase-B player action). It is a
// pure consumer + command client — it never touches engine internals. The map projection
// (px/py) already pins anything with a lon/lat onto the terrain, so the feed's colonies and
// caravans place with no new geometry.
// where the feed lives — resolved once, in core.mjs (?live= override, else the base the index.html
// bootstrap recorded on the bundle, else the deployed server). It used to be re-derived here and in
// auth.mjs: three copies of the same two lines, all of which had to stay in lockstep with the
// bootstrap that actually picks the server.
import { ctx, px, py, cssVar, VIEW, baseXr, baseYr, sxSrc, sySrc, LABEL_FONT, centerOn, S, SERVER_BASE as LIVE_BASE, pllOn } from "../core.mjs";
import { hasDeepLink } from "../main.mjs";
import { atLeast, BAND, bandAlpha } from "../bands.mjs";
import { setRouteSession, invalidateRoutes } from "../routefetch.mjs";
import { showLiveLog, ingestLog, ingestChat, resetLog, setChatSender } from "../livelog.mjs";
import { showNotify, ingestNotify, seedNotify, resetNotify } from "../notify.mjs";
import { minusDays, LIFETIME_DAYS, MAX_CARDS } from "../notify-age.mjs";
import { makeLogGate } from "../snapshot-dedupe.mjs";
import { renderPicker } from "../build-picker.mjs";
import { setSessionEnded } from "../diag.mjs";
import { fmtNum } from "../num.mjs";

const PALETTE = ["#e8c37a","#6bd08a","#7aa2e0","#e07a9e","#9e7ae0","#e0a97a","#7ae0d0","#c0e07a"];

// caravan dot/trail colour by role (CaravanRole) — settler gold, worker green, explorer
// blue, military red — so the flavors read apart on the map; falls back to the palette by
// index for an unknown/absent role
const ROLE_COLOR = { SETTLER: "#e8c37a", WORKER: "#6bd08a", EXPLORER: "#7aa2e0", MILITARY: "#e07a9e" };
// the imported unit-icon sheet (build-units.mjs) — a band that embodies a UNIT_* draws its button
// icon from here (via the snapshot's unitIcon rect); 64² cells, 50 cols. docs/c2c-unit-import.md §5.
const USHEET = new Image();
USHEET.src = "assets/units/unit-icons.webp";
const cap1 = s => s ? s[0] + s.slice(1).toLowerCase() : s;

let es = null;          // the EventSource, while connected
let sid = null;         // the live session id
// The session this client is watching, if a particular one was chosen. Null means "whatever is
// running" — the plain visitor's answer, and what this has always done.
//
// The SOURCE OF TRUTH is the URL: ?session=<id> (docs/session-management.md). That makes the choice
// reload-survivable and shareable, and means discovery is deterministic rather than re-derived from a
// list on every reconnect (the class of bug that once left a founded session stuck on the demo).
// window.__spectate / sessionStorage["cs.spectate"] are the pre-URL handoff — a choice made in the
// lobby before this module (or the URL) existed — kept only as a fallback.
function urlSession() {
  try { return new URLSearchParams(location.search).get("session") || null; } catch { return null; }
}
let preferred = urlSession() || window.__spectate
  || (() => { try { const s = sessionStorage.getItem("cs.spectate"); if (s) sessionStorage.removeItem("cs.spectate"); return s; } catch { return null; } })();
let snap = null;        // the latest snapshot
// guards the log delta against re-ingestion: a reconnect is handed the cached frame again, and its
// lines have already been posted (see snapshot-dedupe.mjs)
const logGate = makeLogGate();
let redraw = () => {};  // main.draw, injected on start
let onState = () => {}; // panel transport-sync callback (play icon + speed chevrons)
const trails = {};      // caravan leader -> [[lat,lon]…] recent path
let framed = false;     // camera centred on the colony once, on the first snapshot

// wall-clock ms per tick for each speed level (1…5): 1 day/s → uncapped
export const LIVE_RATES = [1000, 1000, 500, 250, 100, 0];

// the short label for the connected server, used as the log header prefix (dev.civstudio.com →
// "dev", localhost → "local"); the picked/overridden server determines it.
function serverLabel() {
  try {
    const h = new URL(LIVE_BASE).hostname;
    if (h === "localhost" || h === "127.0.0.1") return "local";
    return h.split(".")[0] || "live";
  } catch { return "live"; }
}

/** Whether the live feed is currently connected (Live mode is active). */
export function liveActive() { return es !== null; }

/** The live session's clock state (CREATED/RUNNING/PAUSED/STOPPED), or null when not connected.
 *  Split out of the old single `state` (docs/session-management.md); the transport reads this. */
export function liveState() { return snap ? snap.clockState : null; }

/** The live session's outcome (LIVE/WON/LOST/ABANDONED), or null when not connected. */
export function liveOutcome() { return snap ? snap.outcome : null; }

/** The POV colony's privy-council roster from the latest snapshot (advisor role → court member),
 *  or [] when not connected. Populated by the server (docs/privy-council.md §0). */
export function liveRoster() { return (snap && snap.colonies && snap.colonies[0] && snap.colonies[0].advisors) || []; }
// the primary colony's known techs (pre-known + researched) — the tech tree's researched-state source
export function liveKnownTechs() { return (snap && snap.colonies && snap.colonies[0] && snap.colonies[0].knownTechs) || []; }
/** What the POV colony is researching now, or null: {type, progress} with progress a 0..1 fraction.
 *  Drives the top bar's research fill (advisors.mjs) and the tree's in-progress node (techtree.mjs). */
export function liveResearch() {
  const c = liveColony();
  return c && c.researchingTech ? { type: c.researchingTech, progress: c.researchProgress || 0 } : null;
}

/** The POV colony from the latest snapshot (its districts / culture / lat-lon drive the district view), or null. */
export function liveColony() { return (snap && snap.colonies && snap.colonies[0]) || null; }

/** The live session id (for the person-detail endpoint), or null when never connected. */
export function liveSid() { return sid; }
/** The current snapshot's wandering bands (empty off Live) — so the caravan rail can re-resolve a
 *  selected band by id each tick and detect when it has settled/dissolved. */
export function liveCaravans() { return (snap && snap.caravans) || []; }

// notified with the fresh roster on each snapshot, so the advisor selector/rail track succession
let onRoster = () => {};
export function onLiveRoster(cb) { onRoster = cb || onRoster; }

/**
 * Connect to the live feed and start driving the overlay.
 * @param onRedraw main's draw()
 * @param onSessionState called with the session state on each snapshot (transport sync)
 */
export async function startLive(onRedraw, onSessionState) {
  redraw = onRedraw || redraw;
  onState = onSessionState || onState;
  hud(true);
  // already connected (the feed was kept alive in the background for the advisor roster when the
  // spectator left the live overlay) — just re-show its HUD and repaint, don't reconnect
  if (es) { renderHud(); onState(snap && snap.clockState, snap && snap.date); redraw(); return; }
  framed = false;
  reconnectAttempts = 0;
  connectStream();
}

/** Leave the live overlay but keep the SSE feed connected in the background — the advisor roster
 *  (and colony data) stay live for every advisor, only the live HUD/dots/clock go away. */
export function liveToBackground() { hud(false); liveTabRunning(false); }

// Reconnect to the SAME server indefinitely rather than ever dropping the map to the picker/loading
// screen: a server redeploy (new CivStudio version) tears the stream down and the new revision can take
// a minute-plus to serve, so we reconnect straight through it (re-resolving the session id each time, in
// case it was re-founded). Fast retries at first, backing off to a steady ~10s poll — a clean reconnect
// resets the cadence (es.onopen). The user stays on the map with a quiet "reconnecting…" HUD; switching
// servers is a manual action, never forced by a transient/redeploy outage.
const RECONNECT_DELAY = 1500, RECONNECT_MAX_DELAY = 10000;
let reconnectAttempts = 0, reconnectTimer = null;

async function connectStream() {
  reconnectTimer = null;
  setHudStatus(reconnectAttempts ? "reconnecting…" : "connecting…");
  try {
    // credentials: a single-player session is PRIVATE — the server lists it only to its owner (see
    // SessionController.list). Without the cookie this fetch is anonymous, so a player's own run is
    // filtered out, `preferred` never matches, and we fall back to list[0] — the public demo. That is
    // why founding a session left the map stuck on the demo: multi-session discovery needs the owner's
    // identity. The cookie is cross-origin to LIVE_BASE, so it only rides with credentials:"include"
    // (the same reason the lobby's own list fetch sends it). The /stream subscription below stays
    // anonymous — spectating by id is ungated; it is only DISCOVERY that must know who you are.
    const list = await (await fetch(LIVE_BASE + "/api/sessions", { cache: "no-store", credentials: "include" })).json();
    // Which session? The chosen one (?session= / the lobby's pick) is PINNED — it is not silently
    // swapped for another. A bare visitor (no choice) takes whatever is running (list[0]).
    // Notifications are PER SESSION: a re-founded session (a new id — e.g. after a server redeploy)
    // starts an empty board; a plain reconnect to the same session keeps it.
    let next;
    if (preferred) {
      if (list.some(s => s.id === preferred)) {
        next = preferred;
      } else if (!list.length) {
        // an empty list with a session in mind: the server is probably mid-restart — keep trying to
        // re-attach rather than declaring the run gone (a redeploy must not read as a dead link)
        setHudStatus("connecting…"); retryOrLost(); return;
      } else {
        // a populated list that does NOT contain it: it is private to someone else, finished-and-
        // forgotten, or never existed. Say so and stay put — never fall back to a different session
        // (that silent swap is exactly what hid the founded-session bug). docs/session-management.md.
        showDeadLink(preferred); return;
      }
    } else {
      if (!list.length) { setHudStatus("no live session"); retryOrLost(); return; }
      next = list[0].id;
    }
    if (next !== sid) { resetNotify(); await rehydrateNotify(next); }
    sid = next;
    if (es) es.close();
    es = new EventSource(LIVE_BASE + "/api/sessions/" + sid + "/stream");
    es.onopen = () => { reconnectAttempts = 0; };   // a clean connection resets the retry budget
    es.onmessage = e => {
      try { onSnapshot(JSON.parse(e.data)); } catch (err) { /* ignore a bad frame */ }
    };
    // lobby chat rides its own SSE event (immediate, not tick-paced); feed it to the log bar
    es.addEventListener("chat", e => {
      try { ingestChat(JSON.parse(e.data)); } catch (err) { /* ignore a bad chat frame */ }
    });
    setChatSender(postChat, postAsk);
    // EventSource retries transient network drops on its own (readyState CONNECTING). A permanently
    // CLOSED feed (readyState 2) — e.g. a non-2xx during a redeploy's revision hand-off — the UA will
    // NOT retry, so we reconnect ourselves (see retryOrLost) rather than dropping straight to the
    // picker; only after a run of failures is it a real loss.
    es.onerror = () => {
      setHudStatus("reconnecting…");
      if (es && es.readyState === 2) { es.close(); es = null; retryOrLost(); }
    };
  } catch (err) {
    retryOrLost();   // /api/sessions unreachable (server mid-restart) — keep trying
  }
}

// Recover the notification board from the session's retained event tail before subscribing to the
// stream, so a spectator who joins mid-session — or who just reloaded the page — sees the last 30
// in-game days rather than an empty board. A snapshot's `log` is a DELTA: it carries only what was
// logged since the previous frame, so everything older is unrecoverable from the stream alone.
//
// Done BEFORE the EventSource opens (hence the await at the call site) so the recovered lines are on
// the board first and the streamed ones pile up beneath them, in order. Any line that ends up in
// both — logged before this fetch but not yet drained into a frame — is de-duplicated by notify.mjs.
//
// Best-effort throughout: an older server with no /events, or a session that has not emitted a frame
// yet (204), simply means an empty board, which is exactly the old behaviour.
async function rehydrateNotify(id) {
  try {
    const snapRes = await fetch(`${LIVE_BASE}/api/sessions/${id}/snapshot`, { cache: "no-store" });
    if (!snapRes.ok) return;                       // 204 = nothing emitted yet; nothing to recover
    const now = (await snapRes.json()).date;
    const from = minusDays(now, LIFETIME_DAYS);    // only the window the board can actually show
    if (!from) return;
    const url = `${LIVE_BASE}/api/sessions/${id}/events?from=${from}&limit=${MAX_CARDS}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    seedNotify(await res.json(), now);
  } catch (err) { /* no tail → an empty board, as before */ }
}

// reconnect to the same server after a delay that backs off with consecutive failures (fast at first,
// capped at RECONNECT_MAX_DELAY) — never gives up, so the map never drops to the picker on its own.
function retryOrLost() {
  if (ended) return;   // the run is over — there is nothing to reconnect to (docs/game-over.md)
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_DELAY * Math.pow(1.6, Math.min(reconnectAttempts++, 6)));
  reconnectTimer = setTimeout(connectStream, delay);
}

/**
 * Watch a particular session — the lobby's pick. Re-points the feed at it: the board is per session,
 * so this is a fresh one, and a game-over screen from the last session must not survive the move.
 * Fired as a DOM event by lobby.mjs so the lobby need not import the overlay (nor the overlay the
 * lobby), the same decoupling the tech tree uses for snapshots.
 */
window.addEventListener("civstudio:spectate", e => {
  const id = e.detail && e.detail.id;
  if (!id || id === sid) return;
  preferred = id;
  setEnded(false);
  stoppedShown = false;
  const go = document.getElementById("gameover");
  if (go) go.hidden = true;
  if (es) { es.close(); es = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  framed = false;                 // open on the new session's colony, as a fresh load would
  connectStream();
});

/** Send a control action (pause/resume/step/rate) to the live session. */
export async function controlLive(action, value) {
  if (!sid) return;
  const body = value === undefined ? { action } : { action, value };
  try {
    // credentials: the owner check reads the session cookie; a write to an owned session needs it
    // (cross-origin to LIVE_BASE, so the default same-origin credentials mode would drop the cookie)
    await fetch(LIVE_BASE + "/api/sessions/" + sid + "/control",
      { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) { /* the next snapshot will reflect the true state anyway */ }
}

/** Disconnect and tear down the overlay (leaving Live mode). */
export function stopLive() {
  if (es) { es.close(); es = null; }
  snap = null; sid = null;
  setRouteSession(null);   // drop the route-index so the next session starts clean
  for (const k in trails) delete trails[k];
  resetLog();
  resetNotify();
  logGate.reset();   // the board is cleared, so the next session's lines are new again
  setEnded(false);   // a fresh connection may be to a living session
  stoppedShown = false;
  const go = document.getElementById("gameover");
  if (go) go.hidden = true;
  liveTabRunning(false);
  hud(false);
}

// tint the Spectate tab's background while the live session is RUNNING (a "live / on air" cue);
// cleared when paused, stopped, or on disconnect.
function liveTabRunning(on) {
  const btn = document.querySelector('#advisorToggle button.advisor-live');
  if (btn) btn.classList.toggle("live-running", on);
  // Twitch-style: the pulsing red LIVE badge shows only while the session is RUNNING — hidden when
  // the clock is paused/stopped or the feed is disconnected
  const badge = document.querySelector('.live-badge');
  if (badge) badge.hidden = !on;
}

// What a snapshot puts on the CANVAS: where the bands and the colony are (drawLive draws dots and
// trails from exactly these, and nothing in it is time-based). Everything else a snapshot carries —
// population, prices, the date, the roster, the event log — is chrome, and chrome has no business
// forcing a full scene render. A tick where only the numbers moved is the common case at speed 1.
const sceneSig = s => JSON.stringify([
  s.caravans.map(c => [c.leader, c.role, c.latitude, c.longitude, c.settled, c.unitId]),
  (s.colonies || []).map(c => [c.latitude, c.longitude]),
]);
let lastSig = null;

// The snapshot-driven chrome: the HUD, the transport controls, the Spectate tab tint. All derived
// from the snapshot alone, so it can be replayed from the retained `snap` at any time.
function paintChrome(s) {
  renderHud();
  onState(s.clockState, s.date);              // sync the transport controls (play icon, speed, date)
  liveTabRunning(s.clockState === "RUNNING"); // tint the Spectate tab while the session is live/unpaused
}
// Coming back to the tab: rebuild the chrome from the last snapshot we kept. Without this a PAUSED
// session would show whatever the HUD said when you left — no further snapshot is coming to fix it.
document.addEventListener("visibilitychange", () => { if (!document.hidden && snap) paintChrome(snap); });

// A stopped clock: show the terminal screen and disable play/pause. Two flavours, told apart by the
// OUTCOME (docs/session-management.md):
//   - FINISHED (outcome != LIVE — won/lost/abandoned): the run will never tick again, so this is the
//     one case where the never-give-up reconnect must give up, or it replays the cached final frame
//     forever (docs/game-over.md). We close the feed and stop retrying.
//   - stopped from OUTSIDE (outcome == LIVE — an admin, a redeploy): still restorable, so we show the
//     banner but keep the feed's reconnect alive; a restored RUNNING/PAUSED frame clears it (hideStopped).
let ended = false;          // finished for good — no more frames are coming
let stoppedShown = false;   // the terminal card is up (finished or suspended)

// `ended` is read by three surfaces that must not disagree — the reconnect loop (stop trying), the
// HUD status strip (say "game over") and the diagnostics chip (go idle) — so it is written in one
// place rather than assigned at each of the four sites that end or revive a run.
function setEnded(over) {
  ended = over;
  setSessionEnded(over);
}
function showStopped(s) {
  const finished = s.outcome && s.outcome !== "LIVE";
  if (finished && !ended) {
    setEnded(true);
    if (es) { es.close(); es = null; }       // no more frames are coming
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }
  if (stoppedShown) return;                  // the cached stopped frame arrives on every subscribe
  stoppedShown = true;
  setHudStatus("game over");
  const el = document.getElementById("gameover");
  if (!el) return;
  const kicker = document.querySelector("#gameover .go-kicker");
  const titleEl = document.getElementById("goTitle");
  const reason = document.getElementById("goReason");
  const date = document.getElementById("goDate");
  // any stopped clock reads GAME OVER with the transport disabled (owner decision, 2026-07-19) — a
  // stopped run is not one you can drive, whichever way it stopped. A suspended (LIVE-outcome) stop
  // keeps reconnecting under the hood, so a restored run clears this card (hideStopped).
  if (kicker) kicker.textContent = "The chronicle ends";
  if (titleEl) titleEl.textContent = "Game Over";
  if (reason) reason.textContent = s.endReason
    || (finished ? "The run has ended." : "The session has stopped.");
  if (date) date.textContent = s.date ? `${s.date} · ${s.tick} days` : "";
  el.hidden = false;
}
// a live (running/paused) frame arrived — clear a terminal card that a suspended stop had put up, so
// a restored run re-attaches without the "stopped" screen lingering. A truly finished run never gets
// here (its feed is closed), so this cannot un-end one.
function hideStopped() {
  if (!stoppedShown) return;
  stoppedShown = false;
  const el = document.getElementById("gameover");
  if (el) el.hidden = true;
}

// A chosen session the viewer cannot watch — private to someone else, finished-and-forgotten, or
// never real. Show a notice and STAY PUT (docs/session-management.md): the map never silently swaps
// to a different session. Reuses the terminal card with dead-link wording.
function showDeadLink(id) {
  setEnded(true);                           // there is nothing to reconnect to
  if (es) { es.close(); es = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  setHudStatus("unavailable");
  const el = document.getElementById("gameover");
  if (!el) return;
  const kicker = document.querySelector("#gameover .go-kicker");
  const titleEl = document.getElementById("goTitle");
  const reason = document.getElementById("goReason");
  const date = document.getElementById("goDate");
  if (kicker) kicker.textContent = "Nothing to watch here";
  if (titleEl) titleEl.textContent = "Run unavailable";
  if (reason) reason.textContent = "That run is private, has ended, or no longer exists.";
  if (date) date.textContent = id ? String(id) : "";
  stoppedShown = true;
  el.hidden = false;
}

// the terminal card's "Back to lobby": dismiss the card and re-open the lobby (dynamic import, the
// same path index.html's during-load open uses — live.mjs must not statically depend on lobby.mjs,
// which deliberately imports no core). Wired once at module load; the button lives in the static HTML.
{
  const goLobby = document.getElementById("goLobby");
  if (goLobby)
    goLobby.addEventListener("click", () => {
      const go = document.getElementById("gameover");
      if (go) go.hidden = true;
      import("../lobby.mjs").then(m => m.openLobby()).catch(() => { /* lobby unavailable — card just closes */ });
    });
}

function onSnapshot(s) {
  snap = s;
  // a stopped clock shows the terminal screen and disables play/pause — a game-over OR a plain
  // external stop (docs/session-management.md). A live frame (running/paused) clears it, so a
  // suspended run that gets restored re-attaches cleanly.
  if (s.clockState === "STOPPED") showStopped(s);
  else hideStopped();
  // the B6 pause-and-choose interrupt: a seated session auto-paused on an empty ruler
  // queue asks the player for the next center building(s); submitting resumes (server)
  syncBuildChoice(s);
  // point the viewport-windowed route feed at this session and flag the provinces whose route layer
  // changed this frame, so the draw layer refetches only those (routefetch.mjs). The refetch is async
  // and repaints itself when the layer lands, so it does not feed the repaint decision below.
  setRouteSession(s.sessionId);
  invalidateRoutes(s.routeDirty);
  s.caravans.forEach(c => {
    const t = (trails[c.leader] = trails[c.leader] || []);
    t.push([c.latitude, c.longitude]);
    if (t.length > 500) t.shift();
  });
  // open on the colony once — UNLESS the visitor deep-linked to a province/zoom (?p=&z=),
  // whose framing (applyHash) we must not stomp. A plain load (no deep link) still opens on the action.
  if (!framed && s.colonies[0]) { if (!hasDeepLink()) frameOn(s.colonies[0].latitude, s.colonies[0].longitude, 6); framed = true; }
  // This frame's log is a DELTA, and a reconnect is handed the CACHED frame again — so ingest the
  // lines only the first time we see a tick, or every reconnect re-posts them (docs/game-over.md).
  const freshLines = logGate.accept(s.sessionId, s.tick) ? s.log : [];
  ingestLog(freshLines);      // feed the event-log bar this frame's new lines
  // …and the notification board, which also needs s.date: it must age, redden and expire its cards
  // on every tick, including the overwhelmingly common one whose log delta is empty.
  ingestNotify(freshLines, s.date);
  // The chrome below is a pure function of `snap`, so a hidden tab can skip it and rebuild on
  // return (paintChrome, wired to visibilitychange) — no point rewriting innerHTML nobody can see.
  // NB ingestLog above is deliberately NOT skipped: s.log is a per-tick DELTA, so a skipped tick
  // would drop those lines from the event log for good.
  if (!document.hidden) paintChrome(s);
  // ...but only repaint the map when the map actually changed. This was the one repaint in the app
  // driven by nothing but the clock — every tick forced a full scene render, up to UNCAPPED at
  // speed 5 (LIVE_RATES ends in 0), however far the camera was parked from the action.
  const sig = sceneSig(s);
  if (sig !== lastSig) { lastSig = sig; redraw(); }
  onRoster(liveRoster());     // let the advisor selector/rail track the roster (succession)
  // let the tech tree (if open) refresh its researched-state styling from the new known set —
  // decoupled via a DOM event so live.mjs need not import techtree.mjs
  window.dispatchEvent(new CustomEvent("civstudio:snapshot"));
}

// centre the camera on a lon/lat at scale k (used once, so Live mode opens on the action rather
// than the whole world). NB this now CLAMPS as well: it was the only one of the four centring
// sites that hand-rolled the camera commit WITHOUT clampPan, so opening on a colony near the map
// edge could park the camera out of bounds. centerOn does the whole commit — see core.mjs.
function frameOn(lat, lon, k) {
  if (!(VIEW.w > 0)) return;
  centerOn(baseXr(sxSrc(lon)), baseYr(sySrc(lat)), k);
}

/** Draw the live colony + caravans. Called by main.renderScene per world-copy in Live mode. */
export function drawLive() {
  if (!snap) return;

  // caravan trails, then dots. The trail polyline is the OVERVIEW stand-in only: it joins province
  // centroids, so it is the right shape at atlas zoom (a province is a few pixels) and the wrong one
  // once plots are legible. Past the Province→Terrain threshold the band's real walked corridor is
  // already on screen as baked Civ4 route art (routes.mjs), stamped per plot from the trail the
  // explorer pioneered — so the polyline fades OUT exactly as that art fades IN, on the complement of
  // its [3.5, 4.5] envelope. Same hand-off the city marker makes to the baked city sprite below.
  const trailA = bandAlpha([-Infinity, -Infinity, 3.5, 4.5]);
  snap.caravans.forEach((c, i) => {
    const col = ROLE_COLOR[c.role] || PALETTE[i % PALETTE.length];
    const tr = trails[c.leader] || [];
    if (tr.length > 1 && trailA > 0.01) {
      ctx.save();
      ctx.globalAlpha = trailA;
      ctx.beginPath();
      tr.forEach((p, k) => { const [x, y] = pllOn(p[1], p[0]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      // a dark casing under the route + a soft glow, so it reads over any terrain rather than
      // blending in; then the bright coloured line on top
      ctx.shadowColor = "rgba(3,6,11,.9)"; ctx.shadowBlur = 4;
      ctx.strokeStyle = "rgba(6,9,14,.9)"; ctx.lineWidth = 5.5; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = col; ctx.globalAlpha = trailA * .95; ctx.lineWidth = 2.6; ctx.stroke();
      ctx.restore();
    }
    const [x, y] = pllOn(c.longitude, c.latitude), r = c.settled ? 6 : 4.6;
    // Overland (BAND.PROVINCE+) shows the embodied unit: its button icon as the marker + a name and
    // signature-skill readout below. At atlas zoom (or a band with no embodied unit) it stays a role
    // dot — the icon would be oversized against the tiny provinces. docs/c2c-unit-import.md §1a.
    const overland = atLeast(BAND.PROVINCE);
    const drewIcon = overland && c.unitIcon && USHEET.complete && USHEET.naturalWidth;
    const isz = c.settled ? 24 : 20;   // icon box side (px)
    if (drewIcon) {
      const sx = c.unitIcon[0], sy = c.unitIcon[1];
      ctx.beginPath(); ctx.arc(x, y, isz / 2 + 2, 0, 7);
      ctx.fillStyle = "rgba(6,9,14,.85)"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, isz / 2, 0, 7); ctx.clip();
      ctx.drawImage(USHEET, sx, sy, 64, 64, x - isz / 2, y - isz / 2, isz, isz);
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = col; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.strokeStyle = "#0b0f16"; ctx.lineWidth = 1.6; ctx.stroke();
    }
    // record a click/hover hit-target for this band (docs/caravan.md — the composition panel). Rides
    // the same S.markers pipeline as the cave/realm glyphs (reset each frame by paintScene, hit-tested
    // by maptip.markerAt); a caravan marker carries the CaravanView so the click can open its rail.
    S.markers.push({ x, y, r: (drewIcon ? isz / 2 + 3 : r + 3),
      label: c.unitName ? `${c.unitName} · ${c.leader}` : c.leader, caravan: c });
    if (overland && c.unitName) {
      const ly = y + 14;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.font = `600 11px ${LABEL_FONT}`;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(6,9,14,.85)"; ctx.strokeText(c.unitName, x, ly);
      ctx.fillStyle = "#eef2f8"; ctx.fillText(c.unitName, x, ly);
      if (c.signatureSkill) {
        const skill = `${cap1(c.signatureSkill)} · ${c.leaderSkill}`;
        ctx.font = `500 9.5px ${LABEL_FONT}`;
        ctx.strokeText(skill, x, ly + 13);
        ctx.fillStyle = "#aeb8c6"; ctx.fillText(skill, x, ly + 13);
      }
      ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
    }
  });

  // the city: at the overview (plots not textured) draw a small marker; once zoomed past the
  // texture threshold the baked city sprite on the urban-core plot takes over, so the marker drops
  // and only the name stays — centred beneath. Hover the city province for its details (city +
  // development), added to panel.provTip. See docs/urban-plots.md.
  const colony = snap.colonies[0];
  if (colony && Number.isFinite(colony.latitude)) {
    const [x, y] = pllOn(colony.longitude, colony.latitude);
    const overview = !atLeast(BAND.TERRAIN);
    if (overview) {
      ctx.fillStyle = cssVar("--accent") || "#e8b76a";
      ctx.strokeStyle = "#0b0f16"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.stroke();
    }
    // the city name, centred beneath the site, with a dark halo so it reads over any terrain
    const label = colony.name || "colony", ly = y + (overview ? 9 : 6);
    ctx.font = `600 13px ${LABEL_FONT}`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(6,9,14,.85)"; ctx.strokeText(label, x, ly);
    ctx.fillStyle = "#eef2f8"; ctx.fillText(label, x, ly);
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
  }
}

// ---- the live colony's vitals, in the top bar ----
// This replaces the old #liveHud rail panel. That panel made Live mode the one mode with its own
// bespoke rail, and filled it with three different kinds of thing: session debug (tick, session id),
// colony vitals, and tax WRITE controls. They have gone three ways:
//   - tick / session id: dropped. The date is already in the Zeitgeist clock, and the rest was
//     debug-grade readout that no spectator was reading.
//   - colony vitals: here, in the top bar — they describe the SESSION, so they should not depend on
//     where the camera is (the same reasoning as the Zeitgeist segment's colony label). The
//     per-province detail lives inline in the province rail instead (panel.provinceRail).
//   - tax levers: moved to the admin console (web/admin.html), where the other write controls
//     already are and where the ROLE_ADMIN gate already applies.
// Live mode now uses the same rail as every other mode.
const el = id => document.getElementById(id);

function hud(show) {
  const v = el("liveVitals");
  if (v && !show) v.textContent = "";
  showLiveLog(show, serverLabel());   // the event-log bar tracks Live mode
  showNotify(show);                   // …and so does the notification board
}

// Connection state ("connecting…", "reconnecting…") goes where the vitals go: it is the answer to the
// same question — how is the session doing — and the first real snapshot overwrites it with the
// numbers. It used to have a dedicated badge in the HUD; a strip that says "reconnecting…" and then
// starts showing figures tells the same story without the chrome.
function setHudStatus(text) {
  const v = el("liveVitals");
  // Once the run is FINISHED there is nothing left to connect to, so the transport's own
  // "connecting…/reconnecting…" chatter — which the teardown still emits on its way down — is a lie
  // about a chronicle that has ended. The terminal wording wins over anything the socket says.
  if (v) v.innerHTML = `<span class="lv lv-status">${ended ? "game over" : text}</span>`;
}

function renderHud() {
  const v = el("liveVitals");
  if (!v || !snap) return;
  // …and the vitals must not paint over it either: the cached terminal frame is re-delivered on
  // every subscribe, and each one used to restore a strip of figures for a colony that is gone.
  if (ended) { setHudStatus("game over"); return; }
  const c = snap.colonies[0] || {};
  if (!c.name) { v.textContent = ""; return; }
  // one compact strip; the colony's NAME is already the Zeitgeist segment's label, so it is not
  // repeated here. Each figure carries a title — the glyphs are recognisable, not self-explanatory.
  v.innerHTML = [
    ["👤", c.population, "Population — the colony's living households"],
    ["⛏", c.poolSize, "Peasant pool — the labour reserve the workforce is drawn from"],
    ["🍼", c.children, "Children born into the colony"],
    ["🏭", c.firms, "Firms currently chartered"],
    ["👑", c.nobles, "Nobles in the aristocracy"],
    ["🌾", fmtNum(c.necessityPrice || 0), "Food price — the necessity market's last clearing price"],
    ["🐫", (snap.caravans || []).length, "Caravans afield"],
  ].map(([ico, val, tip]) =>
    `<span class="lv" data-tip="${tip}"><span class="lv-i">${ico}</span>${val}</span>`).join("");
}

// post a lobby chat message to the session (server attaches the authoritative username). The owner
// check doesn't apply — any signed-in user may chat — but the cookie must ride (cross-origin).
async function postChat(text) {
  if (!sid) return;
  try {
    await fetch(LIVE_BASE + "/api/sessions/" + sid + "/chat",
      { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch (err) { /* transient — the message just won't post */ }
}

// "@ask <question>" from the log bar — the same gesture the lobby has, pointed at THIS session's
// room so the answer comes back where it was asked (server: SessionController#ask → LoreChat). The
// server posts both the question and the Loremaster's reply into the room, so nothing is drawn
// here: both arrive over the SSE `chat` event like any other line. Only a refusal is shown locally,
// since a question the room never received should not look as though it were asked.
async function postAsk(question) {
  if (!sid) return;
  try {
    const res = await fetch(LIVE_BASE + "/api/sessions/" + sid + "/ask",
      { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: question }) });
    if (!res.ok)
      ingestChat({ user: "Loremaster", text: res.status === 503 || res.status === 404
        ? "the lore chatbot isn't enabled on this server yet."
        : "(could not ask — " + res.status + ")" });
  } catch (err) {
    ingestChat({ user: "Loremaster", text: "(lore service unreachable)" });
  }
}

// --- the B6 pause-and-choose modal (docs/build-queue-plan.md) -------------------------
// Shown while the snapshot carries awaitingBuildChoice — the server has genuinely paused a
// seated (SINGLE_PLAYER) session's clock on an empty ruler queue (HostedSession.maybeAwait-
// BuildChoice); submitting queue_build resumes it. Styled as a Civ4 "choose production" menu:
// each candidate row is icon · name · hammer cost, click order IS queue order (a numbered
// badge shows it), and the first candidate — the ruler-brain's highest-weighted pick — is
// flagged ★ advised. Candidates arrive as bare ids; name/cost/icon join the /api/buildings
// bundle (the same one the tech tree + districts read), falling back to a prettified id.
let bcPick = null;               // the live picker controller (its click order = queue order)
let bcSubmitted = false;         // a decree is in flight — see syncBuildChoice

function syncBuildChoice(s) {
  const el = document.getElementById("buildchoice");
  if (!el) return;
  if (!s.awaitingBuildChoice || s.clockState === "STOPPED") {
    el.hidden = true;
    bcSubmitted = false;   // the server cleared the await — the next one is a real, new prompt
    return;
  }
  if (!el.hidden) return; // already open — keep the player's in-progress picks
  // a decree we already submitted is still applying server-side: the queue_build command takes a
  // tick to land, so the snapshot keeps reporting awaitingBuildChoice for a frame or two. Without
  // this guard the just-closed modal reopens on that stale snapshot (the "shows up twice" bug),
  // then vanishes once the decree lands. Hold it closed until the await genuinely clears above.
  if (bcSubmitted) return;

  const colony = s.colonies && s.colonies[0] && s.colonies[0].name;
  const kicker = document.getElementById("bcKicker");
  if (kicker) kicker.textContent = colony
    ? colony + " · the crown awaits your decree" : "The crown awaits your decree";

  const submit = document.getElementById("bcSubmit");
  submit.disabled = true;
  bcPick = renderPicker(document.getElementById("bcList"), s.buildCandidates || [],
    { onChange: picked => { submit.disabled = picked.length === 0; } });
  submit.onclick = async () => {
    const items = bcPick.picked();
    if (!items.length) return;
    el.hidden = true;
    bcSubmitted = true;
    // if the command is refused (not the owner, session gone), let the prompt come back so the
    // player can retry rather than being stuck behind a hidden-but-still-awaiting modal
    const ok = await postCommand({ type: "queueBuild", colony, items });
    if (!ok) bcSubmitted = false;
  };
  el.hidden = false;
}

/**
 * Submit a player command to the live session (the general command seam — the build queue, the
 * playback transport). Owner-gated server-side; the cookie rides along.
 *
 * @returns the accepted-command body, or null if it was refused
 */
export async function postCommand(body) {
  if (!sid) return null;
  // credentials: player commands are owner-gated (see docs/authentication.md) — send the cookie
  const r = await fetch(LIVE_BASE + "/api/sessions/" + sid + "/commands",
    { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.ok ? r.json() : null;
}

// (applyTax lived here, driving the retired HUD's tax inputs. Setting a tax rate is an owner/admin
//  write, so it now sits in the admin console next to the other write controls — see web/admin.html.
//  postCommand stays: it is the general command seam, and the playback transport uses it.)
