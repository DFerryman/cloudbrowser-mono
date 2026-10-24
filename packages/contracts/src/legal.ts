/**
 * The version of what a user agrees to before paying, the Terms of Service and the Privacy Policy:
 * the date either last changed (ISO date, with .2, .3… for later changes the same day). Consent is
 * recorded against it, so change it whenever the text of either changes.
 */
export const TERMS_VERSION = '2026-10-24.9';

/**
 * SHA-256 (hex) of the document a user agrees to before paying for TERMS_VERSION: the Terms of
 * Service and the Privacy Policy, in every language, as the web build publishes it at
 * `termsDocumentPath(TERMS_VERSION)`. A web test fails when either text changes without a new
 * TERMS_VERSION and this hash (a Privacy Policy change needs a new version too); the api stores
 * that document with the version the first time someone accepts it, so each acceptance points at
 * the exact text the user was shown.
 */
export const TERMS_SHA256 = 'ec55b839fc752529af8e0097af80caa42cdaabc94561c366925bf460f2e354b7';

/** Where the web build publishes a version's document: Terms and Privacy Policy (JSON, every language). */
export const termsDocumentPath = (version: string) => `/legal/terms-${version}.json`;
