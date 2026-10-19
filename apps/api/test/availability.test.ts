import { readFileSync } from 'node:fs';
import { estimateRttMs } from '@cloudbrowser/contracts';
import { createDb, recordLaunch, reopenRegion, schema, type LaunchHealthRow } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { describe, expect, it } from 'vitest';
import { availabilityOf, regionViews } from '../src/availability.js';
import { admitCreate } from '../src/limits.js';

const now = new Date('2026-10-19T07:00:00Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
const row = (zone: string, r: Partial<LaunchHealthRow>): LaunchHealthRow => ({
  regionId: 'tyo1', zone, lastSuccessAt: null, lastCapacityAt: null, lastFailureAt: null, lastFailureClass: null, lastFailure: null, ...r,
});
const base = { enabled: true, acceptingNew: true, stock: 4, health: [] as LaunchHealthRow[], now };

describe('region availability', () => {
  it('is available without recent problems, and limited by a recent capacity shortage until a launch succeeds', () => {
    expect(availabilityOf(base)).toEqual({ availability: 'available', availabilityReason: null });
    expect(availabilityOf({ ...base, health: [row('a', { lastCapacityAt: at(5) })] })).toEqual({ availability: 'limited', availabilityReason: 'capacity' });
    // Another zone launched since: creation moves there.
    expect(availabilityOf({ ...base, health: [row('a', { lastCapacityAt: at(5) }), row('c', { lastSuccessAt: at(2) })] }).availability).toBe('available');
    // A shortage is forgotten after 30 minutes.
    expect(availabilityOf({ ...base, health: [row('a', { lastCapacityAt: at(31) })] }).availability).toBe('available');
    expect(availabilityOf({ ...base, stock: 1 })).toEqual({ availability: 'limited', availabilityReason: 'low_stock' });
  });

  it('is unavailable while a provider failure is open, when closed, or without stock', () => {
    expect(availabilityOf({ ...base, health: [row('a', { lastFailureAt: at(10), lastFailureClass: 'invalid' })] })).toEqual({ availability: 'unavailable', availabilityReason: 'provider_issue' });
    expect(availabilityOf({ ...base, health: [row('a', { lastFailureAt: at(10) }), row('c', { lastSuccessAt: at(1) })] }).availability).toBe('available');
    expect(availabilityOf({ ...base, health: [row('a', { lastFailureAt: at(7 * 60) })] }).availability).toBe('available');
    expect(availabilityOf({ ...base, enabled: false })).toEqual({ availability: 'unavailable', availabilityReason: 'closed' });
    expect(availabilityOf({ ...base, acceptingNew: false, stock: 0 })).toEqual({ availability: 'unavailable', availabilityReason: 'no_stock' });
  });

  it('keeps a region blocked when the provider refused our account, until a launch succeeds there', () => {
    const refused = row('a', { lastFailureAt: at(7 * 60), lastFailureClass: 'forbidden' });
    expect(availabilityOf({ ...base, health: [refused] })).toEqual({ availability: 'unavailable', availabilityReason: 'blocked' });
    expect(availabilityOf({ ...base, health: [refused, row('c', { lastSuccessAt: at(1) })] }).availability).toBe('available');
  });

  it('estimates latency from distance, within the range real networks show', () => {
    const tokyo = { lat: 35.7, lon: 139.7 };
    expect(estimateRttMs(tokyo, tokyo)).toBe(5);
    const sydney = estimateRttMs(tokyo, { lat: -33.9, lon: 151.2 });
    expect(sydney).toBeGreaterThan(90);
    expect(sydney).toBeLessThan(140);
  });

  it('refuses new browsers in a region whose last launch failed for a provider reason, until a launch succeeds', async () => {
    const d1 = createTestD1();
    const db = createDb(d1);
    const t = Date.now();
    d1.sqlite.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u','test','u@example.test',1,${t},${t});
      UPDATE regions SET enabled = 1;`);
    await admitCreate(db, 'u', 'tyo1', new Date(), { trial: true });
    await recordLaunch(db, 'tyo1', 'ap-northeast-1a', { kind: 'failure', errorClass: 'invalid', message: 'VM ended during launch: KMS key' }, new Date());
    await expect(admitCreate(db, 'u', 'tyo1', new Date(), { trial: true })).rejects.toMatchObject({ status: 409, type: 'region_unavailable' });
    const views = await regionViews(db, { lat: 35.7, lon: 139.7 });
    expect(views.find((r) => r.id === 'tyo1')).toMatchObject({ availability: 'unavailable', availabilityReason: 'provider_issue', acceptingNew: false });
    expect(views.find((r) => r.id === 'syd1')).toMatchObject({ availability: 'available', acceptingNew: true });
    await recordLaunch(db, 'tyo1', 'ap-northeast-1c', { kind: 'success' }, new Date());
    await admitCreate(db, 'u', 'tyo1', new Date(), { trial: true });
  });

  it('refuses a blocked region with its own reason, marks regions without a launch as not yet tested, and reopens', async () => {
    const d1 = createTestD1();
    const db = createDb(d1);
    const t = Date.now();
    d1.sqlite.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u','test','u@example.test',1,${t},${t});
      UPDATE regions SET enabled = 1;`);
    const launched = new Date(t - 3_600_000);
    await recordLaunch(db, 'syd1', 'ap-southeast-2a', { kind: 'success' }, launched);
    await recordLaunch(db, 'tyo1', 'ap-northeast-1a', { kind: 'failure', errorClass: 'forbidden', message: 'VM ended during launch: KMS key' }, new Date(t - 6 * 3_600_000));
    await expect(admitCreate(db, 'u', 'tyo1', new Date(), { trial: true })).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('provider configuration problem') });
    const views = await regionViews(db, null);
    expect(views.find((r) => r.id === 'tyo1')).toMatchObject({ availability: 'unavailable', availabilityReason: 'blocked', launchVerifiedAt: null });
    expect(views.find((r) => r.id === 'syd1')).toMatchObject({ availability: 'available', launchVerifiedAt: launched.toISOString() });
    expect(views.find((r) => r.id === 'usw1')).toMatchObject({ availability: 'available', launchVerifiedAt: null });
    await reopenRegion(db, 'tyo1');
    await admitCreate(db, 'u', 'tyo1', new Date(), { trial: true });
  });

  it('counts a region as tested from history only when its last create there succeeded (migration 0016)', async () => {
    const d1 = createTestD1();
    const t = Date.UTC(2026, 9, 18);
    const op = (id: string, inst: string, status: string, at: number) =>
      `INSERT INTO operations (id,instance_id,user_id,kind,status,attempt,deadline_at,created_at,updated_at,finished_at) VALUES ('${id}','${inst}','u','create','${status}',0,${at + 3_600_000},${at},${at},${at + 60_000});`;
    const inst = (id: string, region: string) =>
      `INSERT INTO browser_instances (id,user_id,name,region_id,status,desired_state,idle_timeout_s,locale,screen,fingerprint,created_at,updated_at) VALUES ('${id}','u','b','${region}','purged','deleted',600,'en-US','auto','{}',${t},${t});`;
    d1.sqlite.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u','test','u@example.test',1,${t},${t});
      ${inst('s1', 'syd1')}${inst('s2', 'syd1')}${inst('t1', 'tyo1')}${inst('t2', 'tyo1')}
      ${op('o1', 's1', 'failed', t)}${op('o2', 's2', 'succeeded', t + 3_600_000)}${op('o3', 't1', 'succeeded', t)}${op('o4', 't2', 'failed', t + 3_600_000)}`);
    d1.sqlite.exec(readFileSync(new URL('../../../packages/db/migrations/0016_launch_verified_backfill.sql', import.meta.url), 'utf8'));
    const rows = await createDb(d1).select().from(schema.launchHealth);
    expect(rows).toEqual([expect.objectContaining({ regionId: 'syd1', zone: '', lastSuccessAt: new Date(t + 3_660_000), lastFailureAt: null })]);
  });

  it('offers a latency probe and estimate for AWS regions', async () => {
    const d1 = createTestD1();
    d1.sqlite.exec(`UPDATE regions SET executor = 'aws-ec2', enabled = 1`);
    const views = await regionViews(createDb(d1), { lat: 35.7, lon: 139.7 });
    expect(views.find((r) => r.id === 'tyo1')).toMatchObject({
      probeUrl: 'https://dynamodb.ap-northeast-1.amazonaws.com/ping', area: 'asia_pacific', estimatedRttMs: 5,
    });
    expect(views.find((r) => r.id === 'usw1')!.estimatedRttMs).toBeGreaterThan(80);
  });
});
