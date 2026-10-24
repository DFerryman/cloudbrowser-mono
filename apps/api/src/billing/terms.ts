/**
 * Consent to the Terms of Service before payment (page 6). A user accepts each version once, by
 * ticking "I have read the Terms of Service" in the dialog the Billing page shows before checkout;
 * top-ups are refused until they have accepted the current version (`TERMS_VERSION`). Acceptances
 * and the text of each version are append-only (migration 0039).
 */
import { TERMS_SHA256, TERMS_VERSION, termsDocumentPath } from '@cloudbrowser/contracts';
import { raiseAlert, schema, type Db } from '@cloudbrowser/db';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { problem } from '../problem.js';

const { termsAcceptances, termsVersions } = schema;

/** Whether the user has accepted the current version of the Terms. */
export async function acceptedCurrentTerms(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: termsAcceptances.id })
    .from(termsAcceptances)
    .where(and(eq(termsAcceptances.userId, userId), eq(termsAcceptances.termsVersion, TERMS_VERSION)));
  return !!row;
}

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Stores the current version's text the first time anyone accepts it: the document the web build
 * published beside the site, checked against the hash pinned with the version. Without that exact
 * text no acceptance can be recorded, so checkouts are refused (and an alert raised) rather than
 * tying users to text nobody can show later.
 */
export async function storeCurrentTerms(env: Env, db: Db, requestUrl: string, now = new Date()): Promise<void> {
  const [stored] = await db.select({ version: termsVersions.version }).from(termsVersions).where(eq(termsVersions.version, TERMS_VERSION));
  if (stored) return;
  const res = await env.ASSETS.fetch(new Request(new URL(termsDocumentPath(TERMS_VERSION), requestUrl)));
  const document = res.ok ? await res.text() : '';
  if ((await sha256(document)) !== TERMS_SHA256) {
    await raiseAlert(db, {
      source: 'billing',
      severity: 'critical',
      title: `The published Terms of Service do not match version ${TERMS_VERSION}: top-ups are refused until the site serves ${termsDocumentPath(TERMS_VERSION)}`,
      detail: { status: res.status },
      dedupeKey: `terms-document:${TERMS_VERSION}`,
    });
    throw problem(503, 'billing_unavailable', 'Payments are briefly unavailable. Try again in a few minutes.');
  }
  await db.insert(termsVersions).values({ version: TERMS_VERSION, sha256: TERMS_SHA256, document, recordedAt: now }).onConflictDoNothing();
}
