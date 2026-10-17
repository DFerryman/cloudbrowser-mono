import type { Db } from '@cloudbrowser/db';
import type { createAuth } from './auth.js';

export interface Env {
  DB: D1Database;
  /** The built web app (apps/web/dist), served on the same origin. */
  ASSETS: Fetcher;
  /** The engine Worker (worker mode), reached only through this service binding. */
  ENGINE: Fetcher;
  /** Public origin of the app, e.g. https://app.example.com. */
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  /** "development" logs sign-in codes to the console instead of sending email. */
  ENVIRONMENT?: string;
  RESEND_API_KEY?: string;
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
