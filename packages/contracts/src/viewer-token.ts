import { ViewerTokenClaims } from './protocol.js';

/**
 * Viewer tokens: 60 s, single use, signed with Ed25519 (page 2). The api holds the private key
 * and signs; the gateway holds only the public key and verifies locally before redeeming the token
 * once through the api. Format: base64url(JSON claims) "." base64url(signature). WebCrypto only,
 * so it runs in Workers, browsers and Node alike.
 */

const enc = new TextEncoder();

/**
 * Node exports Ed25519 JWKs with `"alg": "Ed25519"`, which workerd rejects (it expects RFC 8037's
 * `EdDSA` or no `alg`). The curve is in `crv`, so `alg` is dropped before import.
 */
function importJwk(jwk: JsonWebKey, usage: 'sign' | 'verify') {
  const { alg: _alg, key_ops: _ops, ...rest } = jwk;
  return crypto.subtle.importKey('jwk', rest, { name: 'Ed25519' }, false, [usage]);
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signViewerToken(privateJwk: JsonWebKey, claims: ViewerTokenClaims): Promise<string> {
  const key = await importJwk(privateJwk, 'sign');
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Returns the claims if the signature is valid and the token has not expired; null otherwise. */
export async function verifyViewerToken(publicJwk: JsonWebKey, token: string, nowMs = Date.now()): Promise<ViewerTokenClaims | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const key = await importJwk(publicJwk, 'verify');
    if (!(await crypto.subtle.verify('Ed25519', key, fromB64url(sig), enc.encode(body)))) return null;
    const claims = ViewerTokenClaims.parse(JSON.parse(new TextDecoder().decode(fromB64url(body))));
    return claims.exp * 1000 > nowMs ? claims : null;
  } catch {
    return null;
  }
}
