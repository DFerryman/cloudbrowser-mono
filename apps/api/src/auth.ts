import { schema, type Db } from '@cloudbrowser/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { passkey } from '@better-auth/passkey';
import { APIError } from 'better-auth/api';
import { emailOTP, magicLink } from 'better-auth/plugins';
import { count, eq, sql } from 'drizzle-orm';
import { sendAlreadyRegistered, sendRegistrationLink, sendSignInCode } from './notifications/user.js';
import type { Env } from './env.js';
import { twoFactorGuard, twoFactorPlugin } from './two-factor.js';

/** Sign-up is open unless the operator turns on `invite_only`; then only invited addresses may sign in. */
async function isInvited(db: Db, email: string) {
  const [flag] = await db.select().from(schema.controlFlags).where(eq(schema.controlFlags.key, 'invite_only'));
  if (flag?.value !== 'true') return true;
  const [row] = await db.select().from(schema.invites).where(eq(schema.invites.email, email.trim().toLowerCase()));
  return !!row;
}

/** WebAuthn relying party: the app's own host and origin (passkeys are bound to them). */
export function relyingParty(env: Env) {
  const url = new URL(env.APP_URL);
  return { rpID: url.hostname, origin: url.origin, rpName: 'Nevazu' };
}

/** How long a registration link works (it is also single use). */
export const REGISTRATION_LINK_SECONDS = 30 * 60;

/**
 * Better Auth, email only (page 1, "Auth"):
 *
 * - Sign-up: the address gets a single-use registration link (magic-link plugin). Opening it and
 *   confirming creates the account and signs in. A sign-up for an address that already has an
 *   account emails a pointer to sign-in instead, so the sign-up form cannot be used to find
 *   accounts, nor to sign in past a passkey or two-step verification.
 * - Sign-in: a 6-digit email code (email-OTP plugin, which no longer creates accounts) or, once
 *   the user has added one, a passkey. `startSignIn` picks the method from the address. Email codes
 *   always work, passkey or not, and are followed by the authenticator-app code when two-step
 *   verification is on (two-factor.ts). A passkey sign-in requires user verification (fingerprint,
 *   face or PIN), so the passkey alone is already two factors.
 *
 * While the operator switch `invite_only` is on, nothing is sent to, and no account created for,
 * addresses outside the `invites` table. OAuth comes later.
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
      passkey({
        ...relyingParty(env),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        authentication: {
          // The plugin asks for user verification but accepts an assertion without it. A passkey
          // stands in for both the email code and the authenticator app, so it must prove both.
          async afterVerification({ verification }) {
            if (!verification.authenticationInfo.userVerified) {
              throw new APIError('UNAUTHORIZED', { message: 'Confirm with your fingerprint, face or device PIN.', code: 'USER_VERIFICATION_REQUIRED' });
            }
          },
        },
      }),
      magicLink({
        expiresIn: REGISTRATION_LINK_SECONDS,
        storeToken: 'hashed',
        async sendMagicLink({ email, token, metadata }) {
          const address = email.trim().toLowerCase();
          if (!(await isInvited(db, address))) return;
          // Registration only: an existing account is never signed in by link.
          const send = (await findAccount(db, address))
            ? sendAlreadyRegistered(env, address)
            : sendRegistrationLink(env, address, `${env.APP_URL}/sign-up/complete?token=${encodeURIComponent(token)}`, metadata?.from === 'sign-in');
          waitUntil(send.catch((e) => console.error('registration email failed', e)));
        },
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        // Codes sign in to existing accounts only; new accounts come from a registration link.
        disableSignUp: true,
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

async function findAccount(db: Db, email: string) {
  const [row] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(sql`lower(${schema.user.email})`, email));
  return row ?? null;
}

export type SignInMethod = 'passkey' | 'code';

/**
 * The sign-in page's first step. An account with a passkey is offered the passkey (an email code
 * is one click away). Otherwise the email code is sent now; an address without an account gets a
 * registration link instead, and the answer is the same as for an account, so the form does not
 * tell who has one. Only "has a passkey" is visible, which the passkey prompt shows anyway.
 */
export async function startSignIn(auth: ReturnType<typeof createAuth>, db: Db, email: string, headers: Headers): Promise<SignInMethod> {
  const account = await findAccount(db, email);
  if (account) {
    const [passkeys] = await db.select({ n: count() }).from(schema.passkey).where(eq(schema.passkey.userId, account.id));
    if (passkeys && passkeys.n > 0) return 'passkey';
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' }, headers });
  } else {
    await auth.api.signInMagicLink({ body: { email, metadata: { from: 'sign-in' } }, headers });
  }
  return 'code';
}
