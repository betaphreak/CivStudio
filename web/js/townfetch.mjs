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
const revs = new Map();          // provinceId -> the townRev the held layout was fetched at
const stale = new Set();         // sites whose held layout is known to be out of date

/** Point the town feed at a session, or `null` to leave Live. Changing session drops every layout,
 *  so one run never shows another's walls. */
export function setTownSession(next) {
  if (next === sid) return;
  sid = next;
  towns.clear();
  state.clear();
  revs.clear();
  stale.clear();
  draw();
}

/**
 * Mark a site's layout stale, so the next draw re-fetches it.
 *
 * KEEPS WHAT IT HOLDS. Dropping the layout outright looks tidier and is wrong: a town that changes
 * faster than a fetch completes then has nothing to draw at all — which is exactly what happened
 * the first time a demo was run at 25 ticks a second, where the layer went permanently blank. The
 * old shape is the best available answer until the new one lands, and it is never more than a tick
 * out of date.
 */
export function invalidateTown(provinceId) {
  stale.add(provinceId);
  state.delete(provinceId);
  revs.delete(provinceId);
}

/**
 * THE DIRTY FLAG (docs/towngen-port.md §1 Transport, T7). The layout never rides the snapshot —
 * it is hundreds of polygons and only a client past band 5.5 wants any of them — so what arrives
 * each tick is a hash of the state the layout is derived from. When it changes, the town would look
 * different, and only then is it worth asking again.
 *
 * Cheap on purpose: a settled town ticks for years without moving this number, and a client that
 * polled the endpoint instead would recompute nothing and transfer fifty kilobytes to learn it.
 *
 * @param {object[]} colonies the snapshot's colonies, each with `provinceId` and `townRev`
 */
export function syncTownRevs(colonies) {
  if (!Array.isArray(colonies)) return;
  for (const c of colonies) {
    const id = c && c.provinceId;
    if (!Number.isFinite(id) || !Number.isFinite(c.townRev)) continue;
    if (revs.has(id) && revs.get(id) === c.townRev) continue;
    if (revs.has(id)) invalidateTown(id);   // it moved: drop what we hold and fetch again
    revs.set(id, c.townRev);
  }
}

/** The layout held for a site, or `undefined` if it has not been fetched. */
export function townOf(provinceId) {
  return towns.get(provinceId);
}

/** Ensure a site's layout is on its way. Called by the draw layer for on-screen provinces only, so
 *  fetching is bounded by the viewport and the band. */
export function ensureTown(provinceId) {
  if (!sid || (towns.has(provinceId) && !stale.has(provinceId))) return;
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
      if (layout) { towns.set(provinceId, layout); stale.delete(provinceId); }
      state.set(provinceId, { pending: false, retryAt: layout ? 0 : Date.now() + RETRY_BACKOFF });
      if (layout && layout.patches && layout.patches.length) draw();
    })
    .catch(() => state.set(provinceId, { pending: false, retryAt: Date.now() + RETRY_BACKOFF }))
    .finally(() => { clearTimeout(timer); inFlight--; });
}
