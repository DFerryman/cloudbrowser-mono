// Rename from a browser's menu on the dashboard: the name field must keep the focus it is given,
// with a mouse and on a touch screen, and Enter must save the typed name.
// Uses the real web build with local API fixtures; never opens a VM.
// Build apps/web, then: node apps/web/e2e/browser-rename.mjs   (WEB_DIST, PLAYWRIGHT_PATH optional)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.WEB_DIST ?? resolve(here, '../dist'));
const require = createRequire(import.meta.url);
let playwright;
for (const path of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/codex/cua_node/lib/node_modules/playwright'].filter(Boolean)) {
  try { playwright = require(path); break; } catch {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_PATH.');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH ??
  (!existsSync(playwright.chromium.executablePath()) && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await playwright.chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const origin = 'https://nevazu.com';
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const results = [];

const instance = (name) => ({
  id: 'i1', name, regionId: 'syd1', tier: 'basic', status: 'sleeping', statusReason: null, desiredState: 'stopped',
  idleTimeoutS: 600, screen: 'auto', videoQuality: 'full', videoAuto: true, ipAddress: '192.0.2.1', dedicatedSince: null,
  lastIpCheck: null, lastActiveAt: new Date().toISOString(), createdAt: new Date().toISOString(), deletedAt: null, purgeAfter: null,
  currentOperation: null, storageGb: 10, stopReason: null, deletesAt: null,
});

async function fixture({ touch }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: touch, isMobile: false, locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  const patches = [];
  let name = 'Fixture browser';
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, origin, 'All fixture requests must remain local');
    if (url.pathname.startsWith('/api/')) {
      let body;
      if (url.pathname === '/api/v1/me') body = { user: { id: 'u1', name: 'Fixture', email: 'fixture@example.test' }, entitlements: {}, usage: {} };
      else if (url.pathname === '/api/v1/instances' && req.method() === 'GET') body = [instance(name)];
      else if (url.pathname === '/api/v1/instances/i1' && req.method() === 'PATCH') {
        const patch = req.postDataJSON();
        patches.push(patch);
        name = patch.name ?? name;
        body = instance(name);
      } else if (url.pathname === '/api/v1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': local fixture\n\n' });
      else if (url.pathname === '/api/v1/regions') body = [{
        id: 'syd1', name: 'AWS Sydney', country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney', enabled: true, acceptingNew: true,
        probeUrl: null, area: 'asia_pacific', availability: 'available', availabilityReason: null, launchVerifiedAt: null, estimatedRttMs: null,
      }];
      // Billing, promotions and the rest are not under test.
      else return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ type: 'not_found', title: 'Not found', status: 404 }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    let file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = resolve(dist, 'index.html');
    return route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto(`${origin}/browsers`);
  await page.getByText('Fixture browser').first().waitFor();
  return { context, page, errors, patches };
}

try {
  for (const touch of [false, true]) {
    const label = touch ? 'Touch screen' : 'Mouse';
    const { context, page, errors, patches } = await fixture({ touch });
    const press = (locator) => (touch ? locator.tap() : locator.click());
    await press(page.getByRole('button', { name: 'More actions' }).first());
    await press(page.getByRole('menuitem', { name: 'Rename' }));
    await page.getByRole('menu').waitFor({ state: 'detached' });
    const field = page.getByRole('textbox', { name: 'Rename' });
    await field.waitFor();
    // The menu's closing used to hand focus back to its button, which ended the edit at once.
    await page.waitForTimeout(500);
    assert.equal(await field.count(), 1, `${label}: the name field is still there after the menu closed`);
    assert.ok(await field.evaluate((el) => el === document.activeElement), `${label}: the name field keeps the focus`);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Renamed browser');
    await page.keyboard.press('Enter');
    await page.getByText('Renamed browser').first().waitFor();
    assert.deepEqual(patches, [{ name: 'Renamed browser' }], `${label}: one rename is saved`);
    results.push(`${label}: Rename keeps the field focused and saves the typed name`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(results.map((r) => `ok - ${r}`).join('\n'));
} finally {
  await browser.close();
}
