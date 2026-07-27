// Verify the 2026-07-27 bug-fix batch in a real browser: the rail's top clearance, the removed
// wordmark, Esc as the lobby's door, and the killed open/close transition.
// Usage: node bugfix-verify.mjs [baseUrl] [serverUrl]
import { chromium } from 'playwright-core';

const [, , base = 'http://localhost:3001', server = 'http://localhost:8080'] = process.argv;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

// a deep link skips the lobby (live-shot-hide-lobby), which is what we want: Esc must OPEN it
const url = `${base.replace(/\/$/, '')}/?p=4411&z=8&live=${encodeURIComponent(server)}#none`;
await page.goto(url, { waitUntil: 'load' });
await page.getByRole('button', { name: /got it/i }).click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(6000);

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// 5 — the wordmark watermark is gone from the map
check('brand watermark removed', await page.evaluate(() => !document.getElementById('brand')));

// 11 — no width/transform transition to drive a repaint storm
const trans = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('.stage'));
  const r = getComputedStyle(document.querySelector('.railwrap'));
  return { stage: s.transitionProperty + ' ' + s.transitionDuration,
           rail: r.transitionProperty + ' ' + r.transitionDuration };
});
check('stage has no `right` transition', !/\bright\b/.test(trans.stage), trans.stage);
check('rail has no `transform` transition', !/\btransform\b/.test(trans.rail), trans.rail);

// (12 — the camera-yaw seam and the rotated viewport marker have their own verifier, which needs a
//  zoom inside the tilt ramp to say anything: minimap-yaw-verify.mjs.)

// 6 — open the rail by selecting a province, then compare its top against the bar's real height
const geom = await page.evaluate(async () => {
  document.querySelector('.railwrap').classList.add('open');
  document.querySelector('.app').classList.add('rail-open');
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const bar = document.querySelector('.topbar').getBoundingClientRect();
  const rail = document.querySelector('.railwrap').getBoundingClientRect();
  return { barBottom: bar.bottom, barH: bar.height, railTop: rail.top,
           barTotal: getComputedStyle(document.querySelector('.app')).getPropertyValue('--bar-total') };
});
check('rail clears the top bar', geom.railTop >= geom.barBottom - 0.5,
  `rail.top=${geom.railTop} barBottom=${geom.barBottom} --bar-total=${geom.barTotal.trim()}`);
await page.screenshot({ path: 'bugfix-rail.png' });

// 5 — Esc opens the lobby, Esc closes it
await page.evaluate(() => {
  document.querySelector('.railwrap').classList.remove('open');
  document.querySelector('.app').classList.remove('rail-open');
});
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
const opened = await page.evaluate(() => { const l = document.getElementById('lobby'); return !!l && !l.hidden; });
check('Esc opens the lobby', opened);
if (opened) await page.screenshot({ path: 'bugfix-lobby.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
check('Esc closes it again',
  await page.evaluate(() => { const l = document.getElementById('lobby'); return !!l && l.hidden; }));

for (const r of results)
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log('console errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
