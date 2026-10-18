import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextInputController, type TextKeyEvent } from '../src/text-input.js';

function setup(mode: 'desktop' | 'software' = 'desktop') {
  const callbacks = {
    mode: vi.fn(() => mode),
    key: vi.fn((_down: boolean, event: TextKeyEvent) => !['Unidentified', 'Process', 'Dead'].includes(event.key)),
    typeText: vi.fn(),
    sendCombo: vi.fn(),
    releaseAllKeys: vi.fn(),
    activity: vi.fn(),
  };
  return { controller: new TextInputController(callbacks), ...callbacks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('viewer text input', () => {
  it('keeps desktop keydown immediate and pairs keyup with the original key', () => {
    const { controller, key, typeText } = setup();
    expect(controller.keyDown({ key: 'A', code: 'KeyA', shiftKey: true })).toBe(true);
    expect(controller.keyUp({ key: 'a', code: 'KeyA' })).toBe(true);
    expect(key.mock.calls[0]).toEqual([true, { key: 'A', code: 'KeyA', shiftKey: true }]);
    expect(key.mock.calls[1]?.[0]).toBe(false);
    expect(key.mock.calls[1]?.[1]).toMatchObject({ key: 'A', code: 'KeyA', shiftKey: true });
    expect(typeText).not.toHaveBeenCalled();
  });

  it('copies non-enumerable DOM KeyboardEvent fields when matching keyup to keydown', () => {
    const { controller, key } = setup();
    const native = Object.create(Object.defineProperties({}, {
      key: { get: () => 'A' },
      code: { get: () => 'KeyA' },
      shiftKey: { get: () => true },
      ctrlKey: { get: () => false },
      metaKey: { get: () => false },
      altKey: { get: () => false },
      isComposing: { get: () => false },
      keyCode: { get: () => 65 },
    })) as TextKeyEvent;
    expect(Object.keys(native)).toEqual([]);
    expect(controller.keyDown(native)).toBe(true);
    expect(controller.keyUp({ key: 'a', code: 'KeyA' })).toBe(true);
    expect(key.mock.calls[1]).toEqual([false, {
      key: 'A', code: 'KeyA', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false,
      isComposing: false, keyCode: 65,
    }]);
  });

  it('uses native text insertion for software printable keys without sending unmatched keyups', () => {
    const { controller, key, typeText } = setup('software');
    expect(controller.keyDown({ key: 'a', code: 'KeyA' })).toBe(false);
    expect(controller.beforeInput({ inputType: 'insertText', data: 'a' })).toBe(false);
    expect(controller.input({ inputType: 'insertText', data: 'a' }, 'a')).toBe(true);
    expect(controller.keyUp({ key: 'a', code: 'KeyA' })).toBe(false);
    expect(key).not.toHaveBeenCalled();
    expect(typeText.mock.calls).toEqual([['a']]);
  });

  it.each(['hello', '你', '😀'])('does not lose soft keyboard input without a usable keydown: %s', (text) => {
    const { controller, typeText } = setup('software');
    expect(controller.keyDown({ key: 'Unidentified', code: '' })).toBe(false);
    expect(controller.input({ inputType: 'insertText', data: text }, text)).toBe(true);
    expect(typeText.mock.calls).toEqual([[text]]);
  });

  it('uses the actual textarea value for dictation or replacement input without event.data', () => {
    const { controller, typeText } = setup('software');
    expect(controller.input({ inputType: 'insertReplacementText', data: null }, 'two words')).toBe(true);
    expect(typeText).toHaveBeenCalledWith('two words');
  });

  it.each(['desktop', 'software'] as const)('submits composition once in %s mode and preserves intermediate textarea values', (mode) => {
    const { controller, key, typeText } = setup(mode);
    controller.compositionStart();
    expect(controller.keyDown({ key: 'n', code: 'KeyN', isComposing: true })).toBe(false);
    expect(controller.beforeInput({ inputType: 'insertCompositionText', data: 'ni', isComposing: true })).toBe(false);
    expect(controller.input({ inputType: 'insertCompositionText', data: 'ni', isComposing: true }, 'ni')).toBe(false);
    // Some engines omit isComposing while their composition is still active.
    expect(controller.input({ inputType: 'insertCompositionText', data: '你' }, '你')).toBe(false);
    expect(typeText).not.toHaveBeenCalled();
    expect(controller.compositionEnd('你')).toBe(true);
    expect(controller.input({ inputType: 'insertFromComposition', data: '你' }, '你')).toBe(true);
    expect(typeText.mock.calls).toEqual([['你']]);
    expect(key).not.toHaveBeenCalled();
  });

  it('suppresses Safari trailing insertText but accepts the next identical real key', () => {
    const { controller, typeText } = setup('software');
    controller.compositionStart();
    controller.compositionEnd('a');
    expect(controller.beforeInput({ inputType: 'insertText', data: 'a' })).toBe(true);
    expect(controller.input({ inputType: 'insertText', data: 'a' }, 'a')).toBe(true);
    controller.keyDown({ key: 'a', code: '' });
    controller.input({ inputType: 'insertText', data: 'a' }, 'a');
    expect(typeText.mock.calls).toEqual([['a'], ['a']]);
  });

  it('does not swallow a later identical input when the composition has no trailing event', async () => {
    const { controller, typeText } = setup('software');
    controller.compositionStart();
    controller.compositionEnd('你');
    await vi.advanceTimersByTimeAsync(0);
    controller.input({ inputType: 'insertText', data: '你' }, '你');
    expect(typeText.mock.calls).toEqual([['你'], ['你']]);
  });

  it('does not swallow a new keyed input even before the composition-tail timer expires', () => {
    const { controller, typeText } = setup('software');
    controller.compositionStart();
    controller.compositionEnd('你');
    controller.keyDown({ key: 'Unidentified', code: '' });
    controller.input({ inputType: 'insertText', data: '你' }, '你');
    expect(typeText.mock.calls).toEqual([['你'], ['你']]);
  });

  it('does not submit a cancelled composition', () => {
    const { controller, typeText } = setup('software');
    controller.compositionStart();
    expect(controller.compositionEnd('')).toBe(true);
    expect(typeText).not.toHaveBeenCalled();
  });

  it.each([
    ['deleteContentBackward', ['Backspace']],
    ['deleteContentForward', ['Delete']],
    ['deleteWordBackward', ['Control', 'Backspace']],
    ['deleteWordForward', ['Control', 'Delete']],
    ['insertLineBreak', ['Enter']],
    ['insertParagraph', ['Enter']],
  ])('handles %s on an empty software textarea once', (inputType, combo) => {
    const { controller, sendCombo, typeText } = setup('software');
    expect(controller.beforeInput({ inputType: inputType as string, data: null })).toBe(true);
    // Guard against an input event even if a browser cannot cancel its beforeinput.
    expect(controller.input({ inputType: inputType as string, data: null }, '')).toBe(true);
    expect(sendCombo.mock.calls).toEqual([[combo]]);
    expect(typeText).not.toHaveBeenCalled();
  });

  it('falls back to input when beforeinput is not cancelable or absent', () => {
    const { controller, sendCombo } = setup('software');
    expect(controller.beforeInput({ inputType: 'deleteContentBackward', cancelable: false })).toBe(false);
    expect(sendCombo).not.toHaveBeenCalled();
    controller.input({ inputType: 'deleteContentBackward' }, '');
    controller.input({ inputType: 'insertLineBreak' }, '\n');
    expect(sendCombo.mock.calls).toEqual([[['Backspace']], [['Enter']]]);
  });

  it('sends a software special key as a complete press even without keyup and avoids beforeinput duplicates', () => {
    const { controller, key, sendCombo } = setup('software');
    expect(controller.keyDown({ key: 'Backspace', code: '' })).toBe(true);
    expect(controller.beforeInput({ inputType: 'deleteContentBackward' })).toBe(true);
    controller.input({ inputType: 'deleteContentBackward' }, '');
    expect(controller.keyUp({ key: 'Backspace', code: '' })).toBe(false);
    expect(sendCombo.mock.calls).toEqual([[['Backspace']]]);
    expect(key).not.toHaveBeenCalled();
  });

  it('sends software modifier shortcuts as complete strokes even without keyup', () => {
    const { controller, key, typeText } = setup('software');
    expect(controller.keyDown({ key: 'Control', code: 'ControlLeft', ctrlKey: true })).toBe(false);
    expect(controller.keyDown({ key: 'a', code: 'KeyA', ctrlKey: true })).toBe(true);
    expect(key.mock.calls.map(([down, event]) => [down, event.key])).toEqual([
      [true, 'Control'], [true, 'a'], [false, 'a'], [false, 'Control'],
    ]);
    expect(controller.keyUp({ key: 'a', code: 'KeyA', ctrlKey: false })).toBe(false);
    expect(controller.keyUp({ key: 'Control', code: 'ControlLeft' })).toBe(false);
    expect(typeText).not.toHaveBeenCalled();
  });

  it('does not hold a software Shift or a navigation key while waiting for an optional keyup', () => {
    const { controller, key, typeText } = setup('software');
    expect(controller.keyDown({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBe(false);
    controller.keyDown({ key: 'a', code: '' });
    controller.input({ inputType: 'insertText', data: 'a' }, 'a');
    expect(typeText.mock.calls).toEqual([['a']]);
    expect(key).not.toHaveBeenCalled();
    expect(controller.keyDown({ key: 'ArrowLeft', code: '' })).toBe(true);
    expect(key.mock.calls.map(([down, event]) => [down, event.key])).toEqual([
      [true, 'ArrowLeft'], [false, 'ArrowLeft'],
    ]);
  });

  it('keeps the first desktop mapping through repeats, case changes, and a code-less keyup', () => {
    const { controller, key } = setup();
    controller.keyDown({ key: 'a', code: 'KeyA', keyCode: 65 });
    controller.keyDown({ key: 'A', code: 'KeyA', keyCode: 65, shiftKey: true });
    expect(key).toHaveBeenCalledTimes(1);
    expect(controller.keyUp({ key: 'A', code: '', keyCode: 65 })).toBe(true);
    expect(key.mock.calls[1]).toMatchObject([false, { key: 'a', code: 'KeyA' }]);
  });

  it('matches a code-less desktop release by its original character regardless of case', () => {
    const { controller, key } = setup();
    controller.keyDown({ key: 'A', code: 'KeyA', shiftKey: true });
    expect(controller.keyUp({ key: 'a', code: '' })).toBe(true);
    expect(key.mock.calls[1]).toMatchObject([false, { key: 'A', code: 'KeyA' }]);
  });

  it('releases outstanding desktop keys when Safari loses the release identity', () => {
    const { controller, releaseAllKeys } = setup();
    controller.keyDown({ key: 'a', code: 'KeyA' });
    expect(controller.keyUp({ key: 'Unidentified', code: '', keyCode: 229 })).toBe(true);
    expect(releaseAllKeys).toHaveBeenCalledOnce();
    expect(controller.keyUp({ key: 'a', code: 'KeyA' })).toBe(false);
  });

  it('releases desktop keys before an IME composition takes over', () => {
    const { controller, releaseAllKeys } = setup();
    controller.keyDown({ key: 'n', code: 'KeyN' });
    controller.compositionStart();
    expect(releaseAllKeys).toHaveBeenCalledOnce();
    expect(controller.keyUp({ key: 'Process', code: '' })).toBe(false);
  });

  it('leaves Ctrl/Meta+V to the paste handler without sending a stray V keyup', () => {
    const { controller, key } = setup('software');
    expect(controller.keyDown({ key: 'v', code: 'KeyV', metaKey: true })).toBe(false);
    expect(controller.keyUp({ key: 'v', code: 'KeyV', metaKey: true })).toBe(false);
    expect(key).not.toHaveBeenCalled();
  });

  it('suppresses duplicate editing input after a desktop keydown', () => {
    const { controller, key, sendCombo } = setup();
    expect(controller.keyDown({ key: 'Enter', code: 'Enter' })).toBe(true);
    expect(controller.beforeInput({ inputType: 'insertParagraph' })).toBe(true);
    controller.input({ inputType: 'insertParagraph' }, '\n');
    expect(controller.keyUp({ key: 'Enter', code: 'Enter' })).toBe(true);
    expect(key).toHaveBeenCalledTimes(2);
    expect(sendCombo).not.toHaveBeenCalled();
  });

  it('allows subsequent independent deletions after the previous sequence ends', async () => {
    const { controller, sendCombo } = setup('software');
    controller.beforeInput({ inputType: 'deleteContentBackward' });
    await vi.advanceTimersByTimeAsync(0);
    controller.beforeInput({ inputType: 'deleteContentBackward' });
    expect(sendCombo).toHaveBeenCalledTimes(2);
  });

  it('releases held keys and cancels composition/editing state on reset', () => {
    const { controller, releaseAllKeys, typeText } = setup();
    controller.keyDown({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
    controller.compositionStart();
    controller.reset();
    expect(releaseAllKeys).toHaveBeenCalledTimes(2); // Composition takes over, then the viewer resets.
    expect(controller.keyUp({ key: 'Control', code: 'ControlLeft' })).toBe(false);
    expect(controller.input({ inputType: 'insertText', data: 'a' }, 'a')).toBe(true);
    expect(typeText).toHaveBeenCalledWith('a');
    expect(vi.getTimerCount()).toBe(0);
  });
});
