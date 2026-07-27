// Would deploying this commit's web/ leave the site talking to a server that predates it?
//
// The site auto-deploys on every master push touching web/**; the server is rolled by hand. So a
// push that changes BOTH ships the frontend immediately and the backend whenever someone gets round
// to it. On 2026-07-27 the six-realm split did exactly that: web went live at 06:51 against a server
// from the day before, and the mismatch sat there until a deploy hours later happened to surface it.
// The ordering rule ("deploy the server FIRST") existed only as a line in CLAUDE.md.
//
// THE CONDITION IS NOT "the server is up to date". Requiring that would block a CSS fix because some
// unrelated server commit had not been rolled — friction that teaches people to bypass the check.
// What actually matters is narrower:
//
//     the deployed server must already contain every SERVER-AFFECTING commit
//     up to the one whose web/ is being shipped
//
// so a web-only push never blocks (the newest server-affecting commit is old, and the running server
// long since contains it), while a push that touches engine/server code blocks until that server is
// live. Server-affecting paths mirror deploy-server.yml's triggers — one definition of "this changes
// what the server serves", not two that can drift.
//
// Usage:
//   node tools/verify-server-ahead.mjs [--base <url>] [--ref <commit>]
//     --base  the deployed server (default https://dev.civstudio.com)
//     --ref   the commit being deployed (default HEAD)
//
// Exits 0 when the server is new enough, 1 when it is behind or cannot be determined. Fails CLOSED:
// an unreachable server or an unrecognisable build stamp means we cannot prove the pairing is safe,
// and shipping a frontend against an unknown backend is the thing being prevented.

import { execFileSync } from 'node:child_process';

// Mirrors .github/workflows/deploy-server.yml `paths`. If that list changes, change this with it.
const SERVER_PATHS = ['civstudio-engine', 'civstudio-server', 'pom.xml', '.mvn'];

const args = process.argv.slice(2);
const val = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const base = val('--base', 'https://dev.civstudio.com').replace(/\/+$/, '');
const ref = val('--ref', 'HEAD');

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error('FAIL  ' + msg); process.exit(1); };

// The newest commit up to `ref` that changed anything the server serves. This is the commit the
// running server must already contain.
let required;
try {
  required = git('log', '-1', '--format=%H', ref, '--', ...SERVER_PATHS);
} catch (e) {
  fail(`could not read git history: ${e.message}`);
}
if (!required) {
  console.log(`PASS  nothing server-affecting in history up to ${ref} — web ships freely`);
  process.exit(0);
}
const requiredShort = required.slice(0, 8);
const subject = git('log', '-1', '--format=%s', required).slice(0, 72);

// What is actually running?
let servedCommit = null;
try {
  const res = await fetch(`${base}/actuator/info`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  servedCommit = (await res.json())?.build?.commit ?? null;
} catch (e) {
  fail(`could not reach ${base}/actuator/info (${e.message}).\n`
    + '      Cannot prove the server is new enough, so this fails closed. If the server is\n'
    + '      knowingly down, re-run with the override (see the workflow) once it is back.');
}
if (!servedCommit)
  fail(`${base} reports no build.commit — cannot tell which code it is running.`);

// Resolve the served short SHA against local history. An unknown commit means the server was built
// from something not in this branch's history (a branch build, a dirty tree, a force-push) — which
// is precisely when "is it new enough" is unanswerable.
let servedFull;
try {
  servedFull = git('rev-parse', `${servedCommit}^{commit}`);
} catch {
  fail(`the server is running commit ${servedCommit}, which is not in this repository's history.\n`
    + '      It was built from a branch, a dirty tree, or a rewritten history — the pairing cannot\n'
    + '      be checked. Roll the server from master, then re-run.');
}

// The whole question, in one call: does what is running already include what web is about to expect?
let contains = false;
try {
  execFileSync('git', ['merge-base', '--is-ancestor', required, servedFull], { stdio: 'ignore' });
  contains = true;
} catch { contains = false; }

const servedShort = servedFull.slice(0, 8);
if (contains) {
  console.log(`PASS  the running server (${servedShort}) contains the newest server-affecting commit `
    + `(${requiredShort})`);
  console.log(`      ${requiredShort}  ${subject}`);
  process.exit(0);
}

console.error(`FAIL  the running server is BEHIND the web build about to ship.
      running:  ${servedShort}
      needs:    ${requiredShort}  ${subject}

      Deploying web now would put the site in front of a server that predates it — the
      frontend would call endpoints and read fields that are not deployed yet. This is the
      2026-07-27 failure mode: web shipped at 06:51 against yesterday's server and the
      mismatch went unnoticed for hours.

      Fix: roll the server first, then re-run this job.
        pwsh tools/deploy-server.ps1
`);
process.exit(1);
