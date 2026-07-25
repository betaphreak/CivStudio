// Where does paint() actually spend its time? Wrap every registry layer's draw fn and attribute cost
// per layer, per frame, at each requested zoom.
//
// Usage:  node layer-profile.mjs [liveBase] [k,k,k]
//   e.g.  node layer-profile.mjs http://localhost:8080 1,4,5.5,8,16
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
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://localhost:${port}/index.html?live=${base}&lobby=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#zoomLevel', { timeout: 45000 });
await page.waitForTimeout(12000);

for (const k of KS) {
  const r = await page.evaluate(async z => {
    const core = await import('./js/core.mjs');
    const layers = await import('./js/layers.mjs');
    const { draw } = await import('./js/repaint.mjs');
    const acc = {};
    // wrap each registry entry once (restore first, so repeated runs don't nest wrappers)
    for (const L of layers.LAYERS) {
      if (L._orig) L.draw = L._orig;
      const orig = L.draw; L._orig = orig;
      L.draw = () => { const t = performance.now(); orig(); acc[L.id] = (acc[L.id] || 0) + (performance.now() - t); };
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
    const rows = Object.entries(acc).map(([id, ms]) => [id, +(ms / N).toFixed(2)])
      .filter(([, ms]) => ms > 0.005).sort((a, b2) => b2[1] - a[1]);
    const layerTotal = rows.reduce((s, [, ms]) => s + ms, 0);
    return { rows: rows.slice(0, 10), layerTotal: +layerTotal.toFixed(2),
             frameWall: +(whole.reduce((s, v) => s + v, 0) / N).toFixed(2) };
  }, k);
  console.log(`\n${k}x  layers ${r.layerTotal}ms/frame (draw→rAF wall ${r.frameWall}ms)`);
  for (const [id, ms] of r.rows) {
    const pct = r.layerTotal > 0 ? Math.round(ms / r.layerTotal * 100) : 0;
    console.log(`     ${String(ms).padStart(7)}ms  ${String(pct).padStart(3)}%  ${id}`);
  }
}
await b.close(); srv.close();
