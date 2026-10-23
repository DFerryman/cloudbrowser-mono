// Who drives the live view while a coding agent is paired: an outline around the picture (orange
// while the agent may act, blue once the user took over), a short closable notice when that
// changes, and the toolbar button whose menu hands control back. Nothing covers the page itself.
// Uses the real web build with entirely local API/WebSocket/WebRTC fixtures; never opens a VM.
// Build apps/web, then: node apps/web/e2e/session-agent-control.mjs   (WEB_DIST, PLAYWRIGHT_PATH, SHOTS_DIR optional)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.WEB_DIST ?? resolve(here, '../dist'));
const shots = process.env.SHOTS_DIR;
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
/** The remote screen's test pattern: a mid grey, so an orange or blue edge stands out from it. */
const PICTURE = [128, 128, 128];
const results = [];
const instance = {
  id: 'i1', name: 'Fixture browser', regionId: 'syd1', status: 'running', desiredState: 'running',
  idleTimeoutS: 600, screen: 'auto', ipAddress: '192.0.2.1', createdAt: new Date().toISOString(),
  lastIpCheck: { ok: true }, lastActiveAt: new Date().toISOString(), currentOperation: null, agentAccess: true, agentControl: 'agent',
};

async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', colorScheme: 'dark' });
  await context.addInitScript((picture) => {
    window.fixture = { socket: null };
    // Playwright's headless Chromium decodes no H.264; the fixture's video is a canvas, so advertise it.
    const capabilities = RTCRtpReceiver.getCapabilities?.bind(RTCRtpReceiver);
    if (capabilities) RTCRtpReceiver.getCapabilities = (kind) => {
      const c = capabilities(kind);
      return kind === 'video' && c ? { ...c, codecs: [...c.codecs, { mimeType: 'video/H264', clockRate: 90000 }] } : c;
    };
    window.WebSocket = class {
      readyState = 1;
      bufferedAmount = 0;
      constructor(url) {
        this.url = url;
        window.fixture.socket = this;
        queueMicrotask(() => this.push({ t: 'neko', data: { event: 'system/init', payload: { screen_size: { width: 1280, height: 720, rate: 30 } } } }));
      }
      send(raw) {
        const { t, data } = JSON.parse(raw);
        if (t === 'neko' && data.event === 'signal/request') {
          queueMicrotask(() => this.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'fixture', iceservers: [] } } }));
        }
      }
      push(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
    window.RTCPeerConnection = class {
      connectionState = 'new';
      async setRemoteDescription() {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const g = canvas.getContext('2d');
        const draw = () => { g.fillStyle = `rgb(${picture.join(',')})`; g.fillRect(0, 0, 1280, 720); };
        draw();
        setInterval(draw, 50);
        const stream = canvas.captureStream(20);
        setTimeout(() => this.ontrack?.({ track: stream.getVideoTracks()[0], streams: [stream] }));
      }
      async createAnswer() { return { type: 'answer', sdp: 'fixture' }; }
      async setLocalDescription() {
        setTimeout(() => { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }, 10);
      }
      async addIceCandidate() {}
      async getStats() { return new Map(); }
      close() { this.connectionState = 'closed'; }
    };
  }, PICTURE);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  const controlRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, origin, 'All fixture requests must remain local');
    if (url.pathname.startsWith('/api/')) {
      let body;
      if (url.pathname === '/api/v1/me') body = { user: { id: 'u1', name: 'Fixture', email: 'fixture@example.test' }, entitlements: {}, usage: {} };
      else if (url.pathname === '/api/v1/instances/i1' && req.method() === 'GET') body = instance;
      else if (url.pathname === '/api/v1/instances/i1/automation/control' && req.method() === 'POST') {
        controlRequests.push(JSON.parse(req.postData() ?? '{}'));
        body = instance;
      }
      else if (url.pathname === '/api/v1/instances/i1/sessions') body = { session: { id: 's1', instanceId: 'i1', startedAt: new Date().toISOString(), endedAt: null }, operationId: null };
      else if (url.pathname.endsWith('/heartbeat')) body = { sleepAt: new Date(Date.now() + 600_000).toISOString(), reason: 'idle' };
      else if (url.pathname.endsWith('/connect')) body = { mode: 'webrtc', gatewayUrl: 'wss://nevazu.com/local-fixture', token: 'token1', iceServers: [] };
      else if (url.pathname.endsWith('/end') || url.pathname.endsWith('/diagnostics')) return route.fulfill({ status: 204 });
      else if (url.pathname === '/api/v1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': local fixture\n\n' });
      else if (url.pathname === '/api/v1/regions') body = [{
        id: 'syd1', name: 'AWS Sydney', country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney', enabled: true, acceptingNew: true,
        probeUrl: null, area: 'asia_pacific', availability: 'available', availabilityReason: null, launchVerifiedAt: null, estimatedRttMs: null,
      }];
      else return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ type: 'not_found', title: 'Not found', status: 404 }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    let file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = resolve(dist, 'index.html');
    return route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto(`${origin}/b/i1`);
  await page.getByRole('button', { name: 'More', exact: true }).waitFor();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && v.readyState >= 2 && v.videoWidth > 0; });
  return { context, page, errors, controlRequests };
}

/** The gateway reporting the agent's connection and who controls the browser. */
const report = (page, control, connected = true) =>
  page.evaluate(({ control, connected }) => window.fixture.socket.push({ t: 'automation_status', connected, control }), { control, connected });

/** The color painted at a point (a 1×1 CSS-pixel screenshot: one PNG pixel). */
async function paintedAt(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 }, scale: 'css', animations: 'disabled' });
  const idat = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return [...inflateSync(Buffer.concat(idat)).subarray(1, 4)];
}

/** The picture's left edge, its center, and the page under the notice's row stay as they were. */
async function edgeAndCenter(page) {
  const box = await page.locator('video').boundingBox();
  const edge = await paintedAt(page, box.x + 1, box.y + box.height / 2);
  const center = await paintedAt(page, box.x + box.width / 2, box.y + box.height / 2);
  return { edge, center };
}

const near = (color, expected, tolerance = 12) => color.every((c, i) => Math.abs(c - expected[i]) <= tolerance);
const isOrange = ([r, g, b]) => r > 200 && g > 70 && g < 170 && b < 90;
const isBlue = ([r, g, b]) => b > 200 && r < 120 && b - r > 100;

async function shot(page, name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

try {
  const { context, page, errors, controlRequests } = await fixture();
  const frame = page.getByTestId('agent-frame');
  const notice = page.getByTestId('agent-notice');

  assert.equal(await frame.count(), 0, 'no outline without an agent');
  assert.equal(await page.getByTestId('agent-control').count(), 0, 'no agent button without an agent');
  results.push('no agent: no outline and no agent button');

  await report(page, { controller: 'agent', mode: 'agent', epoch: 1 });
  await frame.and(page.locator('[data-control="agent"]')).waitFor();
  await notice.getByText('A coding agent is driving this browser').waitFor();
  await page.waitForTimeout(400); // the outline's colour transition
  await shot(page, 'agent-driving');
  let { edge, center } = await edgeAndCenter(page);
  assert.ok(isOrange(edge), `the agent's outline is orange, got rgb(${edge})`);
  assert.ok(near(center, PICTURE), `the picture's center is untouched, got rgb(${center})`);
  const noticeBox = await notice.boundingBox();
  const videoBox = await page.locator('video').boundingBox();
  assert.ok(noticeBox.height < 40 && noticeBox.width < videoBox.width * 0.7, 'the notice is small');
  results.push('agent acting: orange outline, a small notice, the page uncovered');

  await report(page, { controller: 'user', mode: 'user', epoch: 2 });
  await frame.and(page.locator('[data-control="user"]')).waitFor();
  await notice.getByText('You have control; the coding agent is paused.').waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'user-control');
  ({ edge, center } = await edgeAndCenter(page));
  assert.ok(isBlue(edge), `the user's outline is blue, got rgb(${edge})`);
  assert.ok(near(center, PICTURE), `the picture's center is untouched, got rgb(${center})`);
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await notice.waitFor({ state: 'detached' });
  assert.equal(await frame.getAttribute('data-control'), 'user', 'the outline stays after the notice is closed');
  results.push('user took over: blue outline; the notice closes on its button and the outline stays');

  await page.getByTestId('agent-control').click();
  await page.getByRole('menuitem', { name: 'Hand control back' }).click();
  await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
  assert.deepEqual(controlRequests, [{ mode: 'agent' }]);
  results.push('the agent button’s menu hands control back');

  await report(page, { controller: 'none', mode: 'agent', epoch: 3 });
  await frame.and(page.locator('[data-control="agent"]')).waitFor();
  await notice.waitFor();
  await page.waitForTimeout(5_500);
  assert.equal(await notice.count(), 0, 'the notice closes by itself');
  assert.equal(await frame.getAttribute('data-control'), 'agent');
  results.push('handed back: orange again, and the notice closes by itself');

  await report(page, { controller: 'user', mode: 'user', epoch: 4 }, false);
  await frame.and(page.locator('[data-control="user"]')).waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'paused-agent-gone');
  results.push('the agent left while paused: blue outline until control is handed back');

  assert.deepEqual(errors, []);
  await context.close();
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  await browser.close();
}
