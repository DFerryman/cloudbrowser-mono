/**
 * Archive key wrapping (page 4: per-instance keys wrapped by KMS). On Cloudflare the master key is
 * a Worker secret (32 bytes, base64) and wrapping is AES-256-GCM: base64(iv ‖ ciphertext).
 */

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function masterKey(masterB64: string) {
  const raw = unb64(masterB64);
  if (raw.length !== 32) throw new Error('ARCHIVE_MASTER_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A new random 256-bit archive key, returned raw (base64) and wrapped. */
export async function newArchiveKey(masterB64: string): Promise<{ key: string; wrapped: string }> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return { key: b64(key), wrapped: await wrapArchiveKey(masterB64, b64(key)) };
}

export async function wrapArchiveKey(masterB64: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await masterKey(masterB64), unb64(keyB64)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

export async function unwrapArchiveKey(masterB64: string, wrapped: string): Promise<string> {
  const all = unb64(wrapped);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await masterKey(masterB64), all.slice(12));
  return b64(new Uint8Array(pt));
}
