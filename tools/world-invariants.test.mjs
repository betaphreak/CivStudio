import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWorld, MIN_PROVINCES } from './world-invariants.mjs';

const REALMS = { cannor: 'Cannor', serpentspine: 'Serpentspine', haless: 'Haless',
                 sarhal: 'Sarhal', aelantir: 'Aelantir', hinuilands: 'Hinuilands' };

/** A bundle with `counts` provinces per realm key (null key = realm-less), padded to `total`. */
function bundle(counts, { total = 5268, mapVersion = 15, realms = REALMS } = {}) {
  const provinces = [];
  for (const [realm, n] of Object.entries(counts))
    for (let i = 0; i < n; i++) provinces.push(realm === 'null' ? { id: provinces.length } : { id: provinces.length, realm });
  while (provinces.length < total) provinces.push({ id: provinces.length, realm: 'cannor' });
  return { mapVersion, realms, provinces };
}

const failing = (checks) => checks.filter((c) => !c.pass).map((c) => c.name);
const detailOf = (checks, name) => checks.find((c) => c.name === name)?.detail ?? '';

test('a healthy world passes every invariant', () => {
  // the real shape as served on 2026-07-27 after the fix
  const checks = checkWorld(bundle({
    cannor: 898, serpentspine: 444, sarhal: 1172, aelantir: 1557, haless: 1102,
    hinuilands: 2, null: 93,
  }, { total: 5268 }));
  assert.deepEqual(failing(checks), [], 'nothing should fail on a good world');
});

test('THE 2026-07-27 FAILURE: provinces stranded under a retired realm key', () => {
  // exactly what prod served: 3,609 under `halcann`, which the six-realm split retired
  const checks = checkWorld(bundle({
    halcann: 3609, aelantir: 1555, hinuilands: 2, null: 102,
  }, { total: 5268 }));
  const bad = failing(checks);
  assert.ok(bad.includes('every province names a realm that exists'),
    'the stranded-realm check must fire — this is the one that was missing');
  assert.match(detailOf(checks, 'every province names a realm that exists'), /halcann=3609/);
  // …and the same break seen from the front
  assert.ok(bad.includes('no realm is empty'));
  assert.match(detailOf(checks, 'no realm is empty'), /cannor/);
});

test('a realm the picker offers but nothing lives in is a dead end', () => {
  const checks = checkWorld(bundle({ cannor: 5000, serpentspine: 268 }, { total: 5268 }));
  assert.ok(failing(checks).includes('no realm is empty'));
  assert.match(detailOf(checks, 'no realm is empty'), /haless/);
});

test('a truncated seed is caught by the province floor', () => {
  const checks = checkWorld(bundle({ cannor: 10 }, { total: 10 }));
  assert.ok(failing(checks).includes('the bundle carries provinces'));
});

test('wholesale loss of realm resolution is caught even with no unknown keys', () => {
  // every province realm-less: no key is "unknown", no realm is populated — the fraction catches it
  const checks = checkWorld(bundle({ null: 5268 }, { total: 5268 }));
  const bad = failing(checks);
  assert.ok(bad.includes('realm-less provinces stay a small minority'));
  assert.ok(bad.includes('no realm is empty'));
});

test('the deliberately realm-less minority is allowed', () => {
  const checks = checkWorld(bundle({
    cannor: 898, serpentspine: 444, sarhal: 1172, aelantir: 1557, haless: 1102,
    hinuilands: 2, null: 93,
  }, { total: 5268 }));
  assert.ok(!failing(checks).includes('realm-less provinces stay a small minority'),
    '1.8% realm-less is by design (docs/realms.md)');
});

test('a bundle with no realms dictionary fails rather than vacuously passing', () => {
  // the pre-split server shape: an empty/absent dictionary must not make the realm checks trivially true
  const checks = checkWorld({ mapVersion: 15, provinces: Array.from({ length: 5268 },
    (_, i) => ({ id: i, realm: 'halcann' })) });
  const bad = failing(checks);
  assert.ok(bad.includes('the bundle declares its realms'));
  assert.ok(bad.includes('every province names a realm that exists'), 'must not pass by having nothing to compare');
  assert.ok(bad.includes('no realm is empty'));
});

test('a missing map version is reported', () => {
  // built by hand: passing `mapVersion: undefined` to the helper would hit its destructuring
  // DEFAULT and quietly restore 15, so the fixture has to omit the key outright
  const b = bundle({ cannor: 5268 }, { total: 5268 });
  delete b.mapVersion;
  assert.ok(failing(checkWorld(b)).includes('the bundle names a map version'));
});

test('garbage in does not throw', () => {
  for (const junk of [null, undefined, {}, { provinces: 'nope' }, { realms: 5 }])
    assert.ok(Array.isArray(checkWorld(junk)), 'always returns results, never throws');
});

test('the province floor is overridable for a smaller fixture world', () => {
  const checks = checkWorld(bundle({ cannor: 5, serpentspine: 5, haless: 5, sarhal: 5,
    aelantir: 5, hinuilands: 5 }, { total: 30 }), { minProvinces: 10 });
  assert.deepEqual(failing(checks), [], `default floor is ${MIN_PROVINCES}, but a caller may lower it`);
});
