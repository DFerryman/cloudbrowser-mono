import type { AgentCommandKind } from '@cloudbrowser/contracts';
import { schema, type AgentCommandsMessage, type Db } from '@cloudbrowser/db';
import type { Executor, OpContext, Placement } from '@cloudbrowser/executors';
import { and, eq, gte } from 'drizzle-orm';

const { agentCommands, instanceHealth } = schema;

export interface AgentCommand {
  /** Deterministic, e.g. `<operation id>:<step>:<round>`, so a retried step finds its command. */
  id: string;
  instanceId: string;
  kind: AgentCommandKind;
  payload: Record<string, unknown>;
}

export interface CommandReply {
  status: 'pending' | 'succeeded' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
  createdAt: Date;
}

/**
 * What the engine needs from the in-VM agent (page 2): readiness, and durable commands with
 * replies. Commands go through `agent_commands` and the session gateway.
 */
export interface AgentBridge {
  /** True for real agents, which run their own IP check every 5 minutes and report it. */
  readonly selfReportsIpChecks: boolean;
  /** 'ready' once the agent of this placement generation reported `ready` at or after `since`. */
  status(instanceId: string, generation: number, since: Date): Promise<'ready' | 'pending'>;
  /** Idempotent: creates the command if it does not exist and asks the gateway to deliver it. */
  send(cmd: AgentCommand): Promise<void>;
  reply(commandId: string): Promise<CommandReply>;
}

/**
 * Agent of a real VM, reached through `agent_commands` and the gateway. The engine pokes the
 * gateway through the `cloudbrowser-agent-commands` queue, so it needs no binding to the gateway.
 */
export class GatewayAgentBridge implements AgentBridge {
  readonly selfReportsIpChecks = true;

  constructor(
    private readonly db: Db,
    private readonly poke: (msg: AgentCommandsMessage) => Promise<void>,
    private readonly now: () => Date,
  ) {}

  async status(instanceId: string, generation: number, since: Date) {
    const [h] = await this.db
      .select({ id: instanceHealth.instanceId })
      .from(instanceHealth)
      .where(
        and(
          eq(instanceHealth.instanceId, instanceId),
          eq(instanceHealth.agentReadyGeneration, generation),
          gte(instanceHealth.agentReadyAt, since),
        ),
      );
    return h ? ('ready' as const) : ('pending' as const);
  }

  async send(cmd: AgentCommand) {
    await this.db
      .insert(agentCommands)
      .values({ id: cmd.id, instanceId: cmd.instanceId, kind: cmd.kind, payload: cmd.payload, status: 'pending', createdAt: this.now() })
      .onConflictDoNothing();
    const [row] = await this.db.select({ status: agentCommands.status }).from(agentCommands).where(eq(agentCommands.id, cmd.id));
    if (row?.status === 'pending') await this.poke({ instanceId: cmd.instanceId });
  }

  async reply(commandId: string): Promise<CommandReply> {
    const [row] = await this.db.select().from(agentCommands).where(eq(agentCommands.id, commandId));
    if (!row) return { status: 'pending', createdAt: this.now() };
    const done = row.status === 'succeeded' || row.status === 'failed';
    return {
      status: done ? (row.status as 'succeeded' | 'failed') : 'pending',
      result: row.reply ?? undefined,
      error: typeof row.reply?.error === 'string' ? row.reply.error : undefined,
      createdAt: row.createdAt,
    };
  }
}

/**
 * Stand-in agent for the `fake` executor: ready as soon as the fake VM runs, and Chrome "sees"
 * whatever public address the fake provider has bound to the VM's interface.
 */
export class FakeAgentBridge implements AgentBridge {
  readonly selfReportsIpChecks = false;
  private readonly sent = new Map<string, AgentCommand>();

  constructor(
    private readonly executor: Executor,
    private readonly ctx: () => OpContext,
    private readonly placementOf: (instanceId: string) => Promise<Placement | null>,
    private readonly now: () => Date,
  ) {}

  async status() {
    return 'ready' as const;
  }

  async send(cmd: AgentCommand) {
    this.sent.set(cmd.id, cmd);
  }

  async reply(commandId: string): Promise<CommandReply> {
    const cmd = this.sent.get(commandId);
    if (!cmd) return { status: 'pending', createdAt: this.now() };
    if (cmd.kind !== 'ip_check') return { status: 'succeeded', result: {}, createdAt: this.now() };
    const p = await this.placementOf(cmd.instanceId);
    const observed = p ? await this.executor.describe(this.ctx(), p) : null;
    // Chrome uses the first public address; a second one is a binding problem caught by verifyEgress.
    const addresses = observed?.vm === 'running' ? observed.publicAddresses.slice(0, 1) : [];
    return { status: 'succeeded', result: { observed: addresses }, createdAt: this.now() };
  }
}

/** The single-use bootstrap token for a VM, derived so create_vm can mint it without storing it. */
export async function bootstrapToken(secret: string, instanceId: string, operationId: string, generation: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`bootstrap:${instanceId}:${operationId}:${generation}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
