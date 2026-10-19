// Uses the real web build with entirely local API/WebSocket fixtures; never opens a VM.
// Build apps/web, then: node apps/web/e2e/session-reconnect.mjs
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
const problem = (status, detail) => ({ status, contentType: 'application/problem+json', body: JSON.stringify({ type: 'invalid_state', title: detail, detail, status }) });

async function fixture({ holdHeartbeat = false, heartbeatDenied = false, holdConnect = false, holdOpen = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 1024 }, locale: 'en-US' });
  await context.addInitScript(() => {
    window.fixtureSockets = [];
    window.WebSocket = class {
      readyState = 1;
      bufferedAmount = 0;
      constructor(url) {
        this.url = url;
        window.fixtureSockets.push(this);
        queueMicrotask(() => this.push({ t: 'agent_offline' }));
      }
      send() {}
      push(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  const page = await context.newPage();
  if (holdConnect || holdOpen) await page.clock.install();
  page.setDefaultTimeout(10_000);
  const state = { opens: 0, openKeys: [], connects: 0, heldHeartbeat: null, heldConnect: null, heldOpen: null, denyConnect: false, errors: [] };
  let connectHeld;
  const heldConnectReady = new Promise((resolve) => { connectHeld = resolve; });
  let openHeld;
  const heldOpenReady = new Promise((resolve) => { openHeld = resolve; });
  page.on('pageerror', (error) => state.errors.push(error.message));
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, origin, 'All fixture requests must remain local');
    if (url.pathname.startsWith('/api/')) {
      let body;
      if (url.pathname === '/api/v1/me') body = { user: { id: 'u1', name: 'Fixture', email: 'fixture@example.test' }, entitlements: {}, usage: {} };
      else if (url.pathname === '/api/v1/instances/i1' && req.method() === 'GET') body = {
        id: 'i1', name: 'Fixture browser', regionId: 'syd1', status: 'running', desiredState: 'running',
        idleTimeoutS: 600, screen: 'auto', ipAddress: '192.0.2.1', createdAt: new Date().toISOString(),
        lastIpCheck: { ok: true }, lastActiveAt: new Date().toISOString(), currentOperation: null,
      };
      else if (url.pathname === '/api/v1/instances/i1/sessions') {
        state.opens++;
        state.openKeys.push(req.headers()['idempotency-key']);
        if (holdOpen && state.opens === 1) { state.heldOpen = route; openHeld(); return; }
        body = { session: { id: `s${state.opens}`, instanceId: 'i1', startedAt: new Date().toISOString(), endedAt: null }, operationId: null };
      } else if (url.pathname.endsWith('/heartbeat')) {
        if (holdHeartbeat && url.pathname.includes('/s1/')) { state.heldHeartbeat = route; return; }
        if (heartbeatDenied) return route.fulfill(problem(402, 'Available credit is required for this browser.'));
        body = { sleepAt: new Date(Date.now() + 600_000).toISOString(), reason: 'idle' };
      } else if (url.pathname.endsWith('/connect')) {
        state.connects++;
        if (holdConnect && state.connects === 2) { state.heldConnect = route; connectHeld(); return; }
        if (state.denyConnect) return route.fulfill(problem(403, 'The browser connection is currently denied.'));
        body = { mode: 'webrtc', gatewayUrl: 'wss://nevazu.com/local-fixture', token: `token${state.connects}`, iceServers: [] };
      } else if (url.pathname.endsWith('/end')) return route.fulfill({ status: 204 });
      else if (url.pathname === '/api/v1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': local fixture\n\n' });
      else if (url.pathname === '/api/v1/regions') body = [{
        id: 'syd1', name: 'AWS Sydney', country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney', enabled: true, acceptingNew: true,
        probeUrl: null, area: 'asia_pacific', availability: 'available', availabilityReason: null, launchVerifiedAt: null, estimatedRttMs: null,
      }];
      else throw new Error(`Unhandled fixture API: ${req.method()} ${url.pathname}`);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    let file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = resolve(dist, 'index.html');
    return route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto(`${origin}/b/i1`);
  return { context, page, state, heldConnectReady, heldOpenReady };
}

async function finish(f, name) {
  assert.deepEqual(f.state.errors, []);
  results.push(name);
  await f.context.close();
}

try {
  const oldHeartbeat = await fixture({ holdHeartbeat: true });
  await oldHeartbeat.page.waitForFunction(() => window.fixtureSockets.length === 1);
  await oldHeartbeat.page.evaluate(() => window.fixtureSockets[0].push({ t: 'taken_over' }));
  await oldHeartbeat.page.getByRole('button', { name: 'Use here', exact: true }).click();
  await oldHeartbeat.page.waitForFunction(() => window.fixtureSockets.length === 2);
  assert.equal(oldHeartbeat.state.opens, 2);
  assert.ok(oldHeartbeat.state.openKeys[0]);
  assert.notEqual(oldHeartbeat.state.openKeys[0], oldHeartbeat.state.openKeys[1], 'an explicit Use here is a new open intent');
  assert.ok(oldHeartbeat.state.heldHeartbeat);
  await oldHeartbeat.state.heldHeartbeat.fulfill(problem(409, 'The old session ended.'));
  await oldHeartbeat.page.waitForTimeout(100);
  assert.equal(await oldHeartbeat.page.getByRole('button', { name: 'Use here', exact: true }).count(), 0);
  await finish(oldHeartbeat, 'late 409 from an old session cannot take over the replacement session');

  const deniedHeartbeat = await fixture({ heartbeatDenied: true });
  await deniedHeartbeat.page.getByText('Available credit is required for this browser.', { exact: true }).waitFor();
  await finish(deniedHeartbeat, 'a running browser shows the actual heartbeat payment rejection');

  const deniedReconnect = await fixture();
  await deniedReconnect.page.waitForFunction(() => window.fixtureSockets.length === 1);
  // The page's own token request is handed to the first viewer attempt; no second request is made.
  assert.equal(deniedReconnect.state.connects, 1, 'the first viewer attempt must reuse the prefetched token');
  assert.match(await deniedReconnect.page.evaluate(() => window.fixtureSockets[0].url), /token=token1$/);
  deniedReconnect.state.denyConnect = true;
  await deniedReconnect.page.evaluate(() => window.fixtureSockets[0].close());
  await deniedReconnect.page.getByText('The browser connection is currently denied.', { exact: true }).waitFor();
  assert.equal(deniedReconnect.state.opens, 1, 'transport reconnection must reuse its viewer session');
  await finish(deniedReconnect, 'a transport reconnect exposes its actual authorization error without creating a new session');

  const oldConnect = await fixture({ holdConnect: true });
  // The first attempt uses the prefetched token; a dropped socket makes the viewer ask for a new one.
  await oldConnect.page.waitForFunction(() => window.fixtureSockets.length === 1);
  await oldConnect.page.evaluate(() => window.fixtureSockets[0].close());
  await oldConnect.page.clock.fastForward(1_000);
  await oldConnect.heldConnectReady;
  assert.ok(oldConnect.state.heldConnect);
  // The old session is replaced while its viewer token request is still pending.
  const pendingHeartbeat = oldConnect.context.route('**/api/v1/sessions/s1/heartbeat', (route) => route.fulfill(problem(409, 'The old session ended.')));
  await pendingHeartbeat;
  await oldConnect.page.clock.fastForward(15_000);
  await oldConnect.page.getByRole('button', { name: 'Use here', exact: true }).click();
  await oldConnect.page.waitForFunction(() => window.fixtureSockets.length === 2);
  await oldConnect.state.heldConnect.fulfill(problem(403, 'This stale error must be ignored.'));
  await oldConnect.page.waitForTimeout(100);
  assert.equal(await oldConnect.page.getByText('This stale error must be ignored.', { exact: true }).count(), 0);
  await finish(oldConnect, 'late token failure from a replaced session cannot overwrite the current session');

  const stalledOpen = await fixture({ holdOpen: true });
  await stalledOpen.heldOpenReady;
  await stalledOpen.page.clock.fastForward(20_000);
  await stalledOpen.page.getByText('The browser connection request timed out. Please retry.', { exact: true }).waitFor();
  await stalledOpen.page.getByRole('button', { name: 'Retry', exact: true }).click();
  await stalledOpen.page.waitForFunction(() => window.fixtureSockets.length === 1);
  assert.equal(stalledOpen.state.opens, 2, 'an aborted open must release the single-flight request for an explicit retry');
  assert.ok(stalledOpen.state.openKeys[0]);
  assert.equal(stalledOpen.state.openKeys[0], stalledOpen.state.openKeys[1], 'a timeout retry must reuse the same open intent');
  await finish(stalledOpen, 'stalled session creation times out visibly and its Retry can create a fresh request');

  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  await browser.close();
}
