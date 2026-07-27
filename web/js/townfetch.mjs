"use strict";
// Lazy per-site town-layout fetching (docs/towngen-port.md T7). Mirrors routefetch.mjs: ask
// GET /api/sessions/{sid}/town/{provinceId} for the provinces actually in view at a band deep
// enough to draw them, keep what comes back, and never ask twice at once.
//
// A layout is keyed by SITE, not by colony (§2a: it outlives the settlement that raised it), so the
// cache key is the province id and a dead colony's ruin would arrive under the same one.
import { apiUrl } from "./core.mjs";
import { draw } from "./repaint.mjs";

const FETCH_TIMEOUT = 6000;      // ms — drop a layout fetch that outlives this
const RETRY_BACKOFF = 15000;     // ms — after a failure, leave the site alone this long
const MAX_INFLIGHT = 4;          // most concurrent layout fetches

let sid = null;
let inFlight = 0;
const towns = new Map();         // provinceId -> layout
const state = new Map();         // provinceId -> { pending, retryAt }

/** Point the town feed at a session, or `null` to leave Live. Changing session drops every layout,
 *  so one run never shows another's walls. */
export function setTownSession(next) {
  if (next === sid) return;
  sid = next;
  towns.clear();
  state.clear();
  draw();
}

/** Mark a site's layout stale — the town grew (T7 proper wires this to the snapshot's dirty flag). */
export function invalidateTown(provinceId) {
  state.delete(provinceId);
  towns.delete(provinceId);
}

/** The layout held for a site, or `undefined` if it has not been fetched. */
export function townOf(provinceId) {
  return towns.get(provinceId);
}

/** Ensure a site's layout is on its way. Called by the draw layer for on-screen provinces only, so
 *  fetching is bounded by the viewport and the band. */
export function ensureTown(provinceId) {
  if (!sid || towns.has(provinceId)) return;
  const st = state.get(provinceId);
  if (st && (st.pending || (st.retryAt && Date.now() < st.retryAt))) return;
  if (inFlight >= MAX_INFLIGHT) return;

  state.set(provinceId, { pending: true, retryAt: 0 });
  inFlight++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  fetch(apiUrl(`/api/sessions/${encodeURIComponent(sid)}/town/${provinceId}`),
        { signal: ctl.signal })
    .then(r => (r.ok ? r.json() : null))
    .then(layout => {
      // an empty layout is an ANSWER — no town on that site — and is kept, so we stop asking
      if (layout) towns.set(provinceId, layout);
      state.set(provinceId, { pending: false, retryAt: layout ? 0 : Date.now() + RETRY_BACKOFF });
      if (layout && layout.patches && layout.patches.length) draw();
    })
    .catch(() => state.set(provinceId, { pending: false, retryAt: Date.now() + RETRY_BACKOFF }))
    .finally(() => { clearTimeout(timer); inFlight--; });
}
