import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { UserRole } from '@tma-shop/shared';

export interface SessionClaims {
  /**
   * Telegram user id (subject). Web accounts: negative for platform ones
   * (-id); a linked one acts as its Telegram user.
   */
  sub: number;
  /** `admin` = platform super-admin when the session was issued. */
  role: UserRole;
  /** Web accounts: the account's session version (a reset ends older sessions). */
  ver?: number;
  /** Web accounts: the account's id (sessions opened on the web). */
  wid?: number;
}

const ALG = 'HS256';

function secretBytes(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(
  claims: SessionClaims,
  secret: string,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: Date }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + ttlSeconds) * 1000);

  const token = await new SignJWT({
    role: claims.role,
    ...(claims.ver === undefined ? {} : { ver: claims.ver }),
    ...(claims.wid === undefined ? {} : { wid: claims.wid }),
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(String(claims.sub))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(secretBytes(secret));

  return { token, expiresAt };
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secretBytes(secret), { algorithms: [ALG] });
  return claimsFromPayload(payload);
}

function claimsFromPayload(payload: JWTPayload): SessionClaims {
  const sub = Number(payload.sub);
  const role = payload.role;
  if (!Number.isFinite(sub) || (role !== 'customer' && role !== 'admin')) {
    throw new Error('Malformed session token payload');
  }
  return {
    sub,
    role,
    ...(typeof payload.ver === 'number' ? { ver: payload.ver } : {}),
    ...(typeof payload.wid === 'number' ? { wid: payload.wid } : {}),
  };
}
