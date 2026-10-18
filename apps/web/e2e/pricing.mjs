// Runs the real web build with every request fulfilled locally. No production requests/payments.
// Build apps/web, then: node apps/web/e2e/pricing.mjs
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
const zero = { totalMicros: 0, byItem: { compute: 0, ip: 0, storage: 0, snapshot: 0, transfer: 0 } };
const month = new Date().toISOString().slice(0, 7);
const instance = {
  id: 'browser-fixture', name: 'Quoted browser', regionId: 'syd1', status: 'sleeping', statusReason: null,
  desiredState: 'stopped', idleTimeoutS: 600, locale: 'en-US', screen: 'auto', ipAddress: '192.0.2.1',
  dedicatedSince: null, lastIpCheck: null, lastActiveAt: null, createdAt: new Date().toISOString(),
  deletedAt: null, purgeAfter: null, currentOperation: null, storageGb: 10, backupsEnabled: false, trial: null,
};
const results = [];

async function fixture({ trial = false, failed = false, noPrice = false, width = 1365, sizeGb = 10, totalBytes, status = 'sleeping', purgeAfter = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1024 }, locale: 'en-US', hasTouch: width === 820 });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const i = { ...instance, storageGb: sizeGb, status, purgeAfter, ...(failed ? { status: 'failed' } : {}), ...(trial ? { storageGb: 2, trial: { state: 'active', secondsLeft: 600, reclaimAt: null } } : {}) };
  const fsTotalBytes = totalBytes === undefined ? i.storageGb * 1024 ** 3 * 0.93 : totalBytes;
  const state = { version: 'quote-1', storageGb: 10, requests: [], priceReads: 0, reject: false };
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'Every request must stay on the intercepted fixture origin');
    if (url.pathname.startsWith('/api/')) {
      let body;
      let status = 200;
      if (request.method() !== 'GET') {
        const entry = { method: request.method(), path: url.pathname, body: request.postData() ? request.postDataJSON() : null };
        state.requests.push(entry);
        if (state.reject) {
          if (state.reject === 'storage') state.storageGb = 100;
          else state.version = 'quote-2';
          state.reject = false;
          status = 409;
          body = { type: 'price_changed', title: 'Prices changed', detail: 'Prices changed. Review the new price and try again.', status };
        } else body = { instanceId: 'new-browser', operationId: 'fixture-operation' };
      } else if (url.pathname === '/api/v1/me') body = {
        user: { id: 'fixture-user', name: 'Test user', email: 'fixture@example.test' },
        entitlements: { billing: 'prepaid', maxBrowsers: 10, maxRunning: 10, idleTimeoutMaxS: 3600, ipChangesPerMonth: 1, maxStorageGb: 100 },
        usage: { browsers: failed ? 0 : 1, running: 0 },
      };
      else if (url.pathname === '/api/v1/regions') body = [{ id: 'syd1', name: 'Sydney', country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney', enabled: true, acceptingNew: true, probeUrl: null }];
      else if (url.pathname === '/api/v1/pricing') {
        state.priceReads++;
        const newer = state.version === 'quote-2';
        body = [{ regionId: 'syd1', available: !noPrice, source: 'aws-price-list', updatedAt: new Date().toISOString(),
          rates: noPrice ? null : { compute: newer ? 200_000 : 100_000, ip: newer ? 12_000 : 6_000, storage: newer ? 200_000 : 100_000, snapshot: newer ? 100_000 : 50_000, transfer: 100_000 },
          rootVolumeGb: 16, machine: { vcpu: 2, memoryGb: 4 }, defaultStorageGb: state.storageGb, maxStorageGb: 100, version: noPrice ? null : state.version }];
      } else if (url.pathname === '/api/v1/billing') body = {
        mode: 'prepaid', enabled: false, balanceMicros: trial ? 0 : 10_000_000, exhaustedAt: null, dataKeptUntil: null, frozen: false,
        minBalanceMicros: 1_000_000, lowBalanceMicros: 2_000_000, burnHourMicros: 10_000, topUps: [], month: { ...zero, month },
        trial: { eligible: false, regionId: 'syd1', minutes: 10, storageGb: 2, keptDays: 7 },
      };
      else if (url.pathname === '/api/v1/instances') body = [i];
      else if (url.pathname === `/api/v1/instances/${i.id}`) body = i;
      else if (url.pathname.endsWith('/storage')) body = { sizeGb: i.storageGb, rootVolumeGb: 16, maxGb: 100, usedBytes: fsTotalBytes === null ? null : 1_000_000_000, totalBytes: fsTotalBytes,
        reportedAt: null, resizable: !trial, blockedReason: trial ? 'trial' : null, nextResizeAt: null, snapshots: { count: 0, retentionDays: 7 } };
      else if (url.pathname.endsWith('/usage') && url.pathname.includes('/instances/')) body = { month, totalMicros: 0, items: [], byDay: [], now: { hourMicros: 10_000, runningHourMicros: 100_000, alwaysOnMonthMicros: 7_300_000 } };
      else if (url.pathname === '/api/v1/usage') body = { ...zero, month, byBrowser: [], byDay: [] };
      else if (url.pathname === '/api/v1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': local fixture\n\n' });
      else if (url.pathname.endsWith('/backups') || url.pathname.endsWith('/sessions') || url.pathname.endsWith('/transactions')) body = [];
      else throw new Error(`Unhandled fixture route: ${request.method()} ${url.pathname}`);
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    let file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = resolve(dist, 'index.html');
    return route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  return { context, page, state, errors };
}
async function finish(f, name) {
  assert.deepEqual(f.errors, []);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page must not overflow horizontally');
  results.push(name);
  await f.context.close();
}
async function rejected(f, path, version = 'quote-1') {
  await f.page.getByText('Prices changed. Review the new price and try again.', { exact: true }).first().waitFor();
  assert.equal(f.state.requests.length, 1, 'Rejected purchase must not retry automatically');
  assert.equal(f.state.requests[0].path, path);
  assert.equal(f.state.requests[0].body.priceVersion, version);
  assert.ok(f.state.priceReads >= 2, 'Rejected quote must fetch replacement prices');
}

try {
  const create = await fixture();
  await create.page.goto(`${origin}/browsers/new`);
  await create.page.getByLabel('Name', { exact: true }).fill('Keep my entered name');
  create.state.reject = true;
  await create.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await rejected(create, '/api/v1/instances');
  assert.equal(await create.page.getByLabel('Name', { exact: true }).inputValue(), 'Keep my entered name');
  await create.page.getByText('$0.20/h', { exact: true }).first().waitFor();
  await create.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await create.page.waitForURL('**/browsers');
  assert.equal(create.state.requests[1].body.priceVersion, 'quote-2');
  assert.equal(create.state.requests[1].body.storageGb, 10);
  await finish(create, 'create refreshes stale prices, preserves input, and only retries after a second explicit click');

  const capacity = await fixture();
  await capacity.page.goto(`${origin}/browsers/new`);
  capacity.state.reject = 'storage';
  await capacity.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await rejected(capacity, '/api/v1/instances');
  assert.equal(capacity.state.requests[0].body.storageGb, 10);
  await capacity.page.getByText('Storage, 116 GB', { exact: true }).waitFor();
  await capacity.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await capacity.page.waitForURL('**/browsers');
  assert.equal(capacity.state.requests[1].body.storageGb, 100);
  await finish(capacity, 'changed default storage refreshes the shown capacity and requires a second confirmation');

  for (const action of ['storage', 'snapshot', 'ip']) {
    const f = await fixture({ width: action === 'storage' ? 820 : 1365 });
    await f.page.goto(`${origin}/browsers/${instance.id}/${action === 'ip' ? 'settings' : 'storage'}`);
    const open = action === 'storage' ? 'Add storage' : action === 'snapshot' ? 'Turn on snapshots' : 'Request a new IP';
    await f.page.getByRole('button', { name: open, exact: true }).click();
    f.state.reject = true;
    const dialog = f.page.getByRole('dialog');
    await dialog.getByRole('button', { name: action === 'ip' ? 'Request new IP' : open, exact: true }).click();
    const path = action === 'storage' ? `/api/v1/instances/${instance.id}/storage` : action === 'snapshot' ? `/api/v1/instances/${instance.id}` : `/api/v1/instances/${instance.id}/ip-change-requests`;
    await rejected(f, path);
    await dialog.waitFor({ state: 'hidden' });
    await f.page.getByRole('button', { name: open, exact: true }).click();
    await f.page.getByRole('dialog').getByRole('button', { name: action === 'ip' ? 'Request new IP' : open, exact: true }).click();
    await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(f.state.requests[1].body.priceVersion, 'quote-2');
    await finish(f, `${action} rejects stale quote, closes confirmation, and sends a fresh quote only after explicit reconfirmation`);
  }

  const trial = await fixture({ trial: true, width: 820 });
  await trial.page.goto(`${origin}/browsers/${instance.id}/storage`);
  assert.equal(await trial.page.getByRole('button', { name: 'Turn on snapshots', exact: true }).isDisabled(), true);
  await trial.page.getByText('Snapshots are not included in the free trial. Add credit to keep this browser first.', { exact: true }).waitFor();
  await trial.page.getByRole('link', { name: 'Usage', exact: true }).click();
  await trial.page.waitForURL('**/usage');
  assert.equal(trial.state.requests.length, 0);
  await finish(trial, 'tablet browser management tabs work and trial snapshots are disabled with an explanation');

  const retry = await fixture({ failed: true, trial: true });
  await retry.page.goto(`${origin}/browsers`);
  await retry.page.getByRole('button', { name: 'Try again', exact: true }).click();
  await retry.page.getByText(/This replaces a failed trial browser/).waitFor();
  assert.equal(await retry.page.getByRole('button', { name: 'Create browser', exact: true }).isDisabled(), true);
  assert.equal(retry.state.requests.length, 0, 'Reviewing a failed trial replacement must not delete or charge anything');
  await finish(retry, 'failed trial retry reviews paid replacement without deleting the failed browser or bypassing the balance requirement');

  const paidRetry = await fixture({ failed: true });
  await paidRetry.page.goto(`${origin}/browsers`);
  await paidRetry.page.getByRole('button', { name: 'Try again', exact: true }).click();
  await paidRetry.page.getByRole('button', { name: 'Create browser', exact: true }).waitFor();
  assert.equal(paidRetry.state.requests.length, 0);
  await paidRetry.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await paidRetry.page.waitForURL('**/browsers');
  assert.deepEqual(paidRetry.state.requests.map((request) => [request.method, request.path]), [
    ['POST', '/api/v1/instances'],
  ]);
  await finish(paidRetry, 'paid retry requires a reviewed quote and never automatically deletes the failed browser');

  const deletion = await fixture();
  await deletion.page.goto(`${origin}/browsers/${instance.id}/settings`);
  await deletion.page.getByText('Permanently delete this browser, its saved data, signed-in sessions and backups, and release its resources. Access closes immediately. This cannot be undone.', { exact: true }).waitFor();
  const deleteButton = deletion.page.getByRole('button', { name: 'Delete browser', exact: true });
  assert.equal(await deleteButton.isDisabled(), true);
  await deletion.page.locator('#confirm-delete').fill('Wrong name');
  assert.equal(await deleteButton.isDisabled(), true);
  await deletion.page.locator('#confirm-delete').fill(instance.name);
  assert.equal(deletion.state.requests.length, 0, 'Typing confirmation must not delete automatically');
  await deleteButton.click();
  await deletion.page.waitForURL('**/browsers');
  assert.deepEqual(deletion.state.requests.map((request) => [request.method, request.path]), [['DELETE', `/api/v1/instances/${instance.id}`]]);
  await finish(deletion, 'permanent deletion requires the browser name and an explicit delete click');

  const cardDelete = await fixture();
  await cardDelete.page.goto(`${origin}/browsers`);
  for (const accepted of [false, true]) {
    await cardDelete.page.getByRole('button', { name: 'More actions', exact: true }).click();
    const confirmation = cardDelete.page.waitForEvent('dialog');
    const clicked = cardDelete.page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const dialog = await confirmation;
    assert.match(dialog.message(), /Permanently delete/);
    assert.match(dialog.message(), /This cannot be undone/);
    const deletedResponse = accepted ? cardDelete.page.waitForResponse((response) => response.request().method() === 'DELETE') : null;
    if (accepted) await dialog.accept();
    else await dialog.dismiss();
    await clicked;
    if (accepted) await deletedResponse;
    else assert.equal(cardDelete.state.requests.length, 0, 'Cancelling must not delete');
  }
  assert.equal(cardDelete.state.requests.length, 1);
  assert.equal(cardDelete.state.requests[0].method, 'DELETE');
  await finish(cardDelete, 'card deletion explains permanence, cancellation sends nothing, and acceptance sends one DELETE');

  for (const recoverable of [false, true]) {
    const pending = await fixture({ status: 'deleting', purgeAfter: new Date(Date.now() + (recoverable ? 7 : -1) * 86_400_000).toISOString() });
    await pending.page.goto(`${origin}/browsers`);
    if (recoverable) {
      await pending.page.getByRole('button', { name: 'Restore', exact: true }).waitFor();
      await pending.page.getByText(/Recoverable until/).waitFor();
    } else {
      await pending.page.getByRole('button', { name: 'Permanently deleting', exact: true }).waitFor();
      assert.equal(await pending.page.getByRole('button', { name: 'Restore', exact: true }).count(), 0);
      await pending.page.getByText('Access is closed. Data is being permanently removed and resources released.', { exact: true }).waitFor();
    }
    assert.equal(pending.state.requests.length, 0);
    await finish(pending, recoverable ? 'legacy system recovery window remains available without automatic restoration' : 'permanent cleanup has no restore action and explains data removal');
  }

  const missing = await fixture({ noPrice: true });
  await missing.page.goto(`${origin}/browsers/${instance.id}/settings`);
  assert.equal(await missing.page.getByRole('button', { name: 'Request a new IP', exact: true }).isDisabled(), true);
  await missing.page.goto(`${origin}/browsers/new`);
  assert.equal(await missing.page.getByRole('button', { name: 'Create browser', exact: true }).isDisabled(), true);
  await finish(missing, 'missing prices block create and IP change before confirmation');

  const phone = await fixture({ width: 390 });
  await phone.page.goto(`${origin}/billing`);
  await phone.page.getByRole('heading', { name: 'Billing & usage', exact: true }).waitFor();
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await phone.page.goto(`${origin}/browsers/new`);
  await phone.page.getByRole('dialog').waitFor();
  await phone.page.getByText('2 vCPU', { exact: false }).waitFor();
  assert.equal(phone.state.requests.length, 0);
  await finish(phone, 'phone billing and create quote fit the viewport without mutations');

  for (const status of ['sleeping', 'running']) {
    const pending = await fixture({ sizeGb: 20, totalBytes: 10 * 1024 ** 3, status });
    await pending.page.goto(`${origin}/browsers/${instance.id}/storage`);
    await pending.page.getByText(status === 'sleeping'
      ? 'Storage has increased. The extra space will be available after the browser next starts.'
      : 'Storage has increased, but available space has not updated yet. Refresh shortly or restart the browser.', { exact: true }).waitFor();
    await finish(pending, `${status} browser explains provisioned capacity awaiting filesystem growth`);
  }
  for (const totalBytes of [20 * 1024 ** 3 * 0.93, null]) {
    const normal = await fixture({ sizeGb: 20, totalBytes });
    await normal.page.goto(`${origin}/browsers/${instance.id}/storage`);
    await normal.page.getByText('Data volume: 20 GB', { exact: true }).waitFor();
    assert.equal(await normal.page.getByText(/Storage has increased/).count(), 0, 'Filesystem overhead or missing metrics must not trigger a capacity warning');
    await finish(normal, totalBytes === null ? 'unknown filesystem capacity does not raise a false warning' : 'normal filesystem overhead does not raise a false warning');
  }

  console.log(JSON.stringify({ result: 'passed', checks: results, productionRequests: 0 }, null, 2));
} finally {
  await browser.close();
}
