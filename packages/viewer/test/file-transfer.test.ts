import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTransfers, pastedFiles, toBase64, type TransferFile, type TransferUpdate } from '../src/file-transfer.js';
import { toRemotePoint, unrotate } from '../src/mapping.js';

const file = (name: string, text: string, type = 'text/plain'): TransferFile => {
  const bytes = new TextEncoder().encode(text);
  return { name, type, size: bytes.length, slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }) };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const decode = (chunk: string) => new TextDecoder().decode(Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0)));

afterEach(() => vi.useRealTimers());

describe('FileTransfers', () => {
  it('sends files in order within the acknowledgement window, then ends', async () => {
    const frames: Record<string, unknown>[] = [];
    const updates: TransferUpdate[] = [];
    const pasted = vi.fn();
    const transfers = new FileTransfers({ send: (f) => (frames.push(f), true), onUpdate: (u) => updates.push(u), onPasteReady: pasted, chunkBytes: 4, window: 2 });
    const id = transfers.start('paste', [file('a.md', 'abcdefghij', 'text/markdown'), file('empty.txt', ''), file('b.txt', 'xyz')])!;
    await settle();
    expect(frames[0]).toEqual({ t: 'file_begin', id, action: 'paste', files: [
      { name: 'a.md', type: 'text/markdown', size: 10 }, { name: 'empty.txt', type: 'text/plain', size: 0 }, { name: 'b.txt', type: 'text/plain', size: 3 },
    ] });
    // Two chunks ahead of the agent at most.
    expect(frames.slice(1).map((f) => [f.file, decode(f.chunk as string)])).toEqual([[0, 'abcd'], [0, 'efgh']]);
    transfers.handle({ id, status: 'progress', received: 8 });
    await settle();
    // A chunk never spans files; the empty file has none.
    expect(frames.slice(3).map((f) => f.t === 'file_chunk' ? [f.file, decode(f.chunk as string)] : f.t)).toEqual([[0, 'ij'], [2, 'xyz'], 'file_end']);
    transfers.handle({ id, status: 'done' });
    expect(pasted).toHaveBeenCalledOnce();
    expect(updates.at(-1)).toMatchObject({ state: 'done', received: 13 });
  });

  it('refuses what the agent would refuse and reports agent errors', async () => {
    const updates: TransferUpdate[] = [];
    const transfers = new FileTransfers({ send: () => true, onUpdate: (u) => updates.push(u) });
    expect(transfers.start('drop', [{ ...file('big', ''), size: 51 * 1024 * 1024 }], { x: 1, y: 1 })).toBeNull();
    expect(updates.at(-1)).toMatchObject({ state: 'error', reason: 'too_large' });
    const id = transfers.start('drop', [file('a.txt', 'a')], { x: 10.4, y: 20.6 })!;
    await settle();
    transfers.handle({ id, status: 'error', reason: 'not_on_page' });
    expect(updates.at(-1)).toMatchObject({ id, state: 'error', reason: 'not_on_page' });
  });

  it('gives up on an agent that never answers, and on a lost socket', async () => {
    vi.useFakeTimers();
    const frames: Record<string, unknown>[] = [];
    const updates: TransferUpdate[] = [];
    const transfers = new FileTransfers({ send: (f) => (frames.push(f), true), onUpdate: (u) => updates.push(u), timeoutMs: 1000 });
    const id = transfers.start('paste', [file('a.txt', 'a')])!;
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames.at(-1)).toEqual({ t: 'file_cancel', id });
    expect(updates.at(-1)).toMatchObject({ state: 'error', reason: 'timeout' });
    transfers.start('paste', [file('b.txt', 'b')]);
    transfers.failAll();
    expect(updates.at(-1)).toMatchObject({ state: 'error', reason: 'disconnected' });
  });

  it('encodes large chunks', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0))).toEqual(bytes);
  });
});

describe('pastedFiles', () => {
  it('pastes copied files and lone images, but text over a picture of it', () => {
    const image = file('image.png', 'png', 'image/png');
    const notes = file('notes.md', '#', 'text/markdown');
    expect(pastedFiles([image], '')).toEqual([image]);
    expect(pastedFiles([image], 'A1\tB1')).toEqual([]);
    expect(pastedFiles([notes], 'notes.md')).toEqual([notes]);
    expect(pastedFiles([], 'text')).toEqual([]);
  });
});

describe('unrotate', () => {
  it('maps a view turned a quarter clockwise back onto the remote screen', () => {
    // A 400×800 portrait box shows an 800×400 picture turned clockwise: the remote top-left
    // corner is at the box's top-right, the remote top-right at its bottom-right.
    const box = { left: 0, top: 0, width: 400, height: 800 };
    const remote = (x: number, y: number) => {
      const local = unrotate(x, y, box);
      return toRemotePoint(local.x, local.y, local.frame, { width: 1600, height: 800 }, null);
    };
    expect(remote(399, 0)).toEqual({ x: 0, y: 2 });
    expect(remote(399, 799)).toEqual({ x: 1598, y: 2 });
    expect(remote(1, 0)).toEqual({ x: 0, y: 798 });
    expect(remote(200, 400)).toEqual({ x: 800, y: 400 });
  });
});
