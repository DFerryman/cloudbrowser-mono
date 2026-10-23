import { createTestD1 } from '@cloudbrowser/db/testing';
import type { OpContext } from '@cloudbrowser/executors';
import { afterEach, expect, it, vi } from 'vitest';
import { makeDeps, type Env } from '../src/deps.js';
import { FakeEc2 } from '../../../packages/executors/test/fake-ec2.js';

const REGION = 'ap-northeast-1';
let n = 0;
const ctx = (): OpContext => ({ operationId: `op${++n}`, step: 'allocate_ip', token: `op${n}:allocate_ip:1`, tags: { 'cb:managed': 'true', 'cb:env': 'test' }, deadline: Date.now() + 60_000 });

afterEach(() => vi.unstubAllGlobals());

it('launches no real VM with the local fallbacks for the bootstrap secret or gateway URL, outside development', async () => {
  const ec2 = new FakeEc2();
  vi.stubGlobal('fetch', ec2.fetch);
  const base: Env = {
    DB: createTestD1(), ENV_NAME: 'test', APP_URL: 'https://app.example.com', AWS_ACCESS_KEY_ID: 'AKIDTEST', AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_REGIONS: JSON.stringify({ [REGION]: { subnets: { 'ap-northeast-1a': 'subnet-a' }, securityGroupId: 'sg-1' } }),
  };
  const aws = (extra: Partial<Env>) => makeDeps({ ...base, ...extra }).executor('aws-ec2');

  await expect(aws({ GATEWAY_URL: 'wss://connect.example.com' }).allocateIp(ctx(), REGION))
    .rejects.toMatchObject({ errorClass: 'invalid', message: expect.stringContaining('BOOTSTRAP_SECRET not set') });
  await expect(aws({ BOOTSTRAP_SECRET: 'secret' }).allocateIp(ctx(), REGION)).rejects.toThrow(/GATEWAY_URL not set/);
  expect(ec2.calls).toEqual([]);
  // Reading and cleaning up still work, and the reaper never launches anything.
  expect(await aws({}).listManaged(ctx(), REGION)).toEqual([]);
  expect(await aws({ ENGINE_MODE: 'reaper' }).listManaged(ctx(), REGION)).toEqual([]);

  // A configured deployment launches; so may development, with the fallbacks.
  for (const extra of [{ BOOTSTRAP_SECRET: 'secret', GATEWAY_URL: 'wss://connect.example.com' }, { ENVIRONMENT: 'development' }]) {
    expect((await aws(extra).allocateIp(ctx(), REGION)).allocationId).toBeTruthy();
  }
});
