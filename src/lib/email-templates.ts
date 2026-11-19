import { APP_NAME, AUTH_CODE } from '@chat/shared';
import { env } from '../config/env';
import type { EmailMessage } from './mailer';

/*
 * Email HTML must use inline styles and tables: most mail apps ignore <style>
 * and modern CSS. Names come from users, so they are always HTML-escaped.
 */

const BRAND = '#4651c9';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const DEFAULT_FOOTER = `You received this email because of activity on your ${APP_NAME} account.
                If this wasn't you, you can safely ignore it.`;

function layout({ preheader, body, footer = DEFAULT_FOOTER }: { preheader: string; body: string; footer?: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2330;">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
            <tr>
              <td style="padding:0 4px 20px;">
                <span style="display:inline-block;width:28px;height:28px;border-radius:8px;background:${BRAND};vertical-align:middle;"></span>
                <span style="font-size:16px;font-weight:600;vertical-align:middle;margin-left:8px;">${APP_NAME}</span>
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;border:1px solid #e4e6ee;border-radius:12px;padding:32px;">
                ${body}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 4px 0;font-size:12px;line-height:18px;color:#7a8094;">
                ${footer}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function codeBlock(code: string): string {
  return `<div style="margin:24px 0;padding:16px;border-radius:10px;background:#f4f5f9;text-align:center;font-size:32px;font-weight:700;letter-spacing:10px;font-family:'SF Mono',Menlo,Consolas,monospace;color:#1f2330;">${code}</div>`;
}

const heading = (text: string) => `<h1 style="margin:0 0 12px;font-size:20px;line-height:28px;font-weight:600;">${text}</h1>`;
const paragraph = (text: string) => `<p style="margin:0 0 12px;font-size:14px;line-height:22px;color:#4a4f60;">${text}</p>`;

export function verificationEmail({ to, name, code }: { to: string; name: string; code: string }): EmailMessage {
  const greeting = `Hi ${escapeHtml(firstName(name))},`;
  return {
    kind: 'verify-email',
    to,
    subject: `${code} is your ${APP_NAME} verification code`,
    text: `Hi ${firstName(name)},\n\nYour ${APP_NAME} verification code is: ${code}\n\nIt expires in ${AUTH_CODE.TTL_MINUTES} minutes. If you didn't create an account, ignore this email.`,
    html: layout({
      preheader: `Your verification code is ${code}`,
      body: `${heading('Verify your email')}
        ${paragraph(greeting)}
        ${paragraph(`Enter this code in ${APP_NAME} to confirm your email address and finish creating your account.`)}
        ${codeBlock(code)}
        ${paragraph(`The code expires in ${AUTH_CODE.TTL_MINUTES} minutes. Never share it with anyone.`)}`,
    }),
  };
}

export function resetPasswordEmail({ to, name, code }: { to: string; name: string; code: string }): EmailMessage {
  const greeting = `Hi ${escapeHtml(firstName(name))},`;
  return {
    kind: 'reset-password',
    to,
    subject: `${code} is your ${APP_NAME} password reset code`,
    text: `Hi ${firstName(name)},\n\nUse this code to reset your ${APP_NAME} password: ${code}\n\nIt expires in ${AUTH_CODE.TTL_MINUTES} minutes. If you didn't ask for this, ignore this email; your password stays the same.`,
    html: layout({
      preheader: `Your password reset code is ${code}`,
      body: `${heading('Reset your password')}
        ${paragraph(greeting)}
        ${paragraph('We received a request to reset your password. Enter this code to choose a new one.')}
        ${codeBlock(code)}
        ${paragraph(`The code expires in ${AUTH_CODE.TTL_MINUTES} minutes. If you didn't ask for this, ignore this email; your password stays the same.`)}`,
    }),
  };
}

export function passwordChangedEmail({ to, name }: { to: string; name: string }): EmailMessage {
  const greeting = `Hi ${escapeHtml(firstName(name))},`;
  const loginUrl = `${env.APP_URL}/login`;
  return {
    kind: 'password-changed',
    to,
    subject: `Your ${APP_NAME} password was changed`,
    text: `Hi ${firstName(name)},\n\nYour ${APP_NAME} password was just changed and you were signed out on all devices.\n\nIf this was you, sign in again: ${loginUrl}\nIf it wasn't, reset your password right away.`,
    html: layout({
      preheader: 'Your password was changed',
      body: `${heading('Your password was changed')}
        ${paragraph(greeting)}
        ${paragraph('Your password was just changed, and you were signed out on all devices.')}
        <p style="margin:24px 0;"><a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${BRAND};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">Sign in</a></p>
        ${paragraph("If this wasn't you, reset your password right away.")}`,
    }),
  };
}

const button = (href: string, label: string) =>
  `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${BRAND};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${escapeHtml(label)}</a></p>`;

/** Sent to someone without an account. The inviter's name is user input: escape it. */
export function inviteEmail({ to, inviterName, joinUrl }: { to: string; inviterName: string; joinUrl: string }): EmailMessage {
  const name = inviterName.trim();
  return {
    kind: 'invite',
    to,
    subject: `${name} invited you to chat on ${APP_NAME}`,
    text: `Hi,\n\n${name} invited you to join ${APP_NAME}, a place to message your team in real time.\n\nCreate your free account here: ${joinUrl}\n\nOnce you sign up, a chat with ${name} will be waiting for you. If you don't know ${name}, you can ignore this email.`,
    html: layout({
      preheader: `${name} invited you to chat on ${APP_NAME}`,
      body: `${heading(`${escapeHtml(name)} invited you to ${APP_NAME}`)}
        ${paragraph(`${escapeHtml(name)} wants to message you on ${APP_NAME}, a place to chat with your team in real time.`)}
        ${button(joinUrl, `Join ${APP_NAME}`)}
        ${paragraph(`Once you sign up with <strong>${escapeHtml(to)}</strong>, a chat with ${escapeHtml(firstName(name))} will be waiting for you.`)}`,
      footer: `You received this email because ${escapeHtml(name)} entered your address on ${APP_NAME}. If you don't know them, you can safely ignore it; you won't get more emails unless someone invites you again.`,
    }),
  };
}
