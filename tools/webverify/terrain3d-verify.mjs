// P1 of docs/terrain-3d.md: the acceptance gate for the 3D ground.
//
// THE CLAIM UNDER TEST. At tilt 0 the 3D ground is meant to be the SAME PICTURE as the canvas-2D ground
// it replaces: an orthographic camera derived from core.unproject, the province offscreens plots.mjs
// already bakes, and the same sea gradient. So the frame is diffed against the 2D path at the same
// camera, with the sun OFF and ambient at 1.0 — flat lighting isolates the projection and the texturing
// from the shading, which is the only thing that is supposed to differ afterwards.
//
// If this passes, then turning the sun on is a change to how terrain LOOKS rather than to where anything
// IS, and the remaining difference is the geometry, which is the entire point of the phase.
//
// Compared canvas-to-canvas, not by page screenshot: the frames are composited in-page (#gl, then #map
// over it) so no DOM chrome — the watermark, the notification board, the fps readout — can drift between
// two runs and be mistaken for a rendering difference.
//
// Usage:  node terrain3d-verify.mjs [webBase] [serverUrl]
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const SERVER = process.argv[3] || 'http://localhost:8080';
const PROVINCE = 4411;              // the demo province (application.yml civstudio.demo.province-id)
const ZOOMS = [40, 120];            // band 5.3 and band 6.9 — just inside the 3D range, and deep in it
// The gate. Chosen BEFORE running it, so a marginal result cannot be talked into passing: GPU linear +
// mipmapped + anisotropic sampling is not canvas 2D's bilinear upscale, and the mesh silhouette is
// antialiased where a blit is not, so a handful of edge pixels must be allowed to differ a lot while the
// body of the frame must barely differ at all.
const GATE = { meanDelta: 10, p99Delta: 64, within16: 0.95 };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.css': 'text/css', '.pack': 'application/octet-stream', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
let base = process.argv[2], srv = null;
if (!base) {
  srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    fs.readFile(path.join(WEB, p), (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(d);
    });
  });
  await new Promise(r => srv.listen(0, r));
  base = `http://localhost:${srv.address().port}`;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];

/** Load the map at one camera in one ground mode and return its composited canvas as a data URL. */
async function capture(zoom, mode3d, lit = false) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => errors.push(`[z${zoom} ${mode3d ? '3d' : '2d'}] PAGEERROR: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`[z${zoom} ${mode3d ? '3d' : '2d'}] ${m.text()}`); });
  // #none = the plain physical overlay (the site defaults to the live Spectate one); ?live= names the
  // server so the page skips the "Choose a server" splash; &lobby=0 keeps the lobby off the map.
  const url = `${base}/index.html?p=${PROVINCE}&z=${zoom}&terrain3d=${mode3d ? 1 : 0}`
    + `&live=${encodeURIComponent(SERVER)}&lobby=0#none`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#zoomLevel', { timeout: 45000 });

  // Wait for the SAME state in both modes: every visible province's textured offscreen built. That is
  // what the 2D path blits and what the 3D path drapes, so comparing before it settles would compare
  // two different amounts of loading rather than two renderers.
  const settled = await page.evaluate(async ({ want3d, lit }) => {
    const { P, cam } = await import('./js/core.mjs');
    const { draw } = await import('./js/repaint.mjs');
    const t3d = want3d ? await import('./js/terrain3d.mjs') : null;
    if (t3d) t3d.setFlatLighting(!lit);     // the acceptance mode: unshaded, so only geometry differs
    const onScreen = () => P.filter(p => p._plots && p._plots.length && p._tcanvas).length;
    let stable = 0, last = -1;
    for (let i = 0; i < 120; i++) {
      draw();
      await new Promise(r => setTimeout(r, 150));
      const n = onScreen();
      if (n === last && n > 0) { if (++stable >= 6) break; } else { stable = 0; last = n; }
    }
    draw();
    await new Promise(r => setTimeout(r, 400));
    return { textured: onScreen(), k: cam.k, stats: t3d ? t3d.terrain3dStats() : null };
  }, { want3d: mode3d, lit });

  // Composite exactly as the browser does: the 3D ground first, the 2D canvas over it.
  //
  // THE 3D SCENE IS RE-RENDERED HERE, SYNCHRONOUSLY, and that is not belt-and-braces. A WebGL canvas
  // created with the default `preserveDrawingBuffer: false` has its drawing buffer discarded once the
  // browser composites the frame, so reading it from a LATER task — a separate page.evaluate, which is a
  // separate turn of the event loop — yields an empty buffer. The first run of this verifier duly
  // reported a mean delta of 108 against a blank 3D frame: the renderer was fine and the measurement was
  // lying. Render and read in the same synchronous block and the buffer is still there.
  //
  // (#map is a 2D canvas and retains its content, so it needs no repaint — and must not get one here,
  // since a fresh 2D paint would itself call renderTerrain3D and hand the buffer back to the compositor.)
  const dataUrl = await page.evaluate(async () => {
    const { renderTerrain3D } = await import('./js/terrain3d.mjs');
    const map = document.getElementById('map'), gl = document.getElementById('gl');
    const c = document.createElement('canvas');
    c.width = map.width; c.height = map.height;
    const x = c.getContext('2d');
    renderTerrain3D();                                    // repopulate the drawing buffer, this task
    if (gl && !gl.classList.contains('off')) x.drawImage(gl, 0, 0, c.width, c.height);
    x.drawImage(map, 0, 0);
    return c.toDataURL('image/png');
  });
  await page.close();
  return { dataUrl, settled };
}

/** Diff two data URLs in a throwaway page, so the browser does the PNG decoding. */
async function diff(aUrl, bUrl) {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const out = await page.evaluate(async ([a, b]) => {
    const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height)
      return { error: `size mismatch ${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const grab = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, c.width, c.height).data; };
    const da = grab(ia), db = grab(ib);
    const n = da.length / 4;
    const hist = new Uint32Array(256);      // per-pixel max channel delta
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const d = Math.max(Math.abs(da[o] - db[o]), Math.abs(da[o + 1] - db[o + 1]), Math.abs(da[o + 2] - db[o + 2]));
      hist[d]++; sum += d;
    }
    let acc = 0, p99 = 0, within16 = 0, within8 = 0;
    for (let d = 0; d < 256; d++) {
      acc += hist[d];
      if (d <= 8) within8 = acc;
      if (d <= 16) within16 = acc;
      if (!p99 && acc >= n * 0.99) p99 = d;
    }
    return { w: ia.width, h: ia.height, pixels: n, mean: sum / n, p99,
             within8: within8 / n, within16: within16 / n, worst: hist.findLastIndex(v => v > 0) };
  }, [aUrl, bUrl]);
  await page.close();
  return out;
}

/**
 * Mean luminance of a frame, and of the SUNWARD vs SHADED halves of the brightness distribution.
 *
 * This is the sun's calibration, and it needs a number rather than an opinion. A Civ4-looking hillshade
 * has flat ground at roughly the brightness of its own texture, with slopes picked out either side of it —
 * so `litRatio` (lit ÷ unlit mean) should land near 1.0. It does NOT come out there by default: three's
 * lights are in physically-correct units and a Lambert BRDF carries a 1/π, so intensities that look
 * plausible written down render the whole ground dark, which on a map reads as "dusk" rather than "wrong".
 */
async function luminance(urls) {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const out = await page.evaluate(async (list) => {
    const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const mean = async src => {
      const img = await load(src);
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 250) continue;                      // skip transparent void — it is not ground
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++;
      }
      return n ? sum / n : 0;
    };
    return { flat: await mean(list[0]), lit: await mean(list[1]) };
  }, urls);
  await page.close();
  return out;
}

const results = [];
for (const z of ZOOMS) {
  const a = await capture(z, false);
  const b = await capture(z, true);
  const c = await capture(z, true, true);          // the same camera, LIT — the deliverable, not the gate
  const d = await diff(a.dataUrl, b.dataUrl);
  const lum = await luminance([b.dataUrl, c.dataUrl]);
  results.push({ z, d, lum, two: a.settled, three: b.settled });
  fs.writeFileSync(path.join(HERE, `terrain3d-z${z}-2d.png`), Buffer.from(a.dataUrl.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(HERE, `terrain3d-z${z}-3d.png`), Buffer.from(b.dataUrl.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(HERE, `terrain3d-z${z}-lit.png`), Buffer.from(c.dataUrl.split(',')[1], 'base64'));
}
// ---- the other half of the claim: BELOW band 5 nothing changed, and three never even loads ----
// The phase's headline promise is that bands 0-4 are untouched. Asserting it via a pixel diff would only
// compare the 2D path to itself; what actually has to be true is stronger and cheaper to check — the 3D
// canvas is not participating, and the 751 KB module was never fetched. No flag is set here, so this is
// the DEFAULT behaviour a real visitor gets.
const below = await (async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const netThree = [];
  page.on('request', q => { if (/three\..*\.js/.test(q.url())) netThree.push(q.url()); });
  page.on('pageerror', e => errors.push('[band3] PAGEERROR: ' + e.message));
  await page.goto(`${base}/index.html?p=${PROVINCE}&z=8&live=${encodeURIComponent(SERVER)}&lobby=0#none`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#zoomLevel', { timeout: 45000 });
  const out = await page.evaluate(async () => {
    const { draw } = await import('./js/repaint.mjs');
    const { band, ground3D } = await import('./js/bands.mjs');
    for (let i = 0; i < 20; i++) { draw(); await new Promise(r => setTimeout(r, 150)); }
    const gl = document.getElementById('gl');
    // read the ground pixel-by-pixel: #map must be OPAQUE here, i.e. the 2D path drew the ground itself
    const map = document.getElementById('map');
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(map, map.width / 2 - 20, map.height / 2 - 20, 40, 40, 0, 0, 40, 40);
    const d = x.getImageData(0, 0, 40, 40).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] === 255) opaque++;
    return { band: band(), ground3D: ground3D(), glOff: gl.classList.contains('off'), opaque, of: 1600 };
  });
  await page.close();
  return { ...out, threeRequests: netThree.length };
})();
console.log(`\n== below the 3D range (z=8, band ${below.band.toFixed(2)}) ==`);
console.log(`  ground3D=${below.ground3D} · #gl off=${below.glOff} · three requests=${below.threeRequests}` +
  ` · #map opaque at centre: ${below.opaque}/${below.of} px`);

await browser.close();
if (srv) srv.close();

const fails = [];
if (below.ground3D) fails.push('band 3: ground3D() must be false below band 5');
if (!below.glOff) fails.push('band 3: the #gl canvas must be hidden, or a stale WebGL frame shows through');
if (below.threeRequests) fails.push(`band 3: three was fetched (${below.threeRequests} requests) — the lazy import must not fire below band 5`);
if (below.opaque < below.of) fails.push(`band 3: #map is not opaque (${below.opaque}/${below.of}) — the 2D ground stopped drawing itself`);

for (const r of results) {
  const { z, d, lum, two, three } = r;
  console.log(`\n== z=${z} (band ${Math.log2(z).toFixed(2)}) ==`);
  if (d.error) { console.log('  DIFF ERROR: ' + d.error); fails.push(`z=${z}: ${d.error}`); continue; }
  console.log(`  2D: ${two.textured} textured provinces, k=${two.k}`);
  console.log(`  3D: ${three.textured} textured provinces, k=${three.k}, ` +
    `${three.stats.meshes} meshes / ${three.stats.triangles} tris, ` +
    `${three.stats.indexedProvinces} provinces indexed (${three.stats.indexedPlots} plots)` +
    `${three.stats.flatLit ? ', flat-lit' : ', LIT — the gate wanted flat!'}`);
  console.log(`  diff over ${d.pixels} px: mean ${d.mean.toFixed(2)} · p99 ${d.p99} · worst ${d.worst}`);
  console.log(`         within 8: ${(d.within8 * 100).toFixed(2)}% · within 16: ${(d.within16 * 100).toFixed(2)}%`);
  // reported, not gated: the sun's calibration is a look, and the look is judged from the -lit.png
  console.log(`  sun: mean luminance unlit ${lum.flat.toFixed(1)} → lit ${lum.lit.toFixed(1)} ` +
    `(ratio ${(lum.lit / lum.flat).toFixed(3)}; want ≈1.0 — flat ground at its own texture brightness)`);
  if (!three.stats.ready) fails.push(`z=${z}: the 3D renderer never became ready`);
  if (!three.stats.meshes) fails.push(`z=${z}: no province meshes were built`);
  if (!three.stats.flatLit) fails.push(`z=${z}: flat lighting was not in effect`);
  if (two.textured !== three.textured)
    console.log(`  NOTE: the two modes settled on different province counts (${two.textured} vs ${three.textured})`);
  if (d.mean > GATE.meanDelta) fails.push(`z=${z}: mean delta ${d.mean.toFixed(2)} > ${GATE.meanDelta}`);
  if (d.p99 > GATE.p99Delta) fails.push(`z=${z}: p99 delta ${d.p99} > ${GATE.p99Delta}`);
  if (d.within16 < GATE.within16) fails.push(`z=${z}: only ${(d.within16 * 100).toFixed(1)}% within 16 (want ${GATE.within16 * 100}%)`);
}
if (errors.length) { console.log('\npage errors:'); for (const e of errors.slice(0, 10)) console.log('  ' + e); }

console.log('');
if (fails.length) { console.error(`FAIL (${fails.length}):`); for (const f of fails) console.error('  ' + f); process.exit(1); }
console.log('PASS — at tilt 0 the 3D ground renders the same picture as the 2D ground it replaces.');
