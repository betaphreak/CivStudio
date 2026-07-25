// node --test web/beachramp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beachRampFromAtlas } from './beachramp.mjs';

// A synthetic coast tile shaped like the real atlas: transparent LAND on the left, then a sand band,
// then water, out to the right edge. `sandW` varies per row so the test exercises the alignment step —
// which is the whole point of the algorithm, and the thing a naive per-depth mean gets wrong.
const SAND = [200, 180, 130], WATER = [90, 130, 140];
function atlas(W, H, sandWAt) {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const land = 20, sandW = sandWAt(y);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (x < land) { rgba[o + 3] = 0; continue; }              // transparent land side
      const c = x < land + sandW ? SAND : WATER;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
    }
  }
  return { width: W, height: H, rgba };
}

test('recovers the sand and water ends of the profile', () => {
  const ramp = beachRampFromAtlas(atlas(120, 64, () => 12), { stops: 9, uMax: 1.25 });
  assert.ok(ramp, 'a ramp was produced');
  assert.equal(ramp.length, 9);
  // u=0..1 is the sand band, u>1 is past its seaward edge — so the first stops are the sand colour
  // and the last are the water colour, with no smearing between them.
  assert.deepEqual(ramp[0], SAND);
  assert.deepEqual(ramp[6], SAND);                              // u=0.94, still inside the sand
  assert.deepEqual(ramp[8], WATER);                             // u=1.25, past it
});

test('aligning rows keeps the step crisp when the sand band varies in width', () => {
  // Rows alternate between a narrow and a wide sand band. Averaging RAW depths would blend sand and
  // water together in the overlap; aligning on each row's own transition must not.
  const ramp = beachRampFromAtlas(atlas(120, 64, y => (y % 2 ? 8 : 20)), { stops: 9, uMax: 1.25 });
  assert.ok(ramp);
  assert.deepEqual(ramp[3], SAND, 'mid-sand stays pure sand across both row widths');
  assert.deepEqual(ramp[8], WATER, 'past the transition stays pure water');
});

test('warm-free art yields no ramp rather than a grey one', () => {
  // An all-water tile has no sand band; every row is rejected and the caller falls back.
  const W = 120, H = 64, img = atlas(W, H, () => 0);
  assert.equal(beachRampFromAtlas(img), null);
});

test('the marched depth is a hard requirement, not a best effort', () => {
  // depth deeper than the painted region leaves no full-depth row, so nothing qualifies.
  assert.equal(beachRampFromAtlas(atlas(60, 32, () => 12), { depth: 200 }), null);
});
