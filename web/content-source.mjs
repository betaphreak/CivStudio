// content-source.mjs — read a dataset from the committed world-bundle snapshot, the single content
// source for the web bakes. generated/ is only ephemeral exporter build-scratch now; the world-bundle
// (civstudio-engine/src/test/resources/world-bundle.json.gz) is committed and always present, so the
// bakes run on a clean checkout with no exporter run. Mirrors studio/scripts/seed.js bundle mode.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'civstudio-engine/src/test/resources/world-bundle.json.gz');

let CACHE = null;
function bundle() {
  if (!CACHE) {
    const raw = fs.readFileSync(FIXTURE);
    const json = FIXTURE.endsWith('.gz') ? zlib.gunzipSync(raw) : raw;
    CACHE = JSON.parse(json.toString('utf8'));
  }
  return CACHE;
}

/** A dataset from the committed world-bundle by its resource key, e.g. '/techs.json' or '/buildings.json'. */
export function bundleResource(key) {
  const r = bundle().resources;
  if (!(key in r)) throw new Error(`world-bundle has no resource ${key} (${FIXTURE})`);
  return r[key];
}

/**
 * Like {@link bundleResource} but returns `[]` for a resource the bundle does not carry, for the
 * datasets a bake can do without (a missing trade-good table just means no icons). Keeps "absent"
 * a value rather than an exception, which is what the old readJsonOpt-on-disk did.
 */
export function bundleResourceOpt(key) {
  const r = bundle().resources;
  return key in r ? r[key] : [];
}
