import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputQueue } from '../src/input-queue.js';

afterEach(() => vi.useRealTimers());

describe('one ordered input transport', () => {
  it('buffers before readiness and preserves mouse/text/key order through real backpressure pauses', async () => {
    vi.useFakeTimers();
    let ready = false;
    const received: string[] = [];
    const transport = { readyState: 1, bufferedAmount: 0, send(data: string) {
      received.push(JSON.parse(data).event);
      this.bufferedAmount += 100;
    } };
    const failed = vi.fn();
    const queue = new InputQueue({ transport: () => transport, ready: () => ready, failed, highWaterBytes: 100 });
    for (const event of ['move', 'wheel', 'keydown', 'text', 'keyup', 'paste', 'buttondown', 'buttonup']) queue.enqueue({ event });
    expect(received).toEqual([]);
    ready = true;
    queue.flush();
    expect(received).toEqual(['move']);
    // A delayed first socket write cannot be overtaken by keys, text, clipboard, or pointer-up.
    for (let i = 0; i < 7; i++) {
      transport.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(received).toEqual(['move', 'wheel', 'keydown', 'text', 'keyup', 'paste', 'buttondown', 'buttonup']);
    expect(failed).not.toHaveBeenCalled();
    queue.clear();
  });

  it('reports bounded-buffer overflow and never replays canceled clicks after reconnect', () => {
    let ready = false;
    const send = vi.fn();
    const failed = vi.fn();
    const queue = new InputQueue({ transport: () => ({ readyState: 1, send }), ready: () => ready, failed, maxEvents: 2 });
    expect(queue.enqueue({ event: 'buttondown' })).toBe(true);
    expect(queue.enqueue({ event: 'buttonup' })).toBe(true);
    expect(queue.enqueue({ event: 'text' })).toBe(false);
    expect(failed).toHaveBeenCalledExactlyOnceWith('overflow');
    ready = true;
    queue.resume();
    queue.flush();
    expect(send).not.toHaveBeenCalled();
    queue.enqueue({ event: 'new move' });
    expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'new move' }));
  });

  it('reports UTF-8 byte overflow and a send exception once, without silently retrying input', () => {
    const failed = vi.fn();
    const queue = new InputQueue({ transport: () => null, ready: () => false, failed, maxBytes: 20 });
    expect(queue.enqueue({ text: '中文中文' })).toBe(false);
    expect(failed).toHaveBeenCalledExactlyOnceWith('overflow');
    const send = vi.fn(() => { throw new Error('closed socket'); });
    const broken = new InputQueue({ transport: () => ({ readyState: 1, send }), ready: () => true, failed });
    expect(broken.enqueue({ event: 'keydown' })).toBe(true);
    expect(broken.enqueue({ event: 'keyup' })).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenLastCalledWith('transport');
  });
});
