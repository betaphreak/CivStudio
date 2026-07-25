// Where does paint() actually spend its time? Wrap every registry layer's draw fn and attribute cost
// per layer, per frame, at each requested zoom.
//
// Usage:  node layer-profile.mjs [liveBase] [k,k,k] [WxH]
//   e.g.  node layer-profile.mjs http://localhost:8080 1,4,5.5,8,16 1600x900
//
// The viewport argument is a DIAGNOSTIC, not decoration. Canvas 2D fill/stroke calls queue work and
// return, so the per-layer CPU timings below measure command ISSUING, not rasterisation — which is why
// stroking 113k inked pixels of tier boundary times at 0 ms while the frame wall is 50 ms. Running the
// same zoom at a quarter of the pixels separates the two: fill-rate scales with pixel count, issuing
// does not.
//
// Serves web/ itself, so it needs nothing but a reachable spectator server for window.BUNDLE.
// (It used to assume a dev-server on :3000 and called main.draw(), which main.mjs does not export —
// the repaint scheduler owns draw(). Both fixed.)
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const base = process.argv[2] || 'http://localhost:8080';
const KS = (process.argv[3] || '1,4,5.5,8,16,40').split(',').map(Number);
const [VW, VH] = (process.argv[4] || '1600x900').split('x').map(Number);
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

const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: VW, height: VH } });
console.log(`viewport ${VW}x${VH} (${(VW * VH / 1e6).toFixed(2)} Mpx)`);
await page.goto(`http://localhost:${port}/index.html?live=${base}&lobby=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#zoomLevel', { timeout: 45000 });
await page.waitForTimeout(12000);

for (const k of KS) {
  const r = await page.evaluate(async z => {
    const core = await import('./js/core.mjs');
    const layers = await import('./js/layers.mjs');
    const { draw } = await import('./js/repaint.mjs');
    const acc = {};
    // Wrap BOTH registries (restore first, so repeated runs don't nest wrappers). SCREEN_LAYERS is
    // included because the ocean base is drawn there, not in LAYERS — and it is a full-viewport
    // gradient plus a soft-light pattern fill, i.e. exactly the shape of thing that was once the
    // most expensive draw in the scene (sea.mjs's header: the deleted polar ice cap, 18.8 ms/frame).
    // Screen-stack entries are prefixed so they cannot be confused with world layers.
    for (const L of layers.LAYERS) {
      if (L._orig) L.draw = L._orig;
      const orig = L.draw; L._orig = orig;
      L.draw = () => { const t = performance.now(); orig(); acc[L.id] = (acc[L.id] || 0) + (performance.now() - t); };
    }
    for (const L of layers.SCREEN_LAYERS) {
      if (L._orig) L.draw = L._orig;
      const orig = L.draw; L._orig = orig;
      L.draw = () => { const t = performance.now(); orig(); acc['screen:' + L.id] = (acc['screen:' + L.id] || 0) + (performance.now() - t); };
    }
    core.cam.k = z; core.clampPan();
    // let plot grids fetch and the per-frame build budget finish before timing steady state
    for (let i = 0; i < 25; i++) {
      core.S.baseVersion++; core.S.viewVersion = core.S.baseVersion * 16;
      draw(); await new Promise(r2 => setTimeout(r2, 140));
    }
    const N = 20;
    for (const id of Object.keys(acc)) delete acc[id];
    const whole = [];
    for (let i = 0; i < N; i++) {
      core.S.baseVersion++; core.S.viewVersion = core.S.baseVersion * 16;
      const t0 = performance.now();
      draw();
      await new Promise(requestAnimationFrame);
      whole.push(performance.now() - t0);
    }
    for (const L of layers.LAYERS) L.draw = L._orig;
    for (const L of layers.SCREEN_LAYERS) L.draw = L._orig;
    const rows = Object.entries(acc).map(([id, ms]) => [id, +(ms / N).toFixed(2)])
      .filter(([, ms]) => ms > 0.005).sort((a, b2) => b2[1] - a[1]);
    const layerTotal = rows.reduce((s, [, ms]) => s + ms, 0);
    // WHOLE-FRAME COST comes from the app's own instrumentation, not from timing draw()→rAF.
    //
    // A draw()→rAF wall is NOT a frame cost and must not be treated as one: repaint.mjs coalesces to
    // one paint per animation frame behind a 30 fps CAP, re-queueing a frame that comes due early. So a
    // tight draw() loop iterates at ~60 Hz while paints land at ~30 Hz — half the awaits measure no
    // paint at all, and the wall reports rAF cadence (~16 ms) or the cap (~33-50 ms) depending on
    // where the loop lands. Subtracting the layer sum from it produced a "residual" that read as
    // 21-30 ms of mystery work at some zooms and 0 ms at the same zoom moments later. It was an
    // artifact. Two separate hypotheses (seaBase, then the realm fog) were chased and disproved
    // before the metric itself turned out to be the bug.
    //
    // main.paint() already times paintScene() synchronously and hands the duration to
    // diag.noteFrame(), which publishes the mean in the chip's tooltip. That is the honest number.
    let paintMs = null;
    const chip = document.getElementById('diagChip');
    const t = chip && [...chip.querySelectorAll('*')].map(e => e.title).find(s => s && s.includes('Render cost'));
    const m = t && t.match(/Render cost:\s*([\d.]+)\s*ms mean/);
    if (m) paintMs = +m[1];
    return { rows: rows.slice(0, 12), layerTotal: +layerTotal.toFixed(2), paintMs,
             // kept only to show it is uninformative; see the note above. Do not derive from it.
             rafWall: +(whole.reduce((s, v) => s + v, 0) / N).toFixed(2) };
  }, k);
  console.log(`\n${k}x  paintScene ${r.paintMs == null ? '—' : r.paintMs + 'ms'}` +
    `  (registries ${r.layerTotal}ms of it; rAF wall ${r.rafWall}ms — uninformative, see source)`);
  for (const [id, ms] of r.rows) {
    const pct = r.layerTotal > 0 ? Math.round(ms / r.layerTotal * 100) : 0;
    console.log(`     ${String(ms).padStart(7)}ms  ${String(pct).padStart(3)}%  ${id}`);
  }
}
await b.close(); srv.close();
