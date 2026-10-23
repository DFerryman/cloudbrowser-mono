import type { Instance, InstanceStatus, OperationKind } from '@cloudbrowser/contracts';
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

/** What a queued wake shows once the engine picks it up (the engine's transitional status). */
const QUEUED_WAKE: Partial<Record<OperationKind, InstanceStatus>> = { start: 'starting', recover: 'starting', create: 'creating' };

/**
 * The status to show. A wake is queued before the engine picks it up and marks the browser
 * starting; until then the browser still reads sleeping, and offering Wake again would only
 * collide with the queued one.
 */
export function shownStatus(i: Pick<Instance, 'status' | 'currentOperation'>): InstanceStatus {
  return (i.status === 'sleeping' && i.currentOperation && QUEUED_WAKE[i.currentOperation.kind]) || i.status;
}

export const regionKey = (id: Instance['regionId']) => `create.region.${id}` as MessageKey;

export function regionInfo(id: Instance['regionId']) {
  return REGION_INFO[id];
}

/**
 * Whether a new browser can still come up by itself: creation keeps retrying through a capacity
 * shortage or a provider problem, so only another status ends the wait to open it.
 */
export const stillCreating = (s: InstanceStatus) => s === 'creating' || s === 'waiting_capacity' || s === 'provider_issue';

/** True while an operation is moving the browser between states. */
export const isTransitioning = (i: Instance) => ['creating', 'starting', 'stopping'].includes(i.status) || !!i.currentOperation;
