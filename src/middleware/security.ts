import { ERROR_CODES } from '@chat/shared';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { isProd, isTest } from '../config/env';
import { HttpError } from '../lib/http-error';
import { getAuth } from './require-auth';

const rateLimited = () =>
  new HttpError(429, ERROR_CODES.RATE_LIMITED, 'Too many attempts. Please wait a few minutes and try again.');

/** Login / register: slows down password guessing from one IP. */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProd ? 20 : 500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, _res, next) => next(rateLimited()),
});

/**
 * Code routes (verify, resend, forgot, reset). Each code also allows only 5
 * guesses; this limit stops one IP from cycling through many accounts.
 */
export const codeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProd ? 30 : 500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, _res, next) => next(rateLimited()),
});

/** Invites send email to people who never signed up, so keep a tight cap per IP. */
export const inviteRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProd ? 30 : 500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, _res, next) => next(rateLimited()),
});

/**
 * Per signed-in user (not per IP): bursts are fine, floods are not.
 * Kept in memory, so on serverless each instance counts on its own.
 */
const perUser = (limit: number, message: string) =>
  rateLimit({
    windowMs: 10 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => isTest,
    keyGenerator: (req) => getAuth(req).userId,
    handler: (_req, _res, next) => next(new HttpError(429, ERROR_CODES.RATE_LIMITED, message)),
  });

export const messageRateLimit = perUser(30, 'You are sending messages too fast');
export const typingRateLimit = perUser(20, 'Too many typing updates');

export const refreshRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, _res, next) => next(rateLimited()),
});

/**
 * CSRF guard for routes that act on the refresh cookie.
 * A plain HTML form on another site cannot set custom headers, and a fetch()
 * with one triggers a CORS preflight that our CORS allowlist rejects.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    return next(new HttpError(403, ERROR_CODES.FORBIDDEN, 'Missing X-Requested-With header'));
  }
  next();
};
