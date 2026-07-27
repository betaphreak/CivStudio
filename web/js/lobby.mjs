"use strict";
// The Spectator Lobby (docs/spectator-lobby.md Phase 5) — the room you are in before you have
// picked a session: a browser of what is running, a chat that belongs to no session, and the two
// ways to play.
//
// Opened over the live map by the brand ("home"), dismissed with Esc or a click outside — the
// gesture the server picker already taught. The picker keeps its own job (choosing a server); the
// lobby is what you get once one is chosen, and links back to it.
//
// Everything here is painting and plumbing. The decisions — what a row is called, what its status
// says, which face a button wears — live in lobby-rows.mjs, pure and unit-tested.
// NB this module deliberately does NOT import core.mjs. The lobby opens *during the load* — while
// the bundle is still downloading — and core.mjs reads window.BUNDLE at import time, so importing it
// would mean the lobby could only exist after the very wait it is meant to fill. Its only need from
// core was the server base, which it resolves the same way core does (below).
import { title, status, isOver, canDelete, singlePlayer, ranked, order, KIND } from "./lobby-rows.mjs";
// Sign-in lives in the lobby (the account control renders into #siteAuth in its header), so this
// imports auth — which is why auth had to stop importing core.mjs too. Both must survive being
// loaded before the world does.
import { initSiteAuth, whoAmI, onAuthChange } from "./auth.mjs";

const REFRESH_MS = 4000;   // the list is a poll: a browser list does not need frame-accurate pushes
const SLOT_LIMIT = 5;      // mirrors SessionHost.SAVE_SLOT_LIMIT; the server is still the authority

let el, rows = [], signedIn = false, isAdmin = false, es = null, timer = null, open = false;
let base = "";             // the server this lobby is a lobby FOR

const $ = id => document.getElementById(id);
const apiUrl = path => base + path;

// The same resolution core.mjs does — an explicit ?live=, else the base the bootstrap recorded on
// the fetched bundle, else the default cloud server — but without needing the bundle to exist yet.
function resolveBase(given) {
  if (given) return given.replace(/\/+$/, "");
  const explicit = new URLSearchParams(location.search).get("live");
  if (explicit) return explicit.replace(/\/+$/, "");
  const b = window.BUNDLE;
  return (b && b.live && b.live.base) || "https://dev.civstudio.com";
}


/**
 * Wire the lobby once. Idempotent, and safe to call before the bundle exists.
 * @param serverBase the server this lobby lists (defaults to the one the page is pointed at)
 */
export function initLobby(serverBase) {
  base = resolveBase(serverBase);
  el = $("lobby");
  if (!el || el.dataset.wired) return;
  el.dataset.wired = "1";

  $("lobbyClose").onclick = closeLobby;
  el.addEventListener("click", e => { if (e.target === el) closeLobby(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !open) return;
    // Esc is now the lobby's DOOR, both ways (shortcuts.mjs opens it when nothing else is up), so
    // this handler must consume the key: it listens on `document` and the global dispatcher on
    // `window`, so without stopPropagation the same press would close the lobby here and then
    // immediately reopen it there.
    e.stopPropagation();
    // the setup panel is a step INSIDE the lobby: Esc backs out of it first, not all the way to the map
    if (!$("lobbySetup").hidden) { e.preventDefault(); showSetup(false); return; }
    e.preventDefault();
    closeLobby();
  });

  // signing in or out repaints the room: which buttons you may press is a fact about you
  onAuthChange(me => { signedIn = !!me.authenticated; isAdmin = !!me.admin; paint(); gateChat(); });
  $("lobbyRestartDemo").onclick = restartDemo;

  $("lobbySay").onsubmit = e => { e.preventDefault(); say(); };
  $("lobbySolo").onclick = () => showSetup(true);
  $("lobbyRanked").onclick = onRanked;
  $("setupCancel").onclick = () => showSetup(false);
  $("setupRoll").onclick = () => { $("setupSeed").value = rollSeed(); };
  $("setupFound").onclick = found;
}

/**
 * Open the lobby — over the map (from "home"), or over the loading splash while the world is still
 * downloading, which is what it is really for: the wait becomes the choosing.
 *
 * @param serverBase the server to list (defaults to the one the page is pointed at)
 */
export function openLobby(serverBase) {
  initLobby(serverBase);
  open = true;
  el.hidden = false;
  $("lobbyServer").textContent = base.replace(/^https?:\/\//, "");
  showSetup(false);
  // Ask the server who you are, rather than guessing from the rows. Inferring sign-in from "do you
  // own any of these runs" said SIGNED OUT to a signed-in player with no runs yet — who could then
  // never make their first. The account control (sign in / register / sign out) paints itself.
  whoAmI().then(me => { signedIn = !!me.authenticated; isAdmin = !!me.admin; paint(); gateChat(); });
  initSiteAuth();
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
  connectChat();
}

// the composer is for people who can post; everyone else gets told how to become one
function gateChat() {
  $("lobbySay").hidden = !signedIn;
  $("lobbySignin").hidden = signedIn;
}

/**
 * Re-deal the caravan demo from day zero (operators only — POST /api/admin/demo/restart, which
 * checks ROLE_ADMIN again server-side; the hidden button is only about not offering what you cannot
 * do). The list refresh that follows brings the new run in, and a spectator watching the old id
 * re-resolves on its next reconnect.
 */
async function restartDemo() {
  if (!window.confirm("Restart the caravan demo? The running one is discarded and re-founded from day zero."))
    return;
  const btn = $("lobbyRestartDemo");
  btn.disabled = true;
  const out = await post("/api/admin/demo/restart", {});
  btn.disabled = false;
  if (!out.ok) { $("lobbyHint").textContent = out.error || "could not restart the demo"; return; }
  refresh();
  if (out.body.id) spectate({ id: out.body.id });
}

/** Back to the map. */
export function closeLobby() {
  open = false;
  if (el) el.hidden = true;
  if (timer) { clearInterval(timer); timer = null; }
  if (es) { es.close(); es = null; }   // the chat feed is only live while you are in the room
}

/** Whether the lobby is the thing on screen (so Esc/shortcuts know who owns the key). */
export const lobbyOpen = () => open;

// The window seam the rest of the app reaches the lobby through — the same handle index.html
// exposes for the server picker (window.__picker) and the realm selector (window.__realms).
// panel.mjs and advisors.mjs have always CALLED it; nothing ever SET it, so every "home" route
// silently fell through to the server picker. Registered at module load, since importing this
// module at all means the lobby exists.
window.__lobby = { open: openLobby, close: closeLobby, isOpen: lobbyOpen };

// ---- the list -------------------------------------------------------------

async function refresh() {
  try {
    const res = await fetch(apiUrl("/api/sessions"), { credentials: "include", cache: "no-store" });
    if (!res.ok) return;
    rows = await res.json();
    paint();
  } catch { /* a lobby that cannot reach the server just shows what it last knew */ }
}

function paint() {
  const list = $("lobbySessions");
  list.textContent = "";
  const ordered = order(rows);
  $("lobbyCount").textContent = ordered.length ? `(${ordered.length})` : "";
  if (!ordered.length) {
    const empty = document.createElement("div");
    empty.className = "lb-empty";
    empty.textContent = "Nothing is running here yet.";
    list.append(empty);
  }
  for (const row of ordered) list.append(rowEl(row));

  const solo = singlePlayer(rows, signedIn, SLOT_LIMIT);
  applyBtn($("lobbySolo"), solo);
  applyBtn($("lobbyRanked"), ranked(rows, signedIn));
  $("lobbyHint").textContent = solo.hint;
  // the operator lever: offered only to an admin, and only while there is a demo to restart
  $("lobbyRestartDemo").hidden = !(isAdmin && rows.some(r => r.kind === KIND.DEMO));
}

function rowEl(row) {
  const item = document.createElement("div");
  item.className = "lb-item" + (isOver(row) ? " over" : "") + (row.mine ? " mine" : "");
  item.setAttribute("role", "listitem");

  const main = document.createElement("button");
  main.className = "lb-item-main";
  main.onclick = () => spectate(row);
  const h = document.createElement("span");
  h.className = "lb-item-title";
  h.textContent = title(row);
  const s = document.createElement("span");
  s.className = "lb-item-sub";
  s.textContent = status(row);
  main.append(h, s);

  const meta = document.createElement("span");
  meta.className = "lb-item-meta";
  meta.textContent = row.watching ? `👁 ${row.watching}` : "";

  item.append(main, meta);
  if (canDelete(row)) {
    const del = document.createElement("button");
    del.className = "lb-del";
    del.textContent = "Delete";
    del.title = "Delete this run";
    del.onclick = () => remove(row);
    item.append(del);
  }
  return item;
}

function applyBtn(btn, face) {
  btn.textContent = face.label;
  btn.disabled = !face.enabled;
  btn.title = face.hint || "";
  btn.dataset.session = face.id || "";
  btn.dataset.join = face.join ? "1" : "";
}

// Watching a session means two things: be in Live mode, and be pointed at THAT session. The first is
// the overlay toggle's own affordance (click it rather than reach into its state); the second is an
// event live.mjs listens for, so neither module imports the other.
function spectate(row) {
  // a session carries its realm (docs/realms.md §A session carries its realm) — if it lives in another
  // realm, cross to it first. The choice rides in the URL (?session=), so it survives the reload with
  // no side-channel needed; the sessionStorage intents are kept as a belt-and-braces fallback.
  // `halcann` is the retired Old-World key, resolved to Cannor as core.mjs does — so a session
  // recorded before the six-realm split does not read as "another realm" and reload for nothing
  const _r = new URLSearchParams(location.search).get("realm");
  const active = (_r === "halcann" ? "cannor" : _r) || "cannor";
  if (row.realm && row.realm !== active) {
    const u = new URL(location.href);
    u.searchParams.set("realm", row.realm);
    if (row.id) u.searchParams.set("session", row.id);
    u.searchParams.delete("p"); u.searchParams.delete("z");
    try { sessionStorage.setItem("cs.spectate", row.id); sessionStorage.setItem("cs.realmSwitch", "1"); } catch { /* private mode */ }
    location.assign(u.toString());
    return;
  }
  closeLobby();
  // Pin the choice in the URL — the source of truth live.mjs reads on (re)connect
  // (docs/session-management.md): shareable, reload-survivable, and never silently swapped. This
  // replaced the fragile window-global + list[0] handoff that once left a founded session on the demo.
  if (row.id) {
    try {
      const u = new URL(location.href);
      u.searchParams.set("session", row.id);
      history.replaceState(history.state, "", u);
    } catch { /* history unavailable — the event below still delivers the choice */ }
  }
  // The lobby can be open BEFORE the app exists (during the load); window.__spectate is the fallback
  // for that pre-URL-read moment, and the event covers the already-running app.
  window.__spectate = row.id;
  const live = document.querySelector('#overlayToggle button[data-ov="live"]');
  if (live && !live.classList.contains("on")) live.click();
  window.dispatchEvent(new CustomEvent("civstudio:spectate", { detail: { id: row.id } }));
}

async function remove(row) {
  if (!window.confirm(`Delete ${title(row)}? This cannot be undone.`)) return;
  let ok = false, error = null;
  try {
    const res = await fetch(apiUrl("/api/sessions/" + encodeURIComponent(row.id)),
      { method: "DELETE", credentials: "include" });
    ok = res.ok;
    if (!ok) { try { error = (await res.json()).error; } catch { /* empty body */ } error = error || ("HTTP " + res.status); }
  } catch (e) { error = String(e && e.message || e); }   // network/CORS failure — don't swallow it
  if (!ok) $("lobbyHint").textContent = error || "could not delete the run";
  refresh();
}

// ---- play -----------------------------------------------------------------

function onRanked() {
  const btn = $("lobbyRanked");
  if (!btn.dataset.session) return;
  if (btn.dataset.join) return join(btn.dataset.session);
  spectate({ id: btn.dataset.session });
}

async function join(id) {
  const out = await post("/api/sessions/" + encodeURIComponent(id) + "/join", {});
  if (out.ok) spectate({ id });
  else $("lobbyHint").textContent = out.error || "could not take a seat";
}

function showSetup(on) {
  $("lobbySetup").hidden = !on;
  $("lobbySolo").disabled = on || !singlePlayer(rows, signedIn, SLOT_LIMIT).enabled;
  if (on) {
    $("setupSeed").value = rollSeed();
    $("setupHint").textContent = singlePlayer(rows, signedIn, SLOT_LIMIT).hint;
    $("setupSeed").focus();
  }
}

// a seed the player can read back, share, and re-found the same world from
const rollSeed = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000);

async function found() {
  const seed = Number($("setupSeed").value);
  const provinceId = Number($("setupProvince").value);
  if (!Number.isFinite(seed) || !Number.isFinite(provinceId)) {
    $("setupHint").textContent = "seed and province are numbers";
    return;
  }
  $("setupFound").disabled = true;
  const out = await post("/api/sessions", { seed, provinceId, scenario: "caravan-demo" });
  $("setupFound").disabled = false;
  if (!out.ok) {
    // the server's refusals are worth reading out loud — a full shelf, or a finished run
    $("setupHint").textContent = out.error || "could not found the run";
    refresh();
    return;
  }
  showSetup(false);
  refresh();
  // carry the realm the server founded us into, so spectate() crosses to that realm's map when it
  // differs from the one on screen (docs/realms.md §A session carries its realm). Without it a session
  // founded outside Halcann would open on the wrong map. It lands PAUSED: survey the world, then press play.
  spectate({ id: out.body.id, realm: out.body.realm });
}

// ---- chat -----------------------------------------------------------------

function connectChat() {
  if (es) es.close();
  $("lobbyChat").textContent = "";
  // No withCredentials: listening is anonymous (the house rule), and asking for credentials turns
  // this into a cross-origin request the server's CORS does not allow — which failed silently, so
  // the chat simply never arrived. The session feed has always connected plainly, for the same reason.
  es = new EventSource(base + "/api/lobby/stream");
  es.addEventListener("chat", e => {
    try { addLine(JSON.parse(e.data)); } catch { /* ignore a bad frame */ }
  });
  es.onerror = () => { /* the lobby is not worth a reconnect storm; reopening re-subscribes */ };
}

function addLine(msg) {
  const box = $("lobbyChat");
  const line = document.createElement("div");
  line.className = "lb-line";
  const who = document.createElement("b");
  who.textContent = msg.user + ": ";
  line.append(who, document.createTextNode(msg.text));
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

async function say() {
  const input = $("lobbyText");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const m = text.match(/^@ask\s+([\s\S]+)/i);   // "@ask <question>" → the lore chatbot
  if (m) return askLore(m[1].trim());
  const out = await post("/api/lobby/chat", { text });
  if (out.status === 401) {
    // the session lapsed under us — re-ask who we are rather than assume, and let the gate follow
    const me = await whoAmI();
    signedIn = !!me.authenticated;
    gateChat();
    paint();
  }
}

/**
 * "@ask <question>" → the RAG lore chatbot, IN THE ROOM.
 *
 * This used to render the exchange client-side and post nothing, so an answer belonged to one tab
 * and vanished the moment the lobby was reopened (connectChat clears the box before replaying the
 * backlog). It now goes through POST /api/lobby/ask: the server posts the question, looks the answer
 * up, and posts that — so both lines arrive over the same SSE feed as ordinary chat, persist in the
 * ChatStore, and replay for whoever walks in later.
 *
 * Nothing is drawn here on purpose: the question comes back down the feed like anyone else's line,
 * and drawing it locally as well would show it twice. Only a REFUSAL is local — a message the room
 * never received should not look as though it were said.
 */
async function askLore(question) {
  const out = await post("/api/lobby/ask", { text: question });
  if (out.ok) return;
  const box = $("lobbyChat");
  const line = document.createElement("div");
  line.className = "lb-line lore";
  const who = document.createElement("b"); who.textContent = "Loremaster: ";
  const span = document.createElement("span");
  span.textContent = out.status === 503 || out.status === 404
    ? "the lore chatbot isn't enabled on this server yet."
    : `(${out.error || out.status || "unreachable"})`;
  line.append(who, span); box.append(line); box.scrollTop = box.scrollHeight;
}

async function post(path, body) {
  try {
    const res = await fetch(apiUrl(path), {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* 204s and empties have no body */ }
    return { ok: res.ok, status: res.status, body: parsed || {},
      error: parsed && parsed.error };
  } catch (e) {
    return { ok: false, status: 0, body: {}, error: String(e && e.message || e) };
  }
}
