// Phase 7 behaviour checks (docs/realms.md §The six realms): the six realms crop and render, the
// retired `halcann` alias resolves and rewrites, the plane toggle is gone, and a deep link lands in
// the Serpentspine. Read-only, no app internals — everything here is observable from the page.
// node _realmsplit-verify.mjs [webBase] [serverBase]
import { chromium } from 'playwright-core';
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const server = process.argv[3] || 'http://localhost:8080';
const url = (q) => `${base}/?${q}&live=${encodeURIComponent(server)}#none`;

const REALMS = { cannor: 898, serpentspine: 444, haless: 1102, sarhal: 1172, aelantir: 1557, hinuilands: 2 };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

async function open(q, wait = 3500) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(url(q), { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  return { page, errors };
}
const probe = page => page.evaluate(() => {
  const B = window.BUNDLE || {};
  const r = new URLSearchParams(location.search).get('realm');
  return {
    realm: r,
    src: (B.realms?.[r] || {}).map?.src,
    provinces: (B.provinces || []).filter(p => p.realm === r).length,
    name: B.geoNames?.realm?.[r],
    label: document.querySelector('#advisorToggle button')?.textContent?.trim(),
    planeToggle: !!document.getElementById('planeToggle'),
    dataPlane: document.querySelectorAll('[data-plane]').length,
  };
});

for (const [key, count] of Object.entries(REALMS)) {
  const { page, errors } = await open(`realm=${key}`);
  const d = await probe(page);
  check(`${key}: crops to its own bake, ${count} provinces`,
    d.src === `assets/terrain/terrain-${key}.webp` && d.provinces === count, JSON.stringify(d));
  check(`${key}: no console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// the retired `halcann` key resolves to Cannor AND is rewritten out of the address bar
{
  const { page, errors } = await open('realm=halcann');
  const d = await probe(page);
  check('halcann → cannor (resolved + URL rewritten + masthead named)',
    d.realm === 'cannor' && d.provinces === 898 && /Cannor/.test(d.label || ''), JSON.stringify(d));
  check('halcann alias: no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// the plane toggle is deleted, and #underworld is an ordinary unknown hash
{
  const { page, errors } = await open('realm=cannor');
  const d = await probe(page);
  check('plane toggle deleted', !d.planeToggle && d.dataPlane === 0, JSON.stringify(d));
  await page.close();
  const u = await open('realm=serpentspine&p=4097&z=60', 5000);
  const dd = await probe(u.page);
  check('deep link into the Serpentspine (Marrhold)',
    dd.realm === 'serpentspine' && dd.provinces === 444, JSON.stringify(dd));
  check('Serpentspine deep link: no console errors', u.errors.length === 0, u.errors.slice(0, 2).join(' | '));
  await u.page.close();
  void errors;
}

await browser.close();
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
