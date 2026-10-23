import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openLiveEvents } from '../src/lib/events.js';
import { queryClient } from '../src/lib/query.js';

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  onerror: ((event: Event) => void) | null = null;
  listeners = new Map<string, (event: MessageEvent) => void>();
  constructor() {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data: unknown = {}) {
    this.readyState = 1;
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  FakeSource.all = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const invalidated = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map(([filters]) => (filters as { queryKey: unknown[] }).queryKey.join('/'));

it('refreshes the account on each ready, and replaces a closed stream with backoff', () => {
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  const stop = openLiveEvents(() => new FakeSource() as unknown as EventSource);
  FakeSource.all[0]!.emit('ready');
  expect(invalidated(invalidate)).toEqual(['instances', 'me', 'billing']);

  // A dropped stream the browser reconnects by itself is left alone.
  FakeSource.all[0]!.fail(0);
  vi.advanceTimersByTime(120_000);
  expect(FakeSource.all).toHaveLength(1);

  // A closed one is replaced after 1 s, then 2 s, and the wait starts over after a ready.
  FakeSource.all[0]!.fail(2);
  vi.advanceTimersByTime(999);
  expect(FakeSource.all).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(FakeSource.all).toHaveLength(2);
  FakeSource.all[1]!.fail(2);
  vi.advanceTimersByTime(1_999);
  expect(FakeSource.all).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(FakeSource.all).toHaveLength(3);
  invalidate.mockClear();
  FakeSource.all[2]!.emit('ready');
  expect(invalidated(invalidate)).toEqual(['instances', 'me', 'billing']);
  FakeSource.all[2]!.fail(2);
  vi.advanceTimersByTime(1_000);
  expect(FakeSource.all).toHaveLength(4);

  stop();
  expect(FakeSource.all[3]!.readyState).toBe(2);
  FakeSource.all[3]!.fail(2);
  vi.advanceTimersByTime(120_000);
  expect(FakeSource.all).toHaveLength(4);
});

it('invalidates the browser an event names', () => {
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  const stop = openLiveEvents(() => new FakeSource() as unknown as EventSource);
  FakeSource.all[0]!.emit('instance.updated', { instanceId: 'i1' });
  expect(invalidated(invalidate)).toEqual(['instances', 'instance/i1', 'me', 'billing']);
  stop();
});
