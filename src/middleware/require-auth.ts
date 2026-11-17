import type { Request, RequestHandler } from 'express';
import { unauthorized } from '../lib/http-error';
import { verifyAccessToken, type AccessTokenClaims } from '../lib/tokens';

const authKey = Symbol('auth');
type AuthedRequest = Request & { [authKey]?: AccessTokenClaims };

/** Checks `Authorization: Bearer <access token>` and stores the user on the request. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return next(unauthorized());

  try {
    (req as AuthedRequest)[authKey] = await verifyAccessToken(token);
    next();
  } catch {
    next(unauthorized('Access token is invalid or expired'));
  }
};

/** The signed-in user. Use only in routes behind requireAuth. */
export function getAuth(req: Request): AccessTokenClaims {
  const auth = (req as AuthedRequest)[authKey];
  if (!auth) throw unauthorized();
  return auth;
}
