// Fetch JSON, tolerating a rolling restart.
//
// Azure Container Apps replaces a revision's replicas gradually: the new one passes its health probe
// while the old one is still draining, so for a few seconds a request can land on either. Straight
// after `refresh-content.ps1` that means a verifier can read the PREVIOUS content and report a
// failure that is already untrue — which happened on 2026-07-27 and cost a round of chasing.
//
// A check that cries wolf on every restart is a check people learn to ignore, so the verifiers poll
// until the answer stops changing (or a deadline passes) rather than trusting the first reply. With
// `settleMs` at 0 this is a plain fetch, which is what the scheduled canary wants: there, an
// inconsistent answer IS the finding.

/**
 * @param {string} url
 * @param {(json: any) => any} keyOf   the value that must settle (e.g. `b => b.contentVersion`)
 * @param {{settleMs?: number, stepMs?: number, log?: (msg: string) => void}} [opts]
 * @returns {Promise<any>} the parsed JSON once `keyOf` has repeated, or the last response at deadline
 */
export async function fetchSettling(url, keyOf, opts = {}) {
  const { settleMs = 0, stepMs = 5000, log = () => {} } = opts;
  const deadline = Date.now() + settleMs;
  let last = null, lastKey = Symbol('none');

  for (;;) {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) {
      if (Date.now() >= deadline) throw new Error(`GET ${url} -> ${res.status}`);
      log(`    ...${res.status} from ${url}, retrying`);
      await sleep(Math.min(stepMs, Math.max(0, deadline - Date.now())));
      continue;
    }
    const json = await res.json();
    const key = keyOf(json);
    // Two consecutive identical readings: every replica in rotation now agrees, or there was only
    // ever one. A single reading proves nothing mid-roll — that is the whole point.
    if (settleMs <= 0 || key === lastKey) return json;
    if (lastKey !== Symbol.for('never') && last !== null)
      log(`    ...answer changed (${String(lastKey)} -> ${String(key)}) — still rolling`);
    last = json; lastKey = key;
    if (Date.now() >= deadline) {
      log('    ...settle deadline reached; taking the latest reading');
      return json;
    }
    await sleep(Math.min(stepMs, Math.max(0, deadline - Date.now())));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
