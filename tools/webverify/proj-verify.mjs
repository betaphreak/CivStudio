// P0 of docs/terrain-3d.md: prove the projection seam changed NO PIXEL.
//
// core.mjs now routes the camera through a swappable projector (project/unproject/plotPxAt/separable)
// instead of only the two separable functions pxr/pyr. The whole value of doing that as its own phase is
// that it is exactly verifiable: for the 2D camera the seam must agree with the literal arithmetic it
// replaced, to the bit, at every zoom.
//
// So this asserts AGREEMENT WITH THE FORMULAS, not a screenshot diff — the same idiom that verified the
// Pixi camera seam (105 samples, exact 0 px, see docs/pixi-migration-plan.md §P1). A screenshot diff
// would pass just as happily on a frame that is subtly wrong everywhere by half a pixel, and would fail
// on an unrelated font or art-load race.
//
// Usage:  node proj-verify.mjs [liveBase]      (needs a server for window.BUNDLE, default :8080)
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const base = process.argv[2] || 'http://localhost:8080';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.css': 'text/css', '.pack': 'application/octet-stream', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(WEB, p), (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
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
await page.waitForTimeout(3000);

const out = await page.evaluate(async () => {
  const core = await import('./js/core.mjs');
  const { cam, VIEW, MAP, baseXr, baseYr, pxr, pyr, project, unproject, plotPxAt, separable,
          setProjector, latAtScreenY, clampPan, S } = core;
  const fails = [], notes = [];
  let checks = 0, worstRound = 0;
  const eq = (a, z, what) => { checks++; if (a !== z) fails.push(`${what}: ${a} !== ${z} (Δ${a - z})`); };

  if (!separable()) fails.push('the default projector must declare itself separable');

  // sample source pixels spanning the crop, including both edges (clampPan parks the camera there)
  const sxs = [MAP.x0, MAP.x0 + 1, (MAP.x0 + MAP.x1) / 2, MAP.x1 - 0.5, MAP.x1];
  const sys = [MAP.y0, MAP.y0 + 1, (MAP.y0 + MAP.y1) / 2, MAP.y1 - 0.5, MAP.y1];

  for (const k of [1, 5, 8, 16, 32, 64, 128, 512]) {          // K_PLOT, K_TEX, the band seams, K_MAX
    cam.k = k;
    clampPan();                                               // a real camera, not an arbitrary one
    S.baseVersion++;
    for (const sx of sxs) for (const sy of sys) {
      // 1) the JOINT projector must equal the separable fast path, exactly. This is the load-bearing
      //    claim: every unconverted call site still uses pxr/pyr, so any divergence here IS a pixel.
      const [x, y] = project(sx, sy);
      eq(x, pxr(sx), `project.x k=${k} sx=${sx}`);
      eq(y, pyr(sy), `project.y k=${k} sy=${sy}`);
      // 2) and both must equal the raw formula, in case pxr/pyr themselves drifted
      eq(x, cam.x + cam.k * baseXr(sx), `pxr formula k=${k} sx=${sx}`);
      eq(y, cam.y + cam.k * baseYr(sy), `pyr formula k=${k} sy=${sy}`);
      // 3) unproject round-trips (float, so a tolerance — in SOURCE PIXELS, i.e. plots)
      const [rx, ry] = unproject(x, y);
      worstRound = Math.max(worstRound, Math.abs(rx - sx), Math.abs(ry - sy));
    }
    // 4) plotPxAt must reproduce the `pxr(1) - pxr(0)` idiom it replaced at the four call sites.
    //    EXACT: this is the pixel-identity claim — those sites all call the no-argument form.
    eq(plotPxAt(), pxr(1) - pxr(0), `plotPxAt() k=${k}`);
    //    And, under a separable projector, it must be position-independent — the property those sites
    //    assumed when they hoisted one probe out of a per-plot loop. TOLERANCE, not equality: probing
    //    at a large source offset subtracts two large screen coordinates, so the low bits cancel away
    //    (~1e-11 px at k=512, i.e. nothing). Worth knowing for P2, where the probe becomes per-plot.
    checks++;
    const drift = Math.abs(plotPxAt(MAP.x0, MAP.y0) - plotPxAt());
    if (drift > 1e-9) fails.push(`plotPxAt position-independence k=${k}: drifted ${drift} px`);
    // 5) latAtScreenY now goes through unproject; assert it against the expression it used to inline,
    //    because its output feeds the ocean's climate banding where a last-bit wobble shows as a seam
    for (const sy of [0, 1, VIEW.h / 2, VIEW.h]) {
      const sp = MAP.y0 + (((sy - cam.y) / cam.k - VIEW.dy) / VIEW.dh) * (MAP.y1 - MAP.y0);
      const t = (1 - 2 * sp / MAP.H) * Math.PI;
      const hand = (2 * Math.atan(Math.exp(t)) - Math.PI / 2) * 180 / Math.PI;
      eq(latAtScreenY(sy), hand, `latAtScreenY k=${k} y=${sy}`);
    }
  }

  // 6) the seam actually swaps, and restoring it puts the old numbers back. Without this the whole
  //    phase is untested for the one thing it exists to enable.
  const before = project(MAP.x0 + 10, MAP.y0 + 10);
  const bv = S.baseVersion;
  setProjector({ separable: false, project: (sx, sy, h = 0) => [sx * 2, sy * 2 + h], unproject: (mx, my) => [mx / 2, my / 2] });
  const swapped = project(MAP.x0 + 10, MAP.y0 + 10);
  if (swapped[0] !== (MAP.x0 + 10) * 2) fails.push('setProjector did not take effect');
  if (separable()) fails.push('separable() must follow the installed projector');
  if (S.baseVersion === bv) fails.push('setProjector must bump baseVersion (cached Path2Ds key off it)');
  // plotPxAt must fall back to the general scale probe rather than the pxr fast path
  const gen = plotPxAt(MAP.x0 + 10, MAP.y0 + 10);
  if (Math.abs(gen - 2) > 1e-9) fails.push(`plotPxAt general path: expected 2, got ${gen}`);
  // h reaches the projector (the 2D camera ignores it; a 3D one will not)
  if (project(0, 0, 5)[1] !== 5) fails.push('the height argument is not being passed through');
  setProjector();
  const after = project(MAP.x0 + 10, MAP.y0 + 10);
  if (after[0] !== before[0] || after[1] !== before[1]) fails.push('restoring the default projector did not restore its numbers');
  if (!separable()) fails.push('the restored default must be separable again');
  notes.push(`swap/restore verified (temporarily projected to ${swapped.map(v => v.toFixed(1)).join(',')})`);

  return { fails, checks, worstRound, notes, realm: core.ACTIVE_REALM, crop: [MAP.x0, MAP.y0, MAP.x1, MAP.y1] };
});

console.log(`realm=${out.realm} crop=${out.crop.join(',')}`);
console.log(`${out.checks} exact-agreement checks; worst unproject round trip ${out.worstRound.toExponential(2)} source px`);
for (const n of out.notes) console.log('  ' + n);
if (out.worstRound > 1e-6) out.fails.push(`unproject round trip too loose: ${out.worstRound} source px`);
if (errors.length) out.fails.push(...errors);

await page.screenshot({ path: path.join(HERE, 'proj-verify.png') });
await b.close(); srv.close();

if (out.fails.length) {
  console.error(`\nFAIL (${out.fails.length}):`);
  for (const f of out.fails.slice(0, 20)) console.error('  ' + f);
  process.exit(1);
}
console.log('\nPASS — the projection seam agrees with the arithmetic it replaced, to the bit.');
