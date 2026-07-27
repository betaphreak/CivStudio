import test from 'node:test';
import assert from 'node:assert/strict';
import mod from './content-hash.cjs';

const { contentHash, isDerived, PREFIX } = mod;

test('the same content hashes the same', () => {
  const a = { '/map/provinces.json': [{ id: 1, realm: 'cannor' }, { id: 2, realm: 'haless' }] };
  const b = { '/map/provinces.json': [{ id: 1, realm: 'cannor' }, { id: 2, realm: 'haless' }] };
  assert.equal(contentHash(a), contentHash(b));
});

test('KEY ORDER does not change the hash', () => {
  // the projection is rebuilt from DB rows; a column reordering must not read as a content change
  const a = { x: { id: 1, realm: 'cannor', name: 'A' } };
  const b = { x: { name: 'A', realm: 'cannor', id: 1 } };
  assert.equal(contentHash(a), contentHash(b));
});

test('THE 2026-07-27 CASE: changing a realm changes the version', () => {
  // this is the whole point — the six-realm split changed exactly this and the version did not move
  const before = { '/map/provinces.json': [{ id: 1, realm: 'halcann' }] };
  const after  = { '/map/provinces.json': [{ id: 1, realm: 'cannor' }] };
  assert.notEqual(contentHash(before), contentHash(after));
});

test('array ORDER does change the hash — order is content here', () => {
  // the world-bundle service sorts every dataset on its natural key precisely so the order is
  // meaningful and stable; a reordering is a real difference worth invalidating on
  assert.notEqual(contentHash({ x: [1, 2] }), contentHash({ x: [2, 1] }));
});

test('adding, removing or emptying a dataset changes the version', () => {
  const base = { a: [1], b: [2] };
  assert.notEqual(contentHash(base), contentHash({ a: [1] }), 'removed');
  assert.notEqual(contentHash(base), contentHash({ a: [1], b: [2], c: [3] }), 'added');
  assert.notEqual(contentHash(base), contentHash({ a: [1], b: [] }), 'emptied');
});

test('values that look alike but are not stay distinct', () => {
  assert.notEqual(contentHash({ v: 1 }), contentHash({ v: '1' }), 'number vs string');
  assert.notEqual(contentHash({ v: null }), contentHash({ v: 'null' }));
  assert.notEqual(contentHash({ v: true }), contentHash({ v: 'true' }));
  assert.notEqual(contentHash({ v: 0 }), contentHash({ v: false }));
  // a nested object must not collide with the flat text that happens to describe it
  assert.notEqual(contentHash({ v: { a: 1 } }), contentHash({ v: '{"a":1}' }));
});

test('null and absent are distinguishable from each other in an array', () => {
  assert.notEqual(contentHash({ v: [null] }), contentHash({ v: [] }));
});

test('the shape is a short, readable, prefixed hex string', () => {
  const h = contentHash({ a: 1 });
  assert.match(h, /^c-[0-9a-f]{12}$/);
  assert.ok(isDerived(h));
  assert.ok(h.startsWith(PREFIX));
});

test('legacy date stamps are not mistaken for derived ones', () => {
  assert.equal(isDerived('seed-2026-07-23'), false);
  assert.equal(isDerived(undefined), false);
  assert.equal(isDerived(null), false);
});

test('a realistically large payload hashes without blowing up', () => {
  const big = { '/map/provinces.json': Array.from({ length: 20000 },
    (_, i) => ({ id: i, realm: 'cannor', name: 'p' + i, neighbors: [i - 1, i + 1] })) };
  assert.match(contentHash(big), /^c-[0-9a-f]{12}$/);
});
