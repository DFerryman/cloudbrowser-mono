// The live session's menus on a touch screen (iPad): opening one must never take the picture away.
// Uses the real web build with entirely local API/WebSocket/WebRTC fixtures; never opens a VM.
// Build apps/web, then: node apps/web/e2e/session-touch-menu.mjs   (WEB_DIST, PLAYWRIGHT_PATH optional)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
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
/** The remote screen's test pattern; the page behind the frame is near-black in the dark theme. */
const PICTURE = [0, 200, 120];
const results = [];

async function fixture({ isMobile }) {
  // iPad Safari: touch, a 2× screen, the visible area below the browser's own bars.
  const context = await browser.newContext({
    viewport: { width: 1366, height: 867 }, hasTouch: true, isMobile, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'dark',
  });
  await context.addInitScript((picture) => {
    window.fixture = { sockets: 0, peers: 0 };
    Object.defineProperty(navigator, 'platform', { get: () => 'iPad' });
    // Playwright's headless Chromium decodes no H.264; the fixture's video is a canvas, so advertise it.
    const capabilities = RTCRtpReceiver.getCapabilities?.bind(RTCRtpReceiver);
    if (capabilities) RTCRtpReceiver.getCapabilities = (kind) => {
      const c = capabilities(kind);
      return kind === 'video' && c ? { ...c, codecs: [...c.codecs, { mimeType: 'video/H264', clockRate: 90000 }] } : c;
    };
    // Enough of the gateway and Neko for the viewer to go live.
    window.WebSocket = class {
      readyState = 1;
      bufferedAmount = 0;
      constructor(url) {
        this.url = url;
        window.fixture.sockets++;
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
    // A peer whose video track is a canvas: a real decoded picture in the real <video>.
    window.RTCPeerConnection = class {
      connectionState = 'new';
      constructor() { window.fixture.peers++; }
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
  page.on('pageerror', (error) => errors.push(error.message));
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
      else if (url.pathname === '/api/v1/instances/i1/sessions') body = { session: { id: 's1', instanceId: 'i1', startedAt: new Date().toISOString(), endedAt: null }, operationId: null };
      else if (url.pathname.endsWith('/heartbeat')) body = { sleepAt: new Date(Date.now() + 600_000).toISOString(), reason: 'idle' };
      else if (url.pathname.endsWith('/connect')) body = { mode: 'webrtc', gatewayUrl: 'wss://nevazu.com/local-fixture', token: 'token1', iceServers: [] };
      else if (url.pathname.endsWith('/end') || url.pathname.endsWith('/diagnostics')) return route.fulfill({ status: 204 });
      else if (url.pathname === '/api/v1/events') return route.fulfill({ contentType: 'text/event-stream', body: ': local fixture\n\n' });
      else if (url.pathname === '/api/v1/regions') body = [{
        id: 'syd1', name: 'AWS Sydney', country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney', enabled: true, acceptingNew: true,
        probeUrl: null, area: 'asia_pacific', availability: 'available', availabilityReason: null, launchVerifiedAt: null, estimatedRttMs: null,
      }];
      // Pages after leaving the session (the browser list) are not under test.
      else return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ type: 'not_found', title: 'Not found', status: 404 }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    let file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = resolve(dist, 'index.html');
    return route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto(`${origin}/b/i1`);
  await page.getByRole('button', { name: 'Send keys', exact: true }).waitFor();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && v.readyState >= 2 && v.videoWidth > 0; });
  return { context, page, errors };
}

/** The share of an element left unclipped within the viewport, as the browser computes it. */
const shown = (page, selector) => page.evaluate((selector) => new Promise((done) => {
  const io = new IntersectionObserver(([entry]) => { io.disconnect(); done(entry.intersectionRatio); });
  io.observe(document.querySelector(selector));
}), selector);

/** The color painted at the picture's center (a 1×1 CSS-pixel screenshot: one PNG pixel, no filter state). */
async function paintedAtPictureCenter(page) {
  const box = await page.locator('video').boundingBox();
  const png = await page.screenshot({ clip: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), width: 1, height: 1 }, scale: 'css', animations: 'disabled' });
  const idat = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return [...inflateSync(Buffer.concat(idat)).subarray(1, 4)];
}

async function assertPicture(page, when) {
  assert.ok(await shown(page, 'video') > 0.99, `${when}: the picture must not be clipped away`);
  assert.ok(await shown(page, 'button[aria-label="More"]') > 0.99, `${when}: the toolbar must stay in view`);
  const color = await paintedAtPictureCenter(page);
  assert.ok(color.every((c, i) => Math.abs(c - PICTURE[i]) <= 12), `${when}: the picture's center is painted rgb(${color}), expected rgb(${PICTURE})`);
}

async function withMenu(page, name, when) {
  await page.getByRole('button', { name, exact: true }).tap();
  await page.getByRole('menu').waitFor();
  await assertPicture(page, when);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  await assertPicture(page, `${when}, closed again`);
}

try {
  for (const isMobile of [false, true]) {
    const label = isMobile ? 'iPad (mobile viewport)' : 'iPad (desktop-class viewport)';
    const { context, page, errors } = await fixture({ isMobile });
    await assertPicture(page, `${label}: live`);

    await withMenu(page, 'More', `${label}: More open`);
    results.push(`${label}: More keeps the picture and the toolbar`);

    await withMenu(page, 'Send keys', `${label}: Send keys open`);
    results.push(`${label}: Send keys keeps the picture and the toolbar`);

    // Any modal layer (a Radix dialog or modal menu) locks scrolling with body { position: relative !important }.
    await page.evaluate(() => document.body.style.setProperty('position', 'relative', 'important'));
    await assertPicture(page, `${label}: body positioned by a scroll lock`);
    await page.evaluate(() => document.body.style.removeProperty('position'));
    results.push(`${label}: a positioned body cannot clip the touch-screen frame`);

    assert.deepEqual(await page.evaluate(() => window.fixture), { sockets: 1, peers: 1 }, 'menus must not reconnect or remount the viewer');

    await page.getByRole('button', { name: 'Back to browsers', exact: true }).tap();
    await page.waitForURL(`${origin}/browsers`);
    await page.locator('.cb-dark').waitFor({ state: 'detached' });
    const left = await page.evaluate(() => [document.documentElement.style.cssText, document.body.style.cssText]);
    assert.deepEqual(left, ['', ''], 'leaving the session restores the page’s own html and body styles');
    results.push(`${label}: leaving the session restores html and body`);

    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  await browser.close();
}
