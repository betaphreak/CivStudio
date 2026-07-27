"use strict";
// What makes a served world USABLE — pure, and therefore testable (world-invariants.test.mjs).
// The fetching/reporting shell is tools/verify-world.mjs; the judgements live here.
//
// Why these exist at all: every gate in the deploy path checks IDENTITY. deploy-server.ps1 polls
// /actuator/info for the commit and build time; seed-studio.yml reports the rows it wrote. On
// 2026-07-27 all of them passed green while the live map was unusable — 3,609 provinces stranded
// under the retired `halcann` realm key, so the realm picker offered "Cannor: 0 provinces" and the
// running demo could not be reached. Nothing in the pipeline was looking at the world itself.
//
// Each invariant below is a statement that would have to be FALSE for the map to be broken in a way
// a visitor notices within seconds. They are deliberately cheap — one already-fetched response, no
// browser — so they can run on every deploy and every seed without anyone weighing whether to.

/** A floor, not a pin. The province count is stable across ordinary content edits (5,268 today), but
 *  pinning it would fail every legitimate map change. What this catches is a truncated or
 *  half-written seed, which loses provinces by the thousand rather than by ones. */
export const MIN_PROVINCES = 5000;

/** How much of the map may legitimately belong to no realm. A handful are deliberately realm-less
 *  (docs/realms.md §"No realm" means no realm) — 93 of 5,268, ~1.8%. A sudden jump means realm
 *  resolution has broken wholesale. */
export const MAX_REALMLESS_FRACTION = 0.10;

/**
 * Judge a world bundle. Returns one result per invariant: `{name, pass, detail}`.
 *
 * @param {object} bundle the parsed /api/bundle response
 * @param {{minProvinces?: number}} [opts]
 * @returns {Array<{name: string, pass: boolean, detail: string}>}
 */
export function checkWorld(bundle, opts = {}) {
  const minProvinces = opts.minProvinces ?? MIN_PROVINCES;
  const out = [];
  const check = (name, pass, detail) => out.push({ name, pass, detail });

  const b = bundle && typeof bundle === 'object' ? bundle : {};
  const provinces = Array.isArray(b.provinces) ? b.provinces : [];
  const realms = b.realms && typeof b.realms === 'object' ? b.realms : null;
  const realmKeys = realms ? Object.keys(realms) : [];

  check('the bundle carries provinces', provinces.length >= minProvinces,
    `${provinces.length} provinces (floor ${minProvinces})`);

  check('the bundle names a map version', Number.isFinite(b.mapVersion),
    `mapVersion=${b.mapVersion}`);

  check('the bundle declares its realms', realmKeys.length > 0,
    realmKeys.length ? realmKeys.join(', ') : '(no realms dictionary)');

  const byRealm = new Map();
  for (const p of provinces) {
    const key = p && p.realm ? p.realm : null;
    byRealm.set(key, (byRealm.get(key) || 0) + 1);
  }

  // THE ONE THAT WOULD HAVE CAUGHT 2026-07-27. A province may belong to no realm, but if it NAMES
  // one, that realm must exist — otherwise it is stranded: filtered out of its own map, drawn
  // nowhere, counted by nothing. `halcann`, the pre-split key retired to a read-only alias, is
  // precisely this.
  const stranded = [...byRealm.entries()]
    .filter(([k]) => k !== null && !realmKeys.includes(k))
    .sort((a, b2) => b2[1] - a[1]);
  check('every province names a realm that exists',
    realmKeys.length > 0 && stranded.length === 0,
    stranded.length
      ? 'STRANDED: ' + stranded.map(([k, n]) => `${k}=${n}`).join(', ')
        + ` — these provinces belong to no map the client can draw (known realms: ${realmKeys.join(', ')})`
      : realmKeys.length ? 'no province names an unknown realm' : '(no realms to check against)');

  // …the same failure seen from the front: a realm the picker offers with nothing in it is a dead
  // end a visitor can click. Every realm is expected inhabited — Hinuilands is only two provinces,
  // but two is not zero.
  const emptyRealms = realmKeys.filter((k) => !byRealm.get(k));
  check('no realm is empty', realmKeys.length > 0 && emptyRealms.length === 0,
    emptyRealms.length ? 'EMPTY: ' + emptyRealms.join(', ')
      : realmKeys.length ? `${realmKeys.length} realms all inhabited` : '(no realms declared)');

  const realmless = byRealm.get(null) || 0;
  const frac = provinces.length ? realmless / provinces.length : 1;
  check('realm-less provinces stay a small minority', frac <= MAX_REALMLESS_FRACTION,
    `${realmless}/${provinces.length} (${(frac * 100).toFixed(1)}%, `
    + `ceiling ${(MAX_REALMLESS_FRACTION * 100).toFixed(0)}%)`);

  return out;
}

/** Render results as aligned PASS/FAIL lines — shared by the CLI and anything else reporting them. */
export function formatChecks(checks) {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}`);
}
