import type { GatewayToAgent, ViewerTokenClaims } from '@cloudbrowser/contracts';

/** `location` on success: where the browser's object belongs (objectLocationHint); absent from an older api. */
export type AgentAuth =
  | { ok: true; generation: number; credential?: string; location?: string }
  | { ok: false; reason: string };

/** A coding agent's access key or sign-in token on an MCP request (docs/agent-access.md); no session is opened by it. */
export type McpAuth =
  | { ok: true; clientId: string; userId: string; generation: number; capability: 'control' | 'view'; name: string; location?: string }
  | { ok: false; reason: 'invalid_token' | 'expired' | 'unknown_instance' };

/** The api Worker's `Internal` RPC entrypoint (page 2: the gateway depends on api internal endpoints). */
export interface InternalApi {
  authenticateAgent(input: { instanceId: string; bootstrap?: string; credential?: string }): Promise<AgentAuth>;
  agentMessage(instanceId: string, generation: number, frame: unknown): Promise<GatewayToAgent | null>;
  redeemViewerToken(claims: ViewerTokenClaims): Promise<boolean>;
  /** Plain archive key of the instance, or null when archives are off or the key is destroyed. */
  archiveKey(instanceId: string): Promise<string | null>;
  /** Checks an access key against the browser in the URL; `client` is the MCP client's name, if known. */
  authenticateMcp(input: { instanceId: string; key: string; ip?: string; client?: string }): Promise<McpAuth>;
  /** Records a coding agent's session (audit, Settings); any other open one ends as `replaced`. */
  openAutomationSession(instanceId: string, clientId: string): Promise<{ sessionId: string }>;
  endAutomationSession(sessionId: string, reason: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  API: InternalApi;
  INSTANCE_GATEWAY: DurableObjectNamespace;
  /** Ed25519 public key (JWK JSON) for viewer tokens. */
  VIEWER_TOKEN_PUBLIC_KEY?: string;
  /**
   * Workers Rate Limiting (`ratelimits` in wrangler.jsonc): MCP calls per access key, and failed
   * authentications and upload URL guesses per address. Optional, so a local run works without it.
   */
  MCP_LIMITER?: RateLimit;
  /**
   * Comma-separated origins (scheme://host[:port]) whose browser pages may call the MCP endpoint.
   * Coding agents send no Origin; any other origin is refused, which stops a web page from using a
   * key the browser has no business holding (DNS rebinding, CSRF). Empty by default.
   */
  MCP_ALLOWED_ORIGINS?: string;
  /**
   * `on`: coding agents may sign in with OAuth instead of sending a key (docs/agent-access.md,
   * "OAuth sign-in"). A 401 without a key then names this Worker's protected-resource metadata,
   * which points to OAUTH_ISSUER. Anything else keeps the plain key challenge and serves no metadata.
   */
  MCP_OAUTH?: string;
  /** The OAuth authorization server: the app's origin, e.g. https://nevazu.com. */
  OAUTH_ISSUER?: string;
}
