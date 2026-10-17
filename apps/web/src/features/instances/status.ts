import type { Instance, InstanceStatus } from '@cloudbrowser/contracts';
import { REGION_INFO } from '@cloudbrowser/contracts';
import type { StatusTone } from '@cloudbrowser/ui';
import type { MessageKey } from '../../messages/en.js';

export const STATUS_TONE: Record<InstanceStatus, StatusTone> = {
  creating: 'progress',
  starting: 'progress',
  stopping: 'progress',
  running: 'running',
  sleeping: 'sleeping',
  waiting_capacity: 'waiting',
  provider_issue: 'error',
  needs_attention: 'error',
  failed: 'error',
  deleting: 'deleted',
  purged: 'deleted',
};

export const statusKey = (s: InstanceStatus) => `status.${s}` as MessageKey;

export const regionKey = (id: Instance['regionId']) => `create.region.${id}` as MessageKey;

export function regionInfo(id: Instance['regionId']) {
  return REGION_INFO[id];
}

/** True while an operation is moving the browser between states. */
export const isTransitioning = (i: Instance) => ['creating', 'starting', 'stopping'].includes(i.status) || !!i.currentOperation;
