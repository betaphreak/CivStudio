// Bump the reactor version across all three POMs, in one command.
//
// `mvn versions:set` is the obvious tool and does not work here: it resolves the versions-maven-
// plugin from the network, and this box deploys offline (-o) with a warm ~/.m2 that does not carry
// it. So the version has been edited BY HAND in three files — root, engine parent, server parent —
// which is exactly the kind of three-place edit that gets done in two.
//
// It is not cosmetic: /actuator/info reports the version, tools/deploy-server.ps1 bakes it into the
// image, and a server feature shipped under an unchanged version is a deploy you cannot identify
// afterwards.
//
// Both the reads and the writes anchor on the same thing — the <version> immediately following
// <artifactId>civstudio-parent</artifactId> — which is the project version in the root POM and the
// parent version in each module, and is never a dependency or plugin version. One anchor, three
// files, no line numbers.
//
// Usage:
//   node tools/bump-version.mjs              0.9.69-SNAPSHOT -> 0.9.70-SNAPSHOT
//   node tools/bump-version.mjs --to 1.0.0-SNAPSHOT
//   node tools/bump-version.mjs --minor      0.9.69-SNAPSHOT -> 0.10.0-SNAPSHOT
//   node tools/bump-version.mjs --show       print the current version and exit
//   node tools/bump-version.mjs --check      exit 1 if the three POMs disagree

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const POMS = ['pom.xml', 'civstudio-engine/pom.xml', 'civstudio-server/pom.xml'];

// The one anchor: civstudio-parent's own version (root) / the parent it inherits (modules).
const ANCHOR = /(<artifactId>civstudio-parent<\/artifactId>\s*<version>)([^<]+)(<\/version>)/;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const read = (rel) => {
  const text = readFileSync(join(REPO, rel), 'utf8');
  const m = text.match(ANCHOR);
  if (!m) throw new Error(`${rel}: no civstudio-parent <version> found — has the POM layout changed?`);
  return { rel, text, version: m[2].trim() };
};

const poms = POMS.map(read);
const versions = [...new Set(poms.map((p) => p.version))];

if (has('--show')) {
  for (const p of poms) console.log(`${p.version}  ${p.rel}`);
  process.exit(versions.length === 1 ? 0 : 1);
}

// Drift is worth catching on its own: three POMs that disagree still BUILD (Maven resolves the
// parent by the module's declared version), they just build something other than what you think.
if (versions.length !== 1) {
  console.error('FAIL  the POMs disagree on the reactor version:');
  for (const p of poms) console.error(`      ${p.version}  ${p.rel}`);
  console.error('      Fix with: node tools/bump-version.mjs --to <version>');
  process.exit(1);
}
const current = versions[0];
if (has('--check')) {
  console.log(`PASS  all three POMs are ${current}`);
  process.exit(0);
}

/** Next version: an explicit --to, else bump the patch (or the minor with --minor), keeping any
 *  -SNAPSHOT/-RC qualifier exactly as it was. */
function next() {
  const explicit = valueOf('--to');
  if (explicit) return explicit;
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`cannot bump "${current}" automatically — pass --to <version>`);
  const [, maj, min, patch, qualifier] = m;
  return has('--minor')
    ? `${maj}.${Number(min) + 1}.0${qualifier}`
    : `${maj}.${min}.${Number(patch) + 1}${qualifier}`;
}

const target = next();
if (target === current) {
  console.log(`already ${current} — nothing to do`);
  process.exit(0);
}

for (const p of poms) {
  // replace ONLY the anchored occurrence: the root POM holds many other <version> elements
  writeFileSync(join(REPO, p.rel), p.text.replace(ANCHOR, `$1${target}$3`));
  console.log(`  ${p.rel}: ${current} -> ${target}`);
}

// Re-read rather than trust the writes: this is the check the manual process never had.
const after = POMS.map(read);
const bad = after.filter((p) => p.version !== target);
if (bad.length) {
  console.error(`FAIL  ${bad.length} POM(s) did not take the new version: `
    + bad.map((p) => p.rel).join(', '));
  process.exit(1);
}
console.log(`\nreactor is ${target} in all ${after.length} POMs`);
console.log('next: mvn -o clean install -DskipTests   (then commit, then deploy)');
