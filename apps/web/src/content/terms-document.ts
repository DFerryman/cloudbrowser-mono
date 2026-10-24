import { TERMS_VERSION } from '@cloudbrowser/contracts';
import { POLICIES } from './legal.js';

/**
 * The Terms of Service a user accepts before paying, for TERMS_VERSION and in every language:
 * the build publishes it at `termsDocumentPath(TERMS_VERSION)` and the api stores it with the
 * version the first time someone accepts it. Its SHA-256 is pinned as TERMS_SHA256
 * (test/terms-version.test.ts), so changed Terms need a new version.
 */
export function termsDocument(): string {
  return `${JSON.stringify({ version: TERMS_VERSION, terms: { en: POLICIES.en.terms, 'zh-CN': POLICIES['zh-CN'].terms } }, null, 2)}\n`;
}
