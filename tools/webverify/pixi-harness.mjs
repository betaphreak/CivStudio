// Isolated check that the VENDORED Pixi bundle boots in this browser at all — no server, no
// window.BUNDLE, no app. Answers the one question the full P0 verifier cannot separate from a
// server outage: does js/vendor/pixi.min.mjs initialise, and on which backend?
//
// Usage:  node pixi-harness.mjs [--headed]
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const headed = process.argv.includes('--headed');

const HARNESS = `<!doctype html><meta charset=utf-8><title>pixi harness</title>
<style>html,body{margin:0;background:#111}canvas#gl{position:absolute;inset:0;width:100%;height:100%}</style>
<canvas id="gl"></canvas>
<script type="module">
  window.__status = (m, k) => { window.__lastStatus = k + ": " + m; };
  const m = await import('/js/pixi.mjs');
  await m.initPixi();
  m.resizePixi(800, 600, 2);
  m.renderPixi();
  window.__result = {
    backend: m.pixiBackend(),
    appUp: !!m.pixiApp(),
    status: window.__lastStatus || null,
    rendererSize: m.pixiApp() ? [m.pixiApp().renderer.width, m.pixiApp().renderer.height, m.pixiApp().renderer.resolution] : null,
    roots: [m.screenBelow.label, m.world.label, m.screenAbove.label],
    stageChildren: m.pixiApp() ? m.pixiApp().stage.children.map(c => c.label) : null,
  };
</script>`;

const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HARNESS); return;
  }
  fs.readFile(path.join(WEB, p), (e, data) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(data);
  });
});
await new Promise(r => srv.listen(0, r));
const port = srv.address().port;

const browser = await chromium.launch({ channel: 'msedge', headless: !headed });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__result, null, { timeout: 20000 }).catch(() => {});
const r = await page.evaluate(() => window.__result || null);

console.log(JSON.stringify({ result: r, errors }, null, 2));
const ok = r && r.appUp && String(r.stageChildren) === 'screenBelow,world,screenAbove';
console.log(ok ? `\nPASS — pixi up on ${r.backend}, roots attached in order`
                : '\nFAIL — see above');
await browser.close(); srv.close();
process.exit(ok ? 0 : 1);
