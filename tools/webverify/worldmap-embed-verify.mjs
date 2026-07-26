// Local check: the map↔province link in the Strapi admin (docs/studio-control-plane-plan.md §D1/§D4).
//
//   1. the World map MENU item + page render the viewer in an iframe;
//   2. the homepage WIDGET renders it too;
//   3. the province edit view carries an "Open in world map" link with the right ?realm=&p=.
//
// The iframe is the fragile part: helmet's `useDefaults` leaves frame-src falling back to
// `default-src 'self'`, so without the frame-src entry in studio/config/middlewares.ts the browser
// refuses to frame the viewer and logs "Refused to frame ...". This script fails on that refusal
// rather than on a missing element, because the element is present either way.
//
// Usage: node worldmap-embed-verify.mjs [strapiBase] [provinceId]
import { chromium } from 'playwright-core';
import { loginAdmin, DEFAULT_BASE } from './login.mjs';

const base = process.argv[2] || DEFAULT_BASE;
const provinceId = process.argv[3] || '4411';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 1 });
await page.addInitScript(() => { try { localStorage.setItem('STRAPI_THEME', 'dark'); } catch {} });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await loginAdmin(page, { base });

// --- 1. the World map page ---
await page.goto(`${base}/admin/civstudio-map`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('h1', { timeout: 60000 });
await page.waitForTimeout(6000);
const pageFrame = await page.$('main iframe');
const pageSrc = pageFrame ? await pageFrame.getAttribute('src') : null;
console.log('World map page iframe src:', pageSrc);
await page.screenshot({ path: 'worldmap-page.png', fullPage: false });

// deep link forwarding
await page.goto(`${base}/admin/civstudio-map?p=${provinceId}&realm=cannor`,
  { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('main iframe', { timeout: 60000 });
const deepSrc = await (await page.$('main iframe')).getAttribute('src');
console.log('deep-linked iframe src:', deepSrc);

// --- 2. the homepage widget ---
await page.goto(`${base}/admin/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-strapi-widget-id="global::civstudio-worldmap"]', { timeout: 60000 });
await page.waitForTimeout(6000);
const widgetFrame = await page.$('[data-strapi-widget-id="global::civstudio-worldmap"] iframe');
console.log('widget iframe present:', !!widgetFrame);
await page.screenshot({ path: 'worldmap-widget.png', fullPage: false });

// --- 3. the province edit view's "Open in world map" ---
// The admin URL needs the opaque documentId, which the bundle never exports (the §D2 lookup
// problem). Pass one in, or the script resolves it through the content-manager list view's own API.
let docId = process.argv[4] || null;
if (!docId) {
  const res = await page.request.get(
    `${base}/content-manager/collection-types/api::province.province` +
    `?page=1&pageSize=1&filters[$and][0][provinceId][$eq]=${provinceId}`);
  if (res.ok()) {
    const body = await res.json().catch(() => null);
    docId = body?.results?.[0]?.documentId ?? null;
  }
}
let linkHref = null;
if (docId) {
  await page.goto(
    `${base}/admin/content-manager/collection-types/api::province.province/${docId}?plugins[i18n][locale]=en`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('main', { timeout: 60000 });
  await page.waitForTimeout(7000);
  const link = await page.$('main a:has-text("Open in world map")');
  linkHref = link ? await link.getAttribute('href') : null;
  await page.screenshot({ path: 'worldmap-editview.png', fullPage: false });
} else {
  console.log('(could not resolve a documentId — pass one as argv[4], or seed studio)');
}
console.log('edit-view link href:', linkHref);

const refusedToFrame = errors.filter((e) => /Refused to frame|frame-src|Content Security Policy/i.test(e));
console.log('CSP frame refusals:', refusedToFrame.length ? refusedToFrame : 'none');
console.log('other page errors:', errors.length ? errors : 'none');

const ok =
  !!pageSrc && !!widgetFrame && refusedToFrame.length === 0 &&
  (deepSrc || '').includes(`p=${provinceId}`) &&
  (linkHref === null || (linkHref.includes(`p=${provinceId}`) && linkHref.includes('realm=')));
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
