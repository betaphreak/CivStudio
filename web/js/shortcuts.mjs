// The single hub for global keyboard shortcuts: one registry drives both the dispatch
// and the bottom bar (#hotbar), so a binding and its displayed hint can never drift. The
// actual actions live in the feature modules (map camera / playback in panel.mjs, the
// tech-tree modal in techtree.mjs); this module wires keys to them and renders the hints.
import { S, cam, VIEW, clampPan } from "./core.mjs";
import { draw } from "./repaint.mjs";
import { zoomAt } from "./main.mjs";
import { resetView, toggleFullscreen, togglePlay, closePanel } from "./panel.mjs";
import { setAdvisor } from "./advisors.mjs";
import { closeCityScreen } from "./city-screen.mjs";

// Open the Spectator Lobby. Via the window seam when the module is already loaded (the common case
// — the boot flow opens the lobby over the splash), else a dynamic import: a deep link or ?lobby=0
// skips that open, so on those loads this is the first time the lobby is needed. Deliberately NOT a
// static import — lobby.mjs must stay free of the map's module graph (it loads before core.mjs can
// exist), and live.mjs reaches it the same way.
function openLobby() {
  if (window.__lobby && window.__lobby.open) { window.__lobby.open(); return; }
  import("./lobby.mjs").then(m => m.openLobby()).catch(() => { /* no lobby — Esc just did nothing */ });
}

// pan the camera and repaint — the shared tail of the WASD / arrow handlers
function panBy(dx, dy) {
  cam.x += dx; cam.y += dy;
  clampPan(); S.baseVersion++; draw();
}

// One entry per shortcut. `keys` are the raw KeyboardEvent.key values that fire `run`;
// `cap` + `label` (when present) render a chip in the bottom bar. Entries with no `cap`
// (keyboard zoom, Home, arrow aliases) are dispatched but not shown.
const REGISTRY = [
  // Privy Council advisor modes (see advisors.mjs) — all modal-safe so they switch OUT of the
  // Technology advisor too. Only Technology carries a hotbar chip to keep the bar uncluttered.
  { keys: ["`"], modalSafe: true, run: e => { e.preventDefault(); setAdvisor("mainmap"); } },
  { keys: ["F4"], modalSafe: true, run: e => { e.preventDefault(); setAdvisor("foreign"); } },
  { keys: ["F6"], cap: ["F6"], label: "Tech tree", modalSafe: true,
    run: e => { e.preventDefault(); setAdvisor("technology"); } },
  { keys: ["F7"], modalSafe: true, run: e => { e.preventDefault(); setAdvisor("religion"); } },
  { keys: ["F11"], modalSafe: true, run: e => { e.preventDefault(); setAdvisor("globe"); } },
  { keys: ["z", "Z"], modalSafe: true, run: e => { e.preventDefault(); setAdvisor("zeitgeist"); } },
  // quick-open the unified search box (mode-scoped corpus)
  { keys: ["/"], modalSafe: true,
    run: e => { e.preventDefault(); document.getElementById("search")?.focus(); } },
  { keys: [" ", "Spacebar"], cap: ["Space"], label: "Play / pause",
    run: e => { e.preventDefault(); togglePlay(); } },
  { keys: ["f", "F"], cap: ["F"], label: "Fullscreen",
    run: e => { e.preventDefault(); toggleFullscreen(); } },
  { keys: ["0", "Home"], cap: ["0"], label: "Reset view",
    run: e => { e.preventDefault(); resetView(); } },
  { keys: ["w", "W", "ArrowUp", "s", "S", "ArrowDown",
           "a", "A", "ArrowLeft", "d", "D", "ArrowRight"],
    cap: ["W", "A", "S", "D"], label: "Pan",
    run: e => {
      e.preventDefault();
      const step = Math.max(40, Math.min(VIEW.w, VIEW.h) * 0.12);
      const move = {
        w: [0, step], W: [0, step], ArrowUp: [0, step],
        s: [0, -step], S: [0, -step], ArrowDown: [0, -step],
        a: [step, 0], A: [step, 0], ArrowLeft: [step, 0],
        d: [-step, 0], D: [-step, 0], ArrowRight: [-step, 0],
      }[e.key];
      if (move) panBy(move[0], move[1]);
    } },
  { keys: ["Escape"], cap: ["Esc"], label: "Lobby / close", modalSafe: true,
    // Escape unwinds what is on screen, innermost first: the city screen closes back to the map; in
    // the Technology advisor it returns to Main Map (keeps the selector consistent); then it
    // collapses the sidebar. With NOTHING left to close it opens the lobby — the door the wordmark
    // watermark used to be, before that was taken off the map (2026-07-27). Closing the lobby again
    // is the lobby's own handler, which consumes the key before this one ever sees it.
    run: e => {
      if (S.cityOpen) { e.preventDefault(); closeCityScreen(); }
      else if (S.techOpen) { e.preventDefault(); setAdvisor("mainmap"); }
      else if (closePanel()) { e.preventDefault(); }
      else { e.preventDefault(); openLobby(); }
    } },
  { keys: ["+", "="],
    run: e => { e.preventDefault(); zoomAt(VIEW.w / 2, VIEW.h / 2, 1.5); } },
  { keys: ["-", "_"],
    run: e => { e.preventDefault(); zoomAt(VIEW.w / 2, VIEW.h / 2, 1 / 1.5); } },
];

/** Render the hint chips into #hotbar and install the one global keydown dispatcher. */
export function initShortcuts() {
  const bar = document.getElementById("hotbar");
  if (bar) bar.innerHTML = REGISTRY.filter(s => s.cap).map(s =>
    `<span class="hk">${s.cap.map(k => `<kbd>${k}</kbd>`).join("")} ${s.label}</span>`
  ).join("");

  window.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;                                  // leave OS/browser combos alone
    if (e.target instanceof HTMLElement && e.target.matches("input, textarea")) return;   // don't hijack typing
    const modal = S.techOpen || S.cityOpen;   // a modal runs in paused mode — only modal-safe keys pass (no play/pan/zoom)
    for (const s of REGISTRY)
      if (s.keys.includes(e.key)) {
        if (modal && !s.modalSafe) { e.preventDefault(); return; }
        s.run(e);
        return;
      }
  });
}
