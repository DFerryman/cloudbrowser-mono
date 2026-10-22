import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionHeartbeat, viewingPresence, type SessionHeartbeatBody } from '../src/features/session/heartbeat.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([
  ['visible', true, true, true],
  ['hidden', true, true, false],
  ['visible', false, true, false],
  ['visible', true, false, false],
  [undefined, true, true, null],
  ['unknown', true, true, null],
] as const)('gates presence on visibility %s, live %s and playback %s', (visibility, live, displaying, expected) => {
  expect(viewingPresence(visibility, live, displaying)).toBe(expected);
});

function setup(send = vi.fn(async (_body: SessionHeartbeatBody, _signal: AbortSignal) => 'ok')) {
  let input = false;
  let viewing: boolean | null = true;
  let sequence = 0;
  const result = vi.fn();
  const error = vi.fn();
  const heartbeat = sessionHeartbeat({
    takeInput: () => { const old = input; input = false; return old; },
    viewing: () => viewing,
    nextSequence: () => ++sequence,
    send, result, error,
  });
  return { heartbeat, send, result, error, setInput: () => { input = true; }, setViewing: (value: boolean | null) => { viewing = value; } };
}

it('renews visible viewing without manufacturing input and keeps reporting hidden state without input', async () => {
  const t = setup();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(t.send.mock.calls.map(([body]) => body)).toEqual([1, 2, 3].map((sequence) => ({ input: false, presence: { sequence, viewing: true } })));
  t.setViewing(false);
  t.heartbeat.refresh();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(t.send.mock.calls.slice(3).map(([body]) => body)).toEqual([4, 5].map((sequence) => ({ input: false, presence: { sequence, viewing: false } })));
  t.heartbeat.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('coalesces hide and input while a request is pending, then sends only the newest presence', async () => {
  let resolve!: (value: string) => void;
  const send = vi.fn((_body: SessionHeartbeatBody, _signal: AbortSignal) => new Promise<string>((done) => { resolve = done; }));
  const t = setup(send);
  await vi.advanceTimersByTimeAsync(0);
  t.setInput();
  t.setViewing(false);
  t.heartbeat.refresh();
  t.heartbeat.refresh();
  expect(send).toHaveBeenCalledTimes(1);
  resolve('first');
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]?.[0]).toEqual({ input: true, presence: { sequence: 2, viewing: false } });
  resolve('second');
  await vi.advanceTimersByTimeAsync(0);
  t.heartbeat.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('times out a stalled request and flushes a newer hide without waiting for an uncancellable fetch', async () => {
  let resolveOld!: (value: string) => void;
  const send = vi.fn((_body: SessionHeartbeatBody, _signal: AbortSignal) => new Promise<string>((done) => { resolveOld = done; }));
  const t = setup(send);
  await vi.advanceTimersByTimeAsync(0);
  const old = resolveOld;
  send.mockImplementationOnce(async () => 'hidden');
  t.setViewing(false);
  t.heartbeat.refresh();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(send.mock.calls[0]?.[1].aborted).toBe(true);
  expect(send.mock.calls[1]?.[0]).toEqual({ input: false, presence: { sequence: 2, viewing: false } });
  expect(t.error).toHaveBeenCalledTimes(1);
  expect(t.result).toHaveBeenCalledExactlyOnceWith('hidden');
  old('obsolete');
  await vi.advanceTimersByTimeAsync(0);
  expect(t.result).toHaveBeenCalledTimes(1);
  t.heartbeat.dispose();
});

it('retains real input after failure and waits for the next cadence instead of retrying forever', async () => {
  const t = setup();
  await vi.advanceTimersByTimeAsync(0);
  t.send.mockRejectedValueOnce(new Error('offline'));
  t.setViewing(null);
  t.setInput();
  t.heartbeat.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(t.send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.send.mock.calls[2]?.[0]).toEqual({ input: true, presence: { sequence: 3, viewing: null } });
  t.heartbeat.dispose();
});

it('aborts and suppresses late results after disposal', async () => {
  let resolve!: (value: string) => void;
  const t = setup(vi.fn((_body: SessionHeartbeatBody, _signal: AbortSignal) => new Promise<string>((done) => { resolve = done; })));
  await vi.advanceTimersByTimeAsync(0);
  t.heartbeat.dispose();
  resolve('late');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.result).not.toHaveBeenCalled();
  expect(t.error).not.toHaveBeenCalled();
  expect(t.send).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not replay one input forever when the server receives requests but responses keep failing', async () => {
  const t = setup();
  await vi.advanceTimersByTimeAsync(0);
  t.send.mockRejectedValue(new Error('response lost'));
  t.setViewing(false);
  t.setInput();
  t.heartbeat.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.send.mock.calls.slice(1).map(([body]) => body.input)).toEqual([true, true, false, false, false]);
  expect(t.send.mock.calls.slice(1).every(([body]) => body.presence.viewing === false)).toBe(true);
  t.heartbeat.dispose();
});
