"use strict";
// The top bar's transport: the EU4-style date, play/pause, and the five speed chevrons.
//
// Split out of panel.mjs, which had grown to ~690 lines across eight unrelated jobs (pan/zoom,
// tooltip, rail, theme, search, boot, …). This is one of the self-contained ones: it owns the
// #clock DOM and is the ONLY consumer of the live session's control API (controlLive / LIVE_RATES),
// so lifting it also takes panel's dependency on the live overlay with it.
//
// The clock/play/speed drive the LIVE hosted session — the only thing time means now that the
// recorded replay is gone (its data came from the server; see docs/client-server.md). Play/pause
// toggles the session over /control; the play icon reflects the SERVER's state, fed back through
// syncLiveTransport on every snapshot rather than assumed from the click. The controls are inert
// (and the clock hidden) outside the Caravans/live view.
import { liveActive, liveState, controlLive, LIVE_RATES,
  buildChoiceDeferred, advisedBuild, liveColony, postCommand } from "./overlays/live.mjs";
import { toast } from "./toast.mjs";
import { buildingName } from "./build-catalog.mjs";

const cDate = document.getElementById("cDate");
const playBtn = document.getElementById("playBtn"), playIcon = document.getElementById("playIcon");
const speedBox = document.getElementById("speed");
// speeds 1..5 = the live session's tick rate (in-game days per real second); see live.LIVE_RATES.
// Paused is the un-playing state.
const SPEEDS = [null,
  { name: "1 day / s" },
  { name: "2 days / s" },
  { name: "4 days / s" },
  { name: "10 days / s" },
  { name: "Max" }];
let speed = 1, playing = false;
const PAUSE_ICON = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>', PLAY_ICON = '<path d="M8 5v14l11-7z"/>';

function renderSpeed() {
  [...speedBox.children].forEach((c, i) => c.classList.toggle("on", (i + 1) <= speed));
  speedBox.classList.toggle("paused", !playing);
}
// controlling playback requires a signed-in user (docs/authentication.md); auth.mjs marks the
// body when anonymous, gating both the click and the keyboard-shortcut paths
function canControl() { return !document.body.classList.contains("auth-anon"); }

// the clock is drivable only while it is actually ticking or paused — a CREATED (not started) or
// STOPPED (ended / suspended) session takes no play/pause, so the transport is inert then
// (docs/session-management.md: a stopped run shows game over with play/pause disabled).
function clockControllable() {
  const s = liveState();
  return s === "RUNNING" || s === "PAUSED";
}

/** Toggle the live session between running and paused (the play button + the spacebar shortcut). */
export function togglePlay() {
  if (!(liveActive() && canControl() && clockControllable())) return;
  if (liveState() === "RUNNING") { controlLive("pause"); return; }
  // RESUMING while the crown is still waiting on a decree the player dismissed. A plain "resume"
  // here does nothing useful: the server pauses on an empty ruler queue, so it would tick once,
  // find the queue still empty, and pause again with the modal — which is exactly the "trying to
  // unpause brings it up again" trap. Pressing play IS the answer "carry on without me", so the
  // crown takes its own advice: queue the ★ advised candidate (the ruler brain's highest-weighted
  // pick — the same one the modal pre-flags) and let the run continue. Submitting resumes the
  // session server-side, so there is no separate resume to send.
  if (buildChoiceDeferred()) {
    const pick = advisedBuild();
    if (pick) {
      // say so. Pressing play here commits a real decree on the player's behalf, and a build they
      // did not choose appearing in the queue with no explanation is worse than the modal was.
      postCommand({ type: "queueBuild", colony: liveColony()?.name, items: [pick] })
        .then(ok => { if (ok) toast(`The crown chose <b>${buildingName(pick)}</b> for you.`); });
      return;
    }
  }
  controlLive("resume");
}

/** Force paused — modals call this on open; the live session keeps ticking, so this is a no-op. */
export function pausePlayback() {}

// a speed chevron sets the live session's tick rate (in-game days per second) over /control
function onSpeed(level) {
  if (!liveActive() || !canControl() || !clockControllable()) return;
  speed = Math.max(1, Math.min(5, level));
  controlLive("rate", LIVE_RATES[speed]);
  renderSpeed();
}

/** Reflect the live session's clock state (and date) on the transport UI, per snapshot. */
export function syncLiveTransport(clockState, date) {
  const running = clockState === "RUNNING";
  // a stopped or not-yet-started clock cannot be driven — grey the play button and the chevrons so the
  // UI does not offer a control that would no-op (docs/session-management.md)
  const controllable = clockState === "RUNNING" || clockState === "PAUSED";
  playing = running;
  playIcon.innerHTML = running ? PAUSE_ICON : PLAY_ICON;
  playBtn.setAttribute("aria-label", running ? "Pause" : "Play");
  playBtn.disabled = !controllable;
  speedBox.classList.toggle("disabled", !controllable);
  if (date != null) cDate.textContent = date;
  renderSpeed();
}

/** Show the clock (live controls) only in the Caravans/live view; clear it otherwise. */
export function showClock(on) {
  document.getElementById("clock").style.display = on ? "" : "none";
  if (!on) cDate.textContent = "";
}

/** Reset the chevrons to speed 1 — entering the live view starts a fresh session's transport.
 *  (The server's own rate is not reported back, so the level is ours to track; syncLiveTransport
 *  only reflects RUNNING/PAUSED and the date.) */
export function resetSpeed() { speed = 1; renderSpeed(); }

playBtn.addEventListener("click", togglePlay);
// the speed selector: five chevrons ( › .. ›››››  ), the active level lit; clicking one sets the rate
SPEEDS.slice(1).forEach((sp, i) => {
  const b = document.createElement("button");
  b.className = "chev"; b.textContent = "›";
  b.setAttribute("data-tip", sp.name); b.setAttribute("aria-label", sp.name);
  b.onclick = () => onSpeed(i + 1);
  speedBox.appendChild(b);
});
renderSpeed();
