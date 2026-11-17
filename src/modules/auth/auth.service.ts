import {
  ERROR_CODES,
  pickAvatarColor,
  type EmailOnlyInput,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
} from '@chat/shared';
import { env } from '../../config/env';
import { passwordChangedEmail, resetPasswordEmail, verificationEmail } from '../../lib/email-templates';
import { conflict, HttpError, isDuplicateKeyError, unauthorized } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { sendEmail } from '../../lib/mailer';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../../lib/password';
import { toPublicUser } from '../../lib/serializers';
import {
  formatRefreshToken,
  generateRefreshSecret,
  hashesMatch,
  hashToken,
  parseRefreshToken,
  signAccessToken,
} from '../../lib/tokens';
import { Session } from '../../models/session.model';
import { User, type UserDoc } from '../../models/user.model';
import { consumeCode, CooldownError, discardCode, invalidCodeError, issueCode } from './auth-codes.service';

/*
 * Account lifecycle:
 *
 *   register ──► email with 6-digit code ──► verifyEmail ──► signed in
 *                     ▲                          │
 *            resendVerification          (login before verifying →
 *                                         403 EMAIL_NOT_VERIFIED + new code)
 *
 *   forgotPassword ──► email with code ──► resetPassword ──► signed out everywhere
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Two tabs can refresh at the same moment with the same cookie. The first one
 * rotates the token; for a short window the second one may still use the old
 * token instead of being treated as a thief.
 */
const ROTATION_GRACE_MS = 30_000;

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  /** null when the cookie should be left as it is (grace-window refresh). */
  refreshToken: string | null;
  refreshExpiresAt: Date;
}

const sessionExpired = () => unauthorized('Your session has expired. Please sign in again.');
const newExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS);

async function startSession(user: UserDoc, meta: SessionMeta): Promise<AuthResult> {
  const secret = generateRefreshSecret();
  const expiresAt = newExpiry();
  const session = await Session.create({
    user: user._id,
    tokenHash: hashToken(secret),
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ip: meta.ip ?? null,
    expiresAt,
  });
  return {
    user: toPublicUser(user),
    accessToken: await signAccessToken({ userId: user._id.toString(), name: user.name }),
    refreshToken: formatRefreshToken(session._id.toString(), secret),
    refreshExpiresAt: expiresAt,
  };
}

/* ---------------------------------------------------------------- emails */

/**
 * Create a verification code and email it.
 * - `strict: true`  → errors reach the caller (resend button: show them).
 * - `strict: false` → best effort: cooldowns are skipped silently and send
 *   failures are logged (register / login: the user can press "resend").
 */
async function sendVerificationCode(user: UserDoc, { strict }: { strict: boolean }): Promise<void> {
  const userId = user._id.toString();
  let code: string;
  try {
    code = await issueCode(userId, 'verify_email');
  } catch (err) {
    if (!strict && err instanceof CooldownError) return; // the code sent earlier is still valid
    throw err;
  }

  try {
    await sendEmail(verificationEmail({ to: user.email, name: user.name, code }));
  } catch (err) {
    await discardCode(userId, 'verify_email'); // so "resend" works straight away
    logger.error({ err, userId }, 'Could not send verification email');
    if (strict) {
      throw new HttpError(503, ERROR_CODES.EMAIL_FAILED, "We couldn't send the email. Please try again in a moment.");
    }
  }
}

/* ------------------------------------------------------- register/verify */

export async function register(input: RegisterInput): Promise<{ email: string }> {
  const passwordHash = await hashPassword(input.password);
  const existing = await User.findOne({ email: input.email });

  if (existing?.emailVerifiedAt) {
    throw conflict('An account with this email already exists. Sign in instead.', ERROR_CODES.EMAIL_TAKEN);
  }

  let user: UserDoc;
  if (existing) {
    // Signed up before but never verified. Nobody has proved they own this
    // inbox yet, so the newest sign-up wins: this stops someone "reserving"
    // another person's email with an account they can never verify.
    existing.name = input.name;
    existing.passwordHash = passwordHash;
    await existing.save();
    user = existing;
  } else {
    try {
      user = await User.create({
        name: input.name,
        email: input.email,
        passwordHash,
        avatarColor: pickAvatarColor(input.email),
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw conflict('An account with this email already exists. Sign in instead.', ERROR_CODES.EMAIL_TAKEN);
      }
      throw err;
    }
  }

  await sendVerificationCode(user, { strict: false });
  return { email: user.email };
}

/** Correct code → mark the email verified and sign the user in. */
export async function verifyEmail(input: VerifyEmailInput, meta: SessionMeta): Promise<AuthResult> {
  const user = await User.findOne({ email: input.email });
  // Unknown email → same error as a wrong code (doesn't reveal who has an account).
  if (!user) throw invalidCodeError();
  if (user.emailVerifiedAt) {
    throw new HttpError(409, ERROR_CODES.ALREADY_VERIFIED, 'Your email is already verified. Please sign in.');
  }

  await consumeCode(user._id.toString(), 'verify_email', input.code);

  user.emailVerifiedAt = new Date();
  await user.save();
  return startSession(user, meta);
}

export async function resendVerification(input: EmailOnlyInput): Promise<void> {
  const user = await User.findOne({ email: input.email });
  // Unknown or already verified: do nothing, but answer the same way.
  if (!user || user.emailVerifiedAt) return;
  await sendVerificationCode(user, { strict: true });
}

/* ----------------------------------------------------------------- login */

export async function login(input: LoginInput, meta: SessionMeta): Promise<AuthResult> {
  const user = await User.findOne({ email: input.email }).select('+passwordHash');
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  // Same message for "no such email" and "wrong password".
  if (!user || !passwordOk) {
    throw unauthorized('Incorrect email or password', ERROR_CODES.INVALID_CREDENTIALS);
  }

  // Only tell them about verification AFTER the password was right.
  if (!user.emailVerifiedAt) {
    await sendVerificationCode(user, { strict: false });
    throw new HttpError(403, ERROR_CODES.EMAIL_NOT_VERIFIED, 'Please verify your email first. We sent a code to your inbox.', {
      email: user.email,
    });
  }

  return startSession(user, meta);
}

/* -------------------------------------------------------- password reset */

/** Always succeeds from the outside, so it can't be used to test which emails exist. */
export async function forgotPassword(input: EmailOnlyInput): Promise<void> {
  const user = await User.findOne({ email: input.email });
  if (!user) return;

  const userId = user._id.toString();
  let code: string;
  try {
    code = await issueCode(userId, 'reset_password');
  } catch (err) {
    // Asked again within 60 s: the code already sent still works. Stay silent
    // instead of returning 429, which would reveal that the account exists.
    if (err instanceof CooldownError) return;
    throw err;
  }

  try {
    await sendEmail(resetPasswordEmail({ to: user.email, name: user.name, code }));
  } catch (err) {
    await discardCode(userId, 'reset_password');
    logger.error({ err, userId }, 'Could not send password reset email');
  }
}

/** Correct code → new password, email counts as verified, every session ends. */
export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const user = await User.findOne({ email: input.email });
  if (!user) throw invalidCodeError();

  const userId = user._id.toString();
  await consumeCode(userId, 'reset_password', input.code);

  user.passwordHash = await hashPassword(input.password);
  // They just proved they can read this inbox.
  user.emailVerifiedAt ??= new Date();
  await user.save();

  // Sign out everywhere: whoever had the old password loses access.
  await Session.deleteMany({ user: user._id });
  await discardCode(userId, 'verify_email');

  sendEmail(passwordChangedEmail({ to: user.email, name: user.name })).catch((err: unknown) =>
    logger.error({ err, userId }, 'Could not send password changed email'),
  );
}

/* --------------------------------------------------------------- session */

export async function refresh(rawToken: unknown, meta: SessionMeta): Promise<AuthResult> {
  const token = parseRefreshToken(rawToken);
  if (!token) throw sessionExpired();

  const session = await Session.findById(token.sessionId);
  if (!session || session.expiresAt.getTime() < Date.now()) throw sessionExpired();

  const presentedHash = hashToken(token.secret);
  const isCurrent = hashesMatch(session.tokenHash, presentedHash);
  const isRecentPrevious =
    hashesMatch(session.previousTokenHash, presentedHash) &&
    session.rotatedAt !== null &&
    Date.now() - session.rotatedAt.getTime() < ROTATION_GRACE_MS;

  if (!isCurrent && !isRecentPrevious) {
    // A real session, but an old token: it was already used once. That is what a
    // stolen token looks like, so end the session. The user signs in again.
    await session.deleteOne();
    throw sessionExpired();
  }

  const user = await User.findById(session.user);
  if (!user) {
    await session.deleteOne();
    throw sessionExpired();
  }

  const accessToken = await signAccessToken({ userId: user._id.toString(), name: user.name });

  if (isRecentPrevious) {
    // The other tab already rotated the cookie; keep that one.
    return { user: toPublicUser(user), accessToken, refreshToken: null, refreshExpiresAt: session.expiresAt };
  }

  // Rotate: every refresh replaces the token, so each token works only once.
  const secret = generateRefreshSecret();
  session.previousTokenHash = session.tokenHash;
  session.tokenHash = hashToken(secret);
  session.rotatedAt = new Date();
  session.expiresAt = newExpiry();
  if (meta.userAgent) session.userAgent = meta.userAgent.slice(0, 300);
  if (meta.ip) session.ip = meta.ip;
  await session.save();

  return {
    user: toPublicUser(user),
    accessToken,
    refreshToken: formatRefreshToken(session._id.toString(), secret),
    refreshExpiresAt: session.expiresAt,
  };
}

export async function logout(rawToken: unknown): Promise<void> {
  const token = parseRefreshToken(rawToken);
  if (!token) return;
  const session = await Session.findById(token.sessionId);
  // Only delete when the secret matches, so knowing a session id is not enough.
  if (session && hashesMatch(session.tokenHash, hashToken(token.secret))) {
    await session.deleteOne();
  }
}
