// P0 of docs/pixi-migration-plan.md: the Pixi renderer boots onto #gl and draws NOTHING.
//
// What this asserts is deliberately narrow, because P0's whole claim is "no visible change":
//   1. the #gl canvas exists, sits BENEATH #map, and its backing store matches #map's exactly
//   2. the renderer initialised, and we report WHICH backend won (webgpu vs a silent webgl2 fallback)
//   3. the three scene roots exist and are EMPTY (nothing has migrated yet)
//   4. the page booted with no console errors / page errors
//   5. a resize keeps both canvases in agreement
//
// Usage:  node pixi-p0-verify.mjs [liveBase] [waitMs]
// Serves web/ itself (the site needs HTTP, not file://) and points the page at a live server for
// window.BUNDLE — same shape as boot-check.mjs.
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const base = process.argv[2] || 'https://dev.civstudio.com';
const waitMs = +(process.argv[3] || 14000);
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
const url = `http://localhost:${port}/index.html?live=${base}&lobby=0`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(waitMs);

// The module graph is not reachable from page.evaluate (ES modules have no global handle), so ask
// the page to import the same module instance the app already loaded — an ES module is a singleton
// per URL, so this is the live object graph, not a second copy.
const state = await page.evaluate(async () => {
  const gl = document.getElementById('gl'), map = document.getElementById('map');
  const cs = el => el ? getComputedStyle(el) : null;
  const out = {
    hasBundle: !!window.BUNDLE,
    glPresent: !!gl,
    mapPresent: !!map,
    glZ: cs(gl) && cs(gl).zIndex,
    mapZ: cs(map) && cs(map).zIndex,
    glBacking: gl ? [gl.width, gl.height] : null,
    mapBacking: map ? [map.width, map.height] : null,
    glRect: gl ? [Math.round(gl.getBoundingClientRect().width), Math.round(gl.getBoundingClientRect().height)] : null,
  };
  try {
    const m = await import('./js/pixi.mjs');
    out.backend = m.pixiBackend();
    out.appUp = !!m.pixiApp();
    out.roots = {
      screenBelow: m.screenBelow.children.length,
      world: m.world.children.length,
      screenAbove: m.screenAbove.children.length,
    };
    out.worldTransform = [m.world.x, m.world.y, m.world.scale.x];
    if (m.pixiApp()) out.rendererSize = [m.pixiApp().renderer.width, m.pixiApp().renderer.height,
                                         m.pixiApp().renderer.resolution];
  } catch (e) { out.importError = String(e && e.message || e); }
  return out;
});

await page.screenshot({ path: path.join(HERE, 'pixi-p0-map.png') });

// resize agreement: shrink the window and re-read both canvases' backing stores
await page.setViewportSize({ width: 1000, height: 700 });
await page.waitForTimeout(1200);
const afterResize = await page.evaluate(() => {
  const gl = document.getElementById('gl'), map = document.getElementById('map');
  return { glBacking: [gl.width, gl.height], mapBacking: [map.width, map.height] };
});

const fail = [];
if (!state.hasBundle) fail.push('window.BUNDLE never arrived (server unreachable?)');
if (!state.glPresent) fail.push('#gl canvas missing');
if (state.importError) fail.push('js/pixi.mjs failed to import: ' + state.importError);
if (!state.appUp) fail.push('Pixi Application did not initialise');
if (Number(state.glZ) >= Number(state.mapZ)) fail.push(`#gl (z=${state.glZ}) is not beneath #map (z=${state.mapZ})`);
if (String(state.glBacking) !== String(state.mapBacking)) {
  fail.push(`backing stores disagree: gl=${state.glBacking} map=${state.mapBacking}`);
}
if (String(afterResize.glBacking) !== String(afterResize.mapBacking)) {
  fail.push(`backing stores disagree AFTER resize: gl=${afterResize.glBacking} map=${afterResize.mapBacking}`);
}
const rootCount = state.roots ? state.roots.screenBelow + state.roots.world + state.roots.screenAbove : -1;
if (rootCount !== 0) fail.push(`scene roots are not empty (${JSON.stringify(state.roots)}) — P0 draws nothing`);
if (errors.length) fail.push('console errors: ' + JSON.stringify(errors.slice(0, 5)));

console.log(JSON.stringify({ ...state, afterResize, errors }, null, 2));
console.log(fail.length ? '\nFAIL\n - ' + fail.join('\n - ') : '\nPASS — renderer up on ' + state.backend + ', scene empty, canvases agree');

await browser.close();
srv.close();
process.exit(fail.length ? 1 : 0);
