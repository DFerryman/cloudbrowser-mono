import type { AgentControlMode } from '@cloudbrowser/contracts';

/** The browser's row as the gateway reads it from D1 on every lease. */
export type LiveInstance = { user_id: string; status: string; desired_state: string; generation: number | null; agent_access: number; agent_control: string };

export const controlMode = (row: Pick<LiveInstance, 'agent_control'>): AgentControlMode =>
  (row.agent_control === 'user' || row.agent_control === 'privacy' ? row.agent_control : 'agent');

/** A deleted (or deleting) browser keeps no connection of any kind. */
export const browserGone = (row: Pick<LiveInstance, 'status' | 'desired_state'>) =>
  row.desired_state === 'deleted' || ['deleting', 'purged', 'failed'].includes(row.status);

/** A failed D1 read is retried after these pauses before authorization fails closed. */
const READ_RETRY_MS = [100, 400];

export async function withRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const wait = READ_RETRY_MS[attempt];
      if (wait === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
