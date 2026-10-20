/**
 * Email delivery and the small state store shared by both notification categories:
 *  - user.ts: what a user is told about their own account (sign-in codes, credit, rewards, browsers);
 *  - admin.ts: what operators are told about the platform (alerts, inventory, growth milestones).
 * Everything goes through Cloudflare Email Service (the `send_email` binding `EMAIL`).
 */
import { schema, type Db } from '@cloudbrowser/db';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';

const { user, notificationState } = schema;

export type Message = { subject: string; text: string; html?: string };

const from = (env: Env, name: string) => ({ email: env.EMAIL_FROM ?? 'no-reply@example.com', name });

/** Sends to one address; throws when the binding is missing or the send fails. */
export async function sendTo(env: Env, to: string, message: Message, sender = 'Nevazu') {
  if (!env.EMAIL) throw new Error('send_email binding EMAIL is not configured');
  try {
    await env.EMAIL.send({ from: from(env, sender), to, ...message });
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new Error(`Email Service send failed${code ? ` (${code})` : ''}: ${(e as Error).message}`);
  }
}

/** Emails a user by id. Best effort: a missing user, binding or failed send is logged, not thrown. */
export async function sendToUser(env: Env, db: Db, userId: string, message: Message): Promise<boolean> {
  const [u] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (!u || !env.EMAIL) return false;
  try {
    await sendTo(env, u.email, message);
    return true;
  } catch (e) {
    console.error('user email failed', userId, e);
    return false;
  }
}

export async function getState(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select({ value: notificationState.value }).from(notificationState).where(eq(notificationState.key, key));
  return row?.value ?? null;
}

export async function setState(db: Db, key: string, value: string | number, now: Date) {
  await db.insert(notificationState).values({ key, value: String(value), updatedAt: now })
    .onConflictDoUpdate({ target: notificationState.key, set: { value: String(value), updatedAt: now } });
}

export async function clearState(db: Db, key: string) {
  await db.delete(notificationState).where(eq(notificationState.key, key));
}

/** Whether `key` (a timestamp written by `setState`) is older than `ms`, or was never set. */
export async function cooledDown(db: Db, key: string, ms: number, now: Date) {
  const last = Number(await getState(db, key));
  return !last || now.getTime() - last >= ms;
}
