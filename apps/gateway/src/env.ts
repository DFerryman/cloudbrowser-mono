import type { GatewayToAgent, ViewerTokenClaims } from '@cloudbrowser/contracts';

export type AgentAuth =
  | { ok: true; generation: number; credential?: string }
  | { ok: false; reason: string };

/** The api Worker's `Internal` RPC entrypoint (page 2: the gateway depends on api internal endpoints). */
export interface InternalApi {
  authenticateAgent(input: { instanceId: string; bootstrap?: string; credential?: string }): Promise<AgentAuth>;
  agentMessage(instanceId: string, generation: number, frame: unknown): Promise<GatewayToAgent | null>;
  redeemViewerToken(claims: ViewerTokenClaims): Promise<boolean>;
}

export interface Env {
  DB: D1Database;
  API: InternalApi;
  INSTANCE_GATEWAY: DurableObjectNamespace;
  /** Ed25519 public key (JWK JSON) for viewer tokens. */
  VIEWER_TOKEN_PUBLIC_KEY?: string;
}
