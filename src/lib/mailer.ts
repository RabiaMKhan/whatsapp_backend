import nodemailer, { type Transporter } from 'nodemailer';
import { env, isTest } from '../config/env';
import { logger } from './logger';

/** What the email is for. Safe to log, unlike the subject (which can hold a code). */
export type EmailKind = 'verify-email' | 'reset-password' | 'password-changed' | 'invite';

export interface EmailMessage {
  kind: EmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/*
 * Three modes:
 *  - SMTP_HOST set → real email through nodemailer (Gmail app password,
 *    Mailtrap, Resend, SES... anything with SMTP).
 *  - Development without SMTP → the email is printed in the server console,
 *    so you can copy the code while building.
 *  - Tests → kept in `testOutbox` so tests can read the code.
 *
 * Logs only say who the email went to and what kind it was. Never log the
 * subject or body: they contain login codes, and anyone who can read the
 * logs could use them to verify accounts or reset passwords.
 */
const transporter: Transporter | null = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

export const testOutbox: EmailMessage[] = [];

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (isTest) {
    testOutbox.push(message);
    return;
  }

  const { kind, to, subject, text, html } = message;

  if (!transporter) {
    // Development only: production refuses to start without SMTP_HOST (see config/env.ts).
    logger.warn({ to, kind }, `Email NOT sent (SMTP_HOST is not set). Content below:\n\n${text}\n`);
    return;
  }

  await transporter.sendMail({ from: env.EMAIL_FROM, to, subject, text, html });
  logger.info({ to, kind }, 'Email sent');
}
