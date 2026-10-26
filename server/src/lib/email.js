import { SES_FROM_EMAIL, APP_URL } from '../config.js';
import db from './db.js';
import { logger } from './logger.js';
import { brandForeground, classroomName, contrastOnWhite, publicTheme } from './branding.js';

// SES is lazy-loaded on first real send: importing this module must not
// construct a client (or require AWS credentials) on deployments that
// never send, such as Cloud Run with SKIP_EMAIL=true.
let sesPromise = null;
function getSes() {
  if (!sesPromise) {
    sesPromise = import('@aws-sdk/client-ses').then(({ SESClient, SendEmailCommand }) => ({
      client: new SESClient({}),
      SendEmailCommand,
    }));
  }
  return sesPromise;
}

export function emailDeliveryEnabled() {
  return process.env.SKIP_EMAIL !== 'true';
}

async function getClassroom() {
  const item = await db.getSyncData('_system', 'settings');
  const s = item?.data || {};
  const primary = publicTheme(s.theme)?.primary || '#470d99';
  return {
    name: classroomName(s) || 'plato',
    primary,
    foreground: brandForeground(primary),
    // A brand that barely differs from white keeps the header and button edges visible.
    edge: contrastOnWhite(primary) < 3,
  };
}

function escapeHtml(value) {
  // A lone surrogate would make the SES SDK's form encoding throw.
  return String(value).toWellFormed().replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/**
 * The SES Source header, which must be ASCII. A name of plain words is sent as
 * before; other ASCII is quoted; anything else becomes RFC 2047 words, each
 * under 75 characters, never splitting a UTF-8 character. Only the address of
 * a configured `Name <address>` sender is used.
 */
export function formatSender(name, from = SES_FROM_EMAIL) {
  const address = from.match(/<([^<>\s]+)>\s*$/)?.[1] ?? from.trim();
  if (/^[\w!#$%&'*+\-/=?^`{|}~ ]+$/.test(name) && !name.includes('=?')) return `${name} <${address}>`;
  if (/^[\x20-\x7e]+$/.test(name)) return `"${name.replace(/[\\"]/g, '\\$&')}" <${address}>`;
  const chunks = [''];
  for (const character of name) {
    if (Buffer.byteLength(chunks.at(-1) + character) > 45) chunks.push('');
    chunks[chunks.length - 1] += character;
  }
  return `${chunks.map(chunk => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join(' ')} <${address}>`;
}

function emailWrapper(classroom, body) {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <div style="background: ${classroom.primary}; color: ${classroom.foreground}; padding: 16px 20px; border-radius: 8px 8px 0 0; font-weight: 700;${classroom.edge ? ' border: 1px solid #e0e0e0; border-bottom: none;' : ''}">
        ${escapeHtml(classroom.name)}
      </div>
      <div style="border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; padding: 24px 20px;">
        ${body}
        <p style="color: #666; font-size: 11px; line-height: 1.5; margin: 24px 0 0; text-align: center;">
          Powered by <a href="https://github.com/1111philo/plato" style="color: #666; text-decoration: underline;">plato</a>.
        </p>
      </div>
    </div>
  `;
}

export async function sendInviteEmail(toEmail, inviteToken, invitedByName) {
  const signupUrl = `${APP_URL}/signup?token=${encodeURIComponent(inviteToken)}`;

  if (!emailDeliveryEnabled()) {
    // Never log the recipient or the tokenized URL (SEC-1): the invite link
    // is returned to the admin caller instead of the log.
    logger.info('email_suppressed', { kind: 'invite' });
    return { delivered: false, reason: 'email_disabled', signupUrl };
  }

  const classroom = await getClassroom();
  const subject = `Welcome to ${classroom.name} — Your AI-Powered Learning Journey`;
  const html = emailWrapper(classroom, `
    <p style="color: #1a1a1a; line-height: 1.5; margin: 0 0 16px;">
      ${invitedByName ? `${escapeHtml(invitedByName)} has invited you` : 'You\'ve been invited'} to join <strong>${escapeHtml(classroom.name)}</strong>, an AI-powered microlearning platform where you'll work through focused lessons in conversation with an AI coach.
    </p>
    <p style="color: #1a1a1a; line-height: 1.5; margin: 0 0 16px;">
      <strong>What to expect:</strong>
    </p>
    <ul style="color: #1a1a1a; line-height: 1.6; margin: 0 0 16px; padding-left: 24px;">
      <li>Chat with an AI coach who guides you through each lesson</li>
      <li>Upload screenshots and create artifacts as you learn</li>
      <li>Work through courses organized into focused lessons, each designed for ~20 minutes</li>
    </ul>
    <p style="color: #1a1a1a; line-height: 1.5; margin: 0 0 20px;">
      Ready to get started? Create your account and begin your first lesson.
    </p>
    <a href="${escapeHtml(signupUrl)}" style="display: inline-block; background: ${classroom.primary}; color: ${classroom.foreground}; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;${classroom.edge ? ' border: 1px solid #757575;' : ''}">
      Create your account
    </a>
    <p style="color: #555; font-size: 13px; line-height: 1.5; margin: 20px 0 0;">
      This invite expires in 7 days. If you didn't expect this, you can ignore it.
    </p>
  `);

  const ses = await getSes();
  await ses.client.send(new ses.SendEmailCommand({
    Source: formatSender(classroom.name),
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: html, Charset: 'UTF-8' } },
    },
  }));

  return { delivered: true, sent: true, signupUrl };
}

export async function sendResetEmail(toEmail, resetToken) {
  const resetUrl = `${APP_URL}/reset-password?reset=${encodeURIComponent(resetToken)}`;

  if (!emailDeliveryEnabled()) {
    // Never log the recipient or the tokenized URL (SEC-1). No URL is
    // returned either: a reset link is an account-takeover credential (D-2a).
    logger.info('email_suppressed', { kind: 'reset' });
    return { delivered: false, reason: 'email_disabled' };
  }

  const classroom = await getClassroom();
  const subject = `Reset your ${classroom.name} password`;
  const html = emailWrapper(classroom, `
    <p style="color: #1a1a1a; line-height: 1.5; margin: 0 0 16px;">
      A password reset was requested for your account. Click the button below to set a new password.
    </p>
    <a href="${escapeHtml(resetUrl)}" style="display: inline-block; background: ${classroom.primary}; color: ${classroom.foreground}; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;${classroom.edge ? ' border: 1px solid #757575;' : ''}">
      Reset password
    </a>
    <p style="color: #555; font-size: 13px; line-height: 1.5; margin: 20px 0 0;">
      This link expires in 1 hour. If you didn't request this, you can ignore it.
    </p>
  `);

  const ses = await getSes();
  await ses.client.send(new ses.SendEmailCommand({
    Source: formatSender(classroom.name),
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: html, Charset: 'UTF-8' } },
    },
  }));

  return { delivered: true, sent: true, resetUrl };
}
