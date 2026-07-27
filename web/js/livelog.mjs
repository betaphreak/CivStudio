"use strict";
// Live event-log bar. In Live mode a collapsed one-line strip sits at the bottom of the map
// showing the latest event; clicking it expands a scrollable, chat-style history above it. It is
// fed by live.mjs from each SSE snapshot's `log` delta (see docs/client-server.md). Each line
// reads "<server>@<in-game-date>  <message>" — the server label is passed in from the connected
// server. "show all" reveals routine churn; otherwise only curated events (foundings, deaths,
// policy changes, anomalies — flagged server-side) are shown.

const el = id => document.getElementById(id);
// history entries are either event-log lines {date, text, curated, sev} or lobby chat
// {kind:"chat", user, text}. Chat is always shown; log lines obey the curated / "show all" filter.
const history = [];
let server = "live";     // header prefix (e.g. "dev"), set on show
let expanded = false;
let wired = false;
let sendChat = null;     // callback (text) => post a chat message; set by live.mjs
let sendAsk = null;      // callback (question) => put a lore question to the room; set by live.mjs

const MAX = 600;         // cap the client-side history

/**
 * Register the callbacks the composer posts through (wired by live.mjs).
 *
 * @param fn  posts a plain chat message
 * @param ask puts an "@ask" lore question to the session's room (optional; without it @ask is
 *            simply said out loud, which is the old behaviour and not a broken one)
 */
export function setChatSender(fn, ask) { sendChat = fn; sendAsk = ask || null; }

/** Show/hide the bar (wiring it once). serverLabel becomes the header prefix, e.g. "dev". */
export function showLiveLog(show, serverLabel) {
  if (serverLabel) server = serverLabel;
  const box = el("liveLog");
  if (box) box.hidden = !show;
  if (show) wire();
}

/** Append a snapshot's log delta and refresh the view. */
export function ingestLog(lines) {
  if (!lines || !lines.length) return;
  for (const l of lines) history.push(l);
  while (history.length > MAX) history.shift();
  renderBar();
  if (expanded) renderHistory();
}

/** Append a lobby chat message (from the SSE `chat` event) and refresh the view. */
export function ingestChat(msg) {
  if (!msg || !msg.text) return;
  history.push({ kind: "chat", user: msg.user || "?", text: msg.text });
  while (history.length > MAX) history.shift();
  renderBar();
  if (expanded) renderHistory();
}

/** Clear history and collapse (on disconnect / leaving Live mode). */
export function resetLog() {
  history.length = 0;
  expanded = false;
  const h = el("liveLogHistory"); if (h) h.hidden = true;
  const line = el("liveLogLine"); if (line) line.textContent = "…";
}

function wire() {
  if (wired) return;
  const latest = el("liveLogLatest");
  if (!latest) return;
  const toggle = () => {
    expanded = !expanded;
    const h = el("liveLogHistory");
    if (h) h.hidden = !expanded;
    if (expanded) renderHistory();
  };
  latest.addEventListener("click", toggle);
  latest.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });
  const all = el("liveLogAll");
  if (all) all.addEventListener("change", () => { renderBar(); if (expanded) renderHistory(); });
  // chat input — functional only for signed-in users (the input is hidden for anon via CSS).
  // Typing here IS typing in the lobby, "@ask <question>" included: the bar is a chat box, and a
  // chat box where the same words do different things depending which one you are looking at is a
  // trap. The split is made here rather than in the sender so both surfaces read the same way
  // (cf. lobby.say) — the server posts question and answer into this session's room, so both come
  // back down the feed as ordinary lines and are drawn by ingestChat.
  const input = el("liveLogChatInput"), send = el("liveLogChatSend");
  const submit = () => {
    const t = ((input && input.value) || "").trim();
    if (!t) return;
    input.value = "";
    const m = t.match(/^@ask\s+([\s\S]+)/i);
    if (m && sendAsk) { sendAsk(m[1].trim()); return; }
    if (sendChat) sendChat(t);   // …including an @ask with nowhere to send it: say it out loud
  };
  if (input) input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  if (send) send.addEventListener("click", submit);
  // swallow map input: interacting with the bar (click to expand, scroll the history, type in chat)
  // must not also pan/zoom/select the map underneath (the stage handlers, like the minimap does)
  const box = el("liveLog");
  if (box) ["pointerdown", "mousedown", "click", "touchstart", "wheel"].forEach(t =>
    box.addEventListener(t, e => e.stopPropagation(), { passive: true }));
  wired = true;
}

function showAll() { const a = el("liveLogAll"); return !!(a && a.checked); }
// chat is always shown; log lines obey the curated / show-all filter
function visible() { return history.filter(l => l.kind === "chat" || showAll() || l.curated); }
function header(l) { return `${server}@${l.date || "----"}`; }

function sevClass(l) { return l.sev && l.sev !== "info" ? " sev-" + l.sev : ""; }

function renderBar() {
  const line = el("liveLogLine"); if (!line) return;
  const vis = visible();
  if (!vis.length) { line.textContent = "…"; line.className = "live-log-line"; return; }
  const l = vis[vis.length - 1];
  if (l.kind === "chat") {
    line.textContent = `${l.user}: ${l.text}`;
    line.className = "live-log-line chat";
  } else {
    line.textContent = `${header(l)}  ${l.text}`;
    line.className = "live-log-line" + sevClass(l);
  }
}

function renderHistory() {
  const box = el("liveLogLines"); if (!box) return;
  box.innerHTML = visible().map(rowHtml).join("");
  box.scrollTop = box.scrollHeight; // pin to newest
}

function rowHtml(l) {
  if (l.kind === "chat")
    return `<div class="live-log-row chat"><span class="live-log-user">${esc(l.user)}:</span> ${esc(l.text)}</div>`;
  return `<div class="live-log-row${l.curated ? " cur" : ""}${sevClass(l)}">` +
    `<span class="live-log-hdr">${esc(header(l))}</span>${esc(l.text)}</div>`;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
