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
  desiredState: 'stopped', idleTimeoutS: 600, locale: 'en-US', screen: 'auto', videoQuality: 'full', videoAuto: true, ipAddress: '192.0.2.1',
  dedicatedSince: null, lastIpCheck: null, lastActiveAt: null, createdAt: new Date().toISOString(),
  deletedAt: null, purgeAfter: null, currentOperation: null, storageGb: 10, trial: null,
};
const results = [];

async function fixture({ trial = false, failed = false, noPrice = false, width = 1365, height = 1024, sizeGb = 10, totalBytes, status = 'sleeping', purgeAfter = null,
  balanceMicros = trial ? 0 : 10_000_000, reservedMicros = 0, availableMicros = Math.max(0, balanceMicros - reservedMicros), mode = 'prepaid', trialEligible = false, trialSeconds = 600, busy = false, legacySnapshots = false, rootVolumeGb = 16, locale = 'en-US', maxBrowsers = 10 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale, hasTouch: width === 820 });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const i = { ...instance, storageGb: sizeGb, status, purgeAfter, ...(legacySnapshots ? { backupsEnabled: true } : {}), ...(busy ? { currentOperation: { id: 'busy-op', kind: 'start', status: 'running' } } : {}), ...(failed ? { status: 'failed' } : {}), ...(trial ? { storageGb: 2, trial: { state: trialSeconds > 0 ? 'active' : 'ended', secondsLeft: trialSeconds, reclaimAt: null } } : {}) };
  const fsTotalBytes = totalBytes === undefined ? i.storageGb * 1024 ** 3 * 0.93 : totalBytes;
  const state = { stockAvailable: true, extraRegion: false, extraRegions: [], version: 'quote-1', storageGb: 10, requests: [], reads: [], priceReads: 0, reject: false };
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'Every request must stay on the intercepted fixture origin');
    if (url.pathname.startsWith('/api/')) {
      if (request.method() === 'GET') state.reads.push(url.pathname);
      let body;
      let status = 200;
      if (request.method() !== 'GET') {
        const entry = { method: request.method(), path: url.pathname, body: request.postData() ? request.postDataJSON() : null };
        state.requests.push(entry);
        if (state.reject === 'instances') {
          status = 403;
          body = { type: 'plan_limit', title: 'Plan limit reached', status, limit: state.reject };
          state.reject = false;
        } else if (state.reject) {
          if (state.reject === 'storage') state.storageGb = 100;
          else state.version = 'quote-2';
          state.reject = false;
          status = 409;
          body = { type: 'price_changed', title: 'Prices changed', detail: 'Prices changed. Review the new price and try again.', status };
        } else if (request.method() === 'PATCH' && url.pathname === `/api/v1/instances/${i.id}`) {
          // Settings save like the API: the browser keeps them and returns itself.
          Object.assign(i, entry.body);
          body = i;
        } else body = { instanceId: 'new-browser', operationId: 'fixture-operation' };
      } else if (url.pathname === '/api/v1/me') body = {
        user: { id: 'fixture-user', name: 'Test user', email: 'fixture@example.test' },
        entitlements: { billing: 'prepaid', maxBrowsers, maxRunning: 10, idleTimeoutMaxS: 3600, ipChangesPerMonth: 1, maxStorageGb: 100 },
        usage: { browsers: failed ? 0 : 1, running: 0 },
      };
      else if (url.pathname === '/api/v1/regions') body = [{ id: 'syd1', name: 'Sydney', country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney', enabled: true, acceptingNew: state.stockAvailable, probeUrl: null,
        area: 'asia_pacific', availability: state.stockAvailable ? 'available' : 'unavailable', availabilityReason: state.stockAvailable ? null : 'no_stock', estimatedRttMs: null,
        ...(!state.stockAvailable ? { inventory: { available: 0, checkedAt: new Date().toISOString(), status: 'ready', constraint: 'quota_and_budget' } } : {}) }];
      else if (url.pathname === '/api/v1/pricing') {
        state.priceReads++;
        const newer = state.version === 'quote-2';
        body = [{ regionId: 'syd1', available: !noPrice, source: 'aws-price-list', updatedAt: new Date().toISOString(),
          rates: noPrice ? null : { compute: newer ? 200_000 : 100_000, ip: newer ? 12_000 : 6_000, storage: newer ? 200_000 : 100_000, snapshot: newer ? 100_000 : 50_000, transfer: 100_000 },
          rootVolumeGb: 16, machine: { vcpu: 2, memoryGb: 4 }, defaultStorageGb: state.storageGb, maxStorageGb: 100, version: noPrice ? null : state.version }];
      } else if (url.pathname === '/api/v1/billing') body = {
        mode, enabled: false, balanceMicros, reservedMicros, availableMicros, retentionDays: 7, exhaustedAt: null, dataKeptUntil: null, frozen: false,
        minBalanceMicros: 1_000_000, lowBalanceMicros: 2_000_000, burnHourMicros: 10_000, topUps: [], month: { ...zero, month },
        trial: { eligible: trialEligible, regionId: 'syd1', minutes: 10, storageGb: 2, keptDays: 7 },
      };
      else if (url.pathname === '/api/v1/instances') body = [i];
      else if (url.pathname === `/api/v1/instances/${i.id}`) body = i;
      else if (url.pathname.endsWith('/storage')) body = { sizeGb: i.storageGb, rootVolumeGb, maxGb: 100, usedBytes: fsTotalBytes === null ? null : 1_000_000_000, totalBytes: fsTotalBytes,
        reportedAt: null, resizable: !trial, blockedReason: trial ? 'trial' : null, nextResizeAt: null };
      else if (url.pathname.endsWith('/usage') && url.pathname.includes('/instances/')) {
        const fixed = 6_000 * 730 + 100_000 * (i.storageGb + rootVolumeGb);
        body = { month, totalMicros: 0, items: [], byDay: [], now: { hourMicros: trial ? 0 : Math.round(fixed / 730) + (i.status === 'running' ? 100_000 : 0), runningHourMicros: 100_000, alwaysOnMonthMicros: fixed } };
      }
      else if (url.pathname === '/api/v1/usage') body = { ...zero, month, byBrowser: [], byDay: [] };
      else if (url.pathname === '/api/v1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': local fixture\n\n' });
      else if (url.pathname.endsWith('/sessions') || url.pathname.endsWith('/transactions')) body = [];
      else throw new Error(`Unhandled fixture route: ${request.method()} ${url.pathname}`);
      if (request.method() === 'GET' && state.extraRegion && url.pathname === '/api/v1/regions') body.push({ id: 'eu-central-1', name: 'Europe (Frankfurt)', country: 'DE', city: 'Frankfurt', timezone: 'Europe/Berlin', enabled: true, acceptingNew: true, probeUrl: null,
        area: 'europe', availability: 'available', availabilityReason: null, estimatedRttMs: null, inventory: { available: 4, checkedAt: new Date().toISOString(), status: 'ready', constraint: 'quota_and_budget' } });
      if (request.method() === 'GET' && state.extraRegion && url.pathname === '/api/v1/pricing') body.push({ ...body[0], regionId: 'eu-central-1', rates: body[0].rates ? { ...body[0].rates, compute: 120_000 } : null });
      if (request.method() === 'GET' && url.pathname === '/api/v1/regions') body.push(...state.extraRegions);
      if (request.method() === 'GET' && url.pathname === '/api/v1/pricing') body.push(...state.extraRegions.map((r) => ({ ...body[0], regionId: r.id })));
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
  assert.equal([...f.state.reads, ...f.state.requests.map((request) => request.path)].some((path) => path.includes('/backups')), false, 'Removed backup APIs must never be requested');
  assert.equal(f.state.requests.some((request) => request.body && Object.hasOwn(request.body, 'backupsEnabled')), false, 'No action may enable snapshots');
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
  {
    const message = '浏览器数量已达上限，请先删除一个浏览器再创建。';
    const limited = await fixture({ locale: 'zh-CN', maxBrowsers: 2 });
    await limited.page.goto(`${origin}/browsers/new`);
    await limited.page.getByText('已用 1 / 2 个浏览器', { exact: true }).waitFor();
    await limited.page.getByText('每天 2 小时，约 US$12.98/月', { exact: true }).waitFor();
    limited.state.reject = 'instances';
    await limited.page.getByRole('button', { name: '创建浏览器', exact: true }).click();
    await limited.page.getByRole('alert').filter({ hasText: message }).waitFor();
    assert.equal(limited.state.requests.length, 1, 'Limit failures must not retry automatically');
    assert.equal(await limited.page.getByText('已达到账户上限。', { exact: true }).count(), 0);
    await finish(limited, 'Chinese browser-count errors explain the cap while the sidebar shows 1 of 2 browsers');
  }

  const create = await fixture();
  await create.page.goto(`${origin}/browsers/new`);
  await create.page.getByText('2 h/day, about $12.98/month', { exact: true }).waitFor();
  await create.page.getByLabel('Name', { exact: true }).fill('Keep my entered name');
  create.state.reject = true;
  await create.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await rejected(create, '/api/v1/instances');
  assert.equal(await create.page.getByLabel('Name', { exact: true }).inputValue(), 'Keep my entered name');
  await create.page.getByText('2 h/day, about $25.96/month', { exact: true }).waitFor();
  // The replacement quote is shown (region row and running total), and its compute-only part in the details.
  await create.page.getByText('$0.2191/h', { exact: true }).first().waitFor();
  await create.page.getByRole('button', { name: 'Price details', exact: true }).click();
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
  await capacity.page.getByText('Dedicated IP and 116 GB of storage', { exact: true }).waitFor();
  await capacity.page.getByText('2 h/day, about $21.98/month', { exact: true }).waitFor();
  await capacity.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await capacity.page.waitForURL('**/browsers');
  assert.equal(capacity.state.requests[1].body.storageGb, 100);
  await finish(capacity, 'changed default storage refreshes the shown capacity and requires a second confirmation');

  const dynamic = await fixture();
  dynamic.state.extraRegion = true;
  await dynamic.page.goto(`${origin}/browsers/new`);
  await dynamic.page.getByText('4 available', { exact: true }).waitFor();
  await dynamic.page.getByText('Europe (Frankfurt)', { exact: true }).click();
  await dynamic.page.getByText('2 h/day, about $14.18/month', { exact: true }).waitFor();
  await dynamic.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await dynamic.page.waitForURL('**/browsers');
  assert.equal(dynamic.state.requests[0].body.regionId, 'eu-central-1');
  await finish(dynamic, 'an API-discovered region outside the legacy list shows live stock and can be selected for creation');

  for (const width of [1920, 390]) {
    const longList = await fixture({ width, height: 900 });
    longList.state.extraRegions = Array.from({ length: 20 }, (_, i) => ({
      id: `test-region-${i}`, name: `Test region ${i + 1}`, country: 'US', city: 'Test city', timezone: 'UTC',
      enabled: true, acceptingNew: true, probeUrl: null, area: null, availability: 'available', availabilityReason: null, estimatedRttMs: null,
    }));
    await longList.page.goto(`${origin}/browsers/new`);
    const dialog = longList.page.getByRole('dialog');
    // A long list shows the nearest regions first; the rest are one click away.
    assert.equal(await dialog.getByText('Test region 20', { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Show all 21 regions', exact: true }).click();
    await dialog.getByText('Test region 20', { exact: true }).click();
    assert.equal(await dialog.getByRole('radio', { name: /Test region 20/ }).isChecked(), true);
    const geometry = await dialog.evaluate((node) => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      return { scrollTop: node.scrollTop, dialog: rect(node), header: rect(node.children[0]), footer: rect(node.children[2]) };
    });
    assert.equal(geometry.scrollTop, 0, 'Focusing a lower region must not scroll the dialog shell');
    assert.ok(geometry.header.top >= geometry.dialog.top, 'Dialog header stays inside the shell');
    assert.ok(geometry.footer.bottom <= geometry.dialog.bottom && geometry.footer.bottom >= geometry.dialog.bottom - 2, 'Actions stay at the bottom of the dialog');
    await dialog.getByRole('radio', { name: /Test region 20/ }).press('ArrowUp');
    assert.equal(await dialog.getByRole('radio', { name: /Test region 19/ }).isChecked(), true);
    assert.equal(await dialog.evaluate((node) => node.scrollTop), 0, 'Keyboard selection also keeps the dialog shell stationary');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await finish(longList, `long region list keeps header and footer in place after selection at ${width}px`);
  }

  {
    // Regions sorted by latency, labelled by availability, the nearest available one recommended.
    const signals = await fixture({ width: 1365 });
    const region = (id, city, country, ms, availability = 'available', availabilityReason = null) => ({
      id, name: `AWS ${city}`, country, city, timezone: 'UTC', enabled: true, acceptingNew: availability !== 'unavailable', probeUrl: null,
      area: 'asia_pacific', availability, availabilityReason, estimatedRttMs: ms, launchVerifiedAt: '2026-10-19T09:30:00.000Z',
    });
    signals.state.extraRegions = [
      region('ap-northeast-1', 'Tokyo', 'JP', 12, 'limited', 'capacity'),
      region('ap-northeast-3', 'Osaka', 'JP', 18, 'unavailable', 'provider_issue'),
      { ...region('ap-northeast-2', 'Seoul', 'KR', 40), launchVerifiedAt: null },
      region('ap-southeast-1', 'Singapore', 'SG', 75),
      region('ap-east-1', 'Hong Kong', 'HK', 55, 'limited', 'low_stock'),
      region('us-west-2', 'Oregon', 'US', 110),
      region('eu-central-1', 'Frankfurt', 'DE', 230, 'unavailable', 'blocked'),
    ];
    await signals.page.goto(`${origin}/browsers/new`);
    const dialog = signals.page.getByRole('dialog');
    const rows = dialog.getByRole('radio');
    await dialog.getByText('Fastest for you', { exact: true }).waitFor();
    const order = await dialog.locator('label:has(input[name=region])').evaluateAll((labels) => labels.map((l) => l.querySelector('input').value));
    assert.deepEqual(order.slice(0, 5), ['ap-northeast-1', 'ap-northeast-2', 'ap-east-1', 'ap-southeast-1', 'us-west-2'], 'Selectable regions come first, nearest first');
    const recommended = dialog.locator('label', { hasText: 'Fastest for you' });
    assert.equal(await recommended.locator('input').getAttribute('value'), 'ap-northeast-2', 'A limited region is not recommended');
    await dialog.getByText('AWS capacity was short recently', { exact: true }).waitFor();
    await dialog.getByText('≈12 ms').waitFor();
    // A region that passed the setup checks but has never run a browser says so.
    await recommended.getByText('Not yet tested', { exact: true }).waitFor();
    assert.equal(await dialog.getByText('Not yet tested', { exact: true }).count(), 1, 'Only the region without a launch is marked');
    await recommended.click();
    await dialog.getByRole('status').filter({ hasText: 'passed our setup checks, but no browser has run there yet.' }).waitFor();
    await dialog.getByText('Tokyo, Japan', { exact: true }).click();
    assert.equal(await dialog.getByRole('status').filter({ hasText: 'passed our setup checks' }).count(), 0);
    await dialog.getByRole('status').filter({ hasText: 'AWS capacity in Tokyo, Japan was short in the last 30 minutes.' }).waitFor();
    await dialog.getByRole('button', { name: 'Show all 8 regions', exact: true }).click();
    assert.equal(await dialog.getByRole('radio', { name: /Osaka/ }).isDisabled(), true);
    await dialog.getByText('Paused while we fix a provider problem', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('radio', { name: /Frankfurt/ }).isDisabled(), true);
    await dialog.getByText('Unavailable until we fix a provider setup problem', { exact: true }).waitFor();
    await dialog.getByRole('searchbox').fill('germany');
    assert.deepEqual(await dialog.locator('label:has(input[name=region]) input').evaluateAll((inputs) => inputs.map((i) => i.value)), ['eu-central-1']);
    await dialog.getByRole('searchbox').fill('');
    if (process.env.SHOT_DIR) await signals.page.screenshot({ path: `${process.env.SHOT_DIR}/regions-en.png` });
    assert.ok(await rows.count() >= 8);
    await dialog.getByRole('button', { name: 'Create browser', exact: true }).click();
    await signals.page.waitForURL('**/browsers');
    assert.equal(signals.state.requests[0].body.regionId, 'ap-northeast-1');
    await finish(signals, 'region list shows availability, latency and a recommendation, and a limited region can still be chosen');

    const phone = await fixture({ width: 390, height: 844, locale: 'zh-CN' });
    phone.state.extraRegions = signals.state.extraRegions;
    await phone.page.goto(`${origin}/browsers/new`);
    const sheet = phone.page.getByRole('dialog');
    await sheet.getByText('离你最快', { exact: true }).waitFor();
    await sheet.getByText('日本 · 东京', { exact: true }).waitFor();
    await sheet.getByText('AWS 近期容量紧张', { exact: true }).waitFor();
    await sheet.getByText('尚未实测', { exact: true }).waitFor();
    if (process.env.SHOT_DIR) await phone.page.screenshot({ path: `${process.env.SHOT_DIR}/regions-zh-phone.png` });
    await finish(phone, 'Chinese region list fits a phone with localized places and availability');
  }

  const noStock = await fixture();
  noStock.state.stockAvailable = false;
  await noStock.page.goto(`${origin}/browsers/new`);
  await noStock.page.getByRole('alert').filter({ hasText: 'No regions currently have space for a new browser.' }).waitFor();
  await noStock.page.getByText('2 h/day, about $12.98/month', { exact: true }).waitFor();
  assert.equal(await noStock.page.getByRole('button', { name: 'Create browser', exact: true }).isDisabled(), true);
  assert.equal(noStock.state.requests.length, 0);
  noStock.state.stockAvailable = true;
  await noStock.page.reload();
  // Enabled once the new inventory and prices are loaded.
  await noStock.page.locator('button:enabled', { hasText: 'Create browser' }).waitFor();
  await finish(noStock, 'no inventory disables creation with a clear message and new inventory restores the action');

  for (const action of ['storage', 'ip']) {
    const f = await fixture({ width: action === 'storage' ? 820 : 1365 });
    await f.page.goto(`${origin}/browsers/${instance.id}/${action === 'ip' ? 'settings' : 'storage'}`);
    const open = action === 'storage' ? 'Add storage' : 'Request a new IP';
    await f.page.getByRole('button', { name: open, exact: true }).click();
    f.state.reject = true;
    const dialog = f.page.getByRole('dialog');
    await dialog.getByRole('button', { name: action === 'ip' ? 'Request new IP' : open, exact: true }).click();
    const path = action === 'storage' ? `/api/v1/instances/${instance.id}/storage` : `/api/v1/instances/${instance.id}/ip-change-requests`;
    await rejected(f, path);
    await dialog.waitFor({ state: 'hidden' });
    await f.page.getByRole('button', { name: open, exact: true }).click();
    await f.page.getByRole('dialog').getByRole('button', { name: action === 'ip' ? 'Request new IP' : open, exact: true }).click();
    await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(f.state.requests[1].body.priceVersion, 'quote-2');
    await finish(f, `${action} rejects stale quote, closes confirmation, and sends a fresh quote only after explicit reconfirmation`);
  }

  {
    const picture = await fixture();
    await picture.page.goto(`${origin}/browsers/${instance.id}/settings`);
    const select = picture.page.getByLabel('Picture resolution', { exact: true });
    assert.equal(await select.inputValue(), 'full');
    assert.equal(await picture.page.getByRole('checkbox', { name: /Adjust to my connection/ }).isChecked(), true);
    assert.equal(await picture.page.getByText('Screen size', { exact: true }).count(), 0, 'The old screen size option never took effect and is gone');
    await select.selectOption('medium');
    await picture.page.waitForFunction(() => document.querySelector('#picture')?.value === 'medium');
    // The cache update is asynchronous; wait for the new state rather than expecting it synchronously.
    await picture.page.getByRole('checkbox', { name: /Adjust to my connection/ }).click();
    await picture.page.waitForFunction(() => !document.querySelector('input[type=checkbox]')?.checked);
    await picture.page.waitForTimeout(300);
    assert.equal(await select.inputValue(), 'medium', 'The saved setting stays shown after the refetch');
    assert.deepEqual(picture.state.requests.map((r) => [r.method, r.body]), [['PATCH', { videoQuality: 'medium' }], ['PATCH', { videoAuto: false }]]);
    if (process.env.SHOT_DIR) await picture.page.screenshot({ path: `${process.env.SHOT_DIR}/picture-settings.png` });
    await finish(picture, 'picture resolution and connection adjustment are browser settings that save at once');
  }

  const trial = await fixture({ trial: true, width: 820 });
  await trial.page.goto(`${origin}/browsers/${instance.id}/storage`);
  await trial.page.getByRole('heading', { name: 'Storage', exact: true }).waitFor();
  assert.equal(await trial.page.getByText(/snapshot|backup|profile archive/i).count(), 0);
  await trial.page.getByRole('link', { name: 'Usage', exact: true }).click();
  await trial.page.waitForURL('**/usage');
  assert.equal(trial.state.requests.length, 0);
  await finish(trial, 'tablet browser management tabs work without snapshot or backup features');

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
  await deletion.page.getByText('Permanently deletes this browser, its data and sign-ins. This cannot be undone.', { exact: true }).waitFor();
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
      await pending.page.getByText('Access is closed; data is being removed.', { exact: true }).waitFor();
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
  const monthly = phone.page.getByText('2 h/day, about $12.98/month', { exact: true });
  await monthly.waitFor();
  const footer = await monthly.boundingBox();
  assert.ok(footer && footer.y + footer.height <= 1024, 'Monthly estimate stays visible beside confirmation on mobile');
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

  const comparable = await fixture({ sizeGb: 20, status: 'running' });
  await comparable.page.goto(`${origin}/browsers/new`);
  // A new browser is quoted all-in (compute, IP and the 10 GB default) in its region row and the cost summary.
  await comparable.page.getByText('$0.1096/h', { exact: true }).first().waitFor();
  assert.equal(await comparable.page.getByText('$0.1096/h', { exact: true }).count(), 2);
  await comparable.page.getByText('Dedicated IP and 26 GB of storage', { exact: true }).waitFor();
  await comparable.page.getByRole('button', { name: 'Price details', exact: true }).click();
  await comparable.page.getByText('Compute only', { exact: true }).waitFor();
  await comparable.page.getByText('Storage, 26 GB', { exact: true }).waitFor();
  await comparable.page.getByText('$0.006/h', { exact: true }).waitFor();
  await comparable.page.getByText('$0.10 per GB-month', { exact: true }).waitFor();
  // The existing browser's own rates use its actual 20 GB volume.
  await comparable.page.goto(`${origin}/browsers/${instance.id}/usage`);
  await comparable.page.getByText('$0.1109/h', { exact: true }).waitFor();
  await comparable.page.getByText('Computer, dedicated IP and 36 GB of storage', { exact: true }).waitFor();
  await comparable.page.getByText('Now', { exact: true }).waitFor();
  await finish(comparable, 'new-browser quotes share one all-in estimate while actual 20 GB usage is explicitly distinguished from the 10 GB default and compute-only component');

  for (const mode of ['prepaid', 'pilot']) {
    const locked = await fixture({ mode, balanceMicros: 2_000_000, reservedMicros: 2_000_000, availableMicros: 0, status: 'running' });
    await locked.page.goto(`${origin}/billing`);
    const tile = (label) => locked.page.locator('dl > div', { has: locked.page.getByText(label, { exact: true }) });
    await locked.page.getByRole('heading', { name: 'Total balance', exact: true }).waitFor();
    await tile('Held amount').getByText('$2.00', { exact: true }).waitFor();
    await tile('Available amount').getByText('$0.00', { exact: true }).waitFor();
    assert.equal(await locked.page.getByText('Free pilot', { exact: true }).count(), 0);
    await locked.page.goto(`${origin}/browsers`);
    await locked.page.getByText(/positive available balance is required/).waitFor();
    assert.equal(await locked.page.getByRole('button', { name: 'Open', exact: true }).isDisabled(), true);
    await locked.page.goto(`${origin}/browsers/new`);
    await locked.page.getByText(/Needs .* of available credit/).waitFor();
    assert.equal(await locked.page.getByRole('button', { name: 'Create browser', exact: true }).isDisabled(), true);
    await locked.page.goto(`${origin}/browsers/${instance.id}/storage`);
    await locked.page.getByText(/positive available balance is required/).waitFor();
    assert.equal(await locked.page.getByRole('button', { name: 'Add storage', exact: true }).isDisabled(), true);
    assert.equal(locked.state.requests.length, 0);
    await finish(locked, `${mode} mode never treats reserved credit or zero available credit as spendable balance`);
  }

  const freeCreate = await fixture({ balanceMicros: 0, trialEligible: true });
  await freeCreate.page.goto(`${origin}/browsers/new`);
  await freeCreate.page.getByText('Free', { exact: true }).first().waitFor();
  // With no credit the trial plan is preselected, and paying as you go stays one click away.
  assert.equal(await freeCreate.page.getByRole('radio', { name: /Free trial/ }).isChecked(), true);
  assert.equal(await freeCreate.page.getByRole('radio', { name: /Pay as you go/ }).isChecked(), false);
  await freeCreate.page.getByRole('button', { name: 'Create browser', exact: true }).click();
  await freeCreate.page.waitForURL('**/browsers');
  assert.equal(freeCreate.state.requests[0].body.trial, true);
  assert.equal(freeCreate.state.requests[0].body.storageGb, 2);
  await finish(freeCreate, 'zero credit allows only the explicitly selected free trial with its own 2 GB storage quote');

  for (const trialSeconds of [600, 0]) {
    const trialAccess = await fixture({ trial: true, trialSeconds });
    await trialAccess.page.goto(`${origin}/browsers/${instance.id}/usage`);
    await trialAccess.page.getByText('This trial is free. Paid hourly rates apply only after you add credit and keep the browser.', { exact: true }).waitFor();
    assert.equal(await trialAccess.page.getByRole('button', { name: 'Wake & open', exact: true }).isDisabled(), trialSeconds === 0);
    assert.equal(await trialAccess.page.getByText(/Compute only:/).count(), 0, 'Free trial must not look like a current paid hourly charge');
    await finish(trialAccess, trialSeconds > 0 ? 'remaining trial minutes are the only zero-credit access exception' : 'exhausted trial is blocked at zero credit');
  }

  for (const options of [{}, { legacySnapshots: true }, { legacySnapshots: true, balanceMicros: 0 }]) {
    const removed = await fixture(options);
    for (const path of [`/browsers/${instance.id}/storage`, `/browsers/${instance.id}/settings`, '/browsers/new', '/billing']) {
      await removed.page.goto(`${origin}${path}`);
      await removed.page.getByText(path.endsWith('/storage') ? 'Data volume: 10 GB' : path.endsWith('/settings') ? 'Name' : path.endsWith('/new') ? 'Create browser' : 'Billing & usage', { exact: true }).first().waitFor();
      assert.equal(await removed.page.getByText(/snapshot|backup|profile archive/i).count(), 0, 'Snapshot UI must be removed, including for old enabled browsers');
      assert.equal(await removed.page.getByRole('button', { name: 'Restore', exact: true }).count(), 0);
    }
    assert.equal(removed.state.requests.length, 0);
    await finish(removed, options.legacySnapshots
      ? `legacy snapshot data exposes no feature UI or API requests with ${options.balanceMicros === 0 ? 'zero' : 'funded'} credit`
      : 'storage, settings, create and billing contain no snapshot features, rates or API requests');
  }

  const insufficientGrowth = await fixture({ availableMicros: 1_000_001 });
  await insufficientGrowth.page.goto(`${origin}/browsers/${instance.id}/storage`);
  await insufficientGrowth.page.getByLabel('New size (GB)', { exact: true }).fill('100');
  await insufficientGrowth.page.getByText(/Also holds .* for seven days of disk retention/).first().waitFor();
  assert.equal(await insufficientGrowth.page.getByRole('button', { name: 'Add storage', exact: true }).isDisabled(), true);
  assert.equal(insufficientGrowth.state.requests.length, 0);
  await finish(insufficientGrowth, 'storage growth requires available credit for both the minimum balance and additional seven-day reserve');

  const growth = await fixture({ status: 'running', rootVolumeGb: 20 });
  await growth.page.goto(`${origin}/browsers/${instance.id}/storage`);
  await growth.page.getByText('Plus a 20 GB system disk (OS and browser), included in the storage charge.', { exact: true }).waitFor();
  await growth.page.getByLabel('New size (GB)', { exact: true }).fill('35');
  assert.equal(growth.state.requests.length, 0);
  await growth.page.getByRole('button', { name: 'Add storage', exact: true }).click();
  const growthDialog = growth.page.getByRole('dialog');
  await growthDialog.getByText(/From 10 GB to 35 GB: about \$5.50\/month instead of \$3.00/).waitFor();
  assert.equal(growth.state.requests.length, 0, 'Opening a quote must not resize or charge');
  await growthDialog.getByRole('button', { name: 'Add storage', exact: true }).click();
  await growthDialog.waitFor({ state: 'hidden' });
  assert.deepEqual(growth.state.requests.map(({ method, path, body }) => ({ method, path, body })), [{ method: 'POST', path: `/api/v1/instances/${instance.id}/storage`, body: { sizeGb: 35, priceVersion: 'quote-1' } }]);
  await finish(growth, 'a running browser grows to the explicitly confirmed capacity with actual system-disk pricing and the current quote');

  const busyStop = await fixture({ status: 'starting', busy: true, balanceMicros: 0 });
  await busyStop.page.goto(`${origin}/browsers`);
  await busyStop.page.getByRole('button', { name: 'More actions', exact: true }).click();
  const stopped = busyStop.page.waitForResponse((response) => response.request().method() === 'POST');
  await busyStop.page.getByRole('menuitem', { name: 'Sleep now', exact: true }).click();
  await stopped;
  assert.equal(busyStop.state.requests[0].path, `/api/v1/instances/${instance.id}/stop`);
  await finish(busyStop, 'a busy starting browser can always be stopped even with zero available balance');

  console.log(JSON.stringify({ result: 'passed', checks: results, productionRequests: 0 }, null, 2));
} finally {
  await browser.close();
}
