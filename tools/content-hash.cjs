// The content version, DERIVED FROM THE CONTENT.
//
// CommonJS on purpose: studio/scripts/seed.js is CJS (booting Strapi through ESM trips
// ERR_UNSUPPORTED_DIR_IMPORT), and the tools/*.mjs verifiers import it as a default export. One
// implementation, because two would drift and drift is the whole problem this file exists to solve.
//
// WHY: `contentVersion` is not a label, it is a CACHE KEY. Strapi caches the assembled world-bundle
// projection keyed by it (studio/src/api/world-bundle/services/world-bundle.ts), and the engine
// records it per run, since reproducibility is `seed + contentVersion + command log`. seed.js's own
// comment already had the right intent — "the version travels WITH the content" — but the value was
// a hand-written string (`seed-2026-07-23`), so travelling with the content was a convention rather
// than a fact.
//
// It failed exactly as a convention does. The six-realm split changed every province's `realm` and
// left the string alone; a clean reseed on 2026-07-27 (5,268 provinces, 0 errors) then invalidated
// nothing, and prod kept serving the pre-split world — the live map read "Cannor: 0 provinces" while
// every gate reported success. Identical data and identical version is a cache hit; identical
// VERSION over different data is a silent lie.
//
// Deriving the version from the bytes makes that lie impossible to tell: you cannot change the
// content without changing the key. It also strengthens the reproducibility stamp — two runs sharing
// a contentVersion now genuinely saw the same world, rather than merely being seeded the same day.

const { createHash } = require('node:crypto');

/** Prefix marking a derived version, so it is distinguishable at a glance from the legacy
 *  `seed-<date>` stamps still sitting in older SessionRecords. */
const PREFIX = 'c-';

/** Hex digits kept. 12 is ~48 bits — collision-free for the handful of content revisions that will
 *  ever exist, and short enough to read in a log line or a URL. */
const DIGITS = 12;

/**
 * Feed a value into `hash` in a form that depends only on its CONTENT, never on key order.
 *
 * Object keys are sorted, so a projection rebuilt from a different row order — or a JSON file whose
 * keys were reordered by an editor — hashes identically. Written as an incremental walk rather than
 * canonical-stringify-then-hash because the bundle is ~2.5 MB gzipped and tens of MB expanded; there
 * is no reason to hold a second copy of it as one string.
 */
function feed(hash, v) {
  if (v === undefined || v === null) { hash.update('n'); return; }
  if (Array.isArray(v)) {
    hash.update('a' + v.length + '[');
    for (const item of v) { feed(hash, item); hash.update(','); }
    hash.update(']');
    return;
  }
  switch (typeof v) {
    case 'object': {
      const keys = Object.keys(v).sort();
      hash.update('o' + keys.length + '{');
      for (const k of keys) { hash.update(JSON.stringify(k) + ':'); feed(hash, v[k]); hash.update(','); }
      hash.update('}');
      return;
    }
    case 'number':  hash.update('#' + (Object.is(v, -0) ? '0' : String(v))); return;
    case 'boolean': hash.update(v ? 't' : 'f'); return;
    default:        hash.update('s' + JSON.stringify(String(v)));
  }
}

/**
 * The content version for a bundle's `resources` payload — order-insensitive and stable across
 * machines.
 *
 * @param {object} resources the bundle's `resources` map (path → dataset)
 * @returns {string} e.g. "c-9f2a1b3c4d5e"
 */
function contentHash(resources) {
  const h = createHash('sha256');
  feed(h, resources);
  return PREFIX + h.digest('hex').slice(0, DIGITS);
}

/** Whether a version string was derived by {@link contentHash} (rather than a legacy `seed-<date>`). */
const isDerived = (v) => typeof v === 'string' && v.startsWith(PREFIX);

module.exports = { contentHash, isDerived, PREFIX, DIGITS };
