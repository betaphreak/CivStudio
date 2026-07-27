// The minimap's viewport marker must follow the camera's YAW. Below the tilt ramp it is the old
// upright rectangle; inside the ramp (band 5..6, which is exactly where the minimap is still shown)
// the camera is yawed and the marker has to turn with it.
// Usage: node minimap-yaw-verify.mjs [baseUrl] [serverUrl]
import { chromium } from 'playwright-core';

// The realm is NAMED, not left to the page's default. Province 4411 is in Haless, and a deep link
// into a realm other than the one on screen makes the viewer switch realm and RELOAD — so the
// measurement lands on the pre-switch page at band 0, which looks exactly like a yaw regression.
const [, , base = 'http://localhost:3001', server = 'http://localhost:8080',
       realm = 'haless'] = process.argv;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// k=8 → band 3 (no tilt, no yaw); k=60 → band 5.9 (tilted, yawed, minimap still on screen)
for (const [zoom, expectYaw] of [[8, false], [60, true]]) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const url = `${base.replace(/\/$/, '')}/?p=4411&realm=${realm}&z=${zoom}`
    + `&live=${encodeURIComponent(server)}&lobby=0#none`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#zoomLevel', { timeout: 45000 });
  await page.waitForTimeout(9000);

  const out = await page.evaluate(async () => {
    const { S, cam } = await import('./js/core.mjs');
    const { draw } = await import('./js/repaint.mjs');
    const { band } = await import('./js/bands.mjs');
    const { viewportQuad } = await import('./js/minimap-geom.mjs');
    draw();
    await new Promise(r => setTimeout(r, 600));
    draw();
    await new Promise(r => setTimeout(r, 600));
    // the marker's shape at the yaw the camera actually reports
    const q = viewportQuad({ x: 0, y: 0, w: 100, h: 60 }, S.camYaw);
    const topEdgeTilt = Math.abs(q[1][1] - q[0][1]);   // 0 when the top edge is horizontal
    return { band: band(), k: cam.k, camYaw: S.camYaw, topEdgeTilt,
             minimapOn: !!document.querySelector('.minimap.on') };
  });

  check(`z=${zoom} (band ${out.band.toFixed(2)}): camYaw ${expectYaw ? '> 0' : '== 0'}`,
    expectYaw ? out.camYaw > 0.5 : out.camYaw === 0,
    `camYaw=${out.camYaw} topEdgeTilt=${out.topEdgeTilt.toFixed(2)}px minimapVisible=${out.minimapOn}`);
  if (expectYaw)
    check('…and the marker is genuinely turned', out.topEdgeTilt > 1,
      `top edge drops ${out.topEdgeTilt.toFixed(2)}px across a 100px box`);
  else
    check('…and the marker is the plain rectangle', out.topEdgeTilt === 0);
  if (errs.length) check(`z=${zoom} no page errors`, false, errs.slice(0, 3).join(' | '));
  await page.screenshot({ path: `minimap-yaw-z${zoom}.png` });
  await page.close();
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  — ${r.detail ?? ''}`);
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
