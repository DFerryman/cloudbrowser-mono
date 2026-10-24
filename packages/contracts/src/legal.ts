/**
 * The version of the Terms of Service in force: the date they last changed (ISO date, with .2, .3…
 * for later changes the same day). Consent to the terms is recorded against it, so change it
 * whenever the terms text changes.
 */
export const TERMS_VERSION = '2026-10-24.2';

/**
 * SHA-256 (hex) of the Terms of Service document for TERMS_VERSION, in every language, as the web
 * build publishes it at `termsDocumentPath(TERMS_VERSION)`. A web test fails when the Terms text
 * changes without a new TERMS_VERSION and this hash; the api stores that document with the version
 * the first time someone accepts it, so each acceptance points at the exact text the user was shown.
 */
export const TERMS_SHA256 = '474821f4f8e6879dce708da67843161783f18a05078e608b09429d5065b19be6';

/** Where the web build publishes a version's Terms document (JSON, every language). */
export const termsDocumentPath = (version: string) => `/legal/terms-${version}.json`;
