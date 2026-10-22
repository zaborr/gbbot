import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hashPassword,
  matchTotp,
  totpCode,
  verifyPassword,
} from './webAdmins.js';

describe('web admin credentials', () => {
  it('computes RFC 6238 codes', () => {
    // RFC 6238 test secret ("12345678901234567890"), times 59 s and 1111111109 s.
    const secret = Buffer.from('12345678901234567890');
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(secret, Math.floor(1_111_111_109 / 30))).toBe('081804');
  });

  it('accepts the current code and its neighbours only', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    const now = 1_111_111_109_000;
    expect(matchTotp(secret, '081804', now)).toBe(Math.floor(now / 30_000));
    expect(matchTotp(secret, '000000', now)).toBeNull();
    expect(matchTotp(secret, 'abc', now)).toBeNull();
  });

  it('hashes passwords', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });
});
