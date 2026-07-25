// P1 of docs/pixi-migration-plan.md: the camera seam, provably in agreement.
//
// This is the guard rail for the whole migration. While two renderers draw one scene, a silent
// disagreement between them would not throw — it would just place things a few pixels wrong at some
// zooms. So this compares PIXI'S OWN CONTAINER MATRIX (world.toGlobal, i.e. what the GPU will
// actually use) against the REAL core.pxr/pyr, over a grid of camera states and map positions.
//
// It is deliberately the authority, rather than js/pixi-cam.test.mjs: the node tests transcribe
// core.mjs's formulas as a reference, and a transcription can drift. Nothing here is transcribed.
//
// Also asserts the P1 clip mask: geometry in BASE space (getLocalBounds) and placement matching the
// screen-space rect main.paintScene derives.
//
// Usage:  node pixi-p1-verify.mjs [liveBase] [waitMs]
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const base = process.argv[2] || 'http://localhost:8080';
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

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(`http://localhost:${port}/index.html?live=${base}&lobby=0`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(waitMs);

const out = await page.evaluate(async () => {
  // ES modules are singletons per URL, so these are the SAME instances the running app uses.
  const core = await import('./js/core.mjs');
  const pixi = await import('./js/pixi.mjs');
  const pcam = await import('./js/pixi-cam.mjs');
  const { Point } = await import('./js/vendor/pixi.min.mjs');
  const { cam, VIEW, MAP, baseXr, baseYr, pxr, pyr } = core;

  const saved = { k: cam.k, x: cam.x, y: cam.y };
  const rows = [];
  let worstXY = 0, worstClip = 0, samples = 0;

  // sample across the real k range (1 → K_MAX) and off-centre pans, at real source pixels
  const ks = [1, 1.7, 5, 16, 64, 233, 512];
  const pans = [[0, 0], [-311, 97], [1420.5, -880.25]];
  const sps = [MAP.x0, MAP.x0 + 1, (MAP.x0 + MAP.x1) / 2, MAP.x1 - 1, MAP.x1];
  const sqs = [MAP.y0, MAP.y0 + 1, (MAP.y0 + MAP.y1) / 2, MAP.y1 - 1, MAP.y1];

  for (const k of ks) for (const [ox, oy] of pans) {
    cam.k = k; cam.x = ox; cam.y = oy;
    pixi.syncCamera(cam, VIEW);
    for (let i = 0; i < sps.length; i++) {
      const bx = baseXr(sps[i]), by = baseYr(sqs[i]);
      // Pixi's real matrix — what the GPU uses — vs core's per-point screen arithmetic
      const g = pixi.world.toGlobal(new Point(bx, by));
      const dx = Math.abs(g.x - pxr(sps[i])), dy = Math.abs(g.y - pyr(sqs[i]));
      worstXY = Math.max(worstXY, dx, dy);
      samples++;
      if (dx > 0.01 || dy > 0.01) rows.push({ k, ox, oy, sp: sps[i], dx, dy });
    }
    // the clip mask, placed: base-space rect through the same matrix vs main.paintScene's screen rect
    const r = pcam.mapClipRect(VIEW);
    const tl = pixi.world.toGlobal(new Point(r.x, r.y));
    const br = pixi.world.toGlobal(new Point(r.x + r.w, r.y + r.h));
    const xL = cam.x + cam.k * VIEW.dx, xR = cam.x + cam.k * (VIEW.dx + VIEW.dw);
    const yT = cam.y + cam.k * VIEW.dy, yB = cam.y + cam.k * (VIEW.dy + VIEW.dh);
    worstClip = Math.max(worstClip,
      Math.abs(tl.x - Math.min(xL, xR)), Math.abs(tl.y - Math.min(yT, yB)),
      Math.abs((br.x - tl.x) - Math.abs(xR - xL)), Math.abs((br.y - tl.y) - Math.abs(yB - yT)));
  }

  // the mask's GEOMETRY is in base space (independent of the camera it was last synced at)
  const lb = pixi.world.children.find(c => c.label === 'mapClip').getLocalBounds();
  const want = pcam.mapClipRect(VIEW);
  const geom = {
    got: [lb.x, lb.y, lb.width, lb.height].map(n => Math.round(n * 100) / 100),
    want: [want.x, want.y, want.w, want.h].map(n => Math.round(n * 100) / 100),
  };

  // Restore the camera AND force a real repaint. Mutating `cam` above can race a repaint the app
  // schedules for its own reasons (an SSE snapshot, the clock), which then paints the 2D canvas at a
  // stress state; restoring cam without repainting leaves that stale frame on screen and the
  // screenshot below libels the change as a rendering regression. Ask repaint.draw() for a frame at
  // the restored camera and let it land (it is rAF-coalesced behind a 30fps cap).
  cam.k = saved.k; cam.x = saved.x; cam.y = saved.y;
  pixi.syncCamera(cam, VIEW);
  const { draw } = await import('./js/repaint.mjs');
  draw();
  await new Promise(r => setTimeout(r, 500));

  return {
    samples, worstXY, worstClip, disagreements: rows.slice(0, 8), geom,
    maskWired: pixi.world.mask === pixi.world.children.find(c => c.label === 'mapClip'),
    // "nothing has migrated yet" must still hold at P1 — the mask is not a layer
    layersInWorld: pixi.world.children.filter(c => c.label !== 'mapClip').length,
    layersElsewhere: pixi.screenBelow.children.length + pixi.screenAbove.children.length,
    backend: pixi.pixiBackend(),
  };
});

await page.screenshot({ path: path.join(HERE, 'pixi-p1-map.png') });

const fail = [];
if (!out.samples) fail.push('no samples taken (app never booted?)');
if (out.worstXY > 0.01) fail.push(`camera disagreement up to ${out.worstXY.toFixed(4)}px: ${JSON.stringify(out.disagreements)}`);
if (out.worstClip > 0.01) fail.push(`clip placement disagreement up to ${out.worstClip.toFixed(4)}px`);
if (String(out.geom.got) !== String(out.geom.want)) fail.push(`mask geometry not the base-space fit rect: ${JSON.stringify(out.geom)}`);
if (!out.maskWired) fail.push('world.mask is not the mapClip graphics');
if (out.layersInWorld !== 0 || out.layersElsewhere !== 0) {
  fail.push(`layers have appeared before P2 (world=${out.layersInWorld}, screen=${out.layersElsewhere})`);
}
if (errors.length) fail.push('console errors: ' + JSON.stringify(errors.slice(0, 5)));

console.log(JSON.stringify({ ...out, errors }, null, 2));
console.log(fail.length ? '\nFAIL\n - ' + fail.join('\n - ')
  : `\nPASS — ${out.samples} samples, Pixi's matrix agrees with core.pxr/pyr to ${out.worstXY.toExponential(1)}px on ${out.backend}`);

await browser.close(); srv.close();
process.exit(fail.length ? 1 : 0);
