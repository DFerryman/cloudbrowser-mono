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

  it('reconnects silently after a quiet spell, but reports a drop right after input or with a key held', () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    let held = false;
    const queue = new InputQueue({ transport: () => ({ readyState: 1, send: vi.fn() }), ready: () => true, failed, held: () => held });
    queue.enqueue({ event: 'buttonup' });
    vi.advanceTimersByTime(60_000);
    queue.interrupt('disconnected');
    expect(failed).not.toHaveBeenCalled();
    queue.resume();
    queue.enqueue({ event: 'keydown' });
    queue.interrupt('disconnected');
    expect(failed).toHaveBeenCalledExactlyOnceWith('disconnected');
    queue.resume();
    queue.enqueue({ event: 'keydown' });
    held = true;
    vi.advanceTimersByTime(60_000);
    queue.interrupt('disconnected');
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it('settles input the gateway confirmed, and keeps unconfirmed input at risk however long the close takes', () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const queue = new InputQueue({ transport: () => ({ readyState: 1, send: vi.fn() }), ready: () => true, failed });
    queue.enqueue({ event: 'buttondown' });
    queue.enqueue({ event: 'buttonup' });
    queue.acknowledge(queue.sent);
    // Confirmed a moment ago: a drop now lost nothing.
    queue.interrupt('disconnected');
    expect(failed).not.toHaveBeenCalled();
    queue.resume();
    queue.acknowledge(0);
    queue.enqueue({ event: 'keydown' });
    // Sent into a socket that died without closing: still at risk when its close arrives late.
    vi.advanceTimersByTime(60_000);
    expect(queue.unconfirmed).toBe(true);
    queue.interrupt('disconnected');
    expect(failed).toHaveBeenCalledExactlyOnceWith('disconnected');
    // Past the gateway (the VM's relay), only time settles input, whatever the gateway confirmed.
    queue.resume();
    queue.enqueue({ event: 'keyup' });
    queue.acknowledge(queue.sent);
    queue.interrupt('relay', false, { beyondGateway: true });
    expect(failed).toHaveBeenLastCalledWith('relay');
  });

  it('keeps input that was held and never sent for the next connection, unless sent input was at risk', () => {
    const failed = vi.fn();
    let ready = false;
    const send = vi.fn();
    const queue = new InputQueue({ transport: () => ({ readyState: 1, send }), ready: () => ready, failed });
    queue.enqueue({ event: 'buttondown' });
    expect(queue.interrupt('disconnected', false, { keepQueued: true })).toBe(true);
    expect(failed).not.toHaveBeenCalled();
    ready = true;
    queue.flush();
    expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'buttondown' }));
    // Something sent moments ago on the old connection: that loss is reported, and nothing is kept.
    ready = false;
    queue.enqueue({ event: 'buttonup' });
    expect(queue.interrupt('disconnected', false, { keepQueued: true })).toBe(false);
    expect(failed).toHaveBeenCalledExactlyOnceWith('disconnected');
    expect(queue.queued).toBe(0);
  });
});
