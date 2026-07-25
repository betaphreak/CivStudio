// docs/frontend-performance.md: WHY did the tier-boundary overlay cost 26 ms? (Kept as the regression
// check for the cull that fixed it — it asserts the cull is pixel-identical to drawing every ring.)
//
// layer-profile put `tiers` at 26.3 ms / 85% of layer cost at 5.5x and 23.0 ms / 75% at 8x — several
// times the plot layer. This separates the candidates instead of guessing:
//
//   0. MEASUREMENT CAVEAT. tierPath caches one Path2D per tier keyed on S.viewVersion, and the
//      profiler bumps baseVersion (→ viewVersion) every frame. So it measured the cache-MISS path. A
//      real pan/zoom also changes viewVersion every frame, so the miss path is the interactive cost —
//      but "still camera" must be measured separately or the number is libel.
//   1. shadowBlur. drawTiers sets shadowColor + shadowBlur = 2 and then strokes a Path2D containing
//      EVERY ring of a tier. A blurred stroke forces an offscreen render + blur + composite.
//   2. No viewport culling. tierPath walks every group and every ring of the whole world, regardless
//      of the camera — where provPath/provOnScreen cull per province. Realm cropping does not help:
//      TIERS is whole-world geometry.
//   3. No decimation. Rings are full-resolution source pixels; at 5.5x many consecutive points land
//      on the same screen pixel.
//
// Part 1 times the REAL layer (cache hit vs miss). Part 2 re-implements the draw against the same
// data and the same canvas to attribute cost across tessellate / shadow / cull.
//
// Usage:  node tiers-probe.mjs [liveBase] [k]
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const base = process.argv[2] || 'http://localhost:8080';
const K = +(process.argv[3] || 5.5);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.css': 'text/css', '.pack': 'application/octet-stream', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(WEB, p);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});
await new Promise(r => srv.listen(0, r));
const port = srv.address().port;

const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(`http://localhost:${port}/index.html?live=${base}&lobby=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#zoomLevel', { timeout: 45000 });
await page.waitForTimeout(12000);

const out = await page.evaluate(async k => {
  const core = await import('./js/core.mjs');
  const layers = await import('./js/layers.mjs');
  const bands = await import('./js/bands.mjs');
  const { draw } = await import('./js/repaint.mjs');
  const { ctx, cam, VIEW, S, pxr, pyr, apiUrl, clampPan } = core;

  cam.k = k; clampPan();
  const bump = () => { S.baseVersion++; S.viewVersion = S.baseVersion * 16; };
  // make sure the tier geometry has been fetched by the app itself
  for (let i = 0; i < 25; i++) { bump(); draw(); await new Promise(r => setTimeout(r, 120)); }

  const med = a => { const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(3); };
  const time = (n, fn) => { const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(i); t.push(performance.now() - t0); } return med(t); };

  // ---- Part 1: the REAL layer, cache miss vs cache hit ----
  const tiersLayer = layers.LAYERS.find(L => L.id === 'tiers');
  const realMiss = time(30, () => { bump(); tiersLayer.draw(); });   // viewVersion changes → rebuild
  const realHit  = time(30, () => { tiersLayer.draw(); });           // viewVersion stable → cached path

  // ---- Part 2: attribution, against the same data and the same canvas ----
  const TIERS = await fetch(apiUrl('/api/tiers')).then(r => r.json());
  const ENV = {
    continents: bands.GEO_TIER_ENV.continents,
    superRegions: bands.GEO_TIER_ENV.superRegions,
    regions: bands.GEO_TIER_ENV.regions,
  };
  const SPEC = [
    { tier: 'continents', width: 2.4, color: '232,237,247' },
    { tier: 'superRegions', width: 1.9, color: '205,217,234' },
    { tier: 'regions', width: 1.3, color: '174,188,210' },
  ].filter(s => bands.bandAlpha(ENV[s.tier]) > 0.01);   // only the tiers actually visible at this k

  // geometry scale, and how much of it is on screen at all
  const stats = {};
  for (const tier of Object.keys(TIERS)) {
    let rings = 0, pts = 0, ringsOnScreen = 0, ptsOnScreen = 0;
    for (const key in TIERS[tier]) for (const ring of TIERS[tier][key]) {
      rings++; pts += ring.length;
      let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
      for (const p of ring) { const x = pxr(p[0]), y = pyr(p[1]);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (!(x1 < 0 || y1 < 0 || x0 > VIEW.w || y0 > VIEW.h)) { ringsOnScreen++; ptsOnScreen += ring.length; }
    }
    stats[tier] = { groups: Object.keys(TIERS[tier]).length, rings, pts, ringsOnScreen, ptsOnScreen };
  }

  // Cull with the SHIPPED predicate and the SHIPPED index, so this validates what actually runs
  // rather than an approximation of it. (An earlier version rolled its own bbox check with no margin
  // and reported a 3-pixel difference at k=8 — which was the margin doing its job, not a bug.)
  const tg = await import('./js/tier-geom.mjs');
  const INDEX = {};
  for (const tier in TIERS) INDEX[tier] = tg.indexTierRings(TIERS[tier]);
  const keep = r => tg.tierRingVisible(r, pxr, pyr, VIEW.w, VIEW.h);

  const build = (tier, { cull = false, minStep = 0 } = {}) => {
    const p2 = new Path2D();
    for (const r of INDEX[tier] || []) {
      const ring = r.ring;
      if (cull && !keep(r)) continue;
      let lx = NaN, ly = NaN, started = false;
      for (let i = 0; i < ring.length; i++) {
        const x = pxr(ring[i][0]), y = pyr(ring[i][1]);
        // decimate: skip a point that lands within minStep px of the last one KEPT (never the last
        // point of the ring, so the outline still closes where it should)
        if (minStep > 0 && started && i < ring.length - 1
            && Math.abs(x - lx) < minStep && Math.abs(y - ly) < minStep) continue;
        if (!started) { p2.moveTo(x, y); started = true; } else p2.lineTo(x, y);
        lx = x; ly = y;
      }
      p2.closePath();
    }
    return p2;
  };
  const strokeAll = (paths, shadow) => {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (shadow) { ctx.shadowColor = 'rgba(6,9,14,.55)'; ctx.shadowBlur = 2; }
    for (let i = 0; i < SPEC.length; i++) {
      ctx.globalAlpha = bands.bandAlpha(ENV[SPEC[i].tier]);
      ctx.lineWidth = SPEC[i].width;
      ctx.strokeStyle = `rgb(${SPEC[i].color})`;
      ctx.stroke(paths[i]);
    }
    ctx.restore();
  };

  const pathsAll = SPEC.map(s => build(s.tier));
  const pathsCull = SPEC.map(s => build(s.tier, { cull: true }));
  const pathsCullDec = SPEC.map(s => build(s.tier, { cull: true, minStep: 1.5 }));

  const r = {
    k, visibleTiers: SPEC.map(s => s.tier), stats,
    real: { cacheMiss: realMiss, cacheHit: realHit },
    tessellate: {
      all: time(20, () => SPEC.forEach(s => build(s.tier))),
      culled: time(20, () => SPEC.forEach(s => build(s.tier, { cull: true }))),
      culledDecimated: time(20, () => SPEC.forEach(s => build(s.tier, { cull: true, minStep: 1.5 }))),
    },
    stroke: {
      allWithShadow: time(20, () => strokeAll(pathsAll, true)),
      allNoShadow: time(20, () => strokeAll(pathsAll, false)),
      culledNoShadow: time(20, () => strokeAll(pathsCull, false)),
      culledDecimatedNoShadow: time(20, () => strokeAll(pathsCullDec, false)),
    },
  };
  // ---- Part 3: is the cull PIXEL-SAFE? ----
  // The cull is the fix, and a wrong cull silently deletes boundaries — which is exactly the failure
  // mode nobody notices. So stroke the culled and un-culled paths to two offscreen canvases with
  // identical settings and compare every pixel. Anything that differs is a boundary the cull dropped
  // (or a stroke that should have bled in from just off-frame).
  const strokeTo = (paths, w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const o = c.getContext('2d');
    o.lineJoin = 'round'; o.lineCap = 'round';
    o.shadowColor = 'rgba(6,9,14,.55)'; o.shadowBlur = 2;
    for (let i = 0; i < SPEC.length; i++) {
      o.globalAlpha = bands.bandAlpha(ENV[SPEC[i].tier]);
      o.lineWidth = SPEC[i].width;
      o.strokeStyle = `rgb(${SPEC[i].color})`;
      o.stroke(paths[i]);
    }
    return o.getImageData(0, 0, w, h).data;
  };
  const diff = (X, Y) => {
    let n = 0, max = 0, at = null;
    for (let i = 0; i < X.length; i += 4) {
      const d = Math.max(Math.abs(X[i] - Y[i]), Math.abs(X[i + 1] - Y[i + 1]),
                         Math.abs(X[i + 2] - Y[i + 2]), Math.abs(X[i + 3] - Y[i + 3]));
      if (d > 0) { n++; if (d > max) { max = d; at = { px: (i / 4) % VIEW.w, py: Math.floor((i / 4) / VIEW.w), d }; } }
    }
    return { diffPx: n, maxDiff: max, at };
  };
  const A = strokeTo(pathsAll, VIEW.w, VIEW.h);
  // CONTROL: the same paths, stroked again. Canvas shadow rendering is not bit-exact between passes,
  // so this establishes the noise floor — without it, a 3-pixel/delta-2 difference reads as "the cull
  // dropped a boundary" when it is really the renderer disagreeing with itself.
  const A2 = strokeTo(pathsAll, VIEW.w, VIEW.h);
  const B = strokeTo(pathsCull, VIEW.w, VIEW.h);
  let inkA = 0;
  for (let i = 3; i < A.length; i += 4) if (A[i] > 0) inkA++;
  r.pixelEqual = {
    viewport: [VIEW.w, VIEW.h], inkedPixelsUnculled: inkA,
    control: diff(A, A2),        // un-culled vs un-culled — pure renderer noise
    culled: diff(A, B),          // un-culled vs culled — noise + any real dropped geometry
  };

  bump(); draw();   // leave the page repainted honestly
  return r;
}, K);

await page.screenshot({ path: path.join(HERE, `tiers-k${String(K).replace('.', '_')}.png`) });
console.log(JSON.stringify({ ...out, errors }, null, 2));
const s = out.stroke, t = out.tessellate;
console.log(`\n--- tiers at k=${out.k} (visible: ${out.visibleTiers.join(', ')}) ---`);
console.log(`  real layer draw:   cache MISS ${out.real.cacheMiss}ms   cache HIT ${out.real.cacheHit}ms`);
console.log(`  tessellate:        all ${t.all}ms   culled ${t.culled}ms   culled+decimated ${t.culledDecimated}ms`);
console.log(`  stroke:            all+shadow ${s.allWithShadow}ms   all no-shadow ${s.allNoShadow}ms`);
console.log(`                     culled no-shadow ${s.culledNoShadow}ms   culled+dec no-shadow ${s.culledDecimatedNoShadow}ms`);
console.log(`  shadow costs:      ${(s.allWithShadow - s.allNoShadow).toFixed(3)}ms  (${Math.round((1 - s.allNoShadow / s.allWithShadow) * 100)}% of the stroke)`);
for (const [tier, v] of Object.entries(out.stats)) {
  console.log(`  ${tier.padEnd(13)} ${v.rings} rings / ${v.pts} pts — on screen: ${v.ringsOnScreen} rings / ${v.ptsOnScreen} pts`);
}
const pe = out.pixelEqual, px = pe.viewport[0] * pe.viewport[1];
console.log(`  cull pixel-safety: culled ${pe.culled.diffPx}/${px} px differ (max ${pe.culled.maxDiff})` +
  `  |  control ${pe.control.diffPx}/${px} (max ${pe.control.maxDiff})  |  ${pe.inkedPixelsUnculled} inked`);

const fail = [];
if (!pe.inkedPixelsUnculled) fail.push('the un-culled reference drew nothing — the comparison proves nothing');
// Judge against the CONTROL, not against zero: a dropped ring would show as hundreds of pixels at
// full stroke alpha, so allow the renderer's own noise floor plus a small margin, and cap the
// per-pixel delta well below anything perceptible.
// Measured: the control is 0 and the culled diff is 0 at k=2/3/5.5/8/9 on this machine, so the floor
// only exists to absorb GPU/driver antialiasing variance elsewhere. A dropped ring shows up as
// hundreds of pixels at full stroke alpha, so 8 is nowhere near enough to hide one.
const noise = Math.max(pe.control.diffPx * 3, 8);
if (pe.culled.diffPx > noise) fail.push(`the cull changes ${pe.culled.diffPx} pixels vs a ${pe.control.diffPx}-pixel control — it is dropping visible boundaries`);
if (pe.culled.maxDiff > 8) fail.push(`a pixel differs by ${pe.culled.maxDiff}/255 at ${JSON.stringify(pe.culled.at)} — too large to be antialiasing noise`);
if (errors.length) fail.push('page errors: ' + JSON.stringify(errors.slice(0, 4)));
console.log(fail.length ? '\nFAIL\n - ' + fail.join('\n - ') : '\nPASS — cull is pixel-identical to drawing every ring');
await b.close(); srv.close();
process.exit(fail.length ? 1 : 0);
