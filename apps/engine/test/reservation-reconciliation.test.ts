import { createDb, schema } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineDeps } from '../src/context.js';
import { errorMessages, retryD1 } from '../src/errors.js';
import { reconcileReservations } from '../src/prepaid.js';

describe('reservation reconciliation after deletion', () => {
  let d1: ReturnType<typeof createTestD1>;
  let db: ReturnType<typeof createDb>;
  const now = new Date('2026-10-18T16:00:00Z');
  const sleep = vi.fn(async (_ms: number) => {});
  const deps = () => ({ db, now: () => now, sleep }) as EngineDeps;

  beforeEach(async () => {
    d1 = createTestD1();
    db = createDb(d1);
    sleep.mockClear();
    d1.sqlite.exec("UPDATE control_flags SET value='true' WHERE key='billing_required'");
    await db.insert(schema.user).values({ id: 'u1', name: 'User', email: 'test@example.com', createdAt: now, updatedAt: now });
    await db.insert(schema.billingAccounts).values({ userId: 'u1', balanceMicros: 10_000_000, updatedAt: now });
    await db.insert(schema.browserInstances).values({ id: 'deleted', userId: 'u1', name: 'Deleted', regionId: 'tyo1',
      status: 'purged', desiredState: 'deleted', idleTimeoutS: 600, locale: 'en-US', screen: 'auto',
      fingerprint: { timezone: 'UTC', locale: 'en-US', screen: 'auto', chromeMajor: null }, createdAt: now, updatedAt: now });
  });

  afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); });

  async function reserve(amount = 100_000) {
    await db.insert(schema.browserReservations).values({ instanceId: 'deleted', userId: 'u1', requiredMicros: 100_000,
      reservedMicros: amount, fixedHourMicros: 600, rates: { compute: 0, ip: 600, storage: 0, snapshot: 0, transfer: 0 }, updatedAt: new Date(0) });
  }

  it('never writes historical purged browsers with no reservation', async () => {
    const update = vi.spyOn(db, 'update');
    await reconcileReservations(deps());
    expect(update).not.toHaveBeenCalled();
  });

  it('does not rewrite a deposit that has already been released', async () => {
    await reserve(0);
    const update = vi.spyOn(db, 'update');
    await reconcileReservations(deps());
    expect(update).not.toHaveBeenCalled();
    expect((await db.select().from(schema.browserReservations))[0]!.updatedAt).toEqual(new Date(0));
  });

  it('releases held funds once without changing the account balance', async () => {
    await reserve();
    await reconcileReservations(deps());
    const update = vi.spyOn(db, 'update');
    await reconcileReservations(deps());
    expect(update).not.toHaveBeenCalled();
    expect((await db.select().from(schema.browserReservations))[0]).toMatchObject({ reservedMicros: 0, updatedAt: now });
    expect((await db.select().from(schema.billingAccounts))[0]!.balanceMicros).toBe(10_000_000);
  });

  it('retries a nested transient D1 failure during release', async () => {
    await reserve();
    vi.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('Failed query: update browser_reservations', { cause: new Error('D1_ERROR: Network connection lost.') });
    });
    await reconcileReservations(deps());
    expect(sleep).toHaveBeenCalledWith(100);
    expect((await db.select().from(schema.browserReservations))[0]!.reservedMicros).toBe(0);
  });

  it('preserves a deposit when recovery wins the race with cleanup', async () => {
    await reserve();
    const update = db.update.bind(db);
    vi.spyOn(db, 'update').mockImplementationOnce((table) => {
      d1.sqlite.exec("UPDATE browser_instances SET status='sleeping',desired_state='stopped' WHERE id='deleted'");
      return update(table);
    });
    await reconcileReservations(deps());
    expect((await db.select().from(schema.browserReservations))[0]!.reservedMicros).toBe(100_000);
  });
});

describe('D1 error handling', () => {
  it('bounds transient retries and preserves the original error', async () => {
    const error = new Error('Failed query', { cause: new Error('D1 DB reset because its code was updated.') });
    const run = vi.fn(async () => { throw error; });
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(retryD1(run, sleep)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it('does not retry SQL, funding, or unknown errors', async () => {
    for (const message of ['no such table: browser_reservations', 'insufficient_prepaid_reserve', 'unknown failure']) {
      const error = new Error('Failed query', { cause: new Error(message) });
      const run = vi.fn(async () => { throw error; });
      const sleep = vi.fn(async (_ms: number) => {});
      await expect(retryD1(run, sleep)).rejects.toBe(error);
      expect(run).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(errorMessages(error)).toEqual(['Failed query', message]);
    }
  });
});
