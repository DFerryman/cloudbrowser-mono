import { TERMS_SHA256, TERMS_VERSION } from '@cloudbrowser/contracts';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { termsDocument } from '../src/content/terms-document.js';

test('the Terms of Service and Privacy Policy match the pinned version: a change to either needs a new TERMS_VERSION', () => {
  const sha256 = createHash('sha256').update(termsDocument()).digest('hex');
  // Users accept a version once and are asked again only for a new one, so editing the Terms
  // without a new version would leave everyone bound by text they never confirmed.
  expect(sha256, `The Terms of Service or Privacy Policy changed: set a new TERMS_VERSION in packages/contracts/src/legal.ts and TERMS_SHA256 to the new hash (with the version in the document, compute it after changing TERMS_VERSION).`).toBe(TERMS_SHA256);
  expect(JSON.parse(termsDocument())).toMatchObject({ version: TERMS_VERSION, terms: { en: { slug: 'terms' }, 'zh-CN': { slug: 'terms' } }, privacy: { en: { slug: 'privacy' }, 'zh-CN': { slug: 'privacy' } } });
});
