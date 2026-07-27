// The case the rail actually overlapped in: a viewport narrow enough that the advisor sub-strip
// (#advisorSubbar) wraps to a second line, so the top bar is TALLER than --bar-h. The rail used to
// be pinned to --bar-h and tucked under that second row.
// Usage: node bugfix-wrap-verify.mjs [baseUrl] [serverUrl]
import { chromium } from 'playwright-core';

const [, , base = 'http://localhost:3001', server = 'http://localhost:8080'] = process.argv;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

for (const width of [1400, 1100, 900]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const url = `${base.replace(/\/$/, '')}/?p=4411&z=8&live=${encodeURIComponent(server)}#none`;
  await page.goto(url, { waitUntil: 'load' });
  await page.getByRole('button', { name: /got it/i }).click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // Zeitgeist is the widest sub-strip (LIVE badge + vitals + clock + speed + diag chip), so it is
  // the mode that wraps first — and the mode a spectator is actually in.
  await page.evaluate(() => {
    const b = document.querySelector('#advisorToggle button.advisor-live');
    if (b) b.click();
  });
  await page.waitForTimeout(1500);

  const geom = await page.evaluate(async () => {
    document.querySelector('.railwrap').classList.add('open');
    document.querySelector('.app').classList.add('rail-open');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const rail = document.querySelector('.railwrap').getBoundingClientRect();
    const sub = document.querySelector('#advisorSubbar').getBoundingClientRect();
    return { barBottom: bar.bottom, barH: bar.height, railTop: rail.top, subBottom: sub.bottom,
             wrapped: bar.height > 60 };
  });
  check(`w=${width}: rail clears the bar${geom.wrapped ? ' (sub-bar WRAPPED)' : ''}`,
    geom.railTop >= geom.barBottom - 0.5 && geom.railTop >= geom.subBottom - 0.5,
    `rail.top=${geom.railTop} barH=${geom.barH} barBottom=${geom.barBottom} subBottom=${geom.subBottom}`);
  await page.screenshot({ path: `bugfix-rail-${width}.png` });
  await page.close();
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  — ${r.detail}`);
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
