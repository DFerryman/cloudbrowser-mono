import { createDb } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billingSweep } from '../src/billing/sweep.js';
import { alertRecipients, deliverAlerts, inventoryAlerts, promotionBudgetAlerts, userMilestoneAlerts } from '../src/notifications/admin.js';
import { LOW_BALANCE_COOLDOWN_MS, REWARD_BATCH_MS, REWARD_COOLDOWN_MS, rewardNotices } from '../src/notifications/user.js';
import { setup, signIn } from './helpers.js';

const DAY = 86_400_000;
let t: ReturnType<typeof setup>;
let userId: string;
const db = () => createDb(t.d1 as never);
const alertTitles = () => (t.d1.sqlite.prepare('SELECT title FROM alerts ORDER BY id').all() as { title: string }[]).map((a) => a.title);

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.prepare('INSERT OR IGNORE INTO invites (email) VALUES (?)').run('user@example.com');
  await signIn(t, 'user@example.com');
  userId = (t.d1.sqlite.prepare('SELECT id FROM user').get() as { id: string }).id;
});

afterEach(() => vi.restoreAllMocks());

describe('user notifications', () => {
  it('emails a low balance once per dip, and no more than once per cooldown when it hovers around the threshold', async () => {
    t.d1.sqlite.exec(`INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = 'true'`);
    t.d1.sqlite.exec(`INSERT INTO billing_accounts (user_id, balance_micros, updated_at) VALUES ('${userId}', 1500000, ${Date.now()})`);
    const start = Date.now();
    const sweep = async (at: number) => (await billingSweep(t.env as never, db(), null, new Date(at), { nightly: false })).lowBalance;
    const setBalance = (micros: number) => t.d1.sqlite.exec(`UPDATE billing_accounts SET balance_micros = ${micros} WHERE user_id = '${userId}'`);
    expect(await sweep(start)).toBe(1);
    expect(await sweep(start + 60_000)).toBe(0);
    // A small top-up re-arms it, but a new dip a few hours later waits for the cooldown.
    setBalance(5_000_000);
    expect(await sweep(start + 3_600_000)).toBe(0);
    setBalance(1_000_000);
    expect(await sweep(start + 2 * 3_600_000)).toBe(0);
    expect(await sweep(start + LOW_BALANCE_COOLDOWN_MS)).toBe(1);
    expect(t.emails.filter((m) => /balance is low/.test(m.subject ?? ''))).toHaveLength(2);
  });

  it('confirms rewards in one email, batched and at most once a day', async () => {
    const now = Date.now();
    t.d1.sqlite.exec(`INSERT INTO billing_accounts (user_id, balance_micros, updated_at) VALUES ('${userId}', 7000000, ${now})`);
    const task = (id: string, en: string) => t.d1.sqlite.prepare(`INSERT INTO promotion_tasks (id, title, description, criterion, target, reward_micros, created_at, updated_at)
      VALUES (?, ?, '{"en":"d","zh-CN":"d"}', 'browsers_created', 1, 1000000, ?, ?)`).run(id, JSON.stringify({ en, 'zh-CN': `${en}（中文）` }), now, now);
    const complete = (id: string, at: number, reward = 1_000_000) => t.d1.sqlite.prepare(`INSERT INTO promotion_completions (task_id, user_id, progress, reward_micros, completed_at, credited_at)
      VALUES (?, ?, 1, ?, ?, ?)`).run(id, userId, reward, at, at);
    const rewardEmails = () => t.emails.filter((m) => /in Nevazu credit/.test(m.subject ?? ''));
    for (const [id, en] of [['a', 'Open a browser'], ['b', 'Turn on 2FA'], ['c', 'Add a passkey'], ['z', 'Nothing']]) task(id, en);

    complete('a', now);
    complete('b', now + 60_000);
    complete('z', now, 0);
    expect(await rewardNotices(t.env as never, db(), new Date(now + 60_000))).toBe(0); // still collecting
    expect(await rewardNotices(t.env as never, db(), new Date(now + REWARD_BATCH_MS))).toBe(1);
    expect(rewardEmails()).toHaveLength(1);
    expect(rewardEmails()[0]).toMatchObject({ to: 'user@example.com', subject: 'You earned $2.00 in Nevazu credit from 2 rewards' });
    expect(rewardEmails()[0]!.text).toContain('Open a browser: $1.00');
    expect(rewardEmails()[0]!.text).toContain('Turn on 2FA（中文）');
    expect(rewardEmails()[0]!.text).toContain('balance is now $7.00');

    // A later reward waits for the cooldown, then gets its own email; nothing is sent twice.
    complete('c', now + 2 * REWARD_BATCH_MS);
    expect(await rewardNotices(t.env as never, db(), new Date(now + 4 * REWARD_BATCH_MS))).toBe(0);
    expect(await rewardNotices(t.env as never, db(), new Date(now + REWARD_BATCH_MS + REWARD_COOLDOWN_MS))).toBe(1);
    expect(await rewardNotices(t.env as never, db(), new Date(now + 3 * REWARD_COOLDOWN_MS))).toBe(0);
    expect(rewardEmails().map((m) => m.subject)).toEqual(['You earned $2.00 in Nevazu credit from 2 rewards', 'You earned $1.00 in Nevazu credit']);
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM promotion_completions WHERE notified_at IS NULL').get()).toEqual({ n: 0 });
  });
});

describe('admin notifications', () => {
  it('alerts once when a region runs out of inventory, and once when it is back', async () => {
    const now = Date.now();
    t.d1.sqlite.exec(`
      INSERT INTO aws_provider_regions (region_id,provider_region,opt_in_status,status,capacity,checked_at) SELECT id,provider_region,'opted-in','ready',1,${now} FROM regions WHERE id='tyo1';
      INSERT OR REPLACE INTO provider_prices (region_id,executor,provider_region,sheet,fetched_at) SELECT id,executor,provider_region,'{"vmHour":0.1,"ipHour":0.005,"volumeGbMonth":0.08,"rootVolumeGb":16}',${now} FROM regions WHERE id='tyo1';`);
    expect(await inventoryAlerts(db(), new Date(now))).toBe(0);
    t.d1.sqlite.exec(`UPDATE aws_provider_regions SET capacity=0 WHERE region_id='tyo1'`);
    expect(await inventoryAlerts(db(), new Date(now))).toBe(1);
    expect(await inventoryAlerts(db(), new Date(now + 300_000))).toBe(0);
    // Acknowledging it does not make it repeat while the region is still empty.
    t.d1.sqlite.exec(`UPDATE alerts SET acknowledged_at = ${now}`);
    expect(await inventoryAlerts(db(), new Date(now + 600_000))).toBe(0);
    t.d1.sqlite.exec(`UPDATE aws_provider_regions SET capacity=2 WHERE region_id='tyo1'`);
    expect(await inventoryAlerts(db(), new Date(now + 900_000))).toBe(1);
    expect(alertTitles()).toEqual([
      'Region Tokyo (tyo1) has no inventory left: every slot the AWS quota allows is in use; new browsers cannot be created there',
      'Region Tokyo (tyo1) has inventory again (2 available)',
    ]);
  });

  it('alerts once per user milestone', async () => {
    const add = (n: number) => {
      for (let i = 0; i < n; i++) {
        t.d1.sqlite.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, '', ?, 1, ?, ?)`)
          .run(`u_${Math.random()}`, `${Math.random()}@example.com`, Date.now(), Date.now());
      }
    };
    expect(await userMilestoneAlerts(db(), new Date())).toBe(0);
    add(9); // 10 users
    expect(await userMilestoneAlerts(db(), new Date())).toBe(1);
    expect(await userMilestoneAlerts(db(), new Date())).toBe(0);
    add(45); // 55: passes 20 and 50 at once, one alert for the highest
    expect(await userMilestoneAlerts(db(), new Date())).toBe(1);
    expect(alertTitles()).toEqual(['Nevazu passed 10 users (10 in total)', 'Nevazu passed 50 users (55 in total)']);
  });

  it('alerts once when a promotion uses up its budget', async () => {
    const now = Date.now();
    t.d1.sqlite.prepare(`INSERT INTO promotion_tasks (id, title, description, criterion, target, reward_micros, max_completions, created_at, updated_at)
      VALUES ('p', '{"en":"Try it","zh-CN":"试试"}', '{"en":"d","zh-CN":"d"}', 'browsers_created', 1, 1000000, 1, ?, ?)`).run(now, now);
    expect(await promotionBudgetAlerts(db(), new Date())).toBe(0);
    t.d1.sqlite.prepare(`INSERT INTO promotion_completions (task_id, user_id, progress, reward_micros, completed_at) VALUES ('p', ?, 1, 1000000, ?)`).run(userId, now);
    expect(await promotionBudgetAlerts(db(), new Date())).toBe(1);
    expect(await promotionBudgetAlerts(db(), new Date())).toBe(0);
    expect(alertTitles()).toEqual(['Promotion "Try it" reached its limit of 1 completions and is no longer offered']);
  });

  it('emails critical alerts to the admin allowlist when no alert address is set', async () => {
    Object.assign(t.env, { ALERT_EMAILS: '', ADMIN_EMAIL_ALLOWLIST: 'ops@example.com, owner@example.com' });
    expect(alertRecipients(t.env as never)).toEqual(['ops@example.com', 'owner@example.com']);
    await userMilestoneAlerts(db(), new Date()); // 1 user: no milestone yet
    t.d1.sqlite.exec(`INSERT INTO alerts (source, severity, title, created_at) VALUES ('api', 'critical', 'Something', ${Date.now()})`);
    expect(await deliverAlerts(t.env as never, db())).toBe(1);
    expect(t.emails.slice(-2).map((m) => [m.to, m.subject])).toEqual([['ops@example.com', '[CRITICAL] Nevazu: Something'], ['owner@example.com', '[CRITICAL] Nevazu: Something']]);
  });

  it.each(['info', 'warning'])('processes %s alerts without email or a webhook and keeps them open in the console', async (severity) => {
    t.emails.length = 0;
    const now = new Date();
    t.d1.sqlite.prepare('INSERT INTO alerts (source, severity, title, created_at) VALUES (?, ?, ?, ?)')
      .run('api', severity, 'Routine update', now.getTime());
    expect(await deliverAlerts(t.env as never, db(), now)).toBe(1);
    expect(t.emails).toHaveLength(0);
    expect(t.d1.sqlite.prepare('SELECT sent_at, acknowledged_at FROM alerts').get())
      .toEqual({ sent_at: now.getTime(), acknowledged_at: null });
    expect(await deliverAlerts(t.env as never, db())).toBe(0);
  });

  it('emails only critical alerts from a mixed batch while the webhook receives all severities', async () => {
    t.emails.length = 0;
    Object.assign(t.env, { ALERT_EMAILS: 'product@example.com', ALERT_WEBHOOK_URL: 'https://chat.example.test/alerts', ADMIN_URL: 'https://admin.example.test' });
    const webhook = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const now = new Date();
    for (const [severity, title] of [['info', 'Routine update'], ['warning', 'Inventory low'], ['critical', 'Launch failed'], ['critical', 'Purge failed']]) {
      t.d1.sqlite.prepare('INSERT INTO alerts (source, severity, title, created_at) VALUES (?, ?, ?, ?)')
        .run('api', severity, title, now.getTime());
    }
    expect(await deliverAlerts(t.env as never, db(), now)).toBe(4);
    expect(t.emails).toEqual([expect.objectContaining({
      to: 'product@example.com',
      subject: '[CRITICAL] Nevazu: 2 new alerts',
      text: '[CRITICAL] api: Launch failed\n[CRITICAL] api: Purge failed\n\nhttps://admin.example.test/alerts',
    })]);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(webhook).toHaveBeenCalledWith('https://chat.example.test/alerts', expect.objectContaining({
      body: JSON.stringify({ text: '[INFO] api: Routine update\n[WARNING] api: Inventory low\n[CRITICAL] api: Launch failed\n[CRITICAL] api: Purge failed\nhttps://admin.example.test/alerts' }),
    }));
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM alerts WHERE sent_at IS NULL').get()).toEqual({ n: 0 });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM alerts WHERE acknowledged_at IS NULL').get()).toEqual({ n: 4 });
    expect(await deliverAlerts(t.env as never, db())).toBe(0);
    expect(t.emails).toHaveLength(1);
    expect(webhook).toHaveBeenCalledTimes(1);
  });

  it('retries failed critical email delivery on the next sweep', async () => {
    t.emails.length = 0;
    const send = vi.spyOn(t.env.EMAIL, 'send').mockRejectedValueOnce(new Error('Email unavailable'));
    t.d1.sqlite.exec(`INSERT INTO alerts (source, severity, title, created_at) VALUES ('api', 'critical', 'Launch failed', ${Date.now()})`);
    expect(await deliverAlerts(t.env as never, db())).toBe(0);
    expect(t.d1.sqlite.prepare('SELECT sent_at FROM alerts').get()).toEqual({ sent_at: null });
    expect(await deliverAlerts(t.env as never, db())).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(t.emails).toHaveLength(1);
    expect(await deliverAlerts(t.env as never, db())).toBe(0);
  });
});
