// Mint a SpacetimeDB identity token for the profile service, signed with the
// server's own JWT key — the same trick publish.sh uses for the publisher.
//
// SpacetimeDB derives an identity from the token's iss/sub claims and accepts
// any token whose signature verifies against its local key, so FIXED claims
// yield the SAME identity on every run. The module authorizes restore_account
// on the issuer alone (PROFILE_SERVICE_ISSUER), which is safe precisely
// because minting one requires read access to the server's private key.
import { createPrivateKey, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function mintToken(keyPath, issuer, subject) {
  const key = createPrivateKey(readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`expected an EC (ES256) private key, got ${key.asymmetricKeyType}`);
  }
  const b64url = data => Buffer.from(data).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: issuer,
      sub: subject,
      aud: ['spacetimedb'],
      iat: Math.floor(Date.now() / 1000),
    })
  );
  const signingInput = `${header}.${payload}`;
  // ieee-p1363 yields the raw 64-byte r||s signature JWS requires (not DER).
  const signature = createSign('SHA256')
    .update(signingInput)
    .end()
    .sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}
