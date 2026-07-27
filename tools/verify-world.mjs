// Assert that a deployed server serves a USABLE WORLD — not merely that the right bits landed.
// The judgements are in world-invariants.mjs (pure, unit-tested); this is the fetch + report shell.
//
// Run it after anything that can change what the world looks like: a server roll (tools/
// deploy-server.ps1 calls it post-verify) and a content reseed (.github/workflows/seed-studio.yml
// calls it after restarting the caches). See docs/client-server.md §Deployment.
//
// Usage:
//   node tools/verify-world.mjs <baseUrl> [--min-provinces N]
//   node tools/verify-world.mjs --json <file> [--min-provinces N]
//
//     <baseUrl>          e.g. https://dev.civstudio.com, or http://localhost:8080
//     --min-provinces N  floor on the province count (default MIN_PROVINCES)
//     --json <file>      judge a bundle already on disk instead of fetching one
//
// Exits 0 when every invariant holds, 1 otherwise.

import { readFileSync } from 'node:fs';
import { checkWorld, formatChecks, MIN_PROVINCES } from './world-invariants.mjs';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUED = new Set(['--min-provinces', '--json']);
const base = args.find((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));
const jsonFile = flagValue('--json');
const minProvinces = Number(flagValue('--min-provinces') ?? MIN_PROVINCES);

async function loadBundle() {
  if (jsonFile) return JSON.parse(readFileSync(jsonFile, 'utf8'));
  if (!base)
    throw new Error('usage: node tools/verify-world.mjs <baseUrl> [--min-provinces N] [--json <file>]');
  const url = base.replace(/\/+$/, '') + '/api/bundle';
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

let bundle;
try {
  bundle = await loadBundle();
} catch (e) {
  console.error('FAIL  could not read the bundle — ' + e.message);
  process.exit(1);
}

const where = jsonFile ? jsonFile : base;
const checks = checkWorld(bundle, { minProvinces });
for (const line of formatChecks(checks)) console.log(line);

const failed = checks.filter((c) => !c.pass);
if (failed.length) {
  console.error(`\n${failed.length} of ${checks.length} world invariants FAILED for ${where}`
    + '\nThe build can be correct and the world still unusable — that is exactly what this checks.'
    + '\n\nIf the realm counts look stale straight after a reseed, the bundle projection is cached'
    + '\nBY CONTENT VERSION, so a reseed that did not bump it changes nothing downstream. Restart the'
    + '\nStrapi revision first (its cache is module-scoped), then the server revision:'
    + '\n  az containerapp revision restart -g civstudio -n civstudio-backend-app --revision <rev>'
    + '\n  az containerapp revision restart -g civstudio -n civstudio-server        --revision <rev>');
  process.exit(1);
}
console.log(`\nall ${checks.length} world invariants hold for ${where}`);
