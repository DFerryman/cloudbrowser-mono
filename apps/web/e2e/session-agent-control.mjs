// Who drives the live view while a coding agent is paired: an outline around the picture (green
// while the agent may act, blue once the user took over, both at 3:1 or more against a white and a
// black page), a short closable notice when that changes, and the toolbar button whose menu hands
// control back. When the agent asks for control while the user holds it, a speech bubble points at
// that button, which then hands control back in one tap. Nothing covers the page itself otherwise.
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
/** The remote screen's test pattern: a mid grey, so a green or blue edge stands out from it. */
const PICTURE = [128, 128, 128];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const results = [];
const instance = {
  id: 'i1', name: 'Fixture browser', regionId: 'syd1', status: 'running', desiredState: 'running',
  idleTimeoutS: 600, screen: 'auto', ipAddress: '192.0.2.1', createdAt: new Date().toISOString(),
  lastIpCheck: { ok: true }, lastActiveAt: new Date().toISOString(), currentOperation: null, agentAccess: true, agentControl: 'agent',
};

async function fixture({ phone = false, colorScheme = 'dark' } = {}) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US', colorScheme }
    : { viewport: { width: 1280, height: 800 }, locale: 'en-US', colorScheme });
  await context.addInitScript((picture) => {
    window.fixture = { socket: null, picture };
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
        const draw = () => { g.fillStyle = `rgb(${window.fixture.picture.join(',')})`; g.fillRect(0, 0, 1280, 720); };
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
  /** Holds the hand-back's answer until released, to see the bubble's pending state. */
  let holdControl = null;
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
        if (holdControl) await holdControl;
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
  return { context, page, errors, controlRequests, hold: (promise) => { holdControl = promise; } };
}

/** The gateway reporting the agent's connection, who controls the browser and the agent's ask for control. */
const report = (page, control, connected = true, request = undefined) =>
  page.evaluate(({ control, connected, request }) => window.fixture.socket.push({ t: 'automation_status', connected, control, request }), { control, connected, request });
const paint = (page, color) => page.evaluate((color) => { window.fixture.picture = color; }, color);

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
const isGreen = ([r, g, b]) => g > 120 && g - r > 80 && g - b > 40;
const isBlue = ([r, g, b]) => b > 200 && r < 120 && b - r > 100;
/** WCAG 2 contrast between two sRGB colours. */
const luminance = (rgb) => rgb.map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The outline's colour on a white and on a black page: at least 3:1 against both (WCAG 1.4.11). */
async function outlineContrast(page) {
  const out = {};
  for (const [name, color] of [['white', WHITE], ['black', BLACK]]) {
    await paint(page, color);
    await page.waitForTimeout(150);
    const { edge, center } = await edgeAndCenter(page);
    assert.ok(near(center, color), `the ${name} page shows, got rgb(${center})`);
    out[name] = Number(contrast(edge, color).toFixed(2));
    assert.ok(out[name] >= 3, `the outline has ${out[name]}:1 against a ${name} page, rgb(${edge})`);
  }
  await paint(page, PICTURE);
  await page.waitForTimeout(150);
  return out;
}

/** The bubble's tail points at the robot button: its center within a few pixels of the button's. */
async function pointsAtButton(page) {
  const button = await page.getByTestId('agent-control').boundingBox();
  const tail = await page.getByTestId('agent-request-tail').boundingBox();
  const bubble = await page.getByTestId('agent-request').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(Math.abs((tail.x + tail.width / 2) - (button.x + button.width / 2)) <= 3, `the tail is under the button (${tail.x + tail.width / 2} vs ${button.x + button.width / 2})`);
  assert.ok(bubble.x >= 0 && bubble.x + bubble.width <= viewport.width, 'the bubble stays on screen');
  return { button, bubble };
}

async function shot(page, name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

try {
{
  const { context, page, errors, controlRequests, hold } = await fixture();
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
  assert.ok(isGreen(edge), `the agent's outline is green, got rgb(${edge})`);
  assert.ok(near(center, PICTURE), `the picture's center is untouched, got rgb(${center})`);
  const noticeBox = await notice.boundingBox();
  const videoBox = await page.locator('video').boundingBox();
  assert.ok(noticeBox.height < 40 && noticeBox.width < videoBox.width * 0.7, 'the notice is small');
  const agentContrast = await outlineContrast(page);
  const dot = await page.getByTestId('agent-control').locator('span').last().evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.match(dot, /oklch\(0\.72|rgb\(0, 201/, `the robot's dot is green, got ${dot}`);
  results.push(`agent acting: green outline (${agentContrast.white}:1 on white, ${agentContrast.black}:1 on black), green dot, a small notice, the page uncovered`);

  await report(page, { controller: 'user', mode: 'user', epoch: 2 });
  await frame.and(page.locator('[data-control="user"]')).waitFor();
  await notice.getByText('You have control; the coding agent is paused.').waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'user-control');
  ({ edge, center } = await edgeAndCenter(page));
  assert.ok(isBlue(edge), `the user's outline is blue, got rgb(${edge})`);
  assert.ok(near(center, PICTURE), `the picture's center is untouched, got rgb(${center})`);
  const userContrast = await outlineContrast(page);
  results.push(`user control: blue outline (${userContrast.white}:1 on white, ${userContrast.black}:1 on black)`);
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
  await page.waitForTimeout(400);
  assert.ok(isGreen((await edgeAndCenter(page)).edge), 'green again');
  const idleContrast = await outlineContrast(page);
  results.push(`handed back: green again (waiting agent ${idleContrast.white}:1 on white, ${idleContrast.black}:1 on black), and the notice closes by itself`);

  await report(page, { controller: 'user', mode: 'user', epoch: 4 }, false);
  await frame.and(page.locator('[data-control="user"]')).waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'paused-agent-gone');
  results.push('the agent left while paused: blue outline until control is handed back');

  // The agent asks for control while the user has it.
  const bubble = page.getByTestId('agent-request');
  const robot = page.getByTestId('agent-control');
  const user = { controller: 'user', mode: 'user', epoch: 5 };
  await report(page, user, true, { remainingMs: 30_000 });
  await bubble.getByText('A coding agent is asking for control').waitFor();
  await bubble.getByText('Click the robot icon to hand control back.').waitFor();
  assert.equal(await notice.count(), 0, 'the bubble replaces the notice');
  assert.equal(await bubble.getAttribute('data-side'), 'below');
  const { button, bubble: bubbleBox } = await pointsAtButton(page);
  assert.ok(bubbleBox.y >= button.y + button.height, 'the bubble sits below the toolbar button');
  assert.equal(await robot.getAttribute('aria-label'), 'Hand control back to the coding agent');
  assert.equal(await page.getByRole('status').filter({ hasText: 'A coding agent is asking for control. Click the robot icon' }).count(), 1, 'said once to screen readers');
  assert.equal(await frame.getAttribute('data-control'), 'user', 'the user keeps control while asked');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-testid="agent-request"]')), null, 'the bubble takes no focus');
  await page.waitForTimeout(200);
  await shot(page, 'agent-requests-control');
  results.push('the agent asks: a bubble below the robot button, its tail at the button, copy to click it, announced once');

  let release;
  hold(new Promise((resolve) => { release = resolve; }));
  await robot.click();
  await bubble.getByText('Handing control back…').waitFor();
  assert.ok(await robot.isDisabled(), 'one hand-back at a time');
  await shot(page, 'agent-request-pending');
  release();
  hold(null);
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-control"][disabled]'));
  assert.deepEqual(controlRequests, [{ mode: 'agent' }, { mode: 'agent' }], 'one tap on the robot hands control back');
  await report(page, { controller: 'none', mode: 'agent', epoch: 6 });
  await bubble.waitFor({ state: 'detached' });
  await frame.and(page.locator('[data-control="agent"]')).waitFor();
  results.push('one click on the robot hands control back: "Handing control back…" until the gateway confirms, then the bubble goes');

  await report(page, { controller: 'user', mode: 'user', epoch: 7 }, true, { remainingMs: 30_000 });
  await bubble.waitFor();
  await bubble.getByRole('button', { name: 'Not now' }).click();
  await bubble.waitFor({ state: 'detached' });
  assert.equal(await robot.getAttribute('data-request'), 'asking', 'the robot still says the agent asks');
  const ring = await robot.locator('span').last().evaluate((e) => ({ dot: getComputedStyle(e).backgroundColor, outline: getComputedStyle(e).outlineColor, width: getComputedStyle(e).outlineWidth }));
  assert.match(ring.dot, /oklch\(0\.62|rgb\(43, 127/, `the dot stays blue, got ${ring.dot}`);
  assert.match(ring.outline, /oklch\(0\.72|rgb\(0, 201/, `a green circle around it, got ${ring.outline}`);
  assert.equal(ring.width, '1px');
  await report(page, { controller: 'user', mode: 'user', epoch: 7 }, true, { remainingMs: 25_000 });
  await page.waitForTimeout(200);
  assert.equal(await bubble.count(), 0, '"Not now" holds while the agent keeps asking');
  await robot.click();
  await page.getByRole('menu').getByText('The coding agent is asking for control.').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
  assert.equal(controlRequests.length, 2, 'after "Not now" the robot opens its menu again');
  await shot(page, 'agent-request-dismissed');
  results.push('"Not now" closes the bubble for this ask; the blue dot keeps a green circle and the robot opens its menu again');

  await report(page, { controller: 'user', mode: 'user', epoch: 7 });
  await page.waitForFunction(() => !document.querySelector('[data-request="asking"]'));
  await report(page, { controller: 'user', mode: 'user', epoch: 7 }, true, { remainingMs: 1_000 });
  await bubble.waitFor();
  await bubble.waitFor({ state: 'detached', timeout: 3_000 });
  results.push('a new ask shows the bubble again, and it goes by itself when the agent stops asking');

  assert.deepEqual(errors, []);
  await context.close();
}
{
  // A phone: the bubble keeps to the screen, says tap, and moves above the maximized view's controls.
  const { context, page, errors, controlRequests } = await fixture({ phone: true, colorScheme: 'light' });
  const bubble = page.getByTestId('agent-request');
  await report(page, { controller: 'user', mode: 'user', epoch: 2 }, true, { remainingMs: 30_000 });
  await bubble.getByText('Tap the robot icon to hand control back.').waitFor();
  await pointsAtButton(page);
  await page.waitForTimeout(200);
  await shot(page, 'phone-agent-requests-control');
  await page.getByRole('button', { name: 'Maximize' }).click();
  await page.getByRole('toolbar').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-request"]')?.getAttribute('data-side') === 'above');
  const { button, bubble: box } = await pointsAtButton(page);
  assert.ok(box.y + box.height <= button.y, 'the bubble sits above the maximized controls');
  await page.waitForTimeout(200);
  await shot(page, 'phone-maximized-agent-requests-control');
  await page.getByTestId('agent-control').tap();
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-control"][disabled]'));
  assert.deepEqual(controlRequests, [{ mode: 'agent' }]);
  results.push('phone: the bubble keeps to the screen with "Tap", sits above the maximized controls, and a tap hands control back');
  assert.deepEqual(errors, []);
  await context.close();
}
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  await browser.close();
}
