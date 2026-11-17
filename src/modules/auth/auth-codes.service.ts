import { createHash, createHmac, randomInt } from 'node:crypto';
import { AUTH_CODE, ERROR_CODES } from '@chat/shared';
import { env } from '../../config/env';
import { HttpError } from '../../lib/http-error';
import { hashesMatch } from '../../lib/tokens';
import { AuthCode, type AuthCodePurpose } from '../../models/auth-code.model';

/*
 * One-time email codes, used for "verify email" and "reset password".
 *
 * Why an HMAC and not a plain hash: there are only 1,000,000 possible 6-digit
 * codes, so a plain SHA-256 could be reversed in a second from a leaked
 * database. An HMAC needs the server secret as well.
 */

const TTL_MS = AUTH_CODE.TTL_MINUTES * 60_000;
const COOLDOWN_MS = AUTH_CODE.RESEND_COOLDOWN_SECONDS * 1000;

// A separate key derived from the JWT secret, so the two uses never share a key.
const codeKey = createHash('sha256').update(`auth-code:${env.JWT_ACCESS_SECRET}`).digest();

const hashCode = (userId: string, purpose: AuthCodePurpose, code: string) =>
  createHmac('sha256', codeKey).update(`${purpose}:${userId}:${code}`).digest('hex');

/** Cryptographically random, keeps leading zeros ("004821"). */
const generateCode = () => randomInt(0, 10 ** AUTH_CODE.LENGTH).toString().padStart(AUTH_CODE.LENGTH, '0');

export class CooldownError extends HttpError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(429, ERROR_CODES.RATE_LIMITED, `Please wait ${retryAfterSeconds}s before requesting a new code.`, {
      retryAfterSeconds,
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Create (or replace) the user's code for this purpose and return it, so the
 * caller can email it. Throws CooldownError if one was sent less than 60 s ago.
 */
export async function issueCode(userId: string, purpose: AuthCodePurpose): Promise<string> {
  const existing = await AuthCode.findOne({ user: userId, purpose }).lean();
  if (existing) {
    const elapsed = Date.now() - existing.lastSentAt.getTime();
    if (elapsed < COOLDOWN_MS) throw new CooldownError(Math.ceil((COOLDOWN_MS - elapsed) / 1000));
  }

  const code = generateCode();
  const now = new Date();
  await AuthCode.findOneAndUpdate(
    { user: userId, purpose },
    {
      $set: {
        codeHash: hashCode(userId, purpose, code),
        expiresAt: new Date(now.getTime() + TTL_MS),
        attempts: 0,
        lastSentAt: now,
      },
    },
    { upsert: true },
  );
  return code;
}

/** Remove the code (e.g. the email could not be sent, so let the user retry now). */
export async function discardCode(userId: string, purpose: AuthCodePurpose): Promise<void> {
  await AuthCode.deleteOne({ user: userId, purpose });
}

export const invalidCodeError = (message = "That code isn't right. Check the email and try again.") =>
  new HttpError(400, ERROR_CODES.INVALID_CODE, message);

/**
 * Check a code and delete it if it matches (so it works once).
 * Every guess counts, even ones sent at the same time: the attempt counter is
 * increased atomically BEFORE the code is compared.
 */
export async function consumeCode(userId: string, purpose: AuthCodePurpose, code: string): Promise<void> {
  const now = new Date();
  const record = await AuthCode.findOneAndUpdate(
    { user: userId, purpose, expiresAt: { $gt: now }, attempts: { $lt: AUTH_CODE.MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );

  if (!record) {
    const live = await AuthCode.exists({ user: userId, purpose, expiresAt: { $gt: now } });
    if (live) {
      throw new HttpError(429, ERROR_CODES.TOO_MANY_ATTEMPTS, 'Too many wrong attempts. Request a new code.');
    }
    throw new HttpError(400, ERROR_CODES.CODE_EXPIRED, 'This code has expired. Request a new one.');
  }

  if (!hashesMatch(record.codeHash, hashCode(userId, purpose, code))) {
    const left = AUTH_CODE.MAX_ATTEMPTS - record.attempts;
    if (left <= 0) {
      throw new HttpError(429, ERROR_CODES.TOO_MANY_ATTEMPTS, 'Too many wrong attempts. Request a new code.');
    }
    throw invalidCodeError(`That code isn't right. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`);
  }

  await record.deleteOne();
}
