import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';
import { internalApi } from '../src/internal.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let instanceId: string;
let gateway: { automationControl: ReturnType<typeof vi.fn>; revokeAutomation: ReturnType<typeof vi.fn>; revokeInstance: ReturnType<typeof vi.fn> };

const pairPublicly = (body: unknown, ip = '203.0.113.5') => app.fetch(
  new Request('http://app.test/api/automation/pair', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }),
  t.env as never, t.ctx,
);

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
});

afterEach(async () => { await t.settle(); t.d1.sqlite.close(); });

describe('coding-agent access', () => {
  it('is on by default, can be declined at creation and switched later, which ends bridge sessions', async () => {
    const one = await t.call('GET', `/api/v1/instances/${instanceId}`);
    expect(one.body).toMatchObject({ agentAccess: true, agentControl: 'agent' });
    const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
    const declined = await t.call('POST', '/api/v1/instances', { name: 'Private', regionId: 'tyo1', storageGb: 10, priceVersion: price.version, agentAccess: false }, { 'idempotency-key': 'private-browser' });
    expect(declined.status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${declined.body.instanceId}`)).body.agentAccess).toBe(false);
    const pairing = await t.call('POST', `/api/v1/instances/${declined.body.instanceId}/automation/pairings`, { name: 'laptop' });
    expect(pairing.status).toBe(409);
    expect(pairing.body.type).toBe('agent_access_off');

    t.d1.sqlite.prepare(`INSERT INTO automation_clients (id, instance_id, user_id, name, credential_hash, created_at, activated_at) VALUES ('c1', ?, (SELECT user_id FROM browser_instances WHERE id = ?), 'x', 'h', 0, 0)`).run(instanceId, instanceId);
    t.d1.sqlite.prepare(`INSERT INTO automation_sessions (id, instance_id, client_id, user_id, generation, started_at, last_seen_at) VALUES ('s1', ?, 'c1', (SELECT user_id FROM browser_instances WHERE id = ?), 1, 0, 0)`).run(instanceId, instanceId);
    const off = await t.call('PATCH', `/api/v1/instances/${instanceId}`, { agentAccess: false });
    expect(off.status).toBe(200);
    expect(off.body.agentAccess).toBe(false);
    expect(gateway.automationControl).toHaveBeenCalledWith(instanceId, 'agent', false);
    expect(t.d1.sqlite.prepare(`SELECT ended_at, end_reason FROM automation_sessions WHERE id = 's1'`).get()).toMatchObject({ end_reason: 'access_off', ended_at: expect.any(Number) });
    const status = await t.call('GET', `/api/v1/instances/${instanceId}/automation`);
    expect(status.body).toMatchObject({ enabled: false, mode: 'agent', session: null });
  });

  it('pairs a bridge with a one-time code, admits it with the credential it got and revokes it', async () => {
    const pairing = await t.call('POST', `/api/v1/instances/${instanceId}/automation/pairings`, { name: 'Work laptop' });
    expect(pairing.status).toBe(201);
    expect(pairing.body.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(pairing.body.command).toContain(pairing.body.code);
    const stored = t.d1.sqlite.prepare(`SELECT pairing_hash, credential_hash FROM automation_clients WHERE id = ?`).get(pairing.body.clientId) as { pairing_hash: string; credential_hash: string | null };
    expect(stored.pairing_hash).not.toContain(pairing.body.code);
    expect(stored.credential_hash).toBeNull();
    const before = await t.call('GET', `/api/v1/instances/${instanceId}/automation`);
    expect(before.body.clients).toEqual([expect.objectContaining({ id: pairing.body.clientId, name: 'Work laptop', activatedAt: null, pairingExpiresAt: expect.any(String) })]);

    // The bridge redeems the code without a user session; lowercase and spacing are tolerated.
    const wrong = await pairPublicly({ code: 'AAAAA-BBBBB-CCCCC' });
    expect(wrong.status).toBe(401);
    const redeemed = await pairPublicly({ code: pairing.body.code.toLowerCase().replaceAll('-', ' '), client: 'Alice’s MacBook' });
    expect(redeemed.status).toBe(200);
    const grant = await redeemed.json() as { credential: string; gatewayUrl: string; instanceId: string; instanceName: string; clientId: string };
    expect(grant).toMatchObject({ instanceId, instanceName: 'Agent browser', clientId: pairing.body.clientId, gatewayUrl: `wss://connect.test/v1/automation/${instanceId}`, protocol: 1 });
    const again = await pairPublicly({ code: pairing.body.code });
    expect(again.status).toBe(401);
    const after = t.d1.sqlite.prepare(`SELECT pairing_hash, credential_hash, client_info FROM automation_clients WHERE id = ?`).get(pairing.body.clientId) as { pairing_hash: string | null; credential_hash: string; client_info: string };
    expect(after.pairing_hash).toBeNull();
    expect(after.credential_hash).not.toContain(grant.credential);
    expect(after.client_info).toBe('Alice’s MacBook');

    // The gateway's connect-time check needs the browser running.
    const api = internalApi(t.env as never);
    expect(await api.authenticateAutomation({ instanceId, credential: 'nope' })).toEqual({ ok: false, reason: 'invalid_token' });
    t.d1.sqlite.prepare(`UPDATE browser_instances SET status = 'sleeping', desired_state = 'stopped' WHERE id = ?`).run(instanceId);
    expect(await api.authenticateAutomation({ instanceId, credential: grant.credential })).toEqual({ ok: false, reason: 'not_running' });
    t.d1.sqlite.prepare(`UPDATE browser_instances SET status = 'running', desired_state = 'running' WHERE id = ?`).run(instanceId);
    t.d1.sqlite.prepare(`INSERT OR IGNORE INTO agent_credentials (instance_id, generation, created_at) VALUES (?, 1, 0)`).run(instanceId);
    const admitted = await api.authenticateAutomation({ instanceId, credential: grant.credential });
    expect(admitted).toMatchObject({ ok: true, clientId: pairing.body.clientId, generation: 1 });
    const connected = await t.call('GET', `/api/v1/instances/${instanceId}/automation`);
    expect(connected.body.session).toMatchObject({ clientId: pairing.body.clientId });
    expect(connected.body.clients[0]).toMatchObject({ activatedAt: expect.any(String), pairingExpiresAt: null });
    await api.endAutomationSession(admitted.ok ? admitted.sessionId : '', 'closed');
    expect((await t.call('GET', `/api/v1/instances/${instanceId}/automation`)).body.session).toBeNull();

    // Another user cannot see or revoke it; the owner can, and the credential dies with it.
    const owner = t.cookie();
    await signIn(t, 'agent-other@example.com');
    expect((await t.call('GET', `/api/v1/instances/${instanceId}/automation`)).status).toBe(404);
    expect((await t.call('DELETE', `/api/v1/instances/${instanceId}/automation/clients/${pairing.body.clientId}`)).status).toBe(404);
    t.setCookie(owner);
    expect((await t.call('DELETE', `/api/v1/instances/${instanceId}/automation/clients/${pairing.body.clientId}`)).status).toBe(204);
    expect(gateway.revokeAutomation).toHaveBeenCalledWith(instanceId, pairing.body.clientId);
    expect((await api.authenticateAutomation({ instanceId, credential: grant.credential })).ok).toBe(false);
    expect((await t.call('GET', `/api/v1/instances/${instanceId}/automation`)).body.clients).toEqual([]);
    const audit = t.d1.sqlite.prepare(`SELECT action FROM audit_log WHERE target = ? AND action LIKE 'automation.%' ORDER BY id`).all(`instance:${instanceId}`) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(['automation.pairing_created', 'automation.pairing_redeemed', 'automation.session_opened', 'automation.session_ended', 'automation.client_revoked']);
  });

  it('throttles public pairing attempts per address', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await pairPublicly({ code: 'AAAAA-BBBBB-CCCCC' }, '198.51.100.9')).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('persists the owner\'s control choice and a takeover reported by the VM', async () => {
    const privacy = await t.call('POST', `/api/v1/instances/${instanceId}/automation/control`, { mode: 'privacy' });
    expect(privacy.status).toBe(200);
    expect(privacy.body.agentControl).toBe('privacy');
    expect(gateway.automationControl).toHaveBeenLastCalledWith(instanceId, 'privacy', true);

    // A takeover the VM reports does not weaken a privacy pause; it does turn 'agent' into 'user'.
    const api = internalApi(t.env as never);
    t.d1.sqlite.prepare(`INSERT OR IGNORE INTO agent_credentials (instance_id, generation, created_at) VALUES (?, 1, 0)`).run(instanceId);
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
