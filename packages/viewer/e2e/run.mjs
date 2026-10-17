// Viewer end-to-end test: the real web app (session view) → gateway → Go agent → fake neko.
// Expects the local stack (README "With a real agent"), LIVE_VIEW=on and viewer keys, the neko
// bridge on :8099, and the agent started with --neko-ws ws://127.0.0.1:8099/api/ws.
//   node packages/viewer/e2e/run.mjs <instance id> <wrangler log with sign-in codes> [screenshot.png]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_PATH ?? execSync('npm root -g').toString().trim() + '/playwright';
const { chromium } = require(pwPath);
const [instanceId, logFile, shot = 'viewer-e2e.png'] = process.argv.slice(2);
const APP = process.env.APP_URL ?? 'http://localhost:8787';
const EMAIL = process.env.EMAIL ?? 'dev@example.com';

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
const neko = await (await browser.newContext()).newPage();
await neko.goto('http://127.0.0.1:8099/');

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const app = await ctx.newPage();
const errors = [];
app.on('pageerror', (e) => errors.push(e.message));
app.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await app.goto(`${APP}/sign-in`);
await app.fill('#email', EMAIL);
await app.click('button[type=submit]');
await app.waitForSelector('#code');
await app.waitForTimeout(800);
const otp = [...readFileSync(logFile, 'utf8').matchAll(new RegExp(`sign-in code for ${EMAIL}: (\\d+)`, 'g'))].pop()[1];
await app.fill('#code', otp);
await app.click('button[type=submit]');
await app.waitForURL('**/browsers');

await app.goto(`${APP}/b/${instanceId}`);
// The stream plays once WebRTC is up through the gateway, the agent and the fake neko.
await app.waitForFunction(() => {
  const v = document.querySelector('video');
  return v && v.videoWidth > 0 && v.currentTime > 0;
}, null, { timeout: 30_000 });
const size = await app.evaluate(() => {
  const v = document.querySelector('video');
  return { w: v.videoWidth, h: v.videoHeight };
});

// Input: move, click, a key, a scroll; IME text and a paste go through the gateway and the agent.
const box = await app.locator('video').boundingBox();
await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await app.mouse.down();
await app.mouse.up();
await app.keyboard.press('a');
await app.mouse.wheel(0, 120);
await app.waitForTimeout(1500);
await app.waitForSelector('[data-testid=connection-indicator]', { timeout: 10_000 });
const indicator = await app.textContent('[data-testid=connection-indicator]');
await app.screenshot({ path: shot });

const received = await neko.evaluate(() => window.received);
const ops = new Set(received.map((r) => r.op));
const moveToCenter = received.find((r) => r.op === 1);
const result = {
  video: size,
  box: { w: Math.round(box.width), h: Math.round(box.height) },
  indicator: indicator?.trim(),
  sawMove: ops.has(1),
  sawButton: ops.has(5) && ops.has(6),
  sawKey: received.some((r) => r.op === 3 && r.code === 0x61),
  sawScroll: ops.has(2),
  firstMove: moveToCenter,
  screenSet: await neko.evaluate(() => window.screenSet ?? null),
  nekoEvents: [...new Set(await neko.evaluate(() => window.events))],
  pageErrors: errors,
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
const ok = result.video.w > 0 && result.sawMove && result.sawButton && result.sawKey && result.sawScroll;
process.exit(ok ? 0 : 1);
