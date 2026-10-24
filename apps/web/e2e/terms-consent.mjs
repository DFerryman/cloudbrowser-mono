// The Terms of Service dialog before a top-up: shown only until the current Terms version is
// accepted, Confirm disabled until the box is ticked, the Terms link opening in a new tab, the
// version sent with the checkout, Cancel and Escape closing without paying, a stale tab asked to
// reload, and screenshots in light, dark and phone width. Real web build, local API fixtures.
// Build apps/web, then: node apps/web/e2e/terms-consent.mjs   (WEB_DIST, SHOT_DIR, PLAYWRIGHT_PATH optional)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.WEB_DIST ?? resolve(here, '../dist'));
const out = process.env.SHOT_DIR ?? resolve(here, '../shots');
mkdirSync(out, { recursive: true });
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
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const TERMS_VERSION = /export const TERMS_VERSION = '([^']+)'/.exec(readFileSync(resolve(here, '../../../packages/contracts/src/legal.ts'), 'utf8'))[1];
const month = new Date().toISOString().slice(0, 7);

const billing = (over) => ({
  mode: 'prepaid', enabled: true, provider: 'stripe', receipts: [], balanceMicros: 0, reservedMicros: 0, availableMicros: 0, retentionDays: 7,
  exhaustedAt: null, dataKeptUntil: null, frozen: false, minBalanceMicros: 1_000_000, lowBalanceMicros: 2_000_000, burnHourMicros: 0, fundedUntil: null,
  retained: [], restoreNeededMicros: null, termsVersion: TERMS_VERSION, termsAccepted: false,
  topUps: [
    { productId: 'price_10', name: '$10', amountCents: 1000, currency: 'USD' },
    { productId: 'price_25', name: '$25', amountCents: 2500, currency: 'USD' },
  ],
  month: { month, totalMicros: 0, byItem: { compute: 0, ip: 0, storage: 0, snapshot: 0, transfer: 0 } },
  ...over,
});

/** Opens /billing with the given billing state; `checkout` answers POST /billing/checkout. */
async function fixture({ state = {}, checkout, width = 1280, height = 860, theme = 'light', locale = 'en-US' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  const posts = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Checkout</h1>' });
    const p = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: status < 300 ? 'application/json' : 'application/problem+json', body: JSON.stringify(body) });
    if (p === '/api/v1/billing/checkout') {
      const body = JSON.parse(route.request().postData());
      posts.push(body);
      const [status, answer] = checkout ? await checkout(body) : [200, { url: 'https://checkout.stripe.test/c/pay/cs_1' }];
      return json(answer, status);
    }
    if (p === '/api/v1/me') return json({ user: { id: 'u', name: 'Ada', email: 'ada@example.com' }, entitlements: { billing: 'prepaid', maxBrowsers: 10, maxRunning: 10, idleTimeoutMaxS: 3600, maxStorageGb: 100, neverSleep: true }, usage: { browsers: 0, running: 0 } });
    if (p === '/api/v1/billing') return json(billing(state));
    if (p === '/api/v1/usage') return json({ totalMicros: 0, byItem: {}, month, byBrowser: [], byDay: [] });
    if (p === '/api/v1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (p.startsWith('/api/')) return json([]);
    let file = resolve(dist, `.${decodeURIComponent(p)}`);
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = resolve(dist, 'index.html');
    return route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto(`${origin}/billing`);
  await page.getByRole('heading', { name: locale.startsWith('zh') ? '账单与用量' : 'Billing' }).first().waitFor();
  return { context, page, errors, posts };
}

const dialog = (page) => page.getByRole('dialog');
const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok: ${name}`);
}

await check('not yet accepted: the dialog opens, Confirm waits for the box, and the version goes with the checkout', async () => {
  const { context, page, errors, posts } = await fixture();
  await page.getByRole('button', { name: '$25.00' }).click();
  await dialog(page).waitFor();
  assert.equal(await dialog(page).getByRole('heading').first().textContent(), 'Before you pay');
  assert.match(await dialog(page).textContent(), /You are adding \$25\.00 of credit\. Next, you pay on Stripe’s secure checkout page\./);
  const box = page.getByRole('checkbox', { name: 'I have read the Terms of Service' });
  // The box is focused first, unticked, and Confirm is disabled until it is ticked.
  assert.equal(await box.evaluate((el) => el === document.activeElement), true);
  assert.equal(await box.isChecked(), false);
  const confirm = page.getByRole('button', { name: 'Confirm and pay' });
  assert.equal(await confirm.isDisabled(), true);
  // The Terms link opens the Terms page in a new tab and says so.
  const link = dialog(page).getByRole('link', { name: 'Terms of Service' });
  assert.equal(await link.getAttribute('href'), '/terms');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await page.locator(`#${await link.getAttribute('aria-describedby').then((id) => id.replace(/:/g, '\\:'))}`).textContent(), /new tab/);
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await tab.waitForLoadState();
  assert.equal(new URL(tab.url()).pathname, '/terms');
  await tab.close();
  // Following the link does not tick the box, and the dialog is still there as it was.
  assert.equal(await box.isChecked(), false);
  await page.keyboard.press('Tab'); // focus comes back into the dialog
  await box.check();
  assert.equal(await confirm.isEnabled(), true);
  await page.screenshot({ path: `${out}/consent-desktop.png` });
  await Promise.all([page.waitForURL(/checkout\.stripe\.test/), confirm.click()]);
  assert.deepEqual(posts, [{ productId: 'price_25', acceptedTermsVersion: TERMS_VERSION }]);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('accepted: a top-up goes straight to checkout, without the dialog or a version', async () => {
  const { context, page, errors, posts } = await fixture({ state: { termsAccepted: true } });
  await Promise.all([page.waitForURL(/checkout\.stripe\.test/), page.getByRole('button', { name: '$10.00' }).click()]);
  assert.deepEqual(posts, [{ productId: 'price_10' }]);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('accepted an older version: the dialog asks again', async () => {
  const { context, page, posts } = await fixture({ state: { termsAccepted: true, termsVersion: '2000-01-01' } });
  await page.getByRole('button', { name: '$10.00' }).click();
  await dialog(page).waitFor();
  assert.deepEqual(posts, []);
  await context.close();
});

await check('the server asks for the Terms after all: the dialog opens instead of an error', async () => {
  const { context, page, posts } = await fixture({
    state: { termsAccepted: true },
    checkout: async (body) => body.acceptedTermsVersion ? [200, { url: 'https://checkout.stripe.test/c/pay/cs_2' }] : [409, { type: 'terms_required', title: 'Confirm the Terms of Service', status: 409 }],
  });
  await page.getByRole('button', { name: '$10.00' }).click();
  await dialog(page).waitFor();
  assert.equal(await dialog(page).getByRole('alert').count(), 0, 'no error shown for a first confirmation');
  await page.getByRole('checkbox').check();
  await Promise.all([page.waitForURL(/checkout\.stripe\.test/), page.getByRole('button', { name: 'Confirm and pay' }).click()]);
  assert.deepEqual(posts.map((b) => b.acceptedTermsVersion ?? null), [null, TERMS_VERSION]);
  await context.close();
});

await check('Cancel and Escape close without paying, and the box starts unticked each time', async () => {
  const { context, page, posts } = await fixture();
  const open = async () => { await page.getByRole('button', { name: '$10.00' }).click(); await dialog(page).waitFor(); };
  await open();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  await dialog(page).waitFor({ state: 'detached' });
  // Focus returns to the button that opened the dialog.
  assert.equal(await page.getByRole('button', { name: '$10.00' }).evaluate((el) => el === document.activeElement), true);
  await open();
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  assert.deepEqual(posts, []);
  await context.close();
});

await check('while the checkout is created: one request however often Confirm is clicked, and Cancel drops it', async () => {
  let release;
  const { context, page, posts } = await fixture({ checkout: () => new Promise((r) => { release = () => r([200, { url: 'https://checkout.stripe.test/c/pay/cs_3' }]); }) });
  await page.getByRole('button', { name: '$10.00' }).click();
  await page.getByRole('checkbox').check();
  const confirm = page.getByTestId('consent-confirm');
  await confirm.click();
  await page.getByRole('button', { name: 'Opening checkout…' }).waitFor();
  assert.equal(await confirm.isDisabled(), true);
  await confirm.click({ force: true }).catch(() => {});
  await page.screenshot({ path: `${out}/consent-opening.png` });
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  release();
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname, '/billing', 'a cancelled checkout must not redirect');
  assert.equal(posts.length, 1);
  await context.close();
});

await check('errors show in the dialog; a stale tab is asked to reload', async () => {
  let answer = [503, { type: 'billing_unavailable', title: 'Billing is not available', status: 503, detail: 'Payments are briefly unavailable. Try again in a few minutes.' }];
  const { context, page } = await fixture({ checkout: async () => answer });
  await page.getByRole('button', { name: '$10.00' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const alert = dialog(page).getByRole('alert');
  await alert.waitFor();
  assert.match(await alert.textContent(), /briefly unavailable/);
  // The box stays ticked and Confirm can be tried again.
  assert.equal(await page.getByRole('checkbox').isChecked(), true);
  assert.equal(await page.getByRole('button', { name: 'Confirm and pay' }).isEnabled(), true);
  answer = [409, { type: 'terms_required', title: 'Confirm the Terms of Service', status: 409, detail: 'The Terms of Service have changed. Reload the page, read them and confirm again.' }];
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  await alert.getByRole('button', { name: 'Reload' }).waitFor();
  assert.match(await alert.textContent(), /were just updated/);
  assert.equal(await page.getByRole('button', { name: 'Confirm and pay' }).isDisabled(), true);
  await page.screenshot({ path: `${out}/consent-changed.png` });
  await context.close();
});

for (const shot of [
  { name: 'consent-dark', theme: 'dark' },
  { name: 'consent-phone', width: 390, height: 844 },
  { name: 'consent-phone-zh', width: 390, height: 844, locale: 'zh-CN', theme: 'dark' },
]) {
  await check(`screenshot ${shot.name}`, async () => {
    const { context, page, errors } = await fixture(shot);
    await page.getByRole('button', { name: /10\.00/ }).click();
    await dialog(page).waitFor();
    await page.getByRole('checkbox').check();
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${shot.name}: horizontal overflow`);
    await page.screenshot({ path: `${out}/${shot.name}.png` });
    assert.deepEqual(errors, []);
    await context.close();
  });
}

await browser.close();
console.log(`${results.length} checks passed`);
