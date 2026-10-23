// Screenshots of the main pages at desktop, tablet and phone widths, every request fulfilled
// locally (no production requests). Build apps/web, then: SHOT_DIR=/tmp/shots node apps/web/e2e/shots.mjs
// Also fails if any page overflows horizontally or throws.
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
const playwright = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox'] });
const origin = 'https://nevazu.com';
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const month = new Date().toISOString().slice(0, 7);
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const rates = (c) => ({ compute: c, ip: 6_000, storage: 100_000, snapshot: 50_000, transfer: 100_000 });
const REGIONS = [
  ['ap-northeast-1', 'Tokyo', 'JP', 'asia_pacific', 'available', 40],
  ['ap-southeast-1', 'Singapore', 'SG', 'asia_pacific', 'available', 70],
  ['syd1', 'Sydney', 'AU', 'asia_pacific', 'available', 120],
  ['ap-east-1', 'Hong Kong', 'HK', 'asia_pacific', 'limited', 30],
  ['ap-south-1', 'Mumbai', 'IN', 'asia_pacific', 'unavailable', 150],
  ['eu-central-1', 'Frankfurt', 'DE', 'europe', 'available', 210],
  ['eu-west-2', 'London', 'GB', 'europe', 'unavailable', 220],
  ['us-west-2', 'Oregon', 'US', 'north_america', 'available', 110],
  ['us-east-1', 'Virginia', 'US', 'north_america', 'available', 160],
  ['sa-east-1', 'São Paulo', 'BR', 'south_america', 'unavailable', 300],
];
const regions = REGIONS.map(([id, city, country, area, availability, rtt]) => ({ id, name: `AWS ${city}`, country, city, timezone: 'UTC', enabled: true,
  acceptingNew: availability !== 'unavailable', probeUrl: null, area, availability, availabilityReason: availability === 'unavailable' ? 'no_stock' : null, estimatedRttMs: rtt, launchVerifiedAt: '2026-10-01T00:00:00Z' }));
const pricing = REGIONS.map(([id], n) => ({ regionId: id, available: true, source: 'aws-price-list', updatedAt: new Date().toISOString(), rates: rates(90_000 + n * 7_000),
  rootVolumeGb: 16, machine: { vcpu: 2, memoryGb: 4 }, defaultStorageGb: 10, maxStorageGb: 100, version: 'q1' }));
const base = { desiredState: 'running', idleTimeoutS: 600, screen: 'auto', videoQuality: 'full', videoAuto: true, dedicatedSince: null, lastIpCheck: null,
  createdAt: ago(5000), deletedAt: null, purgeAfter: null, currentOperation: null, storageGb: 10, stopReason: null, deletesAt: null, statusReason: null };
const instances = [
  { ...base, id: 'b1', name: 'Shop admin — Tokyo', regionId: 'ap-northeast-1', status: 'running', ipAddress: '203.0.113.24', lastActiveAt: ago(2) },
  { ...base, id: 'b2', name: 'Research', regionId: 'us-west-2', status: 'sleeping', ipAddress: '198.51.100.7', lastActiveAt: ago(300) },
  { ...base, id: 'b3', name: 'Ads account EU', regionId: 'eu-central-1', status: 'sleeping', ipAddress: '192.0.2.88', lastActiveAt: ago(3000) },
  { ...base, id: 'b4', name: 'Research browser', regionId: 'syd1', status: 'running', ipAddress: '192.0.2.10', lastActiveAt: ago(1), storageGb: 10 },
  { ...base, id: 'b5', name: 'Social SG', regionId: 'ap-southeast-1', status: 'starting', ipAddress: '203.0.113.90', lastActiveAt: ago(30), currentOperation: { id: 'o', kind: 'start', status: 'running' } },
];
const promotions = [
  { id: 'first-browser-20-minutes', title: { en: 'Use your first browser for 20 minutes', 'zh-CN': '使用你的第一个浏览器 20 分钟' }, description: { en: 'Create a browser and use it for a total of 20 minutes, in one go or over several sessions. $5 of credit is added to your balance as soon as you finish.', 'zh-CN': '创建一个浏览器，累计使用满 20 分钟（可一次用完，也可分多次）。完成后，$5 额度会立即加入你的余额。' },
    actionUrl: '/browsers/new', criterion: 'browser_used_minutes', target: 20, progress: 12, rewardMicros: 5_000_000, status: 'pending', needsTopup: false, completedAt: null, endsAt: null },
  { id: 'two-factor', title: { en: 'Turn on two-step verification', 'zh-CN': '开启两步验证' }, description: { en: 'Protect your account with an authenticator app.', 'zh-CN': '用验证器应用保护你的账户。' },
    actionUrl: '/account', criterion: 'two_factor_enabled', target: 1, progress: 1, rewardMicros: 1_000_000, status: 'completed', needsTopup: false, completedAt: ago(2000), endsAt: null },
];
const publicPricing = {
  regions: REGIONS.map(([id, city, country, area, availability], n) => ({ ...pricing[n], name: `AWS ${city}`, city, country, area, availability, acceptingNew: availability !== 'unavailable', available: availability !== 'unavailable', cost: rates(40_000) })),
  model: { computeMarkupPercent: 220, fixedMarkupPercent: 150, transferMarkupPercent: 150, relayGbMicros: 50_000, billTransitions: true },
  minBalanceMicros: 1_000_000, retentionDays: 7, signupCreditMicros: 2_000_000,
};

async function shoot({ path, name, width, height = 900, signedIn = true, locale = 'en-US', theme = 'light', empty = false, action }) {
  const context = await browser.newContext({ viewport: { width, height }, locale, colorScheme: theme, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) {
      const p = url.pathname;
      let body;
      if (p === '/api/v1/me') {
        if (!signedIn) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'unauthenticated', title: 'x', status: 401 }) });
        body = { user: { id: 'u', name: 'Ada', email: 'ada@example.com' }, entitlements: { billing: 'prepaid', maxBrowsers: 10, maxRunning: 10, idleTimeoutMaxS: 3600, maxStorageGb: 100, neverSleep: true }, usage: { browsers: empty ? 0 : instances.length, running: 3 } };
      } else if (p === '/api/v1/regions') body = regions;
      else if (p === '/api/v1/pricing') body = pricing;
      else if (p === '/api/public/pricing') body = publicPricing;
      else if (p === '/api/public/status') body = { status: 'operational', checkedAt: new Date().toISOString(), components: [], regions: [], creationPaused: false };
      else if (p === '/api/v1/billing') body = { mode: 'prepaid', enabled: true, provider: 'stripe', receipts: ['stripe'], balanceMicros: 42_500_000, reservedMicros: 3_100_000, availableMicros: 39_400_000, retentionDays: 7, exhaustedAt: null, dataKeptUntil: null, frozen: false,
        minBalanceMicros: 1_000_000, lowBalanceMicros: 2_000_000, burnHourMicros: 310_000, topUps: [], month: { totalMicros: 18_420_000, byItem: { compute: 12_000_000, ip: 3_000_000, storage: 2_000_000, snapshot: 0, transfer: 1_420_000 }, month },
        fundedUntil: new Date(Date.now() + 127 * 3_600_000).toISOString(), retained: [], restoreNeededMicros: null };
      else if (p === '/api/v1/instances') body = empty ? [] : instances;
      else if (p.startsWith('/api/v1/instances/') && p.split('/').length === 5) body = instances.find((i) => i.id === p.split('/')[4]);
      else if (p === '/api/v1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      else if (p === '/api/v1/usage') body = { totalMicros: 0, byItem: {}, month, byBrowser: [], byDay: [] };
      else if (p === '/api/v1/promotions') body = empty ? [] : promotions;
      else body = [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    let file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = resolve(dist, 'index.html');
    return route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto(`${origin}${path}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  if (action) await action(page);
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: !!process.env.FULL });
  await context.close();
  assert.deepEqual(errors, [], `${name}: page errors`);
  assert.equal(overflow, false, `${name}: horizontal overflow`);
  console.log(`${name}: ok (page height ${scrollHeight}px)`);
}

const only = process.env.ONLY;
const jobs = [
  { name: 'home-desktop', path: '/', width: 1440, signedIn: false },
  { name: 'home-desktop-dark', path: '/', width: 1440, signedIn: false, theme: 'dark' },
  { name: 'home-phone', path: '/', width: 390, height: 844, signedIn: false },
  { name: 'home-tablet', path: '/', width: 820, height: 1180, signedIn: false, locale: 'zh-CN' },
  { name: 'lang-menu', path: '/', width: 1440, signedIn: false, action: (p) => p.getByRole('button', { name: 'Language' }).first().click() },
  { name: 'pricing-desktop', path: '/pricing', width: 1440, signedIn: false, action: (p) => p.getByText('Estimate your month').scrollIntoViewIfNeeded() },
  { name: 'pricing-regions', path: '/pricing', width: 1440, signedIn: false, action: (p) => p.getByRole('button', { name: /Tokyo/ }).first().click() },
  { name: 'pricing-phone', path: '/pricing', width: 390, height: 844, signedIn: false, action: (p) => p.getByText('Estimate your month').scrollIntoViewIfNeeded() },
  { name: 'browsers-desktop', path: '/browsers', width: 1440 },
  { name: 'browsers-desktop-dark', path: '/browsers', width: 1440, theme: 'dark' },
  { name: 'browsers-list', path: '/browsers', width: 1440, action: (p) => p.getByRole('radio', { name: 'List' }).click() },
  { name: 'browsers-tablet', path: '/browsers', width: 820, height: 1180 },
  { name: 'browsers-phone', path: '/browsers', width: 390, height: 844, locale: 'zh-CN' },
  { name: 'browsers-empty', path: '/browsers', width: 1440, empty: true },
  { name: 'create-desktop', path: '/browsers/new', width: 1440 },
  { name: 'create-cost-open', path: '/browsers/new', width: 1440, action: (p) => p.getByRole('button', { name: /Show cost/ }).click() },
  { name: 'create-phone', path: '/browsers/new', width: 390, height: 844 },
  { name: 'billing-desktop', path: '/billing', width: 1440 },
  { name: 'billing-phone', path: '/billing', width: 390, height: 844 },
  { name: 'account-desktop', path: '/account', width: 1440 },
  { name: 'promotions-desktop', path: '/promotions', width: 1440 },
  { name: 'promotions-desktop-dark', path: '/promotions', width: 1440, theme: 'dark', locale: 'zh-CN' },
  { name: 'promotions-phone', path: '/promotions', width: 390, height: 844 },
  { name: 'promotions-empty', path: '/promotions', width: 1440, empty: true },
  { name: 'settings-desktop', path: '/browsers/b1/settings', width: 1440 },
  { name: 'settings-phone', path: '/browsers/b1/settings', width: 390, height: 844 },
  { name: 'sidebar-collapsed', path: '/browsers', width: 1440, action: (p) => p.getByRole('button', { name: 'Collapse sidebar' }).click() },
  { name: 'sidebar-wide', path: '/browsers', width: 1440, action: async (p) => { const h = p.getByRole('separator').first(); const b = await h.boundingBox(); await p.mouse.move(b.x + 5, b.y + 300); await p.mouse.down(); await p.mouse.move(b.x + 120, b.y + 300, { steps: 5 }); await p.mouse.up(); } },
  { name: 'signin-desktop', path: '/sign-in', width: 1440, signedIn: false },
];
for (const job of jobs) if (!only || job.name.includes(only)) await shoot(job);
await browser.close();
