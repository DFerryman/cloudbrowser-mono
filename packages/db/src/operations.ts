import { newId } from './ids.js';

/**
 * Deadlines per operation kind, in minutes (page 10, "Operations"). A stop or delete waits up to
 * 5 minutes for the agent's archive and then stops the VM anyway, which EC2 may take up to 10
 * minutes to finish before it is forced: their deadline must leave room for both. At 5 minutes it
 * expired first, the fallback never ran, and the browser stayed on "Going to sleep".
 */
export const OPERATION_DEADLINE_MIN: Record<string, number> = {
  create: 20,
  start: 15,
  stop: 20,
  recover: 60,
  restore: 60,
  delete: 20,
  undelete: 5,
  purge: 60,
  resize_volume: 30,
};

/** Values for a new `operations` row. The api inserts user operations; the engine inserts idle stops. */
export function operationRow(input: {
  instanceId: string;
  userId: string | null;
  kind: string;
  params?: Record<string, unknown>;
  id?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return {
    id: input.id ?? newId(now.getTime()),
    instanceId: input.instanceId,
    userId: input.userId,
    kind: input.kind,
    status: 'queued',
    step: null,
    attempt: 0,
    deadlineAt: new Date(now.getTime() + (OPERATION_DEADLINE_MIN[input.kind] ?? 20) * 60_000),
    params: input.params ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Body of a message on the `cloudbrowser-operations` queue (api and engine produce, engine consumes). */
export interface OperationMessage {
  operationId: string;
}

/** Body of a message on the `cloudbrowser-agent-commands` queue: deliver this instance's pending commands. */
export interface AgentCommandsMessage {
  instanceId: string;
}
