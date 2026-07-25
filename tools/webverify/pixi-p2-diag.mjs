// Why does the P2 plot layer place sprites correctly and render nothing?
// Isolates the candidates one at a time: mask, alpha/visibility, texture upload, sprite bounds.
// Usage:  node pixi-p2-diag.mjs [liveBase]
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
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});
await new Promise(r => srv.listen(0, r));
const port = srv.address().port;

const b = await chromium.launch({ channel: 'msedge', headless: true });
const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(`http://localhost:${port}/index.html?live=${base}&lobby=0&pixiPlots=1`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(13000);

const out = await page.evaluate(async () => {
  const core = await import('./js/core.mjs');
  const main = await import('./js/main.mjs');
  const pixi = await import('./js/pixi.mjs');
  const { draw } = await import('./js/repaint.mjs');
  const { cam, VIEW, P, S, baseXr, baseYr, clampPan } = core;
  const bump = () => { S.baseVersion++; S.viewVersion = S.baseVersion * 16; };

  // load grids from a wide view, then park on a real plot box at k=16
  for (let i = 0; i < 40; i++) {
    cam.k = 5.5; clampPan(); bump(); draw();
    await new Promise(r => setTimeout(r, 150));
    if (P.filter(p => p._pbox || p._tbox).length > 40) break;
  }
  const withBox = P.filter(p => (p._pbox || p._tbox) && p._plots && p._plots.length
                                && p.type !== 'SEA' && p.type !== 'LAKE')
                   .sort((x, y) => y._plots.length - x._plots.length);
  const box = withBox[0]._tbox || withBox[0]._pbox;
  const cx = box.x0 + box.w / 2, cy = box.y0 + box.h / 2;
  cam.k = 16; cam.x = VIEW.w / 2 - cam.k * baseXr(cx); cam.y = VIEW.h / 2 - cam.k * baseYr(cy);
  clampPan();
  for (let i = 0; i < 20; i++) { bump(); draw(); await new Promise(r => setTimeout(r, 150)); }

  bump(); pixi.syncCamera(cam, VIEW); main.drawSurfacePlots(); pixi.renderPixi();

  const plotsC = pixi.world.children.find(c => c.label === 'plots');
  const vis = (plotsC ? plotsC.children : []).filter(s => s.visible);
  const s0 = vis[0];
  const info = {
    plotsContainer: !!plotsC,
    childCount: plotsC ? plotsC.children.length : 0,
    visibleCount: vis.length,
    containerAlpha: plotsC ? plotsC.alpha : null,
    containerVisible: plotsC ? plotsC.visible : null,
    worldMask: pixi.world.mask ? (pixi.world.mask.label || 'unlabelled') : null,
    worldVisible: pixi.world.visible, worldAlpha: pixi.world.alpha,
    worldPos: [pixi.world.x, pixi.world.y], worldScale: pixi.world.scale.x,
  };
  if (s0) {
    const gb = s0.getBounds();
    info.sprite0 = {
      pos: [+s0.x.toFixed(2), +s0.y.toFixed(2)], size: [+s0.width.toFixed(2), +s0.height.toFixed(2)],
      alpha: s0.alpha, visible: s0.visible,
      globalBounds: [Math.round(gb.x), Math.round(gb.y), Math.round(gb.width), Math.round(gb.height)],
      texValid: !!(s0.texture && s0.texture.source),
      texSize: s0.texture ? [s0.texture.width, s0.texture.height] : null,
      texScaleMode: s0.texture && s0.texture.source ? s0.texture.source.scaleMode : null,
      texLabel: s0.texture && s0.texture.source ? String(s0.texture.source.label || '') : null,
    };
  }

  // ---- is the pixel actually on the canvas? read back the framebuffer centre ----
  const readCentre = () => {
    const gl = document.getElementById('gl');
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const cx2 = c.getContext('2d');
    try { cx2.drawImage(gl, gl.width / 2 - 16, gl.height / 2 - 16, 32, 32, 0, 0, 32, 32); }
    catch (e) { return { error: String(e) }; }
    const d = cx2.getImageData(0, 0, 32, 32).data;
    let n = 0, sum = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { n++; sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; sum[3] += d[i + 3]; }
    return { mean: sum.map(v => Math.round(v / n)) };
  };
  info.withMask = readCentre();

  // ---- candidate 1: the mask ----
  pixi.world.mask = null;
  pixi.renderPixi();
  info.withoutMask = readCentre();

  // ---- candidate 2: mask as a SIBLING rather than a child of the container it masks ----
  const clip = pixi.world.children.find(c => c.label === 'mapClip');
  if (clip) {
    pixi.world.removeChild(clip);
    pixi.pixiApp().stage.addChild(clip);
    pixi.world.mask = clip;
    pixi.renderPixi();
    info.maskAsSibling = readCentre();
  }
  return info;
});

console.log(JSON.stringify({ ...out, errors }, null, 2));
await b.close(); srv.close();
