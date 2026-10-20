import { createDb, prepaidBalance } from '@cloudbrowser/db';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promotionSweep } from '../src/promotions.js';
import { accessToken, adminCall, configureAdmin, mockAccessJwks, prepareAdminKeys } from './admin-helpers.js';
import { setup, signIn } from './helpers.js';

const SEED = 'first-browser-20-minutes';
let t: ReturnType<typeof setup>;
let token: string;
const callAdmin = (method: string, path: string, body?: unknown) => adminCall(t, token, method, path, body);

async function user(email = 'user@example.com') {
  t.d1.sqlite.prepare('INSERT OR IGNORE INTO invites (email) VALUES (?)').run(email);
  await signIn(t, email);
  return (t.d1.sqlite.prepare('SELECT id FROM user WHERE email = ?').get(email) as { id: string }).id;
}

let browsers = 0;
/** A browser with `minutes` of metered running time today (what the engine's meter records). */
function browser(userId: string, minutes: number) {
  const id = `inst_${++browsers}`;
  const now = Date.now();
  t.d1.sqlite.prepare(`INSERT INTO browser_instances (id, user_id, name, region_id, status, desired_state, idle_timeout_s, locale, screen, video_quality, video_auto, fingerprint, created_at, updated_at)
    VALUES (?, ?, 'b', 'tyo1', 'sleeping', 'stopped', 1800, 'en-US', '1280x800', 'full', 1, '{}', ?, ?)`).run(id, userId, now, now);
  run(id, userId, minutes);
  return id;
}
function run(instanceId: string, userId: string, minutes: number) {
  // One row per minute, as the meter adds 1/60 h at a time (floating point included).
  for (let i = 0; i < minutes; i++) {
    t.d1.sqlite.prepare(`INSERT INTO usage_records (instance_id, user_id, region_id, item, day, unit_price_micros, unit_cost_micros, quantity, amount_micros, cost_micros, charged_micros, updated_at)
      VALUES (?, ?, 'tyo1', 'compute', ?, 0, 100000, ?, 0, 0, 0, ?)
      ON CONFLICT DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`).run(instanceId, userId, new Date().toISOString().slice(0, 10), 1 / 60, Date.now());
  }
}
const promotions = async () => (await t.call('GET', '/api/v1/promotions')).body as { id: string; status: string; progress: number; target: number; rewardMicros: number; needsTopup: boolean }[];

beforeAll(prepareAdminKeys);
beforeEach(async () => {
  t = setup();
  configureAdmin(t);
  mockAccessJwks();
  token = await accessToken();
});
afterEach(() => vi.unstubAllGlobals());

describe('promotions', () => {
  it('ships the first-browser task: one browser used for 20 minutes earns $5 once', async () => {
    const id = await user();
    expect(await promotions()).toEqual([expect.objectContaining({ id: SEED, status: 'pending', progress: 0, target: 20, rewardMicros: 5_000_000, criterion: 'browser_running_minutes', actionUrl: '/browsers/new' })]);

    // Two browsers with 15 minutes each are not one browser with 20.
    const first = browser(id, 15);
    browser(id, 15);
    expect((await promotions())[0]).toMatchObject({ status: 'pending', progress: 15 });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(0);

    run(first, id, 5);
    expect((await promotions())[0]).toMatchObject({ status: 'completed', progress: 20 });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(5_000_000);
    const tx = (await t.call('GET', '/api/v1/billing/transactions')).body;
    expect(tx).toEqual([expect.objectContaining({ kind: 'promotion', amountMicros: 5_000_000, description: 'Run your first browser for 20 minutes' })]);

    // Opening the page again, more use, and the cron never pay twice.
    run(first, id, 30);
    await promotions();
    await promotionSweep(null, createDb(t.d1));
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(5_000_000);
  });

  it('credits finished tasks from the cron without the user opening the page', async () => {
    const id = await user();
    browser(id, 21);
    expect(await promotionSweep(null, createDb(t.d1))).toEqual({ completed: 1, credited: 1 });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(5_000_000);
    expect(await promotionSweep(null, createDb(t.d1))).toEqual({ completed: 0, credited: 0 });
  });

  it('lets operators configure tasks: criterion, reward, budget, top-up requirement and window', async () => {
    const task = {
      title: { en: 'Turn on two-step verification', 'zh-CN': '开启两步验证' },
      description: { en: 'Protect your account.', 'zh-CN': '保护你的账户。' },
      actionUrl: '/account',
      criterion: 'browsers_created',
      target: 2,
      rewardMicros: 1_000_000,
      enabled: true,
      requiresTopup: false,
      sortOrder: 5,
      startsAt: null,
      endsAt: null,
      maxCompletions: 1,
      reason: 'Launch onboarding',
    };
    expect((await callAdmin('PUT', '/api/v1/admin/promotions/Bad_Id', task)).status).toBe(400);
    expect((await callAdmin('PUT', '/api/v1/admin/promotions/two-browsers', { ...task, actionUrl: 'https://evil.test' })).status).toBe(400);
    expect((await callAdmin('PUT', '/api/v1/admin/promotions/two-browsers', task)).status).toBe(200);
    // Turn the seeded task off: it is no longer offered.
    const [seed] = (await callAdmin('GET', '/api/v1/admin/promotions')).body;
    expect(seed).toMatchObject({ id: SEED, completions: 0 });
    const { id: _, createdAt: _c, updatedAt: _u, updatedBy: _b, completions: _n, credited: _r, paidMicros: _p, ...seedInput } = seed;
    expect((await callAdmin('PUT', `/api/v1/admin/promotions/${SEED}`, { ...seedInput, enabled: false, reason: 'Pause' })).status).toBe(200);

    const a = await user('a@example.com');
    browser(a, 0);
    browser(a, 0);
    const cookieA = t.cookie();
    expect(await promotions()).toEqual([expect.objectContaining({ id: 'two-browsers', status: 'completed', rewardMicros: 1_000_000 })]);
    // The budget of one completion is used up: the next account is not offered it.
    const b = await user('b@example.com');
    browser(b, 0);
    browser(b, 0);
    expect(await promotions()).toEqual([]);
    expect((await prepaidBalance(createDb(t.d1), b)).balanceMicros).toBe(0);

    const list = (await callAdmin('GET', '/api/v1/admin/promotions')).body;
    expect(list.find((x: { id: string }) => x.id === 'two-browsers')).toMatchObject({ completions: 1, credited: 1, paidMicros: 1_000_000 });
    expect((await callAdmin('GET', '/api/v1/admin/promotions/two-browsers/completions')).body).toEqual([expect.objectContaining({ email: 'a@example.com', rewardMicros: 1_000_000 })]);
    // A completed task cannot be deleted; an untouched one can.
    expect((await callAdmin('DELETE', '/api/v1/admin/promotions/two-browsers', { reason: 'Cleanup' })).status).toBe(409);
    expect((await callAdmin('DELETE', `/api/v1/admin/promotions/${SEED}`, { reason: 'Cleanup' })).status).toBe(200);
    const audit = t.d1.sqlite.prepare("SELECT action FROM audit_log WHERE target LIKE 'promotion:%' ORDER BY id").all().map((r) => (r as { action: string }).action);
    expect(audit).toEqual(['promotion.create', 'promotion.update', 'promotion.delete']);

    // A task that needs a paid top-up waits for one.
    t.setCookie(cookieA);
    expect((await callAdmin('PUT', '/api/v1/admin/promotions/topup-first', { ...task, maxCompletions: null, requiresTopup: true, criterion: 'browsers_created', target: 1 })).status).toBe(200);
    expect((await promotions()).find((x) => x.id === 'topup-first')).toMatchObject({ status: 'pending', needsTopup: true, progress: 1 });
    t.d1.sqlite.prepare(`INSERT INTO balance_transactions (id, user_id, kind, amount_micros, reference, actor, created_at, applied_at) VALUES ('tx1', ?, 'topup', 10000000, 'order:1', 'creem', ?, ?)`).run(a, Date.now(), Date.now());
    expect((await promotions()).find((x) => x.id === 'topup-first')).toMatchObject({ status: 'completed', needsTopup: false });

    // A task that has ended is not offered to someone who has not finished it.
    expect((await callAdmin('PUT', '/api/v1/admin/promotions/ended', { ...task, maxCompletions: null, startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-02-01T00:00:00Z' })).status).toBe(200);
    expect((await promotions()).map((x) => x.id)).not.toContain('ended');
  });
});
