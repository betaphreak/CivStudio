// Unit coverage for the rail's URL round-trip (docs/studio-control-plane-plan.md §D3).
// Run: node --test web/js/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionUrl } from './deeplink.mjs';

const BASE = 'https://anbennar.civstudio.com/';

test('selecting a province writes ?p=', () => {
  assert.equal(selectionUrl(BASE, { id: 4411 }), `${BASE}?p=4411`);
});

test('deselecting removes ?p=', () => {
  assert.equal(selectionUrl(`${BASE}?p=4411`, null), BASE);
});

test('selecting replaces a previous ?p= rather than appending', () => {
  const out = new URL(selectionUrl(`${BASE}?p=4411`, { id: 1234 }));
  assert.deepEqual(out.searchParams.getAll('p'), ['1234']);
});

test('every other parameter survives — realm, session and live are not ours to drop', () => {
  const out = new URL(selectionUrl(`${BASE}?realm=aelantir&session=abc&live=http%3A%2F%2Flocalhost%3A8080`,
    { id: 77 }));
  assert.equal(out.searchParams.get('realm'), 'aelantir');
  assert.equal(out.searchParams.get('session'), 'abc');
  assert.equal(out.searchParams.get('live'), 'http://localhost:8080');
  assert.equal(out.searchParams.get('p'), '77');
});

test('the hash is preserved — it carries the map mode (#none, #nation)', () => {
  assert.equal(new URL(selectionUrl(`${BASE}#none`, { id: 9 })).hash, '#none');
});

test('a province without an id is treated as no selection', () => {
  // defensive: never write "p=undefined" into a link someone might share
  assert.equal(selectionUrl(`${BASE}?p=4411`, {}), BASE);
});
