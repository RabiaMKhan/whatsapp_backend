import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthCode } from '../src/models/auth-code.model';
import { User } from '../src/models/user.model';
import { emailsTo, lastCodeFor, lastEmailTo, registerUser, startTestServer, uniqueEmail } from './helpers';

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };
const PASSWORD = 'password-123';

beforeAll(async () => {
  server = await startTestServer();
  baseUrl = server.baseUrl;
});

afterAll(async () => {
  await server.stop();
});

const signUp = (email: string, name = 'Test User', password = PASSWORD) =>
  request(baseUrl).post('/api/auth/register').send({ name, email, password });

const verify = (email: string, code: string) => request(baseUrl).post('/api/auth/verify-email').send({ email, code });

/** A code that is guaranteed to be wrong. */
const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

/** Pretend the last code was sent long ago, so the resend cooldown is over. */
async function skipCooldown(email: string) {
  const user = await User.findOne({ email });
  await AuthCode.updateMany({ user: user!._id }, { $set: { lastSentAt: new Date(Date.now() - 120_000) } });
}

describe('sign up + email verification', () => {
  it('creates an unverified account, emails a code, and does not sign in', async () => {
    const email = uniqueEmail('new');
    const res = await signUp(`  ${email.toUpperCase()} `).expect(201);

    expect(res.body).toMatchObject({ email, verificationRequired: true });
    expect(res.headers['set-cookie']).toBeUndefined(); // no session yet

    const message = lastEmailTo(email);
    expect(message.subject).toMatch(/verification code/i);
    expect(lastCodeFor(email)).toMatch(/^\d{6}$/);

    const user = await User.findOne({ email });
    expect(user?.emailVerifiedAt).toBeNull();
  });

  it('escapes HTML in names inside emails', async () => {
    const email = uniqueEmail('xss');
    await signUp(email, '<b>Eve</b> Smith').expect(201);
    expect(lastEmailTo(email).html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(lastEmailTo(email).html).not.toContain('<b>Eve</b>');
  });

  it('blocks login until verified, then the code signs the user in', async () => {
    const email = uniqueEmail('verify');
    await signUp(email).expect(201);

    const blocked = await request(baseUrl).post('/api/auth/login').send({ email, password: PASSWORD }).expect(403);
    expect(blocked.body.error).toMatchObject({ code: 'EMAIL_NOT_VERIFIED', details: { email } });
    // Within the cooldown, login does not send a second email.
    expect(emailsTo(email)).toHaveLength(1);

    // A wrong password never reveals that the account is unverified.
    const wrongPassword = await request(baseUrl).post('/api/auth/login').send({ email, password: 'nope-nope' }).expect(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');

    const code = lastCodeFor(email);
    const wrong = await verify(email, wrongCode(code)).expect(400);
    expect(wrong.body.error).toMatchObject({ code: 'INVALID_CODE' });
    expect(wrong.body.error.message).toMatch(/4 attempts left/);

    const ok = await verify(email, code).expect(200);
    expect(ok.body.accessToken).toBeTypeOf('string');
    expect(ok.body.user.email).toBe(email);
    const cookie = ([] as string[]).concat(ok.headers['set-cookie'] ?? [])[0] ?? '';
    expect(cookie).toMatch(/^rt=.*HttpOnly/i);

    // The code works once; the account is now verified and can log in normally.
    const again = await verify(email, code).expect(409);
    expect(again.body.error.code).toBe('ALREADY_VERIFIED');
    await request(baseUrl).post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  });

  it('locks the code after 5 wrong attempts', async () => {
    const email = uniqueEmail('locked');
    await signUp(email).expect(201);
    const code = lastCodeFor(email);

    for (let i = 0; i < 4; i++) await verify(email, wrongCode(code)).expect(400);
    const fifth = await verify(email, wrongCode(code)).expect(429);
    expect(fifth.body.error.code).toBe('TOO_MANY_ATTEMPTS');

    // Even the right code is refused now; a new one must be requested.
    const correct = await verify(email, code).expect(429);
    expect(correct.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('rejects expired codes', async () => {
    const email = uniqueEmail('expired');
    await signUp(email).expect(201);
    const user = await User.findOne({ email });
    await AuthCode.updateMany({ user: user!._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await verify(email, lastCodeFor(email)).expect(400);
    expect(res.body.error.code).toBe('CODE_EXPIRED');
  });

  it('resends a code with a 60 second cooldown, and the old code stops working', async () => {
    const email = uniqueEmail('resend');
    await signUp(email).expect(201);
    const firstCode = lastCodeFor(email);

    const tooSoon = await request(baseUrl).post('/api/auth/resend-verification').send({ email }).expect(429);
    expect(tooSoon.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

    await skipCooldown(email);
    await request(baseUrl).post('/api/auth/resend-verification').send({ email }).expect(200);
    expect(emailsTo(email)).toHaveLength(2);

    const secondCode = lastCodeFor(email);
    if (secondCode !== firstCode) await verify(email, firstCode).expect(400);
    await verify(email, secondCode).expect(200);
  });

  it('answers resend the same way for unknown emails', async () => {
    const email = uniqueEmail('ghost');
    const res = await request(baseUrl).post('/api/auth/resend-verification').send({ email }).expect(200);
    expect(res.body.message).toMatch(/if that email/i);
    expect(emailsTo(email)).toHaveLength(0);
  });

  it('lets a new sign-up replace an unverified one, but not a verified one', async () => {
    const email = uniqueEmail('squat');
    await signUp(email, 'Squatter', 'squatter-pass').expect(201);
    await skipCooldown(email);
    await signUp(email, 'Real Owner', 'owner-password').expect(201);
    await verify(email, lastCodeFor(email)).expect(200);

    const user = await User.findOne({ email });
    expect(user?.name).toBe('Real Owner');
    await request(baseUrl).post('/api/auth/login').send({ email, password: 'squatter-pass' }).expect(401);

    const taken = await signUp(email).expect(409);
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('hides unverified accounts from people search', async () => {
    const searcher = await registerUser(baseUrl, 'Finder');
    const email = uniqueEmail('hidden');
    await signUp(email, 'Hidden Person').expect(201);

    const res = await request(baseUrl).get('/api/users').query({ search: 'Hidden' }).set(searcher.auth).expect(200);
    expect(res.body.users).toHaveLength(0);
  });
});

describe('password reset', () => {
  it('emails a code, sets the new password, and signs out every device', async () => {
    const user = await registerUser(baseUrl, 'Forgetful');

    const res = await request(baseUrl).post('/api/auth/forgot-password').send({ email: user.email }).expect(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(lastEmailTo(user.email).subject).toMatch(/password reset/i);
    const code = lastCodeFor(user.email);

    // The password rule still applies.
    await request(baseUrl)
      .post('/api/auth/reset-password')
      .send({ email: user.email, code, password: 'short' })
      .expect(400);

    await request(baseUrl)
      .post('/api/auth/reset-password')
      .send({ email: user.email, code, password: 'brand-new-password' })
      .expect(200);

    expect(lastEmailTo(user.email).subject).toMatch(/password was changed/i);
    // Old sessions are gone, the old password fails, the new one works.
    await user.agent.post('/api/auth/refresh').set(CSRF).expect(401);
    await request(baseUrl).post('/api/auth/login').send({ email: user.email, password: user.password }).expect(401);
    await request(baseUrl)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'brand-new-password' })
      .expect(200);

    // The code worked once.
    await request(baseUrl)
      .post('/api/auth/reset-password')
      .send({ email: user.email, code, password: 'another-password' })
      .expect(400);
  });

  it('gives the same answer for unknown emails and sends nothing', async () => {
    const email = uniqueEmail('nobody');
    const res = await request(baseUrl).post('/api/auth/forgot-password').send({ email }).expect(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(emailsTo(email)).toHaveLength(0);

    const reset = await request(baseUrl)
      .post('/api/auth/reset-password')
      .send({ email, code: '123456', password: 'whatever-123' })
      .expect(400);
    expect(reset.body.error.code).toBe('INVALID_CODE');
  });

  it('a reset also verifies an unverified email', async () => {
    const email = uniqueEmail('resetverify');
    await signUp(email).expect(201);
    await request(baseUrl).post('/api/auth/forgot-password').send({ email }).expect(200);
    await request(baseUrl)
      .post('/api/auth/reset-password')
      .send({ email, code: lastCodeFor(email), password: 'fresh-password-1' })
      .expect(200);
    await request(baseUrl).post('/api/auth/login').send({ email, password: 'fresh-password-1' }).expect(200);
  });
});
