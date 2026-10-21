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
/** A browser of the user's, with `minutes` of live-view use (see `view`). */
function browser(userId: string, minutes = 0) {
  const id = `inst_${++browsers}`;
  const now = Date.now();
  t.d1.sqlite.prepare(`INSERT INTO browser_instances (id, user_id, name, region_id, status, desired_state, idle_timeout_s, locale, screen, video_quality, video_auto, fingerprint, created_at, updated_at)
    VALUES (?, ?, 'b', 'tyo1', 'sleeping', 'stopped', 1800, 'en-US', '1280x800', 'full', 1, '{}', ?, ?)`).run(id, userId, now, now);
  if (minutes) view(id, userId, minutes);
  return id;
}
// Sessions are laid end to end after the task started (the seed counts from the migration).
let clock = Date.now() + 1_000;
let sessions = 0;
/**
 * One live-view session of `minutes`. Ended cleanly by default; `abandoned` is a tab closed without
 * ending: its last heartbeat is at `minutes`, and the browser only stamped `ended_at` when it slept,
 * `abandoned` minutes later.
 */
function view(instanceId: string, userId: string, minutes: number, abandoned = 0) {
  const from = clock;
  const seen = from + minutes * 60_000;
  clock = seen + abandoned * 60_000 + 60_000;
  t.d1.sqlite.prepare(`INSERT INTO viewer_sessions (id, instance_id, user_id, started_at, last_seen_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`vs_${++sessions}`, instanceId, userId, from, abandoned ? seen : seen, abandoned ? seen + abandoned * 60_000 : seen);
}
function run(instanceId: string, userId: string, minutes: number) {
  // Billed running time, one row-update per minute as the meter adds 1/60 h at a time.
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

/** Only the first seeded task stays on, so each test looks at the tasks it is about. */
const onlySeed = () => t.d1.sqlite.prepare('UPDATE promotion_tasks SET enabled = 0 WHERE id <> ?').run(SEED);

describe('promotions', () => {
  beforeEach(onlySeed);

  it('ships the first-browser task: one browser used for 20 minutes earns $5 once', async () => {
    const id = await user();
    expect(await promotions()).toEqual([expect.objectContaining({ id: SEED, status: 'pending', progress: 0, target: 20, rewardMicros: 5_000_000, criterion: 'browser_used_minutes', actionUrl: '/browsers/new' })]);

    // Running with nobody watching is not use.
    const first = browser(id);
    run(first, id, 45);
    expect((await promotions())[0]).toMatchObject({ status: 'pending', progress: 0 });

    // Two browsers used 15 minutes each are not one browser used for 20.
    view(first, id, 10);
    view(first, id, 5);
    browser(id, 15);
    expect((await promotions())[0]).toMatchObject({ status: 'pending', progress: 15 });
    // A tab closed without ending counts until its last heartbeat + 1 minute, not until the
    // browser slept 30 minutes later.
    view(first, id, 3, 30);
    expect((await promotions())[0]).toMatchObject({ status: 'pending', progress: 19 });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(0);

    view(first, id, 1);
    expect((await promotions())[0]).toMatchObject({ status: 'completed', progress: 20 });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(5_000_000);
    const tx = (await t.call('GET', '/api/v1/billing/transactions')).body;
    expect(tx).toEqual([expect.objectContaining({ kind: 'promotion', amountMicros: 5_000_000, description: 'Use your first browser for 20 minutes' })]);

    // Opening the page again, more use, and the cron never pay twice.
    view(first, id, 30);
    await promotions();
    await promotionSweep(null, createDb(t.d1), new Date(clock));
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(5_000_000);
  });

  it('does not count use from before the task started', async () => {
    const id = await user();
    const b = browser(id);
    t.d1.sqlite.prepare(`INSERT INTO viewer_sessions (id, instance_id, user_id, started_at, last_seen_at, ended_at) VALUES ('old', ?, ?, ?, ?, ?)`)
      .run(b, id, Date.now() - 86_400_000, Date.now() - 86_400_000 + 3_600_000, Date.now() - 86_400_000 + 3_600_000);
    expect((await promotions())[0]).toMatchObject({ status: 'pending', progress: 0 });
  });

  it('can measure billed running time instead, when an operator chooses it', async () => {
    const id = await user();
    const seed = (await callAdmin('GET', '/api/v1/admin/promotions')).body.find((x: { id: string }) => x.id === SEED);
    const { id: _, createdAt: _c, updatedAt: _u, updatedBy: _b, completions: _n, credited: _r, paidMicros: _p, ...input } = seed;
    expect((await callAdmin('PUT', `/api/v1/admin/promotions/${SEED}`, { ...input, criterion: 'browser_running_minutes', reason: 'Count running time' })).status).toBe(200);
    run(browser(id), id, 20);
    expect((await promotions())[0]).toMatchObject({ status: 'completed', progress: 20 });
  });

  it('credits finished tasks from the cron without the user opening the page', async () => {
    const id = await user();
    browser(id, 21);
    expect(await promotionSweep(null, createDb(t.d1), new Date(clock))).toEqual({ completed: 1, credited: 1 });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(5_000_000);
    expect(await promotionSweep(null, createDb(t.d1), new Date(clock))).toEqual({ completed: 0, credited: 0 });
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
    const seed = (await callAdmin('GET', '/api/v1/admin/promotions')).body.find((x: { id: string }) => x.id === SEED);
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

function topup(userId: string, usd: number, refunded = false) {
  const n = ++topups;
  const now = Date.now();
  t.d1.sqlite.prepare(`INSERT INTO balance_transactions (id, user_id, kind, amount_micros, reference, order_id, actor, created_at, applied_at) VALUES (?, ?, 'topup', ?, ?, ?, 'creem', ?, ?)`)
    .run(`tx_${n}`, userId, usd * 1_000_000, `order:${n}`, `ord_${n}`, now, now);
  if (refunded) {
    t.d1.sqlite.prepare(`INSERT INTO balance_transactions (id, user_id, kind, amount_micros, reference, order_id, actor, created_at, applied_at) VALUES (?, ?, 'refund', ?, ?, ?, 'creem', ?, ?)`)
      .run(`rf_${n}`, userId, -usd * 1_000_000, `refund:${n}`, `ord_${n}`, now, now);
  }
}
let topups = 0;

describe('more promotions', () => {
  const only = (...ids: string[]) =>
    t.d1.sqlite.prepare(`UPDATE promotion_tasks SET enabled = CASE WHEN id IN (${ids.map(() => '?').join(', ')}) THEN 1 ELSE 0 END`).run(...ids);
  const task = async (id: string) => (await promotions()).find((x) => x.id === id) as { status: string; progress: number; needsTopup: boolean; topupToUnlockMicros: number } | undefined;

  it('ships small, scarce rewards that mostly need a top-up', async () => {
    const tasks = (await callAdmin('GET', '/api/v1/admin/promotions')).body as { id: string; rewardMicros: number; maxCompletions: number | null; requiresTopup: boolean; enabled: boolean }[];
    const added = tasks.filter((x) => x.id !== SEED);
    expect(added.length).toBeGreaterThanOrEqual(10);
    for (const x of added) {
      expect(x.enabled).toBe(true);
      expect(x.rewardMicros).toBeGreaterThanOrEqual(1_000_000);
      expect(x.rewardMicros).toBeLessThanOrEqual(10_000_000);
      expect(x.maxCompletions).not.toBeNull();
      expect(x.maxCompletions!).toBeLessThanOrEqual(100);
    }
    expect(added.filter((x) => !x.requiresTopup).map((x) => x.id)).toEqual(['turn-on-two-step']);
    // The console refuses a reward above $10.
    const { id: _, createdAt: _c, updatedAt: _u, updatedBy: _b, completions: _n, credited: _r, paidMicros: _p, ...input } = added[0] as unknown as Record<string, unknown>;
    expect((await callAdmin('PUT', `/api/v1/admin/promotions/${added[0]!.id}`, { ...input, rewardMicros: 10_000_001, reason: 'Too much' })).status).toBe(400);
  });

  it('counts active days: 5 minutes of use on different UTC days', async () => {
    only('three-active-days');
    const id = await user();
    const b = browser(id);
    const day = 86_400_000;
    const start = Math.ceil((Date.now() + 1000) / day) * day;
    const session = (n: number, from: number, minutes: number) => t.d1.sqlite.prepare(`INSERT INTO viewer_sessions (id, instance_id, user_id, started_at, last_seen_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`d_${n}`, b, id, from, from + minutes * 60_000, from + minutes * 60_000);
    session(1, start, 3);
    session(2, start + 3_600_000, 2); // 5 minutes on day one, in two sessions
    session(3, start + day, 4); // only 4 minutes on day two
    session(4, start + 2 * day, 10);
    expect(await task('three-active-days')).toMatchObject({ progress: 2, needsTopup: true });
    session(5, start + 3 * day, 6);
    expect(await task('three-active-days')).toMatchObject({ status: 'pending', progress: 3, needsTopup: true });
    topup(id, 10);
    expect(await task('three-active-days')).toMatchObject({ status: 'completed' });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(2_000_000);
  });

  it('counts regions, storage upgrades, paid usage and top-ups', async () => {
    only('try-a-second-region', 'grow-your-storage', 'usage-15', 'three-topups');
    const id = await user();
    topup(id, 20);
    topup(id, 5, true); // refunded: not counted
    topup(id, 30);
    const b = browser(id);
    expect(await task('try-a-second-region')).toMatchObject({ progress: 1 });
    t.d1.sqlite.prepare(`INSERT INTO browser_instances (id, user_id, name, region_id, status, desired_state, idle_timeout_s, locale, screen, video_quality, video_auto, fingerprint, created_at, updated_at)
      VALUES ('other', ?, 'b', 'usw1', 'sleeping', 'stopped', 1800, 'en-US', '1280x800', 'full', 1, '{}', ?, ?)`).run(id, Date.now() + 1000, Date.now() + 1000);
    const op = (n: number, status: string) => t.d1.sqlite.prepare(`INSERT INTO operations (id, instance_id, user_id, kind, status, deadline_at, created_at, updated_at, finished_at) VALUES (?, ?, ?, 'resize_volume', ?, ?, ?, ?, ?)`)
      .run(`op_${n}`, b, id, status, Date.now() + 60_000, Date.now() + 1000, Date.now() + 1000, Date.now() + 1000);
    op(1, 'failed');
    expect(await task('grow-your-storage')).toMatchObject({ progress: 0 });
    op(2, 'succeeded');
    t.d1.sqlite.prepare(`INSERT INTO usage_records (instance_id, user_id, region_id, item, day, unit_price_micros, unit_cost_micros, quantity, amount_micros, cost_micros, charged_micros, updated_at)
      VALUES (?, ?, 'tyo1', 'compute', ?, 60000, 50000, 250, 15000000, 12500000, 15000000, ?)`).run(b, id, new Date().toISOString().slice(0, 10), Date.now());
    const list = await promotions();
    expect(list.find((x) => x.id === 'try-a-second-region')).toMatchObject({ status: 'completed' });
    expect(list.find((x) => x.id === 'grow-your-storage')).toMatchObject({ status: 'completed' });
    expect(list.find((x) => x.id === 'usage-15')).toMatchObject({ status: 'completed' });
    expect(list.find((x) => x.id === 'three-topups')).toMatchObject({ status: 'pending', progress: 2 });
  });

  it('caps rewards from top-up tasks at half of what the account paid', async () => {
    only('try-a-second-region', 'grow-your-storage', 'usage-15');
    const id = await user();
    topup(id, 6); // room for $3 of rewards
    const b = browser(id);
    t.d1.sqlite.prepare(`INSERT INTO browser_instances (id, user_id, name, region_id, status, desired_state, idle_timeout_s, locale, screen, video_quality, video_auto, fingerprint, created_at, updated_at)
      VALUES ('other', ?, 'b', 'usw1', 'sleeping', 'stopped', 1800, 'en-US', '1280x800', 'full', 1, '{}', ?, ?)`).run(id, Date.now() + 1000, Date.now() + 1000);
    t.d1.sqlite.prepare(`INSERT INTO operations (id, instance_id, user_id, kind, status, deadline_at, created_at, updated_at, finished_at) VALUES ('op', ?, ?, 'resize_volume', 'succeeded', ?, ?, ?, ?)`)
      .run(b, id, Date.now() + 60_000, Date.now() + 1000, Date.now() + 1000, Date.now() + 1000);
    // Both tasks are done ($2 each), but only one fits under the $3 cap.
    const list = await promotions();
    expect(list.filter((x) => x.status === 'completed')).toHaveLength(1);
    const waiting = list.find((x) => x.status === 'pending' && x.progress >= x.target) as unknown as { topupToUnlockMicros: number; needsTopup: boolean };
    expect(waiting).toMatchObject({ needsTopup: false, topupToUnlockMicros: 2_000_000 });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(2_000_000); // the top-ups above are bare ledger rows: only rewards reach the balance
    // The cron respects the cap too.
    expect(await promotionSweep(null, createDb(t.d1), new Date())).toEqual({ completed: 0, credited: 0 });
    topup(id, 2);
    expect((await promotions()).filter((x) => x.status === 'completed')).toHaveLength(2);
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(4_000_000);
  });

  it('pays two-step verification without a top-up', async () => {
    only('turn-on-two-step');
    const id = await user();
    expect(await task('turn-on-two-step')).toMatchObject({ status: 'pending', needsTopup: false });
    t.d1.sqlite.prepare('UPDATE user SET two_factor_enabled = 1 WHERE id = ?').run(id);
    expect(await task('turn-on-two-step')).toMatchObject({ status: 'completed' });
    expect((await prepaidBalance(createDb(t.d1), id)).balanceMicros).toBe(1_000_000);
  });
});
