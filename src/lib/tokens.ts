import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env';

/*
 * Two kinds of tokens:
 *
 * 1. Access token: a short-lived JWT (15 min). The frontend keeps it in memory
 *    and sends it as `Authorization: Bearer <token>` and in the Socket.io handshake.
 *
 * 2. Refresh token: a random opaque string "<sessionId>.<secret>" in an httpOnly
 *    cookie, so JavaScript can never read it. The database stores only a SHA-256
 *    hash of the secret, so a leaked database does not leak usable tokens.
 *    It is rotated (replaced) on every refresh.
 */

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = 'chat-app';
const AUDIENCE = 'chat-app:web';

export interface AccessTokenClaims {
  userId: string;
  name: string;
}

export async function signAccessToken({ userId, name }: AccessTokenClaims): Promise<string> {
  return new SignJWT({ name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(accessSecret);
}

/** Throws if the token is invalid, expired, or signed with another key/algorithm. */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, accessSecret, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });
  if (typeof payload.sub !== 'string' || typeof payload.name !== 'string') {
    throw new Error('Invalid access token payload');
  }
  return { userId: payload.sub, name: payload.name };
}

export const generateRefreshSecret = () => randomBytes(32).toString('base64url');

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

/** Constant-time compare, so response timing does not leak how much of a hash matched. */
export function hashesMatch(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export const formatRefreshToken = (sessionId: string, secret: string) => `${sessionId}.${secret}`;

export function parseRefreshToken(token: unknown): { sessionId: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  const [sessionId, secret, ...rest] = token.split('.');
  if (!sessionId || !secret || rest.length > 0 || !/^[a-f\d]{24}$/i.test(sessionId)) return null;
  return { sessionId, secret };
}
