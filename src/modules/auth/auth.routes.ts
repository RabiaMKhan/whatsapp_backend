import {
  emailOnlySchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type AuthResponse,
  type MeResponse,
  type MessageOnlyResponse,
  type RegisterResponse,
} from '@chat/shared';
import { Router, type CookieOptions, type Request, type Response } from 'express';
import { env, isProd } from '../../config/env';
import { unauthorized } from '../../lib/http-error';
import { parse } from '../../lib/parse';
import { getAuth, requireAuth } from '../../middleware/require-auth';
import { authRateLimit, codeRateLimit, refreshRateLimit, requireCsrfHeader } from '../../middleware/security';
import { getUserById } from '../users/users.service';
import * as authService from './auth.service';

export const REFRESH_COOKIE = 'rt';

const cookieOptions = (): CookieOptions => ({
  httpOnly: true, // JavaScript in the browser cannot read it (protects against XSS token theft)
  secure: isProd || env.COOKIE_SAMESITE === 'none', // HTTPS only in production
  sameSite: env.COOKIE_SAMESITE,
  path: '/api/auth', // the browser sends it only to the auth routes
});

function setRefreshCookie(res: Response, result: authService.AuthResult) {
  if (!result.refreshToken) return;
  res.cookie(REFRESH_COOKIE, result.refreshToken, { ...cookieOptions(), expires: result.refreshExpiresAt });
}

const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, cookieOptions());

const sessionMeta = (req: Request): authService.SessionMeta => ({
  userAgent: req.get('user-agent'),
  ip: req.ip,
});

const authBody = (result: authService.AuthResult): AuthResponse => ({
  user: result.user,
  accessToken: result.accessToken,
});

export const authRouter = Router();

/* ---------- sign up + email verification ---------- */

/** Creates the account and emails a 6-digit code. Does NOT sign in. */
authRouter.post('/register', authRateLimit, async (req, res) => {
  const input = parse(registerSchema, req.body);
  const { email } = await authService.register(input);
  res.status(201).json({
    email,
    verificationRequired: true,
    message: 'Account created. Enter the code we sent to your email to finish.',
  } satisfies RegisterResponse);
});

/** Correct code → email verified, signed in (access token + refresh cookie). */
authRouter.post('/verify-email', codeRateLimit, async (req, res) => {
  const input = parse(verifyEmailSchema, req.body);
  const result = await authService.verifyEmail(input, sessionMeta(req));
  setRefreshCookie(res, result);
  res.json(authBody(result));
});

authRouter.post('/resend-verification', codeRateLimit, async (req, res) => {
  const input = parse(emailOnlySchema, req.body);
  await authService.resendVerification(input);
  res.json({ message: 'If that email is waiting for verification, we sent a new code.' } satisfies MessageOnlyResponse);
});

/* ---------- sign in / out ---------- */

authRouter.post('/login', authRateLimit, async (req, res) => {
  const input = parse(loginSchema, req.body);
  const result = await authService.login(input, sessionMeta(req));
  setRefreshCookie(res, result);
  res.json(authBody(result));
});

/** Exchange the refresh cookie for a new access token (and a rotated cookie). */
authRouter.post('/refresh', refreshRateLimit, requireCsrfHeader, async (req, res) => {
  try {
    const result = await authService.refresh(req.cookies?.[REFRESH_COOKIE], sessionMeta(req));
    setRefreshCookie(res, result);
    res.json(authBody(result));
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
});

authRouter.post('/logout', requireCsrfHeader, async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  res.status(204).end();
});

/* ---------- password reset ---------- */

authRouter.post('/forgot-password', codeRateLimit, async (req, res) => {
  const input = parse(emailOnlySchema, req.body);
  await authService.forgotPassword(input);
  res.json({ message: 'If an account exists for that email, we sent a reset code.' } satisfies MessageOnlyResponse);
});

authRouter.post('/reset-password', codeRateLimit, async (req, res) => {
  const input = parse(resetPasswordSchema, req.body);
  await authService.resetPassword(input);
  clearRefreshCookie(res);
  res.json({ message: 'Password updated. Sign in with your new password.' } satisfies MessageOnlyResponse);
});

/* ---------- current user ---------- */

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(getAuth(req).userId);
  if (!user) throw unauthorized('Account not found');
  res.json({ user } satisfies MeResponse);
});
