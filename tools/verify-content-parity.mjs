// Is the deployed world the world this repository describes?
//
// The gap this closes: the test suites run against the COMMITTED snapshot
// (civstudio-engine/src/test/resources/world-bundle.json.gz), while production runs against Strapi.
// They are different content stores and nothing compared them — so on 2026-07-27, 501 engine + 132
// server + 235 web tests were green while the live map was unusable, and no test could have caught
// it. The fixture had the six realms; prod had the pre-split assignment. Both were internally
// consistent. Only the comparison was missing.
//
// The comparison is cheap because contentVersion is now DERIVED from the content
// (tools/content-hash.cjs): hash the committed snapshot, ask the server what it is serving, and see
// whether they agree. No credentials — /api/bundle is public.
//
// Usage:
//   node tools/verify-content-parity.mjs [baseUrl]      compare prod against the committed snapshot
//   node tools/verify-content-parity.mjs --restamp      rewrite the snapshot's meta.contentVersion
//                                                       to its own derived hash (no network)
//   node tools/verify-content-parity.mjs --print        print the snapshot's derived hash and exit
//
// Exits 0 when they agree, 1 on drift.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import hashMod from './content-hash.cjs';

const { contentHash, isDerived } = hashMod;
const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, '..', 'civstudio-engine', 'src', 'test', 'resources', 'world-bundle.json.gz');

const args = process.argv.slice(2);
const restamp = args.includes('--restamp');
const printOnly = args.includes('--print');
const base = args.find((a) => !a.startsWith('--')) || 'https://dev.civstudio.com';

function readSnapshot() {
  return JSON.parse(gunzipSync(readFileSync(SNAPSHOT)).toString('utf8'));
}

const snapshot = readSnapshot();
const derived = contentHash(snapshot.resources);
const stamped = snapshot.meta?.contentVersion ?? null;

if (printOnly) {
  console.log(derived);
  process.exit(0);
}

// --restamp: make the snapshot's own meta agree with its content. Kept explicit rather than
// automatic — rewriting a committed artifact is a decision, and the diff should be reviewable.
if (restamp) {
  if (stamped === derived) {
    console.log(`already stamped: ${derived}`);
    process.exit(0);
  }
  snapshot.meta = { ...snapshot.meta, contentVersion: derived };
  // gzip level 9 to match how the snapshot is normally written — a size wobble on an otherwise
  // identical payload just makes the diff harder to read
  writeFileSync(SNAPSHOT, gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 }));
  console.log(`restamped meta.contentVersion: ${stamped ?? '(none)'} -> ${derived}`);
  console.log('commit the snapshot, then reseed so the deployed store carries the same version.');
  process.exit(0);
}

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

check('the committed snapshot is stamped with its own content hash', stamped === derived,
  stamped === derived ? derived
    : `snapshot says "${stamped ?? '(none)'}", its content hashes to ${derived}`
      + (isDerived(stamped) ? '' : ' — a legacy hand-written stamp')
      + ' · fix: node tools/verify-content-parity.mjs --restamp');

let served = null;
let reachable = true;
try {
  const res = await fetch(base.replace(/\/+$/, '') + '/api/bundle', { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  served = (await res.json()).contentVersion ?? null;
} catch (e) {
  reachable = false;
  check(`${base} is reachable`, false, e.message);
}

if (reachable) {
  check('the server reports a content version', served !== null,
    served ?? '(absent — an older server, or a source with no stamp)');

  // THE CHECK. Everything above is scaffolding for this line: does production serve the content this
  // repository says it should?
  check('the deployed content matches the committed snapshot', served !== null && served === derived,
    served === derived
      ? `both ${derived}`
      : `server=${served ?? '(none)'} snapshot=${derived}`
        + ' — production is NOT serving the content in this repo.'
        + ' Reseed (Seed Studio), then: pwsh tools/refresh-content.ps1');
}

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}`);

const failed = checks.filter((c) => !c.pass);
if (failed.length) {
  console.error(`\n${failed.length} of ${checks.length} parity checks FAILED`
    + '\nThe deployed world and the committed snapshot have drifted. Tests pass against the snapshot,'
    + '\nso nothing else will tell you this.');
  process.exit(1);
}
console.log(`\nthe deployed world matches the committed snapshot (${derived})`);
