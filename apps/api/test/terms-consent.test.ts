import { TERMS_SHA256, TERMS_VERSION, termsDocumentPath } from '@cloudbrowser/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { termsDocument } from '../../web/src/content/terms-document.js';
import { setup, signIn } from './helpers.js';

/**
 * Consent to the Terms of Service before payment: a user accepts each version once, in the dialog
 * shown before checkout, and the api refuses a top-up until they have accepted the current one.
 */
let t: ReturnType<typeof setup>;
let creemCheckouts: Record<string, unknown>[];
let userId: string;

const creemFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/v1/products') return ok({ id: 'prod_10', name: '$10 credit', price: 1000, currency: 'USD', billing_type: 'onetime' });
  if (init?.method === 'POST' && url.pathname === '/v1/checkouts') {
    const body = JSON.parse(String(init.body));
    creemCheckouts.push(body);
    return ok({ id: `ch_${creemCheckouts.length}`, checkout_url: `https://checkout.test/ch_${creemCheckouts.length}` });
  }
  return new Response('unexpected', { status: 500 });
};

const checkout = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  t.call('POST', '/api/v1/billing/checkout', { productId: 'prod_10', ...body }, headers);
const rows = (table: string) => t.d1.sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
const billing = async () => (await t.call('GET', '/api/v1/billing')).body as { termsVersion: string; termsAccepted: boolean };

beforeEach(async () => {
  t = setup();
  creemCheckouts = [];
  vi.stubGlobal('fetch', creemFetch);
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('buyer@example.com')`);
  Object.assign(t.env, { CREEM_API_BASE: 'https://test-api.creem.io', CREEM_API_KEY: 'creem_test_key', CREEM_WEBHOOK_SECRET: 'whsec_test', CREEM_TOPUP_PRODUCTS: 'prod_10' });
  await signIn(t, 'buyer@example.com');
  userId = (await t.call('GET', '/api/v1/me')).body.user.id;
});
afterEach(() => vi.unstubAllGlobals());

describe('Terms of Service consent before payment', () => {
  it('refuses a top-up until the user has accepted the current Terms, without asking the provider', async () => {
    expect(await billing()).toMatchObject({ termsVersion: TERMS_VERSION, termsAccepted: false });
    expect(await checkout({})).toMatchObject({ status: 409, body: { type: 'terms_required' } });
    expect(creemCheckouts).toHaveLength(0);
    expect(rows('topup_checkouts')).toHaveLength(0);
  });

  it('records the acceptance once per version, with the checkout, the time and where it came from', async () => {
    const res = await checkout({ acceptedTermsVersion: TERMS_VERSION }, { 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'GB', 'user-agent': 'Mozilla/5.0 Test' });
    expect(res.status).toBe(200);
    const [attempt] = rows('topup_checkouts');
    expect(rows('terms_acceptances')).toEqual([
      expect.objectContaining({ user_id: userId, terms_version: TERMS_VERSION, context: 'checkout', topup_checkout_id: attempt!.id, ip: '203.0.113.7', country: 'GB', user_agent: 'Mozilla/5.0 Test' }),
    ]);
    expect(rows('terms_acceptances')[0]!.accepted_at).toBe(attempt!.created_at);
    // The provider's record of the payment names the version too.
    expect(creemCheckouts[0]).toMatchObject({ metadata: { userId, termsVersion: TERMS_VERSION } });
    expect(await billing()).toMatchObject({ termsAccepted: true });

    // Accepted once: later top-ups go straight to checkout, and accepting again keeps the first record.
    expect((await checkout({})).status).toBe(200);
    expect((await checkout({ acceptedTermsVersion: TERMS_VERSION })).status).toBe(200);
    expect(rows('topup_checkouts')).toHaveLength(3);
    expect(rows('terms_acceptances')).toHaveLength(1);
  });

  it('ties each acceptance to the exact Terms and Privacy Policy text of that version, as the site published it', async () => {
    await checkout({ acceptedTermsVersion: TERMS_VERSION });
    expect(rows('terms_versions')).toEqual([expect.objectContaining({ version: TERMS_VERSION, sha256: TERMS_SHA256, document: termsDocument() })]);
    const document = JSON.parse(String(rows('terms_versions')[0]!.document));
    expect([document.terms.en.title, document.privacy.en.title]).toEqual(['Terms of Service', 'Privacy Policy']);
  });

  it('asks again for a new version: an older acceptance does not count, and a stale tab must reload', async () => {
    t.d1.sqlite.exec(`INSERT INTO terms_versions (version, sha256, document, recorded_at) VALUES ('2020-01-01', 'x', '{}', 0)`);
    t.d1.sqlite.prepare(`INSERT INTO terms_acceptances (id, user_id, terms_version, context, accepted_at) VALUES ('old', ?, '2020-01-01', 'checkout', 0)`).run(userId);
    expect(await billing()).toMatchObject({ termsAccepted: false });
    expect(await checkout({})).toMatchObject({ status: 409, body: { type: 'terms_required' } });
    // A tab that still shows the old Terms sends their version: refused before anything is written.
    expect(await checkout({ acceptedTermsVersion: '2020-01-01' })).toMatchObject({ status: 409, body: { type: 'terms_required', detail: expect.stringContaining('changed') } });
    expect(rows('topup_checkouts')).toHaveLength(0);
    expect((await checkout({ acceptedTermsVersion: TERMS_VERSION })).status).toBe(200);
    expect(rows('terms_acceptances').map((r) => r.terms_version).sort()).toEqual(['2020-01-01', TERMS_VERSION]);
  });

  it('keeps acceptances and Terms versions append-only', async () => {
    await checkout({ acceptedTermsVersion: TERMS_VERSION });
    expect(() => t.d1.sqlite.exec(`UPDATE terms_acceptances SET terms_version = terms_version`)).toThrow(/append-only/);
    expect(() => t.d1.sqlite.exec(`DELETE FROM terms_acceptances`)).toThrow(/append-only/);
    expect(() => t.d1.sqlite.exec(`UPDATE terms_versions SET document = ''`)).toThrow(/append-only/);
    expect(() => t.d1.sqlite.exec(`DELETE FROM terms_versions`)).toThrow(/append-only/);
    expect(rows('terms_acceptances')).toHaveLength(1);
  });

  it('refuses payment, and alerts, while the site does not serve the Terms text of the current version', async () => {
    (t.env as { ASSETS: unknown }).ASSETS = { fetch: async () => new Response('<html>app</html>') };
    expect(await checkout({ acceptedTermsVersion: TERMS_VERSION })).toMatchObject({ status: 503, body: { type: 'billing_unavailable' } });
    expect(rows('topup_checkouts')).toHaveLength(0);
    expect(rows('terms_acceptances')).toHaveLength(0);
    expect(rows('alerts')).toEqual([expect.objectContaining({ source: 'billing', severity: 'critical', dedupe_key: `terms-document:${TERMS_VERSION}` })]);
    expect(String(rows('alerts')[0]!.title)).toContain(termsDocumentPath(TERMS_VERSION));
  });
});
