import { newArchiveKey, sha256Hex } from '@cloudbrowser/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { internalApi } from '../src/internal.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('owner@example.com'), ('other@example.com')`);
  await signIn(t, 'owner@example.com');
});

async function createBrowser(key = 'create') {
  const sheet = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
  const created = await t.call('POST', '/api/v1/instances', { name: 'Private browser', regionId: 'tyo1', storageGb: 10, priceVersion: sheet.version }, { 'idempotency-key': key });
  expect(created.status).toBe(202);
  await t.settle();
  return created.body.instanceId as string;
}

async function privateAccess(id: string) {
  const api = internalApi(t.env as never);
  const record = t.d1.sqlite.prepare(`SELECT attrs FROM fake_provider_resources WHERE kind = 'vm' AND json_extract(tags, '$."cb:instance"') = ?`).get(id) as { attrs: string };
  const { bootstrapToken } = JSON.parse(record.attrs).userData;
  const auth = await api.authenticateAgent({ instanceId: id, bootstrap: bootstrapToken });
  expect(auth.ok).toBe(true);
  const credential = auth.ok ? auth.credential! : '';
  const open = await t.call('POST', `/api/v1/instances/${id}/sessions`);
  expect(open.status).toBe(201);
  const sid = open.body.session.id as string;
  const uid = (t.d1.sqlite.prepare('SELECT user_id FROM browser_instances WHERE id = ?').get(id) as { user_id: string }).user_id;
  const claims = { iid: id, sid, uid, jti: `token-${id}`, exp: Math.floor(Date.now() / 1000) + 60 };
  const master = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
  const { key, wrapped } = await newArchiveKey(master);
  t.d1.sqlite.prepare('INSERT INTO archive_keys (instance_id, wrapped_key, created_at) VALUES (?, ?, ?)').run(id, wrapped, Date.now());
  return { api, credential, bootstrapToken, sid, claims, master, key };
}

describe('permanent deletion and browser profile isolation', () => {
  it('revokes profile keys, credentials and sessions in the accepting transaction, before the engine runs', async () => {
    const id = await createBrowser();
    const access = await privateAccess(id);
    const revoked: string[] = [];
    Object.assign(t.env, { OPERATIONS: { send: async () => {} }, GATEWAY: { revokeInstance: async (instanceId: string) => void revoked.push(instanceId) } });
    t.d1.sqlite.prepare(`INSERT INTO agent_commands (id, instance_id, kind, payload, status, created_at) VALUES ('restore-old', ?, 'restore_archive', '{}', 'pending', ?)`).run(id, Date.now());
    const before = Date.now();
    expect((await t.call('DELETE', `/api/v1/instances/${id}`, undefined, { 'idempotency-key': 'delete' })).status).toBe(202);
    const row = t.d1.sqlite.prepare('SELECT * FROM browser_instances WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
    expect(Number(row.purge_after)).toBeGreaterThanOrEqual(before);
    expect(Number(row.purge_after)).toBeLessThanOrEqual(Date.now());
    const identity = t.d1.sqlite.prepare('SELECT * FROM agent_credentials WHERE instance_id = ?').get(id);
    expect(identity).toMatchObject({ bootstrap_hash: null, credential_hash: null, bootstrap_expires_at: null });
    expect(t.d1.sqlite.prepare('SELECT wrapped_key, destroyed_at FROM archive_keys WHERE instance_id = ?').get(id)).toMatchObject({ wrapped_key: null, destroyed_at: expect.any(Number) });
    expect(t.d1.sqlite.prepare('SELECT ended_at FROM viewer_sessions WHERE id = ?').get(access.sid)).toMatchObject({ ended_at: expect.any(Number) });
    expect(t.d1.sqlite.prepare("SELECT status FROM agent_commands WHERE id = 'restore-old'").get()).toMatchObject({ status: 'failed' });
    expect(revoked).toEqual([id]);
    expect(await access.api.authenticateAgent({ instanceId: id, credential: access.credential })).toEqual({ ok: false, reason: 'unknown_instance' });
    expect(await access.api.authenticateAgent({ instanceId: id, bootstrap: access.bootstrapToken })).toEqual({ ok: false, reason: 'unknown_instance' });
    expect(await access.api.redeemViewerToken(access.claims)).toBe(false);
    expect(await internalApi({ ...t.env, ARCHIVE_MASTER_KEY: access.master } as never).archiveKey(id)).toBeNull();
    expect((await t.call('GET', `/api/v1/sessions/${access.sid}/connect`)).status).toBe(409);
    expect((await t.call('POST', `/api/v1/sessions/${access.sid}/heartbeat`, { input: true })).status).toBe(409);
    expect((await t.call('POST', `/api/v1/instances/${id}/undelete`, undefined, { 'idempotency-key': 'restore' })).status).toBe(409);
  });

  it('denies stale credentials, unredeemed tokens and keys as soon as deletion intent is recorded', async () => {
    const id = await createBrowser();
    const access = await privateAccess(id);
    // Simulate a legacy/system deletion that has not ended sessions or destroyed keys yet.
    t.d1.sqlite.prepare(`UPDATE browser_instances SET desired_state = 'deleted' WHERE id = ?`).run(id);
    expect((await access.api.authenticateAgent({ instanceId: id, credential: access.credential })).ok).toBe(false);
    expect(await access.api.redeemViewerToken(access.claims)).toBe(false);
    expect(await internalApi({ ...t.env, ARCHIVE_MASTER_KEY: access.master } as never).archiveKey(id)).toBeNull();
    const healthBefore = t.d1.sqlite.prepare('SELECT * FROM instance_health WHERE instance_id = ?').get(id);
    expect(await access.api.agentMessage(id, 1, { t: 'event', kind: 'heartbeat', data: { viewers: 99 } })).toBeNull();
    expect(t.d1.sqlite.prepare('SELECT * FROM instance_health WHERE instance_id = ?').get(id)).toEqual(healthBefore);
    expect((await t.call('POST', `/api/v1/instances/${id}/sessions`)).status).toBe(409);
  });

  it('never lets a different user delete, connect or restore the old owner profile', async () => {
    const id = await createBrowser();
    const access = await privateAccess(id);
    await signIn(t, 'other@example.com');
    for (const [method, path, body] of [
      ['DELETE', `/api/v1/instances/${id}`, undefined],
      ['POST', `/api/v1/instances/${id}/sessions`, undefined],
      ['POST', `/api/v1/instances/${id}/undelete`, undefined],
      ['POST', `/api/v1/instances/${id}/backups/private-snapshot/restore`, undefined],
      ['GET', `/api/v1/sessions/${access.sid}/connect`, undefined],
    ] as const) expect((await t.call(method, path, body, { 'idempotency-key': `${method}-${path}` })).status).toBe(404);
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(id)).toMatchObject({ status: 'running', desired_state: 'running' });
    expect(await access.api.redeemViewerToken({ ...access.claims, uid: 'other-user' })).toBe(false);
  });

  it('activates a bootstrap at most once even when two handshakes race', async () => {
    const id = await createBrowser();
    const token = 'one-use-bootstrap';
    t.d1.sqlite.prepare('UPDATE agent_credentials SET bootstrap_hash = ?, bootstrap_expires_at = ? WHERE instance_id = ?').run(await sha256Hex(token), Date.now() + 60_000, id);
    const api = internalApi(t.env as never);
    const attempts = await Promise.all([api.authenticateAgent({ instanceId: id, bootstrap: token }), api.authenticateAgent({ instanceId: id, bootstrap: token })]);
    expect(attempts.filter((a) => a.ok)).toHaveLength(1);
  });
});
