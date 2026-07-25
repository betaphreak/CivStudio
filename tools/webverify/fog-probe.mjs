// docs/frontend-performance.md Trap 1: what is the ~30 ms of paintScene work
// that sits OUTSIDE both layer registries at world/realm zoom?
//
// layer-profile (post-P4b) attributes, at 1600x900:
//   4x    registries 2.48ms + residual 29.90ms
//   5.5x  registries 1.70ms + residual 17.16ms
//   8x    registries 1.29ms + residual  5.85ms
//   16x   registries 0.67ms + residual ~0
// and screen:seaBase is only 0.08-0.12ms, so the ocean is not it.
//
// That residual tracks main.realmFogFade() — full below K_PLOT (5), gone by K_TEX (16) — which points
// at the realm fog: _fogFill does a full-viewport PATTERN fill plus a full-viewport colour fill, and
// paintScene runs it twice a frame (drawRealmFogUnder inside the map clip, drawRealmFog in the void
// outside it). Four full-viewport fills, one of them a repeating pattern.
//
// This times that work directly, and times the obvious fix (compose the sheet once, blit it) so the
// win is known before any code changes.
//
// Usage:  node fog-probe.mjs [liveBase] [k]
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const base = process.argv[2] || 'http://localhost:8080';
const K = +(process.argv[3] || 4);
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
  const { draw } = await import('./js/repaint.mjs');
  const { ctx, cam, VIEW, S, K_PLOT, K_TEX, clampPan } = core;
  cam.k = k; clampPan();
  for (let i = 0; i < 8; i++) { S.baseVersion++; S.viewVersion = S.baseVersion * 16; draw(); await new Promise(r => setTimeout(r, 120)); }

  const tile = window.BUNDLE.fow && (window.BUNDLE.fow.PARCHMENT || window.BUNDLE.fow.HATCH_MED);
  if (!tile) return { error: 'no BUNDLE.fow tile — this realm draws no fog, so there is nothing to measure' };
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = tile.src; });
  const pat = ctx.createPattern(img, 'repeat');

  const fade = Math.max(0, Math.min(1, (K_TEX - cam.k) / (K_TEX - K_PLOT)));
  const med = a => { const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(3); };
  const time = (n, fn) => { const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); } return med(t); };

  // exactly main._fogFill
  const fogFill = a => {
    ctx.globalAlpha = 0.9 * a; ctx.fillStyle = pat; ctx.fillRect(0, 0, VIEW.w, VIEW.h);
    ctx.globalAlpha = 0.14 * a; ctx.fillStyle = '#3a2c18'; ctx.fillRect(0, 0, VIEW.w, VIEW.h);
    ctx.globalAlpha = 1;
  };
  // split the two halves, to see whether the PATTERN or the flat colour is the cost
  const patOnly = a => { ctx.globalAlpha = 0.9 * a; ctx.fillStyle = pat; ctx.fillRect(0, 0, VIEW.w, VIEW.h); ctx.globalAlpha = 1; };
  const colOnly = a => { ctx.globalAlpha = 0.14 * a; ctx.fillStyle = '#3a2c18'; ctx.fillRect(0, 0, VIEW.w, VIEW.h); ctx.globalAlpha = 1; };

  // the candidate fix: compose the sheet ONCE at this fade, then blit. Screen-space and
  // camera-independent, so a pan never rebuilds it; only a zoom (fade change) or a resize does.
  const sheet = document.createElement('canvas'); sheet.width = VIEW.w; sheet.height = VIEW.h;
  const sctx = sheet.getContext('2d');
  const buildSheet = a => {
    sctx.clearRect(0, 0, VIEW.w, VIEW.h);
    sctx.globalAlpha = 0.9 * a; sctx.fillStyle = pat; sctx.fillRect(0, 0, VIEW.w, VIEW.h);
    sctx.globalAlpha = 0.14 * a; sctx.fillStyle = '#3a2c18'; sctx.fillRect(0, 0, VIEW.w, VIEW.h);
    sctx.globalAlpha = 1;
  };
  buildSheet(fade);
  const blitSheet = () => { ctx.drawImage(sheet, 0, 0); };

  return {
    k: cam.k, fade: +fade.toFixed(3), viewport: [VIEW.w, VIEW.h], tile: tile.src,
    oneFogFill: time(20, () => fogFill(fade)),
    patternHalf: time(20, () => patOnly(fade)),
    colourHalf: time(20, () => colOnly(fade)),
    // paintScene runs _fogFill twice a frame (under + over)
    perFrameToday: time(20, () => { fogFill(fade); fogFill(fade); }),
    buildSheetOnce: time(20, () => buildSheet(fade)),
    perFrameCached: time(20, () => { blitSheet(); blitSheet(); }),
  };
}, K);

console.log(JSON.stringify({ ...out, errors }, null, 2));
if (!out.error) {
  console.log(`\n--- realm fog at k=${out.k} (fade ${out.fade}, ${out.viewport.join('x')}) ---`);
  console.log(`  one _fogFill:        ${out.oneFogFill}ms   (pattern half ${out.patternHalf}ms, colour half ${out.colourHalf}ms)`);
  console.log(`  per frame TODAY:     ${out.perFrameToday}ms   (paintScene calls it twice: under + over)`);
  console.log(`  per frame CACHED:    ${out.perFrameCached}ms   (+ ${out.buildSheetOnce}ms to rebuild the sheet on a zoom/resize)`);
  const win = out.perFrameToday - out.perFrameCached;
  console.log(`  => caching the sheet saves ${win.toFixed(3)}ms/frame (${(out.perFrameToday / Math.max(out.perFrameCached, 0.001)).toFixed(1)}x)`);
}
await b.close(); srv.close();
