import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets kept in the database (bot tokens, account sessions) with
 * AES-256-GCM. The key comes from BOTS_KEY, or is derived from JWT_SECRET when
 * that is not set, so nothing else has to be configured.
 */
export function secretKey(env: { BOTS_KEY?: string | undefined; JWT_SECRET: string }): Buffer {
  if (env.BOTS_KEY) return createHash('sha256').update(env.BOTS_KEY).digest();
  return Buffer.from(hkdfSync('sha256', env.JWT_SECRET, 'gb', 'gb-secret-box', 32));
}

/** `v1.<iv>.<tag>.<data>`, base64url. */
export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

/** The plain text, or null when it cannot be opened (another key, tampered). */
export function open(key: Buffer, sealed: string): string | null {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
