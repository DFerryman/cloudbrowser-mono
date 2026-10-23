import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalApi } from '../src/internal.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let instanceId: string;
let gateway: { automationControl: ReturnType<typeof vi.fn>; revokeAutomation: ReturnType<typeof vi.fn>; revokeInstance: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  t = setup();
  gateway = { automationControl: vi.fn().mockResolvedValue(undefined), revokeAutomation: vi.fn().mockResolvedValue(undefined), revokeInstance: vi.fn().mockResolvedValue(undefined) };
  Object.assign(t.env, { GATEWAY: gateway, GATEWAY_URL: 'wss://connect.test' });
  t.d1.sqlite.exec("INSERT INTO invites (email) VALUES ('agent-owner@example.com'), ('agent-other@example.com')");
  await signIn(t, 'agent-owner@example.com');
  const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
  const created = await t.call('POST', '/api/v1/instances', { name: 'Agent browser', regionId: 'tyo1', storageGb: 10, priceVersion: price.version }, { 'idempotency-key': 'agent-browser' });
  expect(created.status).toBe(202);
  await t.settle();
  instanceId = created.body.instanceId;
  t.d1.sqlite.prepare(`INSERT OR IGNORE INTO agent_credentials (instance_id, generation, created_at) VALUES (?, 1, 0)`).run(instanceId);
});

afterEach(async () => { await t.settle(); t.d1.sqlite.close(); });

const createKey = (body: Record<string, unknown> = {}) =>
  t.call('POST', `/api/v1/instances/${instanceId}/automation/keys`, { name: 'Claude Code', expiresInDays: 30, capability: 'control', ...body });

describe('coding-agent access', () => {
  it('is on by default, can be declined at creation and switched later, which ends the agent\'s session', async () => {
    const one = await t.call('GET', `/api/v1/instances/${instanceId}`);
    expect(one.body).toMatchObject({ agentAccess: true, agentControl: 'agent' });
    const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
    const declined = await t.call('POST', '/api/v1/instances', { name: 'Private', regionId: 'tyo1', storageGb: 10, priceVersion: price.version, agentAccess: false }, { 'idempotency-key': 'private-browser' });
    expect(declined.status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${declined.body.instanceId}`)).body.agentAccess).toBe(false);
    const key = await t.call('POST', `/api/v1/instances/${declined.body.instanceId}/automation/keys`, { name: 'laptop' });
    expect(key.status).toBe(409);
    expect(key.body.type).toBe('agent_access_off');

    const made = await createKey();
    const { sessionId } = await internalApi(t.env as never).openAutomationSession(instanceId, made.body.clientId);
    const off = await t.call('PATCH', `/api/v1/instances/${instanceId}`, { agentAccess: false });
    expect(off.status).toBe(200);
    expect(off.body.agentAccess).toBe(false);
    expect(gateway.automationControl).toHaveBeenCalledWith(instanceId, 'agent', false);
    expect(t.d1.sqlite.prepare(`SELECT ended_at, end_reason FROM automation_sessions WHERE id = ?`).get(sessionId)).toMatchObject({ end_reason: 'access_off', ended_at: expect.any(Number) });
    const status = await t.call('GET', `/api/v1/instances/${instanceId}/automation`);
    expect(status.body).toMatchObject({ enabled: false, mode: 'agent', session: null });
    // Keys are kept while access is off; new ones wait until it is on again.
    expect(status.body.clients).toHaveLength(1);
    expect((await createKey()).body.type).toBe('agent_access_off');
  });

  it('creates a key shown once, stores only its hash and checks MCP requests with it', async () => {
    const made = await createKey();
    expect(made.status).toBe(201);
    const key: string = made.body.key;
    expect(key).toMatch(/^nvzk_[A-Za-z0-9]{43}$/);
    expect(made.body).toMatchObject({
      name: 'Claude Code', keyPrefix: key.slice(0, 11), capability: 'control', mcpUrl: `https://connect.test/mcp/${instanceId}`,
      expiresAt: expect.any(String),
    });
    expect(new Date(made.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const row = t.d1.sqlite.prepare(`SELECT * FROM automation_clients WHERE id = ?`).get(made.body.clientId) as Record<string, unknown>;
    expect(row).toMatchObject({ kind: 'key', key_prefix: key.slice(0, 11), capability: 'control', credential_hash: await sha256Hex(`bridge:${key}`) });
    expect(JSON.stringify(row)).not.toContain(key.slice(11));

    const status = await t.call('GET', `/api/v1/instances/${instanceId}/automation`);
    expect(status.body).toMatchObject({ enabled: true, mcpUrl: `https://connect.test/mcp/${instanceId}`, session: null });
    expect(status.body.clients).toEqual([{
      id: made.body.clientId, name: 'Claude Code', kind: 'key', keyPrefix: key.slice(0, 11), capability: 'control',
      createdAt: expect.any(String), expiresAt: made.body.expiresAt, lastSeenAt: null, lastClient: null,
    }]);
    expect(JSON.stringify(status.body)).not.toContain(key.slice(11));
    await t.settle();
    expect(t.emails.at(-1)).toMatchObject({ to: 'agent-owner@example.com', subject: expect.stringContaining('Claude Code') });
    expect(t.emails.at(-1)!.text).not.toContain(key.slice(11));

    const api = internalApi(t.env as never);
    const auth = await api.authenticateMcp({ instanceId, key, ip: '203.0.113.5', client: 'claude-code/2.1.0' });
    expect(auth).toEqual({ ok: true, clientId: made.body.clientId, userId: expect.any(String), generation: 1, capability: 'control', name: 'Claude Code' });
    const seen = t.d1.sqlite.prepare(`SELECT last_seen_at, last_client, last_ip FROM automation_clients WHERE id = ?`).get(made.body.clientId) as { last_seen_at: number };
    expect(seen).toMatchObject({ last_client: 'claude-code/2.1.0', last_ip: '203.0.113.5', last_seen_at: expect.any(Number) });
    // Within a minute the row is not written again.
    await api.authenticateMcp({ instanceId, key, ip: '203.0.113.6' });
    expect(t.d1.sqlite.prepare(`SELECT last_ip FROM automation_clients WHERE id = ?`).get(made.body.clientId)).toEqual({ last_ip: '203.0.113.5' });

    expect(await api.authenticateMcp({ instanceId, key: `nvzk_${'x'.repeat(43)}` })).toEqual({ ok: false, reason: 'invalid_token' });
    expect(await api.authenticateMcp({ instanceId, key: 'not a key' })).toEqual({ ok: false, reason: 'invalid_token' });
    expect(await api.authenticateMcp({ instanceId: 'otherbrowser', key })).toEqual({ ok: false, reason: 'invalid_token' });

    // The gateway opens a session on the first tool call; one per browser.
    const first = await api.openAutomationSession(instanceId, made.body.clientId);
    expect((await t.call('GET', `/api/v1/instances/${instanceId}/automation`)).body.session).toMatchObject({ id: first.sessionId, clientId: made.body.clientId });
    const second = await api.openAutomationSession(instanceId, made.body.clientId);
    expect(t.d1.sqlite.prepare(`SELECT end_reason FROM automation_sessions WHERE id = ?`).get(first.sessionId)).toEqual({ end_reason: 'replaced' });
    await api.endAutomationSession(second.sessionId, 'idle');
    expect((await t.call('GET', `/api/v1/instances/${instanceId}/automation`)).body.session).toBeNull();

    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, made.body.clientId);
    expect(await api.authenticateMcp({ instanceId, key })).toEqual({ ok: false, reason: 'expired' });
    const audit = t.d1.sqlite.prepare(`SELECT action FROM audit_log WHERE target = ? AND action LIKE 'automation.%' ORDER BY id`).all(`instance:${instanceId}`) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(['automation.key_created', 'automation.session_opened', 'automation.session_opened', 'automation.session_ended']);
  });

  it('makes view-only and never-expiring keys, and at most ten active keys per browser', async () => {
    const view = await createKey({ name: 'watcher', capability: 'view', expiresInDays: null });
    expect(view.body).toMatchObject({ capability: 'view', expiresAt: null });
    expect(await internalApi(t.env as never).authenticateMcp({ instanceId, key: view.body.key })).toMatchObject({ ok: true, capability: 'view' });
    for (let i = 1; i < 10; i++) expect((await createKey({ name: `key ${i}` })).status).toBe(201);
    const over = await createKey({ name: 'eleventh' });
    expect(over.status).toBe(409);
    expect(over.body.type).toBe('agent_key_limit');
    // An expired key no longer counts; a revoked one neither.
    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = 1 WHERE id = ?`).run(view.body.clientId);
    expect((await createKey({ name: 'eleventh' })).status).toBe(201);
    expect((await t.call('POST', `/api/v1/instances/${instanceId}/automation/keys`, { name: 'bad', expiresInDays: 12 })).status).toBe(400);
  });

  it('revokes a key at once: it stops working, its session ends and the gateway closes it', async () => {
    const made = await createKey();
    const api = internalApi(t.env as never);
    const { sessionId } = await api.openAutomationSession(instanceId, made.body.clientId);
    const owner = t.cookie();
    await signIn(t, 'agent-other@example.com');
    expect((await t.call('GET', `/api/v1/instances/${instanceId}/automation`)).status).toBe(404);
    expect((await t.call('DELETE', `/api/v1/instances/${instanceId}/automation/clients/${made.body.clientId}`)).status).toBe(404);
    t.setCookie(owner);
    expect((await t.call('DELETE', `/api/v1/instances/${instanceId}/automation/clients/${made.body.clientId}`)).status).toBe(204);
    expect(gateway.revokeAutomation).toHaveBeenCalledWith(instanceId, made.body.clientId);
    expect(await api.authenticateMcp({ instanceId, key: made.body.key })).toEqual({ ok: false, reason: 'invalid_token' });
    expect(t.d1.sqlite.prepare(`SELECT end_reason FROM automation_sessions WHERE id = ?`).get(sessionId)).toEqual({ end_reason: 'client_revoked' });
    expect((await t.call('GET', `/api/v1/instances/${instanceId}/automation`)).body.clients).toEqual([]);
    expect((await t.call('DELETE', `/api/v1/instances/${instanceId}/automation/clients/${made.body.clientId}`)).status).toBe(404);
  });

  it('revokes every key of a deleted browser, and every key of a user who signs out everywhere', async () => {
    const made = await createKey();
    const api = internalApi(t.env as never);
    const deleted = await t.call('DELETE', `/api/v1/instances/${instanceId}`, undefined, { 'idempotency-key': 'delete-agent-browser' });
    expect(deleted.status).toBe(202);
    expect(gateway.revokeInstance).toHaveBeenCalledWith(instanceId);
    expect(t.d1.sqlite.prepare(`SELECT revoked_at, credential_hash FROM automation_clients WHERE id = ?`).get(made.body.clientId)).toEqual({ revoked_at: expect.any(Number), credential_hash: null });
    expect((await api.authenticateMcp({ instanceId, key: made.body.key })).ok).toBe(false);

    const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
    const next = await t.call('POST', '/api/v1/instances', { name: 'Second', regionId: 'tyo1', storageGb: 10, priceVersion: price.version }, { 'idempotency-key': 'second-browser' });
    await t.settle();
    instanceId = next.body.instanceId;
    const key = await createKey();
    expect(key.status).toBe(201);
    const out = await t.call('POST', '/api/auth/revoke-sessions', {});
    expect(out.status).toBe(200);
    await t.settle();
    expect(t.d1.sqlite.prepare(`SELECT revoked_at FROM automation_clients WHERE id = ?`).get(key.body.clientId)).toEqual({ revoked_at: expect.any(Number) });
    expect(gateway.revokeAutomation).toHaveBeenCalledWith(instanceId);
    const audit = t.d1.sqlite.prepare(`SELECT detail FROM audit_log WHERE action = 'automation.clients_revoked'`).get() as { detail: string };
    expect(audit.detail).toContain('sign_out_everywhere');
  });

  it('keeps a retired bridge\'s credential working as a key', async () => {
    const credential = 'ab'.repeat(32);
    const userId = (t.d1.sqlite.prepare(`SELECT user_id FROM browser_instances WHERE id = ?`).get(instanceId) as { user_id: string }).user_id;
    t.d1.sqlite.prepare(`INSERT INTO automation_clients (id, instance_id, user_id, name, credential_hash, created_at, activated_at) VALUES ('bridge1', ?, ?, 'old laptop', ?, 0, 0)`)
      .run(instanceId, userId, await sha256Hex(`bridge:${credential}`));
    expect(await internalApi(t.env as never).authenticateMcp({ instanceId, key: credential })).toMatchObject({ ok: true, clientId: 'bridge1', capability: 'control' });
    const status = await t.call('GET', `/api/v1/instances/${instanceId}/automation`);
    expect(status.body.clients[0]).toMatchObject({ id: 'bridge1', kind: 'bridge', keyPrefix: null, expiresAt: null });
  });

  it('persists the owner\'s control choice and a takeover reported by the VM', async () => {
    const privacy = await t.call('POST', `/api/v1/instances/${instanceId}/automation/control`, { mode: 'privacy' });
    expect(privacy.status).toBe(200);
    expect(privacy.body.agentControl).toBe('privacy');
    expect(gateway.automationControl).toHaveBeenLastCalledWith(instanceId, 'privacy', true);

    // A takeover the VM reports does not weaken a privacy pause; it does turn 'agent' into 'user'.
    const api = internalApi(t.env as never);
    await api.agentMessage(instanceId, 1, { t: 'control_state', control: { controller: 'user', mode: 'user', epoch: 2 }, reason: 'user_input' });
    expect((await t.call('GET', `/api/v1/instances/${instanceId}`)).body.agentControl).toBe('privacy');
    const back = await t.call('POST', `/api/v1/instances/${instanceId}/automation/control`, { mode: 'agent' });
    expect(back.body.agentControl).toBe('agent');
    await api.agentMessage(instanceId, 1, { t: 'control_state', control: { controller: 'user', mode: 'user', epoch: 3 }, reason: 'user_input' });
    expect((await t.call('GET', `/api/v1/instances/${instanceId}`)).body.agentControl).toBe('user');
    const audit = t.d1.sqlite.prepare(`SELECT detail FROM audit_log WHERE action = 'automation.control_changed'`).all() as { detail: string }[];
    expect(audit).toHaveLength(2);
    expect(audit[1]!.detail).toContain('"reason":"user_input"');
    expect((await t.call('POST', `/api/v1/instances/${instanceId}/automation/control`, { mode: 'nonsense' })).status).toBe(400);
  });
});

describe('migration 0035', () => {
  it('adds the key columns and revokes pairing codes that were never redeemed', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', 'packages', 'db', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    for (const file of files.filter((f) => f < '0035')) db.exec(readFileSync(join(dir, file), 'utf8'));
    db.exec(`INSERT INTO automation_clients (id, instance_id, user_id, name, pairing_hash, pairing_expires_at, created_at)
        VALUES ('pending', 'b', 'u', 'never redeemed', 'p1', 1, 0);
      INSERT INTO automation_clients (id, instance_id, user_id, name, credential_hash, created_at, activated_at)
        VALUES ('paired', 'b', 'u', 'bridge', 'c1', 0, 0);`);
    db.exec(readFileSync(join(dir, files.find((f) => f.startsWith('0035'))!), 'utf8'));
    expect(db.prepare(`SELECT id, kind, capability, revoked_at IS NOT NULL AS revoked, pairing_hash FROM automation_clients ORDER BY id`).all()).toEqual([
      { id: 'paired', kind: 'bridge', capability: 'control', revoked: 0, pairing_hash: null },
      { id: 'pending', kind: 'bridge', capability: 'control', revoked: 1, pairing_hash: null },
    ]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'automation_clients_credential_idx'`).get()).toEqual({ name: 'automation_clients_credential_idx' });
    db.close();
  });
});
