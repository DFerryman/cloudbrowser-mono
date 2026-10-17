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
