// P2 of docs/pixi-migration-plan.md: the plot layer on Pixi — CORRECTNESS + the go/no-go MEASUREMENT.
//
// Loads the page twice — once plain, once with ?pixiPlots=1 — and in each: zooms to a deep-zoom view
// over real land, waits for the province offscreens to finish building, then times the plot layer.
//
// The timed unit is main.drawSurfacePlots() — the exported layer draw fn, called directly, so no rAF
// scheduling and no 30fps cap (js/repaint.mjs) pollute the number. On the flagged pass renderPixi() is
// timed too and ADDED, because that is where the GPU work actually happens: comparing sprite-sync
// against drawImage alone would flatter Pixi dishonestly.
//
// Correctness on the flagged pass: every placed sprite's rect, pushed through Pixi's real matrix, must
// land on the rect blitProvinceCanvas would have drawn to.
//
// Usage:  node pixi-p2-verify.mjs [liveBase]
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
  const f = path.join(WEB, p);
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => srv.listen(0, r));
const port = srv.address().port;

const SAMPLES = 60;
// The plot layer has TWO cost regimes and they pull in opposite directions, so measuring one is
// measuring nothing:
//   k≈6   just past K_PLOT — MANY provinces visible, each a cheap flat 1px/plot blit. Province-count
//         bound, and the case where per-province overhead (four pxr/pyr + a drawImage) dominates.
//   k≈40  past K_TEX — FEW provinces visible, each a large textured offscreen scaled up. Fill-rate
//         bound, and where a single drawImage is already close to optimal.
// A first run at k=40 alone reported "0.21x SLOWER" off ONE visible province — i.e. it measured Pixi's
// fixed per-frame renderer cost against a single blit, which tells you nothing about how either scales.
const KS = [5.5, 8, 16, 40];

// Runs in the page. Returns timings, sprite stats and (flagged only) placement agreement.
// NOTE: page.evaluate serialises this function, so module-scope constants are NOT in scope here —
// everything it needs arrives through the single argument.
async function probe({ flagged, SAMPLES, KS }) {
  const core = await import('./js/core.mjs');
  const main = await import('./js/main.mjs');
  const pixi = await import('./js/pixi.mjs');
  const pplots = await import('./js/pixi-plots.mjs');
  const { draw } = await import('./js/repaint.mjs');
  const { Point } = await import('./js/vendor/pixi.min.mjs');
  const { cam, VIEW, P, S, provSrcBox, baseXr, baseYr, pxr, pyr, clampPan, K_TEX } = core;

  const bump = () => { S.baseVersion++; S.viewVersion = S.baseVersion * 16; };

  // ---- pick the camera target ----
  // NOT by provSrcBox: a province's bounding box can be enormous and centred over water, so parking
  // on its middle (then being moved by clampPan) can leave the viewport with no plots in it at all.
  // The first version of this benchmark did exactly that and "measured" k=16/40 with a single sprite
  // sitting at global x=-2694 — off screen. So: load grids from a wide view first, then aim at the
  // centre of the actual PLOT box of the province with the most plots.
  let cx = null, cy = null;
  for (let i = 0; i < 40; i++) {
    cam.k = 5.5; clampPan(); bump(); draw();
    await new Promise(r => setTimeout(r, 150));
    if (P.filter(p => p._pbox || p._tbox).length > 40) break;
  }
  {
    const withBox = P.filter(p => (p._pbox || p._tbox) && p._plots && p._plots.length
                                  && p.type !== 'SEA' && p.type !== 'LAKE');
    if (!withBox.length) return { error: 'no land province ever built a plot offscreen' };
    withBox.sort((a, b) => b._plots.length - a._plots.length);
    const box = withBox[0]._tbox || withBox[0]._pbox;
    cx = box.x0 + box.w / 2; cy = box.y0 + box.h / 2;
  }
  const park = k => {
    cam.k = k;
    cam.x = VIEW.w / 2 - cam.k * baseXr(cx);
    cam.y = VIEW.h / 2 - cam.k * baseYr(cy);
    clampPan();
  };
  // Two different counts, and the difference matters:
  //   drawn    — what drawPlots actually iterates and emits. It culls on provSrcBox (the province
  //              polygon's bbox), so a blit can be issued for a province whose PLOTS are off screen.
  //   onScreen — provinces whose plot offscreen really intersects the viewport, i.e. the work that
  //              produces visible pixels. If this is 0 the row is measuring nothing and must not be
  //              reported as a result.
  const boxOf = p => p._tcanvas ? p._tbox : p._pbox;
  const counts = () => {
    let drawn = 0, onScreen = 0;
    for (const p of P) {
      if (p.type === 'SEA' || p.type === 'LAKE') continue;
      if (!(p._plots && p._plots.length && (p._tcanvas || p._pcanvas))) continue;
      const b = provSrcBox(p);
      if (b && !(pxr(b.x1) < 0 || pyr(b.y1) < 0 || pxr(b.x0) > VIEW.w || pyr(b.y0) > VIEW.h)) drawn++;
      const q = boxOf(p);
      if (q && !(pxr(q.x0 + q.w) < 0 || pyr(q.y0 + q.h) < 0 || pxr(q.x0) > VIEW.w || pyr(q.y0) > VIEW.h)) onScreen++;
    }
    return { drawn, onScreen };
  };

  // is the ground-texture atlas actually reachable? If it 404s, `textured` never turns on and the
  // k>=K_TEX rows silently measure the flat path instead — which looks like a real result.
  let atlas = null;
  try {
    const r = await fetch(core.TT ? core.TT.src : 'about:blank', { cache: 'no-store' });
    atlas = { src: core.TT && core.TT.src, ok: r.ok, status: r.status };
  } catch (e) { atlas = { src: core.TT && core.TT.src, ok: false, error: String(e) }; }

  const stat = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y);
    return { median: +s[s.length >> 1].toFixed(3), p90: +s[Math.floor(s.length * 0.9)].toFixed(3) }; };
  const rows = [];

  for (const k of KS) {
    park(k);
    // settle: fetch the grids and let the 6ms-per-frame build budget finish the offscreens for the
    // provinces actually in view. Wait on the VISIBLE count holding steady, not a global tally.
    let hold = 0, prev = -1;
    for (let i = 0; i < 70; i++) {
      bump(); draw();
      await new Promise(r => setTimeout(r, 150));
      const n = counts().onScreen;
      if (n === prev && n > 0) { if (++hold >= 5) break; } else { hold = 0; prev = n; }
    }
    const { drawn, onScreen } = counts();
    const textured = P.filter(p => p._tcanvas).length;

    const tLayer = [], tRender = [];
    for (let i = 0; i < SAMPLES; i++) {
      cam.x += (i % 2 ? 1 : -1) * 0.75;   // jitter so nothing short-circuits on an unchanged view
      bump();
      if (flagged) pixi.syncCamera(cam, VIEW);
      let t0 = performance.now();
      main.drawSurfacePlots();
      tLayer.push(performance.now() - t0);
      if (flagged) { t0 = performance.now(); pixi.renderPixi(); tRender.push(performance.now() - t0); }
      await new Promise(requestAnimationFrame);   // let the GPU retire the frame
    }

    // placement: every visible sprite must sit where blitProvinceCanvas would have drawn it
    let worst = 0, checked = 0, sample = null;
    if (flagged) {
      const plotsC = pixi.world.children.find(c => c.label === 'plots');
      for (const s of (plotsC ? plotsC.children : [])) {
        if (!s.visible) continue;
        const p = P.find(q => [q._tbox, q._pbox].some(b =>
          b && Math.abs(baseXr(b.x0) - s.x) < 1e-6 && Math.abs(baseYr(b.y0) - s.y) < 1e-6));
        if (!p) continue;
        const box = (p._tbox && Math.abs(baseXr(p._tbox.x0) - s.x) < 1e-6) ? p._tbox : p._pbox;
        const g = pixi.world.toGlobal(new Point(s.x, s.y));
        const wantX = pxr(box.x0), wantY = pyr(box.y0);
        const wantW = pxr(box.x0 + box.w) - wantX, wantH = pyr(box.y0 + box.h) - wantY;
        const d = Math.max(Math.abs(g.x - wantX), Math.abs(g.y - wantY),
                           Math.abs(s.width * cam.k - wantW), Math.abs(s.height * cam.k - wantH));
        if (d > worst) { worst = d; sample = { got: [+g.x.toFixed(2), +g.y.toFixed(2)], want: [+wantX.toFixed(2), +wantY.toFixed(2)] }; }
        checked++;
      }
    }

    rows.push({ k, drawn, onScreen, texturedCanvases: textured, layerMs: stat(tLayer), renderMs: stat(tRender),
                placement: flagged ? { checked, worst: +worst.toFixed(6), sample } : null,
                stats: flagged ? pplots.plotStats() : null });
  }

  // leave the page on a state worth screenshotting: a mid zoom where plots fully cover, repainted
  park(16); bump();
  if (flagged) pixi.syncCamera(cam, VIEW);
  draw();
  await new Promise(r => setTimeout(r, 600));
  if (flagged) pixi.renderPixi();

  return { flagged, atlas, K_TEX, target: { cx, cy }, rows };
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = {};
for (const flagged of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const q = `?live=${base}&lobby=0` + (flagged ? '&pixiPlots=1' : '');
  await page.goto(`http://localhost:${port}/index.html${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);
  results[flagged ? 'pixi' : 'canvas2d'] = { ...(await page.evaluate(probe, { flagged, SAMPLES, KS })), errors };
  await page.screenshot({ path: path.join(HERE, flagged ? 'pixi-p2-pixi.png' : 'pixi-p2-canvas2d.png') });
  await page.close();
}
await browser.close(); srv.close();

const a = results.canvas2d, b = results.pixi;
const fail = [];
if (a.error || b.error) fail.push('probe error: ' + (a.error || b.error));
if (!a.rows || !b.rows) fail.push('no timings collected');
if (b.atlas && !b.atlas.ok) fail.push(`ground-texture atlas unreachable (${JSON.stringify(b.atlas)}) — the k>=K_TEX rows are NOT measuring the textured path`);

const total = r => r.layerMs ? r.layerMs.median + (r.renderMs ? r.renderMs.median : 0) : NaN;
console.log(JSON.stringify(results, null, 2));
console.log('\n--- P2 measurement: median ms to get the plot layer on screen ---');
console.log('   k   drawn/onScreen   canvas2d      pixi (layer+render)     ratio');
for (let i = 0; i < (a.rows || []).length; i++) {
  const ra = a.rows[i], rb = b.rows[i];
  if (!ra || !rb) continue;
  const ta = total(ra), tb = total(rb);
  const x = ta / tb;
  console.log(`  ${String(ra.k).padStart(4)}   ${String(ra.drawn + '/' + ra.onScreen).padStart(12)}   ${ta.toFixed(3).padStart(8)}ms   ` +
    `${rb.layerMs.median.toFixed(3)}+${rb.renderMs.median.toFixed(3)}=${tb.toFixed(3).padStart(7)}ms   ` +
    `${x.toFixed(2)}x ${x >= 1 ? 'faster' : 'SLOWER'}`);
  // a row with nothing on screen is not a result — it is Pixi's fixed cost against an idle canvas
  if (ra.onScreen === 0 || rb.onScreen === 0) fail.push(`k=${ra.k}: nothing on screen (${ra.onScreen}/${rb.onScreen}) — camera is off the plots, row is meaningless`);
  if (rb.placement) {
    if (rb.placement.checked === 0) fail.push(`k=${rb.k}: no sprites placed — the layer drew nothing`);
    else if (rb.placement.worst > 0.01) fail.push(`k=${rb.k}: placement off by ${rb.placement.worst}px ${JSON.stringify(rb.placement.sample)}`);
  }
}
for (const [k, r] of Object.entries(results)) if (r.errors.length) fail.push(`${k} console errors: ${JSON.stringify(r.errors.slice(0, 4))}`);
console.log(fail.length ? '\nFAIL\n - ' + fail.join('\n - ') : '\nPASS — placement exact at every zoom, both paths measured');
process.exit(fail.length ? 1 : 0);
