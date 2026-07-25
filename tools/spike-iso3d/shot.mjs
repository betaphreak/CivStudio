// Serve the spike and screenshot it in a few configurations, so the look can be judged without
// launching a browser by hand. Usage:  node shot.mjs [--headed]
//
// Each shot names the height model it used, because that is the whole question: does the Civ4-ish
// discrete plotType relief carry the look, or does the real (very gentle) heightmap?
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const headed = process.argv.includes('--headed');
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png' };

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(HERE, p), (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(d);
  });
});
await new Promise(r => srv.listen(0, r));
const port = srv.address().port;

const b = await chromium.launch({ channel: 'msedge', headless: !headed });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__spike, null, { timeout: 30000 })
  .catch(() => { throw new Error('viewer never initialised: ' + errors.join(' | ')); });
await page.waitForTimeout(1200);

const stats = await page.evaluate(() => document.getElementById('stats').textContent);
console.log(stats);

const shots = [
  ['civ-oblique',   { peak: 3.4, hill: 1.0, elev: 6,  smooth: 1 }, 30],
  ['civ-low',       { peak: 3.4, hill: 1.0, elev: 6,  smooth: 1 }, 18],
  ['heightmap-only',{ peak: 0,   hill: 0,   elev: 30, smooth: 1 }, 30],
  ['flat',          { peak: 0,   hill: 0,   elev: 0,  smooth: 0 }, 30],
  ['strong',        { peak: 6.0, hill: 1.8, elev: 8,  smooth: 2 }, 26],
  ['topdown',       { peak: 3.4, hill: 1.0, elev: 6,  smooth: 1 }, 89],
];
for (const [name, cfg, tilt] of shots) {
  await page.evaluate(([cfg, tilt]) => {
    // setParams, not a raw P assignment — it also pushes the values to the sliders, so the panel in
    // each screenshot describes the mesh in that screenshot rather than the defaults.
    window.__spike.setParams({ ...cfg, flat: false });
    const m = window.__spike.meta.box;
    window.__spike.view(tilt, Math.max(m.w, m.h) * (tilt > 60 ? 1.25 : 1.45));
  }, [cfg, tilt]);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(HERE, `shot-${name}.png`) });
  console.log(`shot-${name}.png  peak ${cfg.peak} hill ${cfg.hill} elev x${cfg.elev} smooth ${cfg.smooth} tilt ${tilt}deg`);
}
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await b.close(); srv.close();
