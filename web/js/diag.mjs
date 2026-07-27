"use strict";
// The top bar's live diagnostics chip: render rate and round-trip latency to the session server.
//
// FPS here is NOT a free-running rAF counter, and it is NOT paints-per-second either. This app paints
// ON DEMAND — main.draw() coalesces to at most one paint per animation frame and paints nothing at all
// when the camera is still. So a rAF loop would report the display's refresh rate (a constant 60) no
// matter how slow a frame really was, and counting paints per second would report the map's DEMAND
// rate: an idle map that renders 7 cheap frames in a second would read "7fps", which looks like a
// catastrophe and is actually nothing at all.
//
// What the number means here is render CAPABILITY: 1000 / the average cost of the frames we did draw.
// A 7ms frame reads ~140fps whether we drew one of them or sixty, and a heavy world-zoom frame at 63ms
// reads ~16fps — which is the thing worth knowing, and the thing that moves when the renderer
// regresses. main.paint() feeds noteFrame() its own measured duration; when nothing has been drawn
// recently there is no fresh cost to report, so the last reading is held and dimmed.
import { apiUrl } from "./core.mjs";

const FRAME_SAMPLES = 20;   // average the cost of this many recent paints
const STALE_AFTER = 700;    // ms without a paint → the map is idle, hold the last reading
const PING_EVERY = 5000;    // ms between latency probes
const PING_TIMEOUT = 4000;  // ms — a probe slower than this counts as a timeout, not a latency

let frames = [];            // durations (ms) of recent paints
let lastFrameMs = 0;        // duration of the most recent paint
let lastPaintAt = 0;
let rttMs = null;           // null → not measured yet; -1 → last probe failed
let chipEl = null, fpsEl = null, netEl = null;
let ended = false;          // the watched run is over — see setSessionEnded

/**
 * Tell the chip whether the run it belongs to has ENDED (live.mjs, on a terminal snapshot).
 *
 * A finished chronicle is not a slow one and not a disconnected one: there are no frames left to
 * time and no feed left to be latent about, so the chip collapses to a single "idle". Reporting a
 * render rate there invites reading a dead number as a performance problem, and "offline" — which
 * is what an unmeasured link says — reads as a fault when nothing is wrong. A merely PAUSED or
 * reconnecting run is NOT idle: it is still a live thing, and keeps the real numbers.
 *
 * @param {boolean} over whether the run has ended for good
 */
export function setSessionEnded(over) {
  if (ended === !!over) return;
  ended = !!over;
  render();
}

/**
 * Record one completed paint. Called by main.paint() — the only honest place to measure, since it is
 * the thing whose cost we care about.
 * @param {number} ms wall-clock duration of the paint
 */
export function noteFrame(ms) {
  lastFrameMs = ms;
  lastPaintAt = performance.now();
  frames.push(ms);
  if (frames.length > FRAME_SAMPLES) frames.shift();
}

// mean cost of the recent frames — averaged over the last samples so a single expensive frame (a
// province's texture canvas building) doesn't make the readout leap about. The rate AND its colour
// both derive from this one number: grading on the last frame while displaying the average let the
// chip show a red-worthy "8fps" in green, because the most recent frame happened to be cheap.
function avgFrameMs() {
  return frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : null;
}
// the frame rate the recent frames' COST implies — see the header.
function fps() {
  const avg = avgFrameMs();
  return avg > 0 ? Math.min(999, Math.round(1000 / avg)) : null;
}

// Latency to the session server: time a request the server answers as cheaply as it can (/api/ping),
// so the number reflects the network rather than any work. no-store matters — a cached ping would
// report ~0ms forever, which is worse than showing nothing.
async function probe() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PING_TIMEOUT);
  const t0 = performance.now();
  try {
    const res = await fetch(apiUrl("/api/ping"), { cache: "no-store", credentials: "omit", signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    await res.json();
    rttMs = Math.round(performance.now() - t0);
  } catch {
    rttMs = -1;   // unreachable / too slow — say so rather than showing a stale good number
  } finally {
    clearTimeout(timer);
    render();
  }
}

// colour-code by how the numbers actually feel: green while smooth/near, amber when it is starting to
// show, red when it is bad enough to explain a complaint.
function grade(v, warn, bad) { return v == null ? "" : v >= bad ? "bad" : v >= warn ? "warn" : "ok"; }

function render() {
  if (!chipEl) return;
  // an ended run: one word, no figures (see setSessionEnded)
  chipEl.classList.toggle("idle", ended);
  if (ended) {
    fpsEl.textContent = "";
    fpsEl.title = "";
    netEl.textContent = "idle";
    netEl.dataset.grade = "";
    netEl.title = "The run has ended — nothing is being rendered or fetched for it";
    return;
  }
  const f = fps(), avg = avgFrameMs(), stale = performance.now() - lastPaintAt > STALE_AFTER;
  if (f != null) {
    fpsEl.textContent = f + "fps";
    // low fps is the bad end, so the thresholds invert: grade the frame time the rate came from
    fpsEl.dataset.grade = grade(avg, 33, 66);
  } else if (!fpsEl.textContent) {
    fpsEl.textContent = "—";
  }
  fpsEl.classList.toggle("stale", stale);
  fpsEl.title = avg
    ? `Render cost: ${avg.toFixed(1)} ms mean over the last ${frames.length} frame(s), last ${lastFrameMs.toFixed(1)} ms. The rate is what that cost implies, not paints per second — the map only redraws on demand.${stale ? " Idle right now." : ""}`
    : "";

  if (rttMs === -1) { netEl.textContent = "offline"; netEl.dataset.grade = "bad"; netEl.title = "The last ping to the server failed"; }
  else if (rttMs == null) { netEl.textContent = "—"; netEl.dataset.grade = ""; netEl.title = "Measuring latency…"; }
  else { netEl.textContent = rttMs + "ms"; netEl.dataset.grade = grade(rttMs, 150, 400); netEl.title = `Round-trip to the session server: ${rttMs} ms`; }
}

/**
 * Mount the chip beside the sign-in handle in the Zeitgeist sub-bar and start measuring. Safe to call
 * when the host element is absent (no chip, no timers).
 */
export function initDiag() {
  const host = document.getElementById("diagChip");
  if (!host) return;
  chipEl = host;
  host.innerHTML = '<span class="diag-v" id="diagFps"></span><span class="diag-sep">·</span><span class="diag-v" id="diagNet"></span>';
  fpsEl = host.querySelector("#diagFps");
  netEl = host.querySelector("#diagNet");
  probe();
  // Both timers are gated on visibility: a hidden tab has no chip to read and no frames to time, so
  // pinging the server and rewriting DOM forever is pure waste — it just drains a laptop watching a
  // session in a background tab. Returning to the tab catches both up immediately, so the chip is
  // never stale by more than the moment you look at it.
  setInterval(() => { if (!document.hidden) probe(); }, PING_EVERY);
  // repaint the chip on a slow timer of its own: the fps window keeps sliding while the map is idle
  // (and must decay to "stale"), which no paint would ever tell us about.
  setInterval(() => { if (!document.hidden) render(); }, 500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { probe(); render(); } });
}
