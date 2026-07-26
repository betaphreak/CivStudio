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
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(+waitMs);
await page.screenshot({ path: out });
console.log('shot:', out, '| url:', url, '| errors:', errors.length ? errors : 'none');
await browser.close();
