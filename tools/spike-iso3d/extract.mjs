// SPIKE (docs/terrain-3d.md): pull ONE province's real baked
// terrain texture and its real per-plot relief data out of the running app, so the 3D viewer next door
// renders actual eos data rather than a mock.
//
// Deliberately a two-step spike: this half drives the real app headless and exports static files, so
// the viewer half needs no server, no engine, and no app modules. Nothing here touches web/.
//
// Exports to ./data/:
//   terrain.png  — the province's _tcanvas, exactly as plots.buildPlotTexCanvas baked it (Civ4 ground
//                  tiles, 4-edge + 4-corner blending, noise masks, snow, coast shallows, rivers,
//                  feature sprites). This is the texture the mesh gets.
//   plots.json   — { box, tpp, stats, plots:[{x,y,elevation,plotType,terrain,feature,river}] }
//
// Usage:  node extract.mjs [liveBase]
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const OUT = path.join(HERE, 'data');
const base = process.argv[2] || 'http://localhost:8080';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.css': 'text/css', '.pack': 'application/octet-stream', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

fs.mkdirSync(OUT, { recursive: true });
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
const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(`http://localhost:${port}/index.html?live=${base}&lobby=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#zoomLevel', { timeout: 45000 });
await page.waitForTimeout(12000);

const meta = await page.evaluate(async () => {
  const core = await import('./js/core.mjs');
  const { draw } = await import('./js/repaint.mjs');
  const { cam, VIEW, P, S, baseXr, baseYr, clampPan, K_TEX } = core;
  const bump = () => { S.baseVersion++; S.viewVersion = S.baseVersion * 16; };

  // Load a broad set of plot grids from a wide view, then pick the province with the most RELIEF
  // (HILL + PEAK plots) — a flat province would tell us nothing about whether the look works.
  for (let i = 0; i < 45; i++) {
    cam.k = 5.5; clampPan(); bump(); draw();
    await new Promise(r => setTimeout(r, 150));
    if (P.filter(p => p._plots && p._plots.length).length > 120) break;
  }
  // Score for VARIETY, not for maximum relief. Two earlier attempts taught this: sorting by absolute
  // HILL+PEAK count picks the biggest province, and sorting by relief DENSITY picks a 100%-PEAK
  // IMPASSABLE sliver (33x93) — maximal relief and useless for judging whether the look works, because
  // a uniform wall of peaks has no slopes, no valleys and no flat ground to contrast against.
  //
  // What the spike needs is a patch that resembles the target screenshot: mixed flat/hill/peak, several
  // terrains, ideally a river and some forest, and a sane aspect ratio so it reads as a landscape
  // rather than a strip.
  const score = p => {
    const n = p._plots.length;
    const cnt = t => p._plots.filter(q => q.plotType === t).length / n;
    const flat = 1 - cnt('HILL') - cnt('PEAK');
    if (flat < 0.15 || (cnt('HILL') + cnt('PEAK')) < 0.08) return -1;   // need BOTH lowland and relief
    const xs = p._plots.map(q => q.x), ys = p._plots.map(q => q.y);
    const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
    const aspect = w / h;
    if (aspect < 0.45 || aspect > 2.2) return -1;                        // no slivers
    const terrains = new Set(p._plots.map(q => q.terrain)).size;
    const rivers = p._plots.filter(q => q.river).length;
    const feats = p._plots.filter(q => q.feature).length / n;
    return terrains * 2 + (rivers > 0 ? 6 : 0) + Math.min(feats, 0.5) * 10
         + Math.min(cnt('PEAK'), 0.2) * 15 + Math.min(cnt('HILL'), 0.4) * 10;
  };
  // Cap at plots.MAX_TEX_PLOTS (20000): above it drawPlots deliberately skips the textured build and
  // uses the flat 1px/plot canvas, so a giant province never produces a _tcanvas at all.
  const cands = P.filter(p => p._plots && p._plots.length >= 250 && p._plots.length <= 18000
                              && p.type !== 'SEA' && p.type !== 'LAKE' && p.type !== 'IMPASSABLE')
                 .filter(p => score(p) > 0)
                 .sort((a, z) => score(z) - score(a));
  if (!cands.length) return { error: 'no land province matched the variety filter' };

  // SELECT FROM WHAT ACTUALLY BUILT, rather than picking a favourite and hoping it builds.
  //
  // Aiming the camera at a chosen province and waiting did not work: six top-scoring candidates all
  // failed while eight other provinces built fine, so something about those particular ones keeps them
  // out of the surface plot pass (drawSurfacePlots passes `isSurface`, so an underground province never
  // builds there; there are other gates too). Diagnosing that is not what this spike is for.
  //
  // So: sweep the camera across a spread of candidates at a textured zoom, let offscreens accumulate
  // (they persist once built), then score only the provinces that HAVE one. This cannot fail on a
  // province-specific gate — it can only ever choose something that demonstrably works.
  const targets = cands.slice(0, 40).map(cand => {
    const xs = cand._plots.map(q => q.x), ys = cand._plots.map(q => q.y);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  });
  let visited = 0;
  for (let t = 0; t < targets.length && visited < 14; t += 3) {
    cam.k = Math.max(K_TEX + 2, 18);
    cam.x = VIEW.w / 2 - cam.k * baseXr(targets[t][0]);
    cam.y = VIEW.h / 2 - cam.k * baseYr(targets[t][1]);
    clampPan();
    for (let i = 0; i < 12; i++) { bump(); draw(); await new Promise(r => setTimeout(r, 150)); }
    visited++;
  }
  const built = P.filter(x => x._tcanvas && x._tbox && x._plots && x._plots.length >= 200 && score(x) > 0)
                 .sort((a, z) => score(z) - score(a));
  const p = built[0];
  if (!p) return {
    error: 'no province with a textured offscreen passed the variety filter',
    diag: { camK: cam.k, visited, candidateCount: cands.length,
            withTcanvas: P.filter(x => x._tcanvas).length,
            withTcanvasScored: P.filter(x => x._tcanvas && score(x) > 0).length },
  };
  const tried = built.slice(0, 5).map(x => ({ name: x.name, type: x.type, plots: x._plots.length, score: +score(x).toFixed(1) }));

  // histograms, so the viewer's height model is tuned against what the data actually contains
  const hist = (arr, key) => arr.reduce((m, q) => { const k = q[key] || 'NONE'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const elevs = p._plots.map(q => q.elevation | 0).sort((a, z) => a - z);
  const pct = f => elevs[Math.floor((elevs.length - 1) * f)];

  return {
    runnersUp: tried,
    province: { name: p.name || null, id: p.id ?? null, type: p.type, plots: p._plots.length },
    box: p._tbox, canvas: [p._tcanvas.width, p._tcanvas.height],
    tpp: p._tcanvas.width / p._tbox.w,
    stats: {
      plotType: hist(p._plots, 'plotType'),
      terrain: hist(p._plots, 'terrain'),
      feature: hist(p._plots, 'feature'),
      elevation: { min: elevs[0], p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p95: pct(0.95), max: elevs[elevs.length - 1] },
      rivers: p._plots.filter(q => q.river).length,
    },
    plots: p._plots.map(q => ({ x: q.x, y: q.y, e: q.elevation | 0, pt: q.plotType || null,
                                t: q.terrain, f: q.feature || null, r: q.river || null })),
    png: p._tcanvas.toDataURL('image/png'),
  };
});

if (meta.error) {
  console.error('FAIL:', meta.error);
  if (meta.tried) console.error('candidates tried:', JSON.stringify(meta.tried, null, 1));
  if (meta.diag) console.error('diag:', JSON.stringify(meta.diag, null, 1));
  await b.close(); srv.close(); process.exit(1);
}

const png = Buffer.from(meta.png.split(',')[1], 'base64');
fs.writeFileSync(path.join(OUT, 'terrain.png'), png);
delete meta.png;
fs.writeFileSync(path.join(OUT, 'plots.json'), JSON.stringify(meta, null, 1));

console.log(JSON.stringify({ ...meta, plots: `[${meta.plots.length} plots]` }, null, 2));
console.log(`\nwrote data/terrain.png (${(png.length / 1024).toFixed(0)} KB, ${meta.canvas.join('x')}) ` +
  `and data/plots.json (${meta.plots.length} plots, box ${meta.box.w}x${meta.box.h}, tpp ${meta.tpp})`);
if (errors.length) console.log('page errors:', errors.slice(0, 4));
await b.close(); srv.close();
