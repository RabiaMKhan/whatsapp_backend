import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * Unit test for the real SMTP path of sendEmail. Normal tests never reach it
 * (they use testOutbox), so here we pretend SMTP is configured, fake
 * nodemailer, and check what ends up in the logs.
 */

const { sendMail, logger } = vi.hoisted(() => ({
  sendMail: vi.fn().mockResolvedValue({}),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock('../src/lib/logger', () => ({ logger }));
vi.mock('../src/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env')>();
  return { ...actual, isTest: false, env: { ...actual.env, SMTP_HOST: 'smtp.example.test' } };
});

const { sendEmail } = await import('../src/lib/mailer');
const { resetPasswordEmail, verificationEmail } = await import('../src/lib/email-templates');

const CODE = '493817';
const user = { to: 'amina@example.test', name: 'Amina Shah', code: CODE };

describe('sendEmail logging', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['verify-email', verificationEmail(user)],
    ['reset-password', resetPasswordEmail(user)],
  ])('%s: sends the code but never logs it', async (kind, message) => {
    await sendEmail(message);

    // The email itself still carries the code...
    const sent = sendMail.mock.calls[0]?.[0] as { subject: string; text: string };
    expect(sent.subject).toContain(CODE);
    expect(sent.text).toContain(CODE);
    expect(sent).not.toHaveProperty('kind');

    // ...but the log line only has the recipient and the kind.
    expect(logger.info).toHaveBeenCalledWith({ to: user.to, kind }, 'Email sent');
    const everythingLogged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(everythingLogged).not.toContain(CODE);
  });
});
