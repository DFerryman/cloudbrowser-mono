/**
 * Passkey step-up for /admin (page 10). A fresh WebAuthn assertion with user verification, from a
 * passkey the admin registered through Better Auth's passkey plugin, marks this sign-in session as
 * stepped up for 30 minutes. The challenge is single-use and expires after 2 minutes.
 */
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { schema, type Db } from '@cloudbrowser/db';
import { and, eq } from 'drizzle-orm';
import { relyingParty } from '../auth.js';
import type { Env } from '../env.js';
import { problem } from '../problem.js';

const { passkey, adminStepUps, auditLog } = schema;
const CHALLENGE_TTL_MS = 2 * 60_000;

const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export async function stepUpOptions(env: Env, db: Db, userId: string, sessionId: string) {
  const keys = await db.select().from(passkey).where(eq(passkey.userId, userId));
  if (!keys.length) throw problem(409, 'invalid_state', 'Add a passkey to your account first (Settings → Security).');
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(env).rpID,
    userVerification: 'required',
    timeout: 60_000,
    allowCredentials: keys.map((k) => ({
      id: k.credentialID,
      transports: k.transports ? (k.transports.split(',') as AuthenticatorTransportFuture[]) : undefined,
    })),
  });
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
  await db
    .insert(adminStepUps)
    .values({ sessionId, userId, challenge: options.challenge, challengeExpiresAt: expires })
    .onConflictDoUpdate({ target: adminStepUps.sessionId, set: { userId, challenge: options.challenge, challengeExpiresAt: expires } });
  return options;
}

export async function stepUpVerify(env: Env, db: Db, userId: string, sessionId: string, response: AuthenticationResponseJSON, ip: string | null) {
  const [row] = await db.select().from(adminStepUps).where(eq(adminStepUps.sessionId, sessionId));
  if (!row?.challenge || !row.challengeExpiresAt || row.challengeExpiresAt.getTime() < Date.now() || row.userId !== userId) {
    throw problem(400, 'validation_failed', 'The passkey request expired. Try again.');
  }
  // Single use: clear the challenge before verifying.
  await db.update(adminStepUps).set({ challenge: null, challengeExpiresAt: null }).where(eq(adminStepUps.sessionId, sessionId));
  const [key] = await db
    .select()
    .from(passkey)
    .where(and(eq(passkey.userId, userId), eq(passkey.credentialID, response.id)));
  if (!key) throw problem(400, 'validation_failed', 'Unknown passkey.');
  const rp = relyingParty(env);
  let verified = false;
  let newCounter = key.counter;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: key.credentialID,
        publicKey: unb64(key.publicKey),
        counter: key.counter,
        transports: key.transports ? (key.transports.split(',') as AuthenticatorTransportFuture[]) : undefined,
      },
    });
    verified = result.verified;
    newCounter = result.authenticationInfo.newCounter;
  } catch (e) {
    console.warn('step-up verification failed', (e as Error).message);
  }
  const now = new Date();
  if (!verified) {
    await db.insert(auditLog).values({ actor: `user:${userId}`, action: 'admin.step_up_failed', target: `session:${sessionId}`, detail: { ip }, createdAt: now });
    throw problem(403, 'step_up_required', 'The passkey could not be verified.');
  }
  await db.batch([
    db.update(passkey).set({ counter: newCounter }).where(eq(passkey.id, key.id)),
    db.update(adminStepUps).set({ verifiedAt: now }).where(eq(adminStepUps.sessionId, sessionId)),
    db.insert(auditLog).values({ actor: `user:${userId}`, action: 'admin.step_up', target: `session:${sessionId}`, detail: { ip, passkey: key.id }, createdAt: now }),
  ]);
  return now;
}
