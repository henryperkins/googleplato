import { SES_FROM_EMAIL, APP_URL } from '../config.js';
import db from './db.js';
import { logger } from './logger.js';

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
  return {
    name: s.logoAlt || 'plato',
    primary: s.theme?.primary || '#470d99',
  };
}

function emailWrapper(classroom, body) {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <div style="background: ${classroom.primary}; color: #fff; padding: 16px 20px; border-radius: 8px 8px 0 0; font-weight: 700;">
        ${classroom.name}
      </div>
      <div style="border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; padding: 24px 20px;">
        ${body}
        <p style="color: #999; font-size: 11px; line-height: 1.5; margin: 24px 0 0; text-align: center;">
          Powered by <a href="https://github.com/1111philo/plato" style="color: #999; text-decoration: underline;">plato</a>.
        </p>
      </div>
    </div>
  `;
}

export async function sendInviteEmail(toEmail, inviteToken, invitedByName) {
  const signupUrl = `${APP_URL}/signup?token=${inviteToken}`;

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
      ${invitedByName ? `${invitedByName} has invited you` : 'You\'ve been invited'} to join <strong>${classroom.name}</strong>, an AI-powered microlearning platform where you'll work through focused lessons in conversation with an AI coach.
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
    <a href="${signupUrl}" style="display: inline-block; background: ${classroom.primary}; color: #fff; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Create your account
    </a>
    <p style="color: #555; font-size: 13px; line-height: 1.5; margin: 20px 0 0;">
      This invite expires in 7 days. If you didn't expect this, you can ignore it.
    </p>
  `);

  const ses = await getSes();
  await ses.client.send(new ses.SendEmailCommand({
    Source: `${classroom.name} <${SES_FROM_EMAIL}>`,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject },
      Body: { Html: { Data: html } },
    },
  }));

  return { delivered: true, sent: true, signupUrl };
}

export async function sendResetEmail(toEmail, resetToken) {
  const resetUrl = `${APP_URL}/reset-password?reset=${resetToken}`;

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
    <a href="${resetUrl}" style="display: inline-block; background: ${classroom.primary}; color: #fff; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Reset password
    </a>
    <p style="color: #555; font-size: 13px; line-height: 1.5; margin: 20px 0 0;">
      This link expires in 1 hour. If you didn't request this, you can ignore it.
    </p>
  `);

  const ses = await getSes();
  await ses.client.send(new ses.SendEmailCommand({
    Source: `${classroom.name} <${SES_FROM_EMAIL}>`,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject },
      Body: { Html: { Data: html } },
    },
  }));

  return { delivered: true, sent: true, resetUrl };
}
