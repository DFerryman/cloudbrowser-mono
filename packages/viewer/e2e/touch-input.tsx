// Mount the production React component while replacing its transport, never its DOM handlers.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteBrowserView, type RemoteBrowserHandle } from '../src/react';
import { RemoteBrowser } from '../src/remote-browser';

type RecordedCall = { method: string; actualMethod: string; args: unknown[]; phase: string | null };
const calls: RecordedCall[] = [];
const focusChanges: { event: string; target: string }[] = [];
let textareaFocusCalls = 0;
const focusTextarea = HTMLTextAreaElement.prototype.focus;
HTMLTextAreaElement.prototype.focus = function (...args) {
  textareaFocusCalls++;
  return focusTextarea.apply(this, args);
};
let phase: string | null = null;
const identify = (target: EventTarget | null) => target instanceof HTMLTextAreaElement ? 'textarea'
  : target instanceof HTMLElement ? target.dataset.testid ?? target.tagName.toLowerCase() : 'unknown';

for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'compositionstart', 'compositionend', 'beforeinput', 'input', 'keydown', 'keyup']) {
  document.addEventListener(type, () => { phase = type; }, true);
}
for (const event of ['focusin', 'focusout']) {
  document.addEventListener(event, (e) => focusChanges.push({ event, target: identify(e.target) }), true);
}
const record = (method: string, args: unknown[], actualMethod = method) => calls.push({ method, actualMethod, args, phase });

for (const method of ['move', 'button', 'scroll', 'typeText', 'setClipboard', 'sendCombo', 'releaseAllKeys', 'setViewport', 'disconnect']) {
  (RemoteBrowser.prototype as any)[method] = function (...args: unknown[]) { record(method, args); };
}
RemoteBrowser.prototype.key = function (down, e) {
  record('key', [down, { key: e.key, code: e.code }]);
  return true;
};
for (const [actualMethod, method] of [['typeSoftwareText', 'typeText'], ['sendSoftwareCombo', 'sendCombo']]) {
  (RemoteBrowser.prototype as any)[actualMethod] = function (...args: unknown[]) { record(method, args, actualMethod); };
}
(RemoteBrowser.prototype as any).softwareKey = function (down: boolean, e: KeyboardEvent) {
  record('key', [down, { key: e.key, code: e.code }], 'softwareKey');
  return true;
};
RemoteBrowser.prototype.connect = async function () {
  record('connect', []);
  (this as any).opts.onState?.('live', 0);
};

function Fixture() {
  const ref = useRef<RemoteBrowserHandle>(null);
  const [keyboard, setKeyboard] = useState(false);
  return <>
    <header>
      <button data-testid="keyboard-toggle" onPointerDown={(e) => e.preventDefault()} onClick={() => ref.current?.toggleKeyboard()}>Keyboard</button>
      <output data-testid="keyboard-state">{String(keyboard)}</output>
    </header>
    <RemoteBrowserView
      ref={ref}
      className="remote-screen"
      style={{ position: 'absolute', top: 64, left: 0, right: 0, bottom: 0, background: '#222' }}
      getConnectInfo={async () => { throw new Error('The regression fixture must not request a real session'); }}
      onKeyboardChange={setKeyboard}
    />
  </>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);

(window as any).touchHarness = {
  clear() { calls.length = 0; focusChanges.length = 0; textareaFocusCalls = 0; phase = null; },
  snapshot() {
    const textarea = document.querySelector('textarea')!;
    return {
      calls: structuredClone(calls), focusChanges: structuredClone(focusChanges), textareaFocusCalls,
      active: identify(document.activeElement), inputMode: textarea.inputMode,
      readOnly: textarea.readOnly, keyboard: document.querySelector('[data-testid="keyboard-state"]')?.textContent,
    };
  },
  inputOnly(text: string) {
    const textarea = document.querySelector('textarea')!;
    textarea.value = text;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  },
  edit(inputType: string) {
    const textarea = document.querySelector('textarea')!;
    const allowed = textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType }));
    if (allowed) textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  },
  compose(text: string, finalBeforeEnd = false) {
    const textarea = document.querySelector('textarea')!;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.value = text;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertCompositionText', isComposing: true }));
    const finalInput = () => {
      const event = (type: string) => {
        const e = new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', data: text, inputType: 'insertFromComposition' });
        // Chromium's constructor clears this Safari inputType. Preserve the sequence we test.
        if (e.inputType !== 'insertFromComposition') Object.defineProperty(e, 'inputType', { value: 'insertFromComposition' });
        return e;
      };
      if (textarea.dispatchEvent(event('beforeinput'))) textarea.dispatchEvent(event('input'));
    };
    if (finalBeforeEnd) finalInput();
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
    if (!finalBeforeEnd) finalInput();
  },
};
