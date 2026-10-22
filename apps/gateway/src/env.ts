import type { GatewayToAgent, ViewerTokenClaims } from '@cloudbrowser/contracts';

export type AgentAuth =
  | { ok: true; generation: number; credential?: string }
  | { ok: false; reason: string };

/** A paired coding-agent bridge admitted for one session (docs/agent-access.md). */
export type AutomationAuth =
  | { ok: true; sessionId: string; clientId: string; userId: string; generation: number }
  | { ok: false; reason: string };

/** The api Worker's `Internal` RPC entrypoint (page 2: the gateway depends on api internal endpoints). */
export interface InternalApi {
  authenticateAgent(input: { instanceId: string; bootstrap?: string; credential?: string }): Promise<AgentAuth>;
  agentMessage(instanceId: string, generation: number, frame: unknown): Promise<GatewayToAgent | null>;
  redeemViewerToken(claims: ViewerTokenClaims): Promise<boolean>;
  /** Plain archive key of the instance, or null when archives are off or the key is destroyed. */
  archiveKey(instanceId: string): Promise<string | null>;
  /** A bridge's long-lived credential, checked against the pairing; opens an automation session. */
  authenticateAutomation(input: { instanceId: string; credential: string }): Promise<AutomationAuth>;
  endAutomationSession(sessionId: string, reason: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  API: InternalApi;
  INSTANCE_GATEWAY: DurableObjectNamespace;
  /** Ed25519 public key (JWK JSON) for viewer tokens. */
  VIEWER_TOKEN_PUBLIC_KEY?: string;
}
