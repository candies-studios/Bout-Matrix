// Offer tokens. token = base64url(HMAC-SHA256(secret, `${offerId}:${nonce}`)).
// The database stores the nonce and sha256(token) — never the token. Uses WebCrypto (Deno, browsers, Node 20+).

const enc = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomNonce(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveOfferToken(secret: string, offerId: string, nonce: string): Promise<string> {
  if (!secret || secret.length < 32) throw new Error('OFFER_TOKEN_SECRET must be at least 32 characters');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${offerId}:${nonce}`)));
  return base64url(sig);
}

/** Shape check before touching the database (43 base64url chars = 256 bits). */
export function isWellFormedToken(t: unknown): t is string {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);
}
