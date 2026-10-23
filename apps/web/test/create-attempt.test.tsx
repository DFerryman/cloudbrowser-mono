import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useCreateInstance } from '../src/features/instances/hooks.js';
import { api, ApiError } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', async (original) => ({ ...await original(), api: vi.fn() }));

let latest: ReturnType<typeof useCreateInstance>;
let rendered: ReturnType<typeof create>;
function Harness() { latest = useCreateInstance(); return null; }
const body = { name: 'Work', regionId: 'tyo1', storageGb: 10, priceVersion: 'v1', agentAccess: true } as const;
const keys = () => vi.mocked(api).mock.calls.map(([, , opts]) => opts?.idempotencyKey);
async function submit(input: Parameters<typeof latest.mutateAsync>[0]) {
  await act(async () => { await latest.mutateAsync(input).catch(() => {}); });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(api).mockReset();
  await act(async () => {
    rendered = create(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(Harness)));
  });
});
afterEach(async () => { await act(async () => rendered.unmount()); vi.unstubAllGlobals(); });

test('retries one creation attempt with one Idempotency-Key, and starts a new one for other choices, after success or on closing', async () => {
  // The first response is lost; the retry must find that request's browser instead of creating another.
  vi.mocked(api).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await submit(body);
  vi.mocked(api).mockRejectedValueOnce(new ApiError(503, { type: 'internal', title: 'Unavailable', status: 503 }));
  await submit(body);
  // A price refresh in between is still the same attempt.
  vi.mocked(api).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await submit({ ...body, priceVersion: 'v2' });
  // Another name (or region, machine, agent access) is another browser.
  vi.mocked(api).mockResolvedValueOnce({ operationId: 'op1', instanceId: 'i1' });
  await submit({ ...body, name: 'Shopping' });
  const [first, retry, refreshed, renamed] = keys();
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect([retry, refreshed]).toEqual([first, first]);
  expect(renamed).not.toBe(first);

  // After a success the same choices create another browser.
  vi.mocked(api).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await submit({ ...body, name: 'Shopping' });
  expect(keys()[4]).not.toBe(renamed);
  // So does submitting again after the dialog was closed.
  act(() => latest.newAttempt());
  vi.mocked(api).mockResolvedValueOnce({ operationId: 'op2', instanceId: 'i2' });
  await submit({ ...body, name: 'Shopping' });
  expect(new Set(keys()).size).toBe(4);
  expect(vi.mocked(api).mock.calls.every(([method, path]) => method === 'POST' && path === '/instances')).toBe(true);
});
