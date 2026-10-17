import type { Db, OperationMessage } from '@cloudbrowser/db';
import type { createAuth } from './auth.js';

export interface Env {
  DB: D1Database;
  /** The built web app (apps/web/dist), served on the same origin. */
  ASSETS: Fetcher;
  /** The engine Worker (worker mode): synchronous calls such as IP checks. */
  ENGINE: Fetcher;
  /** Operation dispatch to the engine (Cloudflare Queues). */
  OPERATIONS: Queue<OperationMessage>;
  /** Per-user SSE fan-out: the EventHub Durable Object hosted by the engine Worker. */
  EVENT_HUB: DurableObjectNamespace;
  /** Cloudflare Email Service binding for sign-in codes. */
  EMAIL?: SendEmail;
  /** Workers Rate Limiting bindings: sign-in attempts per IP/email, and API writes per user. */
  AUTH_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
  /** Public origin of the app, e.g. https://app.example.com. */
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  /** "development" also logs sign-in codes to the console (wrangler dev only simulates email). */
  ENVIRONMENT?: string;
  /** Sender on a domain onboarded to Cloudflare Email Service, e.g. no-reply@example.com. */
  EMAIL_FROM?: string;
  /** Public WebSocket URL of the session gateway, e.g. wss://connect.example.com. */
  GATEWAY_URL?: string;
  /** Ed25519 private key (JWK JSON) that signs 60 s viewer tokens. Secret. */
  VIEWER_TOKEN_PRIVATE_KEY?: string;
  /** Cloudflare Realtime TURN key: viewers and neko get short-lived credentials from it. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** `on` returns WebRTC connect info even for `fake` placements (local runs with a real agent and neko). */
  LIVE_VIEW?: string;
  /** Wraps per-browser archive keys (base64, 32 bytes); same value as the engine's. Secret. */
  ARCHIVE_MASTER_KEY?: string;
}

export type SessionUser = { id: string; email: string; name: string };

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    auth: ReturnType<typeof createAuth>;
    user: SessionUser;
  };
};
