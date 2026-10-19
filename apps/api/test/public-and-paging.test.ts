import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessToken, adminCall, configureAdmin, mockAccessJwks, prepareAdminKeys } from './admin-helpers.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
beforeAll(prepareAdminKeys);
beforeEach(() => {
  t = setup();
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('pilot@example.com')`);
});
afterEach(() => vi.unstubAllGlobals());

describe('public pages', () => {
  it('serves the price list without a session and only for enabled regions', async () => {
    const res = await t.call('GET', '/api/public/pricing');
    expect(res.status).toBe(200);
    const enabled = (t.d1.sqlite.prepare('SELECT id FROM regions WHERE enabled = 1 ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(res.body.regions.map((r: { regionId: string }) => r.regionId)).toEqual(enabled);
    expect(res.body.regions[0]).toMatchObject({ available: true, acceptingNew: true, rates: { compute: expect.any(Number) } });
    expect(res.body.regions[0]).not.toHaveProperty('version');
    expect(res.body).toMatchObject({ retentionDays: 7, trial: { regionId: 'syd1', minutes: 10 }, minBalanceMicros: expect.any(Number) });
  });

  it('reports status and a paused creation switch', async () => {
    const ok = await t.call('GET', '/api/public/status');
    expect(ok.status).toBe(200);
    expect(ok.body.components.find((c: { id: string }) => c.id === 'database').status).toBe('operational');
    // Sydney is switched off until configured: not offered, so not listed (and not an outage).
    expect(ok.body.regions.some((r: { regionId: string }) => r.regionId === 'syd1')).toBe(false);
    expect(ok.body.status).toBe('operational');
    expect(ok.body.creationPaused).toBe(false);
    t.d1.sqlite.exec(`INSERT INTO control_flags (key, value, reason, updated_at) VALUES ('creation_freeze', 'true', 'test', 0)`);
    const paused = await t.call('GET', '/api/public/status');
    expect(paused.body.creationPaused).toBe(true);
    expect(paused.body.status).toBe('degraded');
    expect(paused.body.regions.find((r: { regionId: string }) => r.regionId === 'tyo1')).toMatchObject({ acceptingNew: false, status: 'degraded' });
  });

  it('accepts no writes', async () => {
    expect((await t.call('POST', '/api/public/status', {})).status).toBe(404);
  });
});

describe('paging', () => {
  it('pages credit history with limit and offset, newest first', async () => {
    await signIn(t, 'pilot@example.com');
    const me = await t.call('GET', '/api/v1/me');
    const insert = t.d1.sqlite.prepare(
      `INSERT INTO balance_transactions (id, user_id, kind, amount_micros, description, reference, actor, created_at) VALUES (?, ?, 'adjustment', ?, 'x', ?, 'system', ?)`,
    );
    for (let i = 0; i < 5; i++) insert.run(`tx${i}`, me.body.user.id, (i + 1) * 1000, `ref${i}`, 1_700_000_000_000 + i);
    const all = await t.call('GET', '/api/v1/billing/transactions');
    expect(all.body.map((x: { id: string }) => x.id)).toEqual(['tx4', 'tx3', 'tx2', 'tx1', 'tx0']);
    const second = await t.call('GET', '/api/v1/billing/transactions?limit=2&offset=2');
    expect(second.body.map((x: { id: string }) => x.id)).toEqual(['tx2', 'tx1']);
    expect((await t.call('GET', '/api/v1/billing/transactions?limit=0')).status).toBe(400);
  });

  it('pages admin lists', async () => {
    configureAdmin(t);
    mockAccessJwks();
    const token = await accessToken();
    for (let i = 0; i < 3; i++) t.d1.sqlite.prepare(`INSERT INTO audit_log (actor, action, target, created_at) VALUES ('system', ?, 'global', ?)`).run(`a${i}`, i);
    const first = await adminCall(t, token, 'GET', '/api/v1/admin/audit?limit=2');
    expect(first.body.map((r: { action: string }) => r.action)).toEqual(['a2', 'a1']);
    const rest = await adminCall(t, token, 'GET', '/api/v1/admin/audit?limit=2&offset=2');
    expect(rest.body.map((r: { action: string }) => r.action)).toEqual(['a0']);
  });
});

describe('validation', () => {
  it('rejects impossible months', async () => {
    await signIn(t, 'pilot@example.com');
    expect((await t.call('GET', '/api/v1/usage?month=2026-13')).status).toBe(400);
    expect((await t.call('GET', '/api/v1/usage?month=2026-12')).status).toBe(200);
  });

  it('answers 404 for admin changes to things that do not exist, without auditing them', async () => {
    configureAdmin(t);
    mockAccessJwks();
    const token = await accessToken();
    const reason = { reason: 'test reason', note: 'test note', action: 'suspend' };
    expect((await adminCall(t, token, 'POST', '/api/v1/admin/alerts/999/ack')).status).toBe(404);
    expect((await adminCall(t, token, 'POST', '/api/v1/admin/alerts/abc/ack')).status).toBe(404);
    expect((await adminCall(t, token, 'POST', '/api/v1/admin/findings/nope/resolve', reason)).status).toBe(404);
    expect((await adminCall(t, token, 'POST', '/api/v1/admin/users/nope/actions', reason)).status).toBe(404);
    expect((await adminCall(t, token, 'POST', '/api/v1/admin/users/nope/unfreeze', reason)).status).toBe(404);
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM audit_log').get()).toEqual({ n: 0 });
  });
});
