import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { deriveOfferToken, isWellFormedToken, randomNonce, sha256Hex } from './tokens.ts';

const secret = 'x'.repeat(48);
describe('offer tokens', () => {
  it('derives a stable 256-bit token matching Node HMAC', async () => {
    const t = await deriveOfferToken(secret, 'offer-1', 'nonce-1');
    expect(t).toBe(await deriveOfferToken(secret, 'offer-1', 'nonce-1'));
    expect(t).toBe(createHmac('sha256', secret).update('offer-1:nonce-1').digest('base64url'));
    expect(isWellFormedToken(t)).toBe(true);
  });
  it('changes with nonce, offer and secret', async () => {
    const t = await deriveOfferToken(secret, 'o', 'n');
    expect(await deriveOfferToken(secret, 'o', 'm')).not.toBe(t);
    expect(await deriveOfferToken(secret, 'p', 'n')).not.toBe(t);
    expect(await deriveOfferToken('y'.repeat(48), 'o', 'n')).not.toBe(t);
  });
  it('refuses weak secrets', async () => {
    await expect(deriveOfferToken('short', 'o', 'n')).rejects.toThrow();
  });
  it('hashes like the database (sha256 hex) and generates unique nonces', async () => {
    expect(await sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(randomNonce()).not.toBe(randomNonce());
    expect(randomNonce().length).toBeGreaterThanOrEqual(32);
    expect(isWellFormedToken("'; drop table--")).toBe(false);
  });
});
