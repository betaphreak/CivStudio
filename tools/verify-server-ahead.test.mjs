import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'verify-server-ahead.mjs');
const REPO = join(HERE, '..');

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();

/** A stand-in for /actuator/info reporting `commit` (or a non-200 when null). */
async function stubServer(commit) {
  const srv = createServer((req, res) => {
    if (commit === null) { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ build: { commit, number: '1', version: 'test' } }));
  });
  await new Promise((r) => srv.listen(0, r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

/** Run the checker; resolves {code, stdout, stderr} without throwing on a non-zero exit. */
async function run(base, ref) {
  const args = [SCRIPT, '--base', base];
  if (ref) args.push('--ref', ref);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, args, { cwd: REPO });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// The commit that shipped the six-realm split (engine + server + web in one push) and the commit
// production was actually running at the time. If either is ever pruned from history these tests
// skip rather than fail — they are about a real sequence, not about keeping SHAs alive forever.
const REALM_SPLIT = '771a3124';
const SERVER_THAT_DAY = 'f2eb0b4d';
const known = (sha) => { try { git('rev-parse', `${sha}^{commit}`); return true; } catch { return false; } };
const haveHistory = known(REALM_SPLIT) && known(SERVER_THAT_DAY);

test('THE 2026-07-27 ORDERING FAILURE is caught', { skip: !haveHistory && 'history unavailable' },
  async () => {
    // web/ at the realm-split commit, against the server that was actually live: the exact pairing
    // that shipped a realm-aware frontend at 06:51 to a server that knew nothing about realms
    const srv = await stubServer(SERVER_THAT_DAY);
    try {
      const { code, stderr } = await run(srv.base, REALM_SPLIT);
      assert.equal(code, 1, 'this pairing must NOT be allowed to deploy');
      assert.match(stderr, /BEHIND/);
      assert.match(stderr, new RegExp(REALM_SPLIT.slice(0, 8)));
      assert.match(stderr, /deploy-server\.ps1/, 'must say how to fix it');
    } finally { srv.close(); }
  });

test('the same commit paired with its OWN server is fine',
  { skip: !haveHistory && 'history unavailable' }, async () => {
    const srv = await stubServer(REALM_SPLIT);
    try {
      const { code, stdout } = await run(srv.base, REALM_SPLIT);
      assert.equal(code, 0, 'server at the same commit contains it');
      assert.match(stdout, /PASS/);
    } finally { srv.close(); }
  });

test('a server AHEAD of the web build passes', { skip: !haveHistory && 'history unavailable' },
  async () => {
    // the normal, safe ordering: server rolled first, web catching up
    const srv = await stubServer(git('rev-parse', 'HEAD').slice(0, 8));
    try {
      const { code } = await run(srv.base, REALM_SPLIT);
      assert.equal(code, 0);
    } finally { srv.close(); }
  });

test('an unreachable server fails CLOSED', async () => {
  const srv = await stubServer(null);
  try {
    const { code, stderr } = await run(srv.base);
    assert.equal(code, 1, 'cannot prove the pairing is safe → do not ship');
    assert.match(stderr, /could not reach/);
  } finally { srv.close(); }
});

test('a build stamp not in this history fails CLOSED', async () => {
  const srv = await stubServer('deadbeef');
  try {
    const { code, stderr } = await run(srv.base);
    assert.equal(code, 1);
    assert.match(stderr, /not in this repository's history/);
  } finally { srv.close(); }
});

test('a server reporting no commit at all fails CLOSED', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ build: { number: '1' } }));   // no commit
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    const { code, stderr } = await run(`http://127.0.0.1:${srv.address().port}`);
    assert.equal(code, 1);
    assert.match(stderr, /no build\.commit/);
  } finally { srv.close(); }
});

test('the current HEAD against the current server is consistent', async () => {
  // not an assertion about WHICH way it goes — that depends on whether the server has been rolled
  // since the last server-affecting commit — only that the checker reaches a clean verdict
  const srv = await stubServer(git('rev-parse', 'HEAD').slice(0, 8));
  try {
    const { code, stdout } = await run(srv.base);
    assert.equal(code, 0, stdout);
  } finally { srv.close(); }
});
