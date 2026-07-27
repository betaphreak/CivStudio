// improvement-shot — verify that the sim's raised improvements reach the map as Civ4 art.
//
// P5a wires three things that can each fail silently: the server carries DistrictView.improvement,
// the bundle whitelists improvementOverlays, and improvements.mjs draws them for the LIVE colony
// only (there is no world-data stand-in — an improvement nobody built does not exist). So this
// checks the chain end to end rather than just eyeballing a picture: it reports the feed count, the
// manifest keys, whether the atlases actually loaded, and how many stamps the layer drew.
//
// Usage: node improvement-shot.mjs [provId=4411] [zoom=256] [out=improvements.png] [--live=<base>]
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--'))
  .map(a => a.replace(/^--/, '').split('=')));
const provId = args[0] || '4411', zoom = args[1] || '256', out = args[2] || 'improvements.png';
const live = flags.live || process.env.LIVE || 'http://localhost:8080';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const f = path.join(WEB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f, (e, b) => e ? (res.statusCode = 404, res.end())
    : (res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream'), res.end(b)));
});
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const notFound = [];
page.on('response', r => { if (r.status() === 404) notFound.push(r.url()); });

// a deep link skips the lobby; ?live= points the bundle fetch at the running server
// `?session=` is what actually puts the page in Live on a spectated run — the same parameter the
// lobby writes when you pick a row. (Do NOT copy live-shot.mjs's `#overlayToggle button[data-ov=live]`
// click: that element no longer exists, so the click is a silent no-op and the report comes back
// empty against a server that is working perfectly.)
const sid = flags.session || 'caravan-demo-7654321';
await page.goto(`${base}/index.html?live=${encodeURIComponent(live)}&session=${encodeURIComponent(sid)}&p=${provId}&z=${zoom}`,
  { waitUntil: 'load' });
await page.waitForTimeout(3000);

// POLL, don't sleep. The page boots (bundle prefetch → map → SSE), the server founds the demo, and
// the first snapshot lands whenever it lands; a fixed wait either flakes or is always too long. The
// old fixed 7s reported colony:null against a perfectly healthy server that simply had not finished
// starting — a false negative that looks exactly like a broken feature.
// `?session=` says WHICH run to spectate; it does not enter the live overlay. That is the Zeitgeist
// advisor (advisors.mjs: case "zeitgeist" → setOverlay("live")). Re-click it every pass rather than
// once at a fixed delay: the advisor bar is built during boot, so a single early click lands on
// nothing and the run reports an empty colony against a healthy server.
const deadline = Date.now() + (+(flags.wait) || 60000);
let ready = false;
while (Date.now() < deadline) {
  ready = await page.evaluate(async () => {
    try {
      const live = await import('./js/overlays/live.mjs');
      if (live.liveColony()) return true;
      document.querySelector('button[data-advisor="zeitgeist"]')?.click();
      return false;
    } catch { return false; }
  }).catch(() => false);
  if (ready) break;
  await page.waitForTimeout(1000);
}
if (!ready) console.error('WARNING: no live colony after wait — the report below will read empty');
await page.waitForTimeout(2500);   // let the layer paint at least one frame with it
// Clear the chrome so the shot is of the MAP. Do NOT press Escape here: on this page Escape OPENS
// the lobby (a deep link skips it, and Esc is how you get back to it), so the obvious "dismiss the
// dialog" reflex covers the viewport with a bigger one. Close each modal by its own control.
await page.evaluate(() => {
  // #buildchoice — "the crown awaits your decree", opened whenever the spectated crown's queue is
  // empty, and it covers the middle of the viewport. It has no close control (it wants an answer),
  // so hide it rather than click it: answering it would submit a command to the live session.
  const bc = document.getElementById('buildchoice'); if (bc) bc.hidden = true;
  document.querySelector('#lobby:not([hidden]) #lobbyClose')?.click();
  [...document.querySelectorAll('button')].find(b => /got it/i.test(b.textContent || ''))?.click();
}).catch(() => {});
await page.waitForTimeout(1500);

const info = await page.evaluate(async () => {
  const core = await import('./js/core.mjs');
  const live = await import('./js/overlays/live.mjs');
  const colony = live.liveColony();
  const ov = core.IMPROVEMENT_OVERLAYS || {};
  // count what the layer would actually stamp: a plot with an improvement whose atlas is loaded
  const loaded = {}, failed = {};
  await Promise.all(Object.entries(ov).map(([k, v]) => new Promise(res => {
    const im = new Image();
    im.onload = () => { loaded[k] = true; res(); };
    im.onerror = () => { failed[k] = im.src; res(); };
    im.src = v.src;
  })));
  const feed = (colony?.districts || []).filter(d => d.improvement);
  const byType = {};
  for (const d of feed) byType[d.improvement] = (byType[d.improvement] || 0) + 1;
  return {
    colony: colony?.name || null,
    plots: colony?.districts?.length ?? 0,
    plotsWithImprovement: feed.length,
    byType,
    manifestKeys: Object.keys(ov),
    atlasesLoaded: Object.keys(loaded),
    atlasesFailed: failed,
    drawable: feed.filter(d => loaded[d.improvement]).length,
  };
});

await page.screenshot({ path: out });
console.log(JSON.stringify({ shot: out, province: provId, zoom, ...info,
  notFound: [...new Set(notFound)].slice(0, 8), errors: errors.length }, null, 2));
await browser.close();
server.close();
