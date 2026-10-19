// Browser regression against the real web build, with every HTTP request intercepted locally.
// No real Access OTP, application login, email, or production API is used.
// Build apps/web first, then: node apps/web/e2e/admin-access.mjs
// ADMIN_TEST_ORIGIN must match VITE_ADMIN_URL if testing a custom local console host.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.WEB_DIST ?? resolve(here, '../dist'));
const admin = new URL(process.env.ADMIN_TEST_ORIGIN ?? 'https://admin.console.nevazu.com');
const app = new URL(process.env.APP_TEST_ORIGIN ?? 'https://nevazu.com');
const require = createRequire(import.meta.url);
let playwright;
for (const path of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/codex/cua_node/lib/node_modules/playwright'].filter(Boolean)) {
  try { playwright = require(path); break; } catch {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_PATH.');
assert.ok(existsSync(resolve(dist, 'index.html')), 'Build apps/web before running this regression.');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH ??
  (!existsSync(playwright.chromium.executablePath()) && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await playwright.chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const results = [];
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const overview = {
  instances: {}, users: 0, operations: { unfinished: 0, failed24h: 0 }, flags: {}, spend: null,
  quotas: [], findingsOpen: 0, alertsOpen: 0, webhooksPending: 0,
};

async function fixture(mode = 'allowed') {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const requests = [];
  const errors = [];
  const navigations = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), host: url.host, path: url.pathname, navigation: request.isNavigationRequest() && request.resourceType() === 'document', requestedWith: request.headers()['x-requested-with'] });
    if (['unauthenticated', 'redirect'].includes(mode) && url.origin === admin.origin && url.pathname === '/'
      && request.isNavigationRequest() && requests.filter((r) => r.navigation).length > 1) {
      return route.fulfill({ contentType: 'text/html', body: '<h1>Local Access login fixture</h1>' });
    }
    if (url.pathname.startsWith('/cdn-cgi/access/')) {
      return route.fulfill({ contentType: 'text/html', body: `<h1>Local Access ${url.pathname.endsWith('/logout') ? 'logout' : 'login'} fixture</h1>` });
    }
    if (url.pathname.startsWith('/api/')) {
      assert.equal(request.method(), 'GET', `Unexpected API mutation: ${request.method()} ${url.pathname}`);
      let body = [];
      let status = 200;
      if (url.pathname === '/api/v1/admin/session') {
        if (mode === 'redirect') return route.fulfill({ status: 302, headers: { location: admin.href }, body: '' });
        status = mode === 'unauthenticated' ? 401 : mode === 'forbidden' ? 403 : 200;
        body = status === 200 ? { email: 'operator@example.test' } : { type: status === 401 ? 'unauthenticated' : 'forbidden', status };
      } else if (url.pathname === '/api/v1/admin/overview') body = overview;
      else if (url.pathname === '/api/v1/admin/pricing') body = {
        settings: { markupPercent: 120, minBalanceMicros: 1_000_000, lowBalanceMicros: 2_000_000, paymentFeeBps: 0, paymentFeeFixedCents: 0 },
        regions: [], month: { month: '2026-10', revenueMicros: 0, costMicros: 0, grossMarginMicros: 0, byItem: {}, topupMicros: 0, topups: 0,
          refundMicros: 0, creditMicros: 0, estimatedFeesMicros: 0, projectedAwsCents: null }, balances: { totalMicros: 0, negativeMicros: 0 },
      };
      else if (url.pathname === '/api/v1/admin/aws-provider') body = {
        settings: { inventoryMode: 'budget', monthlyBudgetMicros: 200_000_000, estimatedHoursPerDay: 24 },
        state: { accountId: '123456789012', managementAccountId: '210987654321', organizationId: 'o-test',
          connection: { runtimeAuthorization: 'sts-assume-role', automaticSessionRefresh: true, baseCredentialRotation: 'operator-managed' },
          billing: { month: '2026-10', spendMicros: 5_000_000, budgetMicros: 50_000_000, estimated: true, accounts: [], credits: [], auxiliaryErrors: {} },
          billingAt: new Date().toISOString(), catalogAt: new Date().toISOString(), lastError: null },
        regions: [{ regionId: 'eu-central-1', providerRegion: 'eu-central-1', name: 'Europe (Frankfurt)', optInStatus: 'opt-in-not-required', status: 'ready',
          quotas: [{ metric: 'static_ips', used: 1, limit: 5 }], checkedAt: new Date().toISOString(), price: { fetchedAt: new Date().toISOString(), lastError: null },
          inventory: { available: 3, quota_available: 4, monthly_unit_micros: 60_000_000, budget_remaining_micros: 195_000_000, availability: 'ready' } }],
      };
      // The lookalike-host case is an ordinary signed-out app. Every ordinary v1 endpoint is
      // protected, including the billing query mounted alongside /me. Returning an arbitrary
      // 200 [] here produces malformed BillingState data and a race with the /me redirect.
      else if (url.pathname.startsWith('/api/v1/') && !url.pathname.startsWith('/api/v1/admin/')) {
        status = 401;
        body = { type: 'unauthenticated', status };
      }
      else if (url.pathname.startsWith('/api/auth/')) body = null;
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    let file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = resolve(dist, 'index.html');
    return route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  return { context, page, requests, errors, navigations };
}

const noOrdinaryLogin = (f) => {
  assert.equal(f.requests.filter((r) => r.path === '/api/v1/me' || r.path.startsWith('/api/auth/')).length, 0, 'Console must not bootstrap ordinary application authentication');
  assert.ok(f.requests.filter((r) => r.path.startsWith('/api/v1/admin/')).every((r) => r.requestedWith === 'XMLHttpRequest'), 'Admin AJAX requests must identify themselves so expired Access sessions return an error');
};
const verifyErrors = (f) => assert.deepEqual(f.errors, []);
const finish = async (f, name) => { verifyErrors(f); results.push(name); await f.context.close(); };

try {
  const f = await fixture();
  await f.page.goto(admin.origin);
  await f.page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  noOrdinaryLogin(f);
  assert.ok(f.requests.some((r) => r.path === '/api/v1/admin/session'));
  const links = await f.page.locator('nav a').evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, href: node.getAttribute('href') })));
  assert.deepEqual(links.map((link) => link.href), ['/', '/alerts', '/operations', '/browsers', '/users', '/pricing', '/aws-provider', '/ledger', '/findings', '/limits', '/audit']);
  await f.page.getByRole('link', { name: 'Alerts', exact: true }).click();
  await f.page.waitForURL(`${admin.origin}/alerts`);
  await f.page.getByRole('heading', { name: 'Alerts', exact: true }).waitFor();
  assert.ok(f.requests.some((r) => r.path === '/api/v1/admin/alerts'));
  assert.ok(await f.page.locator('a[href="/cdn-cgi/access/logout"]').count(), 'Console exposes an Access logout link');
  noOrdinaryLogin(f);
  await finish(f, 'dedicated host loads Access session and root console navigation without ordinary login');

  const deep = await fixture();
  await deep.page.goto(`${admin.origin}/operations`);
  await deep.page.getByRole('heading', { name: 'Operations', exact: true }).waitFor();
  noOrdinaryLogin(deep);
  await finish(deep, 'dedicated host deep links load the console directly');

  const pricing = await fixture();
  await pricing.page.goto(`${admin.origin}/pricing`);
  await pricing.page.getByRole('heading', { name: 'Pricing & margin', exact: true }).waitFor();
  await pricing.page.getByLabel('Markup (% of AWS cost)', { exact: true }).waitFor();
  noOrdinaryLogin(pricing);
  await finish(pricing, 'pricing deep link stays inside the Access-protected console');

  const provider = await fixture();
  await provider.page.goto(`${admin.origin}/aws-provider`);
  await provider.page.getByRole('heading', { name: 'AWS Provider', exact: true }).waitFor();
  await provider.page.getByText('Europe (Frankfurt)', { exact: false }).first().waitFor();
  assert.equal(await provider.page.getByLabel('Estimated running hours/day').inputValue(), '24');
  assert.equal(await provider.page.getByLabel('Project budget (USD/month)').inputValue(), '200');
  await provider.page.getByText('static_ips: 1 / 5', { exact: true }).waitFor();
  noOrdinaryLogin(provider);
  await finish(provider, 'AWS Provider displays dynamic regions, quota inventory, budget policy and session renewal status');

  for (const [legacy, target] of [
    ['/admin?from=legacy#overview', '/?from=legacy#overview'],
    ['/admin/console/operations?status=failed#row', '/operations?status=failed#row'],
  ]) {
    const old = await fixture();
    await old.page.goto(app.origin + legacy);
    await old.page.waitForURL(admin.origin + target);
    await old.page.getByText('Signed in as operator@example.test', { exact: true }).waitFor();
    assert.equal(old.requests.some((r) => r.host === app.host && r.path.startsWith('/api/v1/admin/')), false);
    noOrdinaryLogin(old);
    await finish(old, `legacy ${legacy.split('?')[0]} redirects to dedicated host with query and fragment`);
  }

  for (const mode of ['unauthenticated', 'redirect']) {
    const expired = await fixture(mode);
    await expired.page.goto(admin.origin);
    const login = expired.page.getByRole('link', { name: 'Sign in with email', exact: true });
    await login.waitFor();
    assert.equal(await login.getAttribute('href'), admin.href, 'Explicit sign-in must navigate to the protected application root');
    await expired.page.locator('a[href="/cdn-cgi/access/logout"]').waitFor();
    assert.equal(expired.requests.some((r) => r.path.startsWith('/cdn-cgi/access/')), false, 'Expired session must not automatically navigate to Access login');
    assert.equal(expired.requests.filter((r) => r.navigation).length, 1, 'Expired session must not automatically reload the page');
    noOrdinaryLogin(expired);
    await login.click();
    await expired.page.getByRole('heading', { name: 'Local Access login fixture' }).waitFor();
    assert.equal(expired.page.url(), admin.href);
    assert.equal(expired.requests.filter((r) => r.navigation).length, 2);
    await finish(expired, `${mode} session presents explicit Access login without a reload loop`);
  }

  const denied = await fixture('forbidden');
  await denied.page.goto(admin.origin);
  await denied.page.getByText(/Access denied\. Your email is not authorized/i).waitFor();
  await denied.page.locator('a[href="/cdn-cgi/access/logout"]').waitFor();
  assert.equal(await denied.page.getByRole('link', { name: 'Sign in with email', exact: true }).count(), 0);
  assert.equal(denied.requests.some((r) => r.path.startsWith('/cdn-cgi/access/')), false);
  assert.equal(denied.requests.filter((r) => r.navigation).length, 1);
  noOrdinaryLogin(denied);
  await finish(denied, 'forbidden session shows access denial without automatic login or reload');

  const wrongHost = await fixture();
  await wrongHost.page.goto(`https://${admin.hostname}.example.test/`);
  await wrongHost.page.waitForURL('**/sign-in?next=*');
  assert.equal(wrongHost.requests.some((r) => r.path.startsWith('/api/v1/admin/')), false, 'Hostname suffix lookalikes must not enter the console');
  assert.ok(wrongHost.requests.some((r) => r.path === '/api/v1/me'));
  await finish(wrongHost, 'only the exact configured admin host enters the console');

  console.log(JSON.stringify({ result: 'passed', checks: results, productionRequests: 0 }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', completedChecks: results }, null, 2));
  throw error;
} finally {
  await browser.close();
}
