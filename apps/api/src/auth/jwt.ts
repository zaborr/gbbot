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
  /** A customer on the web with an access key: the key's id (revoked keys end the session). */
  ck?: string;
  /** That key's GB: the session only reaches it. */
  ws?: string;
  /**
   * Signed in with a customer's web account (username and password, or the
   * login bot): the customer side only, whatever the person manages.
   */
  cs?: boolean;
}

/** Sessions that only buy: a web key, or a customer's web account. */
export const customerOnly = (claims: SessionClaims | undefined): boolean =>
  claims !== undefined && (claims.ck !== undefined || claims.cs === true);

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
    ...(claims.ck === undefined ? {} : { ck: claims.ck }),
    ...(claims.ws === undefined ? {} : { ws: claims.ws }),
    ...(claims.cs === true ? { cs: true } : {}),
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
    ...(typeof payload.ck === 'string' ? { ck: payload.ck } : {}),
    ...(typeof payload.ws === 'string' ? { ws: payload.ws } : {}),
    ...(payload.cs === true ? { cs: true } : {}),
  };
}
