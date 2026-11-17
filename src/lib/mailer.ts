import nodemailer, { type Transporter } from 'nodemailer';
import { env, isTest } from '../config/env';
import { logger } from './logger';

export interface EmailMessage {
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

  if (!transporter) {
    logger.warn(
      { to: message.to, subject: message.subject },
      `Email NOT sent (SMTP_HOST is not set). Content below:\n\n${message.text}\n`,
    );
    return;
  }

  await transporter.sendMail({ from: env.EMAIL_FROM, ...message });
  logger.info({ to: message.to, subject: message.subject }, 'Email sent');
}
