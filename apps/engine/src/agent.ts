import type { Executor, OpContext, Placement } from '@cloudbrowser/executors';

/**
 * What the engine needs from the in-VM agent. The real implementation sends `agent.v1` commands
 * through `agent_commands` and the session gateway (page 2); it arrives with services/agent.
 */
export interface AgentBridge {
  /** 'pending' until the agent has registered, mounted the volume and started Chrome. */
  status(instanceId: string, generation: number): Promise<'ready' | 'pending'>;
  /** Graceful Chrome close, sync and archive backup. Resolves false if the agent did not ack. */
  prepareShutdown(instanceId: string): Promise<boolean>;
  /** The outbound addresses observed from a separate browser context inside Chrome (page 3). */
  checkIpFromChrome(instanceId: string, placement: Placement): Promise<{ observed: string[] }>;
}

/**
 * Stand-in agent for the `fake` executor: ready as soon as the fake VM runs, and Chrome "sees"
 * whatever public address the fake provider has bound to the VM's interface.
 */
export class FakeAgentBridge implements AgentBridge {
  constructor(
    private readonly executor: Executor,
    private readonly ctx: () => OpContext,
  ) {}

  async status() {
    return 'ready' as const;
  }
  async prepareShutdown() {
    return true;
  }
  async checkIpFromChrome(_instanceId: string, placement: Placement) {
    const observed = await this.executor.describe(this.ctx(), placement);
    if (observed.vm !== 'running') return { observed: [] };
    // Chrome uses the first public address; a second one is a binding problem caught by verifyEgress.
    return { observed: observed.publicAddresses.slice(0, 1) };
  }
}
