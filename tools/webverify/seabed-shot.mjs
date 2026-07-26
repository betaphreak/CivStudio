// Screenshot the shelf around a province, for the SEABED TEXTURE work (docs/civ4-texture-inventory.md
// §4): the eight water terrains now have art in the terrain atlas, so a water plot tiles its own
// ground texture instead of being filled flat.
//
// Same shape as shot.mjs, with two deviations that are load-bearing here:
//   * waitUntil 'load', not 'networkidle' — the page holds an SSE stream open, so networkidle never
//     fires and shot.mjs times out (see the live-shot note).
//   * Esc after load, to dismiss the lobby if it opened over the map.
//
// Usage: node seabed-shot.mjs <p> <z> <outPng> [waitMs] [base] [server]
import { chromium } from 'playwright-core';
const [, , pid, z, out, waitMs = '9000',
  base = 'http://localhost:3000/', server = 'http://localhost:8080'] = process.argv;
const url = `${base.replace(/\/$/, '')}/?p=${pid}&z=${z}&live=${encodeURIComponent(server)}#none`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(url, { waitUntil: 'load' });
await page.getByRole('button', { name: /got it/i }).click({ timeout: 1500 }).catch(() => {});
// WAIT FOR A REAL SIGNAL, not a timeout. Against prod the assets are cold and a fixed wait lands on
// the loading splash — which looks like a screenshot of nothing and has already been mistaken for a
// verified frame once. `#loading` takes the `gone` class when the map is actually up.
await page.waitForFunction(
  () => { const l = document.getElementById('loading'); return !l || l.classList.contains('gone'); },
  { timeout: 120000 });
// Esc TWICE, and the second is the one that matters: the lobby opens DURING load, so an Esc sent
// before it is up dismisses nothing. Press again once the map has settled, just before the shot.
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(+waitMs);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
console.log('shot:', out, '| url:', url, '| errors:', errors.length ? errors : 'none');
await browser.close();
