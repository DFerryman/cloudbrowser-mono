import { InstanceStatus } from '@cloudbrowser/contracts';
import { expect, it } from 'vitest';
import { stillCreating } from '../src/features/instances/status.js';

it('keeps waiting to open a new browser while creation retries through a capacity shortage or provider problem', () => {
  expect(InstanceStatus.options.filter(stillCreating).sort()).toEqual(['creating', 'provider_issue', 'waiting_capacity']);
});
