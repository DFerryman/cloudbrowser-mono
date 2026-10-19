import { z } from 'zod';

/** `change_ip` is retired: no longer created or run, kept so earlier operations still parse. */
export const OperationKind = z.enum([
  'create',
  'start',
  'stop',
  'recover',
  'restore',
  'change_ip',
  'delete',
  'undelete',
  'purge',
  'resize_volume',
]);
export type OperationKind = z.infer<typeof OperationKind>;

export const OperationStatus = z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled']);
export type OperationStatus = z.infer<typeof OperationStatus>;

export const UNFINISHED_OPERATION_STATUSES: OperationStatus[] = ['queued', 'running', 'waiting'];

/** Steps per operation kind, in order (page 10, "Create steps"). */
export const OPERATION_STEPS = {
  create: [
    'allocate_ip',
    'screen_ip',
    'create_nic',
    'create_volume',
    'issue_bootstrap',
    'create_vm',
    'await_agent',
    'verify_binding',
    'verify_ip_in_chrome',
    'finish',
  ],
  start: ['ensure_running', 'await_agent', 'verify_binding', 'verify_ip_in_chrome', 'finish'],
  stop: ['prepare_shutdown', 'ensure_stopped', 'verify_binding', 'finish'],
  change_ip: [],
  delete: ['prepare_shutdown', 'ensure_stopped', 'finish'],
  undelete: ['finish'],
  purge: ['delete_resources', 'finish'],
  // A new VM generation in another zone of the same region, with the same IP and data (page 10).
  recover: [
    'snapshot_volume',
    'restore_volume',
    'create_nic',
    'issue_bootstrap',
    'create_vm',
    'await_agent',
    'verify_binding',
    'verify_ip_in_chrome',
    'finish',
  ],
  // From a provider snapshot (swapped in while asleep) or an archive (unpacked by the agent while running).
  restore: ['restore_volume', 'swap_volume', 'restore_archive', 'finish'],
  // Grows the data volume online (ModifyVolume), then the file system: by the agent while running, at the next boot otherwise.
  resize_volume: ['resize_volume', 'grow_filesystem', 'finish'],
} as const satisfies Record<OperationKind, readonly string[]>;

export type OperationStep<K extends OperationKind = OperationKind> = (typeof OPERATION_STEPS)[K][number];

/** The four user-facing phases of a create (page 1, "Flow: create a browser"). */
export const CREATE_PHASES = ['reserve_ip', 'create_storage', 'start_chrome', 'check_ip'] as const;
export type CreatePhase = (typeof CREATE_PHASES)[number];

export function createPhaseForStep(step: string | null): CreatePhase {
  switch (step) {
    case 'allocate_ip':
    case 'screen_ip':
    case 'create_nic':
    case null:
      return 'reserve_ip';
    case 'create_volume':
      return 'create_storage';
    case 'issue_bootstrap':
    case 'create_vm':
    case 'await_agent':
      return 'start_chrome';
    default:
      return 'check_ip';
  }
}

export const OperationSummary = z.object({
  id: z.string(),
  kind: OperationKind,
  status: OperationStatus,
  step: z.string().nullable(),
});
export type OperationSummary = z.infer<typeof OperationSummary>;

export const Operation = OperationSummary.extend({
  instanceId: z.string(),
  attempt: z.number().int(),
  errorClass: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Operation = z.infer<typeof Operation>;

export const Accepted = z.object({
  operationId: z.string(),
  instanceId: z.string(),
});
export type Accepted = z.infer<typeof Accepted>;
