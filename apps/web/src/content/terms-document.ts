import { TERMS_VERSION } from '@cloudbrowser/contracts';
import { POLICIES } from './legal.js';

/**
 * What a user agrees to before paying, for TERMS_VERSION and in every language: the Terms of
 * Service and the Privacy Policy. The build publishes it at `termsDocumentPath(TERMS_VERSION)` and
 * the api stores it with the version the first time someone accepts it. Its SHA-256 is pinned as
 * TERMS_SHA256 (test/terms-version.test.ts), so a change to either document needs a new version.
 */
export function termsDocument(): string {
  return `${JSON.stringify({ version: TERMS_VERSION, terms: { en: POLICIES.en.terms, 'zh-CN': POLICIES['zh-CN'].terms }, privacy: { en: POLICIES.en.privacy, 'zh-CN': POLICIES['zh-CN'].privacy } }, null, 2)}\n`;
}
