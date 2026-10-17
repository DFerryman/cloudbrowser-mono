// Generates the Ed25519 key pair for viewer tokens.
//   VIEWER_TOKEN_PRIVATE_KEY (secret on the api Worker) and VIEWER_TOKEN_PUBLIC_KEY (var on the gateway).
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
// Only the key material: workerd rejects Node's `"alg": "Ed25519"`.
const bare = async (k) => {
  const { kty, crv, x, d } = await crypto.subtle.exportKey('jwk', k);
  return JSON.stringify(d ? { kty, crv, x, d } : { kty, crv, x });
};
console.log(`VIEWER_TOKEN_PRIVATE_KEY='${await bare(privateKey)}'`);
console.log(`VIEWER_TOKEN_PUBLIC_KEY='${await bare(publicKey)}'`);
