/**
 * Closing an account (Terms sections 8 and 9). A user closes their own account from the Account
 * page and confirms with a code sent to their email. Then, in this order:
 *
 *  1. At once: the closure is recorded (`account_closures`, status `closing`); every sign-in
 *     session, passkey, authenticator app and pending sign-in code is deleted, and no new session
 *     can be created (trigger, migration 0040); coding-agent keys and sign-ins are revoked; every
 *     browser is permanently deleted through the same path as Delete browser. Promotion rewards
 *     not yet credited are dropped, and the account earns no new ones (promotions.ts).
 *  2. Once every browser is purged, nothing meters any more (`closed`): the final balance is
 *     recorded with the part of it that was paid for, per order, for support.
 *  3. 30 days after the closure, even with a browser not purged yet, the balance left is written
 *     off and the personal data erased: the email address and name are replaced, the browsers'
 *     names, session logs and agent records deleted. Billing records, Terms acceptances, the audit
 *     log and the browser ledger stay, tied to the anonymous user id, and the address can sign up
 *     again.
 *
 * Closing refunds nothing by itself. A user who wants unused paid credit back writes to support,
 * who agrees it with them and refunds it by hand in the provider's dashboard; the provider's
 * refund webhook takes it off the balance as for any refund (billing/ledger.ts).
 *
 * Self-serve closure is refused during a payment dispute hold, while an operator has suspended a
 * browser, and for operators' own accounts; support handles those.
 */
import {
  CLOSURE_CODE_ATTEMPTS,
  CLOSURE_CODE_SECONDS,
  CLOSURE_ERASE_DAYS,
  type ClosureBlocker,
  type ClosurePreview,
  type ClosureReason,
} from '@cloudbrowser/contracts';
import { newId, raiseAlert, schema, sha256Hex, type ClosureOrder, type Db } from '@cloudbrowser/db';
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql, type SQLWrapper } from 'drizzle-orm';
import type { Context } from 'hono';
import { isAdminEmail } from './admin/access.js';
import { revokeUserClients } from './automation.js';
import { applyBalance, notifyHub } from './billing/ledger.js';
import { deleteBrowserPermanently, permanentDeleteStatements } from './deletion.js';
import type { AppEnv, Env } from './env.js';
import { closureCodeMessage, closureErasedMessage, closureStartedMessage } from './notifications/user.js';
import { sendTo } from './notifications/send.js';
import { systemOperation } from './ops.js';
import { problem } from './problem.js';

const {
  accountClosures, admins, alerts, auditLog, automationClients, automationSessions, balanceTransactions, billingAccounts, browserInstances,
  events, idempotencyKeys, invites, notificationState, oauthAuthorizationCodes, oauthSpentRefreshTokens, promotionCompletions, user, userNotices, verification,
  viewerSessions, session, passkey, twoFactor, account, adminStepUps,
} = schema;

/** As on the site (apps/web/src/lib/site.ts). */
const SUPPORT_EMAIL = 'support@nevazu.com';
const DAY = 86_400_000;
const CENT_MICROS = 10_000;
/** What an erased account's address becomes: unique, and undeliverable (RFC 2606 `.invalid`). */
export const erasedEmail = (userId: string) => `${userId}@closed.invalid`;
const codeIdentifier = (userId: string) => `account-closure:${userId}`;
/** `column LIKE before + literal + after`, with `%`, `_` and `\` in `literal` matching only themselves. */
const likeLiteral = (column: SQLWrapper, before: string, literal: string, after: string) =>
  sql`${column} LIKE ${before + literal.replace(/[\\%_]/g, '\\$&') + after} ESCAPE '\\'`;

// ---------------------------------------------------------------------------------------------
// What closing would do

/** Why the account cannot be closed from the app, or null. */
export async function closureBlocker(db: Db, env: Env, userId: string, email: string): Promise<ClosureBlocker | null> {
  const [frozen] = await db.select({ at: billingAccounts.frozenAt }).from(billingAccounts).where(and(eq(billingAccounts.userId, userId), isNotNull(billingAccounts.frozenAt)));
  if (frozen) return 'dispute';
  const [suspended] = await db.select({ id: browserInstances.id }).from(browserInstances)
    .where(and(eq(browserInstances.userId, userId), ne(browserInstances.status, 'purged'), isNotNull(browserInstances.suspendedAt))).limit(1);
  if (suspended) return 'suspended';
  const [staff] = await db.select({ id: admins.userId }).from(admins).where(eq(admins.userId, userId));
  if (staff || isAdminEmail(env, email)) return 'operator';
  return null;
}

/**
 * The unused paid credit, support's reference for a refund: the smaller of the balance and the
 * paid credit not yet refunded or disputed. Credit that was not paid for (signup, promotions,
 * operator credit) counts as spent first. It is split over the newest paid orders first, each up
 * to its unrefunded credit; on each, refunding it would be that credit's share of what was paid,
 * tax included, which the refund webhook maps back to the same credit (billing/ledger.ts).
 */
export async function unusedPaidCredit(db: Db, userId: string): Promise<{ balanceMicros: number; paidMicros: number; orders: ClosureOrder[] }> {
  const [acct] = await db.select({ balance: billingAccounts.balanceMicros }).from(billingAccounts).where(eq(billingAccounts.userId, userId));
  const balanceMicros = acct?.balance ?? 0;
  const paid = await db.select().from(balanceTransactions)
    .where(and(eq(balanceTransactions.userId, userId), eq(balanceTransactions.kind, 'topup'), isNotNull(balanceTransactions.orderId), isNotNull(balanceTransactions.appliedAt), sql`${balanceTransactions.amountMicros} > 0`))
    .orderBy(desc(balanceTransactions.createdAt), desc(balanceTransactions.id));
  const reversed = new Map((await db.select({ orderId: balanceTransactions.orderId, micros: sql<number>`sum(${balanceTransactions.amountMicros})` }).from(balanceTransactions)
    .where(and(eq(balanceTransactions.userId, userId), inArray(balanceTransactions.kind, ['refund', 'dispute']), isNotNull(balanceTransactions.orderId), isNotNull(balanceTransactions.appliedAt)))
    .groupBy(balanceTransactions.orderId)).map((r) => [r.orderId, Number(r.micros)]));
  const orders = paid.map((p) => ({ p, left: Math.max(0, p.amountMicros + (reversed.get(p.orderId) ?? 0)) })).filter((o) => o.left > 0);
  const paidMicros = Math.max(0, Math.min(balanceMicros, orders.reduce((a, o) => a + o.left, 0)));
  const split: ClosureOrder[] = [];
  let left = paidMicros;
  for (const o of orders) {
    if (left <= 0) break;
    const creditMicros = Math.min(o.left, left);
    left -= creditMicros;
    // Older rows without the amount paid are taken as untaxed.
    const refundCents = o.p.grossAmountCents ? Math.round((creditMicros * o.p.grossAmountCents) / o.p.amountMicros) : Math.round(creditMicros / CENT_MICROS);
    split.push({ orderId: o.p.orderId!, provider: o.p.actor === 'stripe' ? 'stripe' : 'creem', creditMicros, refundCents, currency: o.p.currency ?? 'USD' });
  }
  return { balanceMicros, paidMicros, orders: split };
}

export async function closurePreview(db: Db, env: Env, u: { id: string; email: string }): Promise<ClosurePreview> {
  const browsers = await db.select({ id: browserInstances.id, name: browserInstances.name }).from(browserInstances)
    .where(and(eq(browserInstances.userId, u.id), ne(browserInstances.status, 'purged'))).orderBy(browserInstances.createdAt);
  const [acct] = await db.select({ balance: billingAccounts.balanceMicros }).from(billingAccounts).where(eq(billingAccounts.userId, u.id));
  return { blocker: await closureBlocker(db, env, u.id, u.email), browsers, balanceMicros: acct?.balance ?? 0 };
}

function refuse(blocker: ClosureBlocker): never {
  if (blocker === 'dispute') throw problem(409, 'account_frozen', `A payment dispute is open on this account. Write to ${SUPPORT_EMAIL} to close it.`);
  if (blocker === 'suspended') throw problem(409, 'suspended', `A browser on this account is suspended. Write to ${SUPPORT_EMAIL} to close it.`);
  throw problem(403, 'forbidden', 'Operator accounts are closed by removing their admin access first.');
}

// ---------------------------------------------------------------------------------------------
// The confirmation code

/** Six digits, uniformly drawn. */
function newCode(): string {
  const limit = 4_294_000_000; // largest multiple of 1e6 below 2^32
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n! < limit) return String(n! % 1_000_000).padStart(6, '0');
  }
}

/** Emails a closure code to the account's address. At most one a minute; a new code replaces the last. */
export async function sendClosureCode(env: Env, db: Db, u: { id: string; email: string }, now = new Date()) {
  const blocker = await closureBlocker(db, env, u.id, u.email);
  if (blocker) refuse(blocker);
  const identifier = codeIdentifier(u.id);
  const [last] = await db.select({ createdAt: verification.createdAt }).from(verification).where(eq(verification.identifier, identifier));
  if (last && now.getTime() - last.createdAt.getTime() < 60_000) throw problem(429, 'rate_limited', 'A code was just sent. Wait a minute before asking for another.');
  const code = newCode();
  await db.batch([
    db.delete(verification).where(eq(verification.identifier, identifier)),
    db.insert(verification).values({ id: newId(now.getTime()), identifier, value: `${await sha256Hex(`${identifier}:${code}`)}:0`, expiresAt: new Date(now.getTime() + CLOSURE_CODE_SECONDS * 1000), createdAt: now, updatedAt: now }),
  ]);
  if (env.ENVIRONMENT === 'development') console.log(`[dev] account closure code for ${u.email}: ${code}`);
  await sendTo(env, u.email, closureCodeMessage(env.APP_URL, code));
}

/** Checks a closure code; a wrong one counts, and the fifth wrong one ends the code. Returns its row id. */
async function checkClosureCode(db: Db, userId: string, code: string, now: Date): Promise<string> {
  const identifier = codeIdentifier(userId);
  const [row] = await db.select().from(verification).where(eq(verification.identifier, identifier));
  if (!row || row.expiresAt <= now) throw problem(400, 'invalid_code', 'This code has expired. Send a new one.');
  const [hash, tries] = row.value.split(':');
  if (hash === (await sha256Hex(`${identifier}:${code}`))) return row.id;
  const attempts = Number(tries) + 1;
  if (attempts >= CLOSURE_CODE_ATTEMPTS) {
    await db.delete(verification).where(eq(verification.id, row.id));
    throw problem(400, 'invalid_code', 'Too many wrong codes. Send a new one.');
  }
  await db.update(verification).set({ value: `${hash}:${attempts}`, updatedAt: now }).where(eq(verification.id, row.id));
  throw problem(400, 'invalid_code', 'That code is not right. Check the email and try again.');
}

// ---------------------------------------------------------------------------------------------
// Closing

/**
 * Closes the signed-in user's account (step 1 above). The request's session is deleted with the
 * others, so the caller is signed out when this returns.
 */
export async function closeAccount(c: Context<AppEnv>, input: { code: string; reason?: ClosureReason }) {
  const db = c.get('db');
  const u = c.get('user');
  const now = new Date();
  const [existing] = await db.select({ status: accountClosures.status }).from(accountClosures).where(eq(accountClosures.userId, u.id));
  if (existing) throw problem(409, 'invalid_state', 'This account is already being closed.');
  const blocker = await closureBlocker(db, c.env, u.id, u.email);
  if (blocker) refuse(blocker);
  const codeId = await checkClosureCode(db, u.id, input.code, now);
  const live = await db.select().from(browserInstances).where(and(eq(browserInstances.userId, u.id), ne(browserInstances.status, 'purged')));
  const credit = await unusedPaidCredit(db, u.id);
  const [recorded] = await db.batch([
    db.insert(accountClosures).values({ userId: u.id, status: 'closing', reason: input.reason ?? null, requestedAt: now, browsers: live.length })
      .onConflictDoNothing().returning({ userId: accountClosures.userId }),
    db.delete(verification).where(or(eq(verification.id, codeId), likeLiteral(verification.identifier, '%-otp-', u.email.toLowerCase(), ''))),
    db.delete(session).where(eq(session.userId, u.id)),
    db.delete(passkey).where(eq(passkey.userId, u.id)),
    db.delete(twoFactor).where(eq(twoFactor.userId, u.id)),
    db.delete(account).where(eq(account.userId, u.id)),
    db.update(user).set({ twoFactorEnabled: false, updatedAt: now }).where(eq(user.id, u.id)),
    db.delete(userNotices).where(and(eq(userNotices.userId, u.id), isNull(userNotices.sentAt))),
    // Rewards not yet credited are dropped, which returns their share of a task's budget.
    db.delete(promotionCompletions).where(and(eq(promotionCompletions.userId, u.id), isNull(promotionCompletions.creditedAt))),
    db.insert(auditLog).values({ actor: `user:${u.id}`, action: 'account.closure_requested', target: `user:${u.id}`,
      detail: { reason: input.reason ?? null, browsers: live.length, balanceMicros: credit.balanceMicros, paidMicros: credit.paidMicros, verifiedBy: 'email_code' }, createdAt: now }),
  ]);
  if (!recorded.length) throw problem(409, 'invalid_state', 'This account is already being closed.');
  await revokeUserClients(db, c.env, u.id, now, 'account_closed').catch((e) => console.error('closure: revoke agent access failed', u.id, e));
  for (const row of live) {
    // A browser this misses (another request racing it) is deleted by the closure sweep.
    await deleteBrowserPermanently(c, row, `closure:${row.id}`, `DELETE /v1/instances/${row.id}`, { closure: true })
      .catch((e) => console.error('closure: browser delete deferred to the sweep', row.id, e));
  }
  await raiseAlert(db, { source: 'billing', severity: 'info', title: `Account ${u.id} was closed by its owner: ${live.length} browsers deleted, $${(credit.paidMicros / 1e6).toFixed(2)} unused paid credit (refunded only if the user asks support)`,
    detail: { userId: u.id, browsers: live.length, balanceMicros: credit.balanceMicros, paidMicros: credit.paidMicros } }, now);
  c.executionCtx.waitUntil(sendTo(c.env, u.email, closureStartedMessage(c.env.APP_URL, { browsers: live.length, eraseDays: CLOSURE_ERASE_DAYS, supportEmail: SUPPORT_EMAIL }))
    .catch((e) => console.error('closure email failed', u.id, e)));
  return { browsers: live.length };
}

// ---------------------------------------------------------------------------------------------
// After closing: the api's 5-minute cron

/**
 * Moves every open closure on: deletes browsers the request missed, records the final balance once
 * all are purged, tells support of a payment that arrived after the closure, and erases the
 * personal data 30 days after the closure, whether or not every browser is purged by then.
 */
export async function closureSweep(env: Env, db: Db, now = new Date()) {
  const summary = { browsers: 0, closed: 0, latePayments: 0, erased: 0 };
  const open = await db.select().from(accountClosures).where(or(isNull(accountClosures.erasedAt), eq(accountClosures.status, 'closing')));
  for (const row of open) {
    try {
      if (row.status === 'closing') {
        const next = await advanceClosing(env, db, row, now);
        summary.browsers += next.deleted;
        if (next.closed) summary.closed++;
      }
      if (row.erasedAt) continue;
      summary.latePayments += await latePayments(db, row, now);
      const [current] = await db.select().from(accountClosures).where(eq(accountClosures.userId, row.userId));
      if (now.getTime() - current!.requestedAt.getTime() >= CLOSURE_ERASE_DAYS * DAY) {
        await eraseAccount(env, db, current!, now);
        summary.erased++;
      }
    } catch (e) {
      console.error('closure sweep failed', row.userId, e);
    }
  }
  return summary;
}

/**
 * A top-up credited after the closure (a checkout paid in another tab, a late webhook, the nightly
 * reconciliation): the user can no longer use it, so support is told to refund it.
 */
async function latePayments(db: Db, row: typeof accountClosures.$inferSelect, now: Date): Promise<number> {
  const late = await db.select().from(balanceTransactions)
    .where(and(eq(balanceTransactions.userId, row.userId), eq(balanceTransactions.kind, 'topup'), isNotNull(balanceTransactions.orderId), isNotNull(balanceTransactions.appliedAt), gte(balanceTransactions.createdAt, row.requestedAt)));
  if (!late.length) return 0;
  for (const p of late) {
    // Once per payment, even after an operator acknowledged it.
    const dedupeKey = `closure-late-payment:${p.orderId}`;
    const [told] = await db.select({ id: alerts.id }).from(alerts).where(eq(alerts.dedupeKey, dedupeKey));
    if (told) continue;
    await raiseAlert(db, { source: 'billing', severity: 'warning', title: `A payment arrived after account ${row.userId} was closed: $${(p.amountMicros / 1e6).toFixed(2)} credit on order ${p.orderId}; refund it in ${p.actor === 'stripe' ? 'Stripe' : 'Creem'} (console → Closures)`,
      detail: { userId: row.userId, orderId: p.orderId, creditMicros: p.amountMicros, grossAmountCents: p.grossAmountCents, currency: p.currency }, dedupeKey }, now);
  }
  return late.length;
}

async function advanceClosing(env: Env, db: Db, row: typeof accountClosures.$inferSelect, now: Date) {
  const left = await db.select().from(browserInstances).where(and(eq(browserInstances.userId, row.userId), ne(browserInstances.status, 'purged')));
  let deleted = 0;
  for (const inst of left.filter((b) => b.desiredState !== 'deleted' && b.status !== 'deleting')) {
    try {
      await systemOperation(env, db, { instanceId: inst.id, userId: row.userId, kind: 'delete', actor: 'closure', params: { reason: 'closure', purgeNow: true }, before: permanentDeleteStatements(db, inst.id, now) }, now);
      await env.GATEWAY?.revokeInstance(inst.id).catch((e: unknown) => console.error('revoke deleted browser connections failed', inst.id, e));
      deleted++;
    } catch (e) {
      // Another operation is running for it; the next sweep tries again.
      console.error('closure: browser delete deferred', inst.id, e);
    }
  }
  if (left.length) {
    if (now.getTime() - row.requestedAt.getTime() >= DAY) {
      await raiseAlert(db, { source: 'billing', severity: 'warning', title: `Closed account ${row.userId}: ${left.length} browsers still not purged after a day`,
        detail: { userId: row.userId, browsers: left.map((b) => ({ id: b.id, status: b.status })) }, dedupeKey: `closure-browsers:${row.userId}` }, now);
    }
    return { deleted, closed: false };
  }
  // Every browser is purged: nothing meters any more, so the balance is final.
  const { balanceMicros, paidMicros, orders } = await unusedPaidCredit(db, row.userId);
  await db.update(accountClosures).set({ status: 'closed', closedAt: now, balanceMicros, paidMicros, paidOrders: orders })
    .where(and(eq(accountClosures.userId, row.userId), eq(accountClosures.status, 'closing')));
  return { deleted, closed: true };
}

/**
 * Erases the personal data of a closed account (step 3 above), after its last email. Credit still
 * on the balance (not refunded through support) is written off so the account holds none.
 */
export async function eraseAccount(env: Env, db: Db, row: typeof accountClosures.$inferSelect, now: Date) {
  const [u] = await db.select({ email: user.email }).from(user).where(eq(user.id, row.userId));
  if (!u) return;
  const email = u.email.toLowerCase();
  // What was left, after any refund support made, is what the closure keeps on record.
  const left = await unusedPaidCredit(db, row.userId);
  await db.update(accountClosures).set({ balanceMicros: left.balanceMicros, paidMicros: left.paidMicros, paidOrders: left.orders }).where(eq(accountClosures.userId, row.userId));
  const [acct] = await db.select({ balance: billingAccounts.balanceMicros }).from(billingAccounts).where(eq(billingAccounts.userId, row.userId));
  if (acct && acct.balance > 0) {
    await applyBalance(db, { userId: row.userId, kind: 'adjustment', amountMicros: -acct.balance, reference: `closure:${row.userId}`, description: 'Account closed: credit not refunded', actor: 'closure' }, now);
  }
  if (u.email !== erasedEmail(row.userId) && env.EMAIL) {
    await sendTo(env, u.email, closureErasedMessage(env.APP_URL, { supportEmail: SUPPORT_EMAIL }))
      .catch((e) => console.error('closure: final email failed', row.userId, e));
  }
  const clients = db.select({ id: automationClients.id }).from(automationClients).where(eq(automationClients.userId, row.userId));
  await db.batch([
    db.update(user).set({ email: erasedEmail(row.userId), name: 'Closed account', image: null, emailVerified: false, twoFactorEnabled: false, updatedAt: now }).where(eq(user.id, row.userId)),
    db.update(browserInstances).set({ name: 'Deleted browser', updatedAt: now }).where(eq(browserInstances.userId, row.userId)),
    db.delete(oauthSpentRefreshTokens).where(inArray(oauthSpentRefreshTokens.grantId, clients)),
    db.delete(automationSessions).where(eq(automationSessions.userId, row.userId)),
    db.delete(automationClients).where(eq(automationClients.userId, row.userId)),
    db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, row.userId)),
    db.delete(viewerSessions).where(eq(viewerSessions.userId, row.userId)),
    db.delete(events).where(eq(events.userId, row.userId)),
    db.delete(userNotices).where(eq(userNotices.userId, row.userId)),
    db.delete(notificationState).where(likeLiteral(notificationState.key, 'user:', row.userId, ':%')),
    db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, row.userId)),
    db.delete(invites).where(eq(invites.email, email)),
    db.delete(verification).where(or(eq(verification.identifier, codeIdentifier(row.userId)), likeLiteral(verification.identifier, '%-otp-', email, ''))),
    db.delete(session).where(eq(session.userId, row.userId)),
    db.delete(passkey).where(eq(passkey.userId, row.userId)),
    db.delete(twoFactor).where(eq(twoFactor.userId, row.userId)),
    db.delete(account).where(eq(account.userId, row.userId)),
    db.delete(adminStepUps).where(eq(adminStepUps.userId, row.userId)),
    db.update(accountClosures).set({ erasedAt: now }).where(eq(accountClosures.userId, row.userId)),
    db.insert(auditLog).values({ actor: 'closure', action: 'account.erased', target: `user:${row.userId}`, detail: { writtenOffMicros: Math.max(0, acct?.balance ?? 0) }, createdAt: now }),
  ]);
  await notifyHub(env, row.userId);
}

/** Whether the account with this address is closed: it cannot sign in, and gets no sign-in code. */
export async function isClosedEmail(db: Db, email: string): Promise<boolean> {
  const [row] = await db.select({ id: accountClosures.userId }).from(accountClosures).innerJoin(user, eq(user.id, accountClosures.userId))
    .where(eq(sql`lower(${user.email})`, email.trim().toLowerCase()));
  return !!row;
}
