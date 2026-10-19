import { estimateRttMs } from '@cloudbrowser/contracts';
import { createDb, recordLaunch, type LaunchHealthRow } from '@cloudbrowser/db';
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
