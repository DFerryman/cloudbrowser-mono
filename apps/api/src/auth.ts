import { schema, type Db } from '@cloudbrowser/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { passkey } from '@better-auth/passkey';
import { emailOTP } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { sendSignInCode } from './email.js';
import type { Env } from './env.js';
import { twoFactorGuard, twoFactorPlugin } from './two-factor.js';

async function isInvited(db: Db, email: string) {
  const [row] = await db.select().from(schema.invites).where(eq(schema.invites.email, email.trim().toLowerCase()));
  return !!row;
}

/** WebAuthn relying party: the app's own host and origin (passkeys are bound to them). */
export function relyingParty(env: Env) {
  const url = new URL(env.APP_URL);
  return { rpID: url.hostname, origin: url.origin, rpName: 'Nevazu' };
}

/**
 * Better Auth with email one-time codes (page 1, "Auth"). The pilot is invite-only, so codes are
 * only sent to, and accounts only created for, addresses in the `invites` table. Signed-in users
 * can add passkeys and turn on two-factor sign-in with an authenticator app (two-factor.ts).
 * OAuth comes later.
 */
export function createAuth(env: Env, db: Db, waitUntil: (p: Promise<unknown>) => void) {
  return betterAuth({
    appName: 'Nevazu',
    baseURL: env.APP_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification, passkey: schema.passkey, twoFactor: schema.twoFactor },
    }),
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: env.APP_URL.startsWith('https://'),
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
    },
    hooks: { before: twoFactorGuard },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await isInvited(db, user.email))) return false;
            return { data: { ...user, name: user.name || user.email.split('@')[0] } };
          },
        },
      },
    },
    plugins: [
      twoFactorPlugin(),
      passkey({ ...relyingParty(env), authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in') return;
          // Answer the same way whether or not the address is invited, so invites cannot be probed.
          if (!(await isInvited(db, email))) return;
          waitUntil(sendSignInCode(env, email, otp).catch((e) => console.error('sign-in email failed', e)));
        },
      }),
    ],
  });
}
