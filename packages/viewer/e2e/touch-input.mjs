// Standalone component regression: no production login, gateway, agent, VM, or AWS credentials.
// node packages/viewer/e2e/touch-input.mjs
// Optional: TOUCH_BROWSER=webkit PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers
//           PLAYWRIGHT_PATH=/path/to/playwright CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const require = createRequire(import.meta.url);
const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/codex/cua_node/lib/node_modules/playwright'].filter(Boolean);
let playwright;
for (const path of candidates) {
  try { playwright = require(path); break; } catch {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_PATH to its module directory.');
const { createServer } = await import(webRequire.resolve('vite'));
const server = await createServer({
  configFile: false,
  root: here,
  logLevel: 'error',
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [
    { find: /^react$/, replacement: webRequire.resolve('react') },
    { find: /^react\/jsx-runtime$/, replacement: webRequire.resolve('react/jsx-runtime') },
    { find: /^react\/jsx-dev-runtime$/, replacement: webRequire.resolve('react/jsx-dev-runtime') },
    { find: /^react-dom\/client$/, replacement: webRequire.resolve('react-dom/client') },
  ] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
});

let browser;
const checks = [];
const engine = process.env.TOUCH_BROWSER ?? 'chromium';
try {
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/touch-input.html`;
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH ??
    (!existsSync(playwright.chromium.executablePath()) && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await playwright[engine].launch(engine === 'chromium'
    ? { headless: true, executablePath, args: ['--no-sandbox'] } : { headless: true });

  const snapshot = (page) => page.evaluate(() => window.touchHarness.snapshot());
  const clear = (page) => page.evaluate(() => window.touchHarness.clear());
  const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const inputCalls = (state, method) => state.calls.filter((call) => call.method === method);
  const typed = (state) => inputCalls(state, 'typeText').map((call) => call.args[0]);
  const openPage = async (touch) => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: touch, isMobile: touch });
    // Playwright's Linux WPE build emits touch events but leaves this capability at zero.
    // Supply the declared emulation capability; real iPad Safari reports its touch points.
    if (engine === 'webkit') await context.addInitScript((points) => {
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => points });
    }, touch ? 5 : 0);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => !!window.touchHarness && !!document.querySelector('textarea'));
    await settle(page);
    await clear(page);
    return { context, page, errors };
  };

  const touch = await openPage(true);
  const page = touch.page;
  const video = await page.locator('video').boundingBox();
  const point = { x: Math.round(video.x + video.width / 2), y: Math.round(video.y + video.height / 2) };
  const keyboardButton = page.getByTestId('keyboard-toggle');
  const check = (name) => checks.push(name);

  await page.touchscreen.tap(point.x, point.y);
  await settle(page);
  let state = await snapshot(page);
  assert.notEqual(state.active, 'textarea', 'A picture tap must not focus the soft-keyboard textarea');
  assert.equal(state.inputMode, 'none');
  assert.equal(state.readOnly, true);
  assert.equal(state.keyboard, 'false');
  assert.equal(state.focusChanges.filter((e) => e.event === 'focusin' && e.target === 'textarea').length, 0);
  assert.deepEqual(inputCalls(state, 'button').map((call) => call.args[0]), [true, false]);
  assert.equal(inputCalls(state, 'button')[0].phase, 'pointerup', 'Touch must decide tap versus scroll before remote mouse-down');
  check('native touch tap: delayed click, no textarea focus or keyboard');

  await clear(page);
  await page.keyboard.press('b');
  state = await snapshot(page);
  assert.deepEqual(inputCalls(state, 'key').filter((call) => call.args[1].key === 'b').map((call) => call.args[0]), [true, false]);
  assert.deepEqual(typed(state), []);
  assert.notEqual(state.active, 'textarea');
  assert.equal(state.keyboard, 'false');
  check('touch device hardware keyboard works while software keyboard stays closed');

  if (engine === 'chromium') {
    const cdp = await touch.context.newCDPSession(page);
    const sendTouch = (type, points = []) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: points.map(([x, y, id = 1]) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 })),
    });
    await clear(page);
    await sendTouch('touchStart', [[point.x, point.y + 80]]);
    assert.equal(inputCalls(await snapshot(page), 'button').length, 0);
    for (const dy of [40, 0, -40, -80]) {
      await sendTouch('touchMove', [[point.x, point.y + dy]]);
      await settle(page);
    }
    await sendTouch('touchEnd');
    await settle(page);
    state = await snapshot(page);
    assert.equal(inputCalls(state, 'button').length, 0, 'A swipe must not create a remote click or drag');
    assert.ok(inputCalls(state, 'scroll').some((call) => call.args[1] > 0), 'Upward finger motion must scroll down');
    assert.ok(state.wire.some((frame) => frame.event === 'control/scroll' && frame.payload.delta_y < 0), 'Neko scroll counts must use the down direction');
    assert.ok(state.remoteScroll.y > 0 && state.remoteScroll.y < 1000, 'The remote document must move down by wheel clicks, not hundreds of clicks per pixel');
    assert.deepEqual(state.localScroll, { x: 0, y: 0 }, 'Touch must never pan the local document');
    const afterSwipe = state.remoteScroll.y;
    await page.waitForTimeout(120);
    assert.equal((await snapshot(page)).remoteScroll.y, afterSwipe, 'The remote position must not spring back after touchend');
    assert.notEqual(state.active, 'textarea');
    check('native touch swipe: remote scroll without click or keyboard');

    await clear(page);
    await sendTouch('touchStart', [[point.x, point.y]]);
    await sendTouch('touchCancel');
    await settle(page);
    assert.equal(inputCalls(await snapshot(page), 'button').length, 0, 'Canceled touch must not leave a remote button pressed');
    check('native touch cancellation: no remote button');

    await clear(page);
    await sendTouch('touchStart', [[point.x, point.y]]);
    await sendTouch('touchStart', [[point.x, point.y], [point.x + 30, point.y + 30, 2]]);
    await sendTouch('touchEnd');
    await settle(page);
    assert.equal(inputCalls(await snapshot(page), 'button').length, 0, 'A second finger must cancel a pending remote tap');
    check('native multiple-finger cancellation: no accidental click');
    await cdp.detach();
  }

  await keyboardButton.tap();
  await settle(page);
  state = await snapshot(page);
  assert.equal(state.active, 'textarea');
  assert.equal(state.inputMode, 'text');
  assert.equal(state.readOnly, false);
  assert.equal(state.keyboard, 'true');
  check('explicit keyboard toggle enables and focuses editable textarea');

  await clear(page);
  await page.touchscreen.tap(point.x, point.y);
  await settle(page);
  state = await snapshot(page);
  assert.equal(state.active, 'textarea');
  assert.equal(state.keyboard, 'true');
  assert.equal(state.textareaFocusCalls, 0, 'Picture taps with keyboard open must not refocus the textarea');
  assert.deepEqual(state.focusChanges, [], 'Picture taps with keyboard open must not blur the textarea');
  check('picture tap preserves open keyboard and textarea focus without refocusing');

  await clear(page);
  await page.locator('.remote-screen').evaluate((box) => { box.style.bottom = '240px'; });
  await settle(page);
  assert.equal(inputCalls(await snapshot(page), 'setViewport').length, 0, 'Local keyboard-height changes must not resize the remote desktop');
  check('keyboard-height ResizeObserver changes do not resize remote Chrome');

  await clear(page);
  await page.keyboard.insertText('a');
  assert.deepEqual(typed(await snapshot(page)), ['a'], 'Native beforeinput/input text must be forwarded exactly once');
  await clear(page);
  await page.evaluate(() => window.touchHarness.inputOnly('好'));
  assert.deepEqual(typed(await snapshot(page)), ['好'], 'Input-only fallback must preserve non-ASCII text');
  check('soft-keyboard native text and input-only fallback: exactly once');

  await page.evaluate(() => window.touchHarness.resetRemote());
  await clear(page);
  await page.evaluate(() => {
    window.touchHarness.nativeKey('keydown', 'Shift', 'ShiftLeft');
    window.touchHarness.inputOnly('A');
    window.touchHarness.nativeKey('keydown', 'ArrowLeft', 'ArrowLeft');
  });
  await page.waitForTimeout(500);
  state = await snapshot(page);
  assert.equal(state.remoteInput, 'A', 'A soft keyboard without keyup must insert its committed letter once');
  assert.deepEqual(state.held, [], 'Neither Shift, ArrowLeft nor the last printable character may remain held');
  check('soft keys with omitted keyup do not leave X11 autorepeat active');

  for (const [inputType, combo] of [['deleteContentBackward', 'Backspace'], ['insertLineBreak', 'Enter']]) {
    await clear(page);
    await page.evaluate((type) => window.touchHarness.edit(type), inputType);
    assert.deepEqual(inputCalls(await snapshot(page), 'sendCombo').map((call) => call.args[0]), [[combo]], `${inputType} without keydown must reach the remote page once`);
  }
  await clear(page);
  await page.keyboard.press('Backspace');
  assert.deepEqual(inputCalls(await snapshot(page), 'sendCombo').map((call) => call.args[0]), [['Backspace']]);
  check('soft-keyboard delete and enter without keydown, plus native Backspace: exactly once');

  for (const finalBeforeEnd of [false, true]) {
    await clear(page);
    await page.evaluate((before) => window.touchHarness.compose('中文', before), finalBeforeEnd);
    state = await snapshot(page);
    assert.deepEqual(typed(state), ['中文'], `IME commit must be forwarded once (final input before end: ${finalBeforeEnd}); ${JSON.stringify(inputCalls(state, 'typeText'))}`);
  }
  check('IME commit before/after compositionend: exactly once');

  await keyboardButton.tap();
  await settle(page);
  state = await snapshot(page);
  assert.equal(state.keyboard, 'false', `Closing the keyboard must keep it closed: ${JSON.stringify({
    keyboardChanges: inputCalls(state, 'keyboardChange'), focusChanges: state.focusChanges,
  })}`);
  await clear(page);
  await page.locator('.remote-screen').evaluate((box) => { box.style.bottom = '0px'; });
  await page.waitForFunction((height) => window.touchHarness.snapshot().calls.some((call) =>
    call.method === 'setViewport' && Math.abs(Number(call.args[1]) - height) < 1), video.height, { timeout: 3000 }).catch(async (error) => {
    console.error('Viewport restoration state:', await page.evaluate(() => ({
      keyboard: window.touchHarness.snapshot().keyboard,
      keyboardChanges: window.touchHarness.snapshot().calls.filter((call) => call.method === 'keyboardChange'),
      focusChanges: window.touchHarness.snapshot().focusChanges,
      viewportCalls: window.touchHarness.snapshot().calls.filter((call) => call.method === 'setViewport'),
      boxHeight: document.querySelector('.remote-screen').getBoundingClientRect().height,
    })));
    throw error;
  });
  state = await snapshot(page);
  assert.ok(inputCalls(state, 'setViewport').some((call) => Math.abs(call.args[1] - video.height) < 1), 'Closing keyboard must restore normal remote viewport updates');
  check('closing keyboard restores normal remote viewport updates');
  await clear(page);
  await page.touchscreen.tap(point.x, point.y);
  await settle(page);
  state = await snapshot(page);
  assert.equal(state.keyboard, 'false');
  assert.equal(state.inputMode, 'none');
  assert.equal(state.readOnly, true);
  assert.notEqual(state.active, 'textarea');
  assert.equal(state.focusChanges.filter((e) => e.event === 'focusin' && e.target === 'textarea').length, 0);
  check('keyboard stays closed after subsequent picture tap');
  assert.deepEqual(touch.errors, []);
  await touch.context.close();

  const desktop = await openPage(false);
  const dp = desktop.page;
  await dp.mouse.click(point.x, point.y);
  await settle(dp);
  state = await snapshot(dp);
  assert.equal(state.active, 'textarea');
  assert.equal(state.readOnly, false);
  assert.deepEqual(inputCalls(state, 'button').map((call) => call.args[0]), [true, false]);
  await clear(dp);
  await dp.keyboard.press('a');
  state = await snapshot(dp);
  assert.deepEqual(inputCalls(state, 'key').filter((call) => call.args[1].key === 'a').map((call) => call.args[0]), [true, false]);
  assert.deepEqual(typed(state), [], 'Hardware key dispatch must not duplicate text insertion');
  await clear(dp);
  await dp.evaluate(() => {
    window.touchHarness.resetRemote();
    window.touchHarness.nativeKey('keydown', 'Control', 'ControlLeft');
    window.touchHarness.nativeKey('keydown', 'Shift', 'ShiftLeft');
    window.touchHarness.inputOnly('aA:中文');
  });
  state = await snapshot(dp);
  assert.equal(state.remoteInput, 'aA:中文', 'Committed text must stay literal while physical modifiers are held');
  assert.deepEqual(state.held, [0xffe3, 0xffe1], 'Text insertion must restore physical holds after Neko paste resets');
  await dp.evaluate(() => {
    window.touchHarness.nativeKey('keyup', 'Shift', 'ShiftLeft');
    window.touchHarness.nativeKey('keyup', 'Control', 'ControlLeft');
  });
  assert.deepEqual((await snapshot(dp)).held, []);
  check('literal mixed text preserves and restores physical modifiers across atomic paste');
  await clear(dp);
  await dp.mouse.wheel(0, 120);
  await settle(dp);
  state = await snapshot(dp);
  assert.ok(inputCalls(state, 'scroll').some((call) => call.args[1] === 120));
  assert.ok(state.remoteScroll.y > 0 && state.remoteScroll.y < 300, 'Desktop wheel must scroll the remote document down at a bounded speed');
  assert.deepEqual(state.localScroll, { x: 0, y: 0 });
  await clear(dp);
  await dp.mouse.wheel(120, 0);
  await settle(dp);
  assert.ok((await snapshot(dp)).remoteScroll.x > 0, 'Horizontal trackpad deltas must scroll right');

  await clear(dp);
  await dp.evaluate(({ x, y }) => window.touchHarness.interleave(x, y), point);
  const expectedOrder = ['control/move', 'control/keydown', 'control/move', 'control/scroll', 'control/keyup', 'control/paste'];
  assert.deepEqual((await snapshot(dp)).wire.map((frame) => frame.event), expectedOrder, 'Mouse, wheel, key and IME boundaries must keep DOM order');
  await clear(dp);
  await dp.evaluate(({ x, y }) => {
    window.touchHarness.socketBuffer(300000);
    window.touchHarness.interleave(x, y);
  }, point);
  assert.deepEqual((await snapshot(dp)).wire, [], 'Backpressure must pause the complete input stream');
  await dp.evaluate(() => window.touchHarness.socketBuffer(0));
  await dp.waitForTimeout(40);
  assert.deepEqual((await snapshot(dp)).wire.map((frame) => frame.event), expectedOrder, 'Queued text must not overtake keys or mouse input');
  assert.deepEqual((await snapshot(dp)).held, []);
  check('one FIFO across pointer/wheel/key/IME boundaries and WebSocket backpressure, without using the unreliable data channel');
  // Files: a drop lands where the pointer let go; a paste puts them on the remote clipboard, then Ctrl+V.
  await clear(dp);
  await dp.evaluate(({ x, y }) => window.touchHarness.dropFile(x, y, 'notes.md', '# Notes'), point);
  await dp.waitForFunction(() => window.touchHarness.transfers()[0]?.done);
  let sent = (await dp.evaluate(() => window.touchHarness.transfers()))[0];
  const dropAt = inputCalls(await snapshot(dp), 'move').at(-1).args;
  assert.deepEqual(sent, { action: 'drop', x: Math.round(dropAt[0]), y: Math.round(dropAt[1]), names: ['notes.md'], text: '# Notes', done: true });
  await dp.waitForTimeout(20);
  assert.ok(!(await snapshot(dp)).wire.some((frame) => frame.event === 'control/keydown' && frame.payload.keysym === 0x76), 'A drop must not paste');
  check('a dropped file reaches the agent with the remote drop point');
  await clear(dp);
  await dp.evaluate(() => window.touchHarness.pasteFile('notes.txt', 'hello', 'text/plain'));
  await dp.waitForFunction(() => window.touchHarness.snapshot().wire.some((frame) => frame.event === 'control/keydown' && frame.payload.keysym === 0x76));
  sent = (await dp.evaluate(() => window.touchHarness.transfers()))[0];
  assert.deepEqual({ action: sent.action, names: sent.names, text: sent.text, done: sent.done, x: sent.x }, { action: 'paste', names: ['notes.txt'], text: 'hello', done: true, x: undefined });
  state = await snapshot(dp);
  assert.deepEqual(state.wire.filter((f) => f.event.startsWith('control/key')).map((f) => [f.event, f.payload.keysym]),
    [['control/keydown', 0xffe3], ['control/keydown', 0x76], ['control/keyup', 0x76], ['control/keyup', 0xffe3]]);
  assert.deepEqual(state.held, []);
  check('a pasted file goes to the remote clipboard, then Ctrl+V');

  // Rotation: the remote screen takes the turned shape and input follows the turn.
  const screen = await dp.locator('.remote-screen').boundingBox();
  await clear(dp);
  await dp.getByTestId('rotate-toggle').click();
  await settle(dp);
  await dp.waitForTimeout(900);
  state = await snapshot(dp);
  const viewport = inputCalls(state, 'setViewport').at(-1)?.args;
  assert.deepEqual(viewport, [screen.height, screen.width], 'A turned view asks for a turned remote screen');
  await clear(dp);
  await dp.mouse.click(screen.x + screen.width - 3, screen.y + 3);
  const turned = inputCalls(await snapshot(dp), 'button')[0].args;
  assert.ok(turned[2] < 8 && turned[3] < 8, `The box's top-right corner is the remote top-left when turned: ${turned}`);
  await dp.getByTestId('rotate-toggle').click();
  await settle(dp);
  check('rotated view: turned remote screen and input mapping');
  assert.deepEqual(desktop.errors, []);
  check('desktop click, hardware keyboard, and wheel remain usable');
  await desktop.context.close();
  console.log(JSON.stringify({ engine, checks, result: 'passed', swipeCoverage: engine === 'chromium' ? 'native CDP touch sequence' : 'not available in Playwright WebKit' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ engine, checks, result: 'failed' }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
