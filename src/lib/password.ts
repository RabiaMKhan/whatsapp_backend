import bcrypt from 'bcryptjs';
import { isTest } from '../config/env';

// 12 rounds ≈ 250 ms per hash: slow for attackers, fine for one login.
// Tests use 4 rounds so they stay fast.
const ROUNDS = isTest ? 4 : 12;

export const hashPassword = (password: string) => bcrypt.hash(password, ROUNDS);

export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/**
 * Compared against when the email does not exist, so "wrong email" and
 * "wrong password" take the same time (stops email discovery by timing).
 */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing-only', ROUNDS);
