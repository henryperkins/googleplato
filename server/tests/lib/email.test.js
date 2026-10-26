/**
 * Email delivery-off contract (SEC-1, EML-1, EML-2): with SKIP_EMAIL=true
 * nothing secret may reach the logs — no recipient, no tokenized URL — and
 * callers get an explicit not-delivered result instead of a fake success.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../src/lib/logger.js';
import db from '../../src/lib/db.js';
import { Readable } from 'node:stream';
import { SESClient } from '@aws-sdk/client-ses';
import { brandForeground } from '../../src/lib/branding.js';
import { contrastRatio, contrastText } from '../../../client/src/lib/branding.js';

const email = await import('../../src/lib/email.js');

describe('email delivery off', () => {
  let logged;
  let originalLog;
  let originalWarn;
  let originalError;

  beforeEach(() => {
    process.env.SKIP_EMAIL = 'true';
    logger._reset();
    logged = [];
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
    console.log = (...args) => logged.push(args.join(' '));
    console.warn = (...args) => logged.push(args.join(' '));
    console.error = (...args) => logged.push(args.join(' '));
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    delete process.env.SKIP_EMAIL;
  });

  it('reports delivery state from SKIP_EMAIL', () => {
    assert.equal(email.emailDeliveryEnabled(), false);
    delete process.env.SKIP_EMAIL;
    assert.equal(email.emailDeliveryEnabled(), true);
  });

  it('invite returns not-delivered with the signup URL, logging no secret', async () => {
    const result = await email.sendInviteEmail('person@example.com', 'tok_secret_123', 'Admin');
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'email_disabled');
    assert.ok(result.signupUrl.includes('tok_secret_123'));
    const entries = logger.recent();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].code, 'email_suppressed');
    assert.deepEqual(entries[0].meta, { kind: 'invite' });
    const allLogged = logged.join('\n') + JSON.stringify(entries);
    assert.ok(!allLogged.includes('person@example.com'));
    assert.ok(!allLogged.includes('tok_secret_123'));
    assert.ok(!allLogged.includes('/signup?'));
    assert.ok(!allLogged.includes('token='));
  });

  it('reset returns not-delivered with no URL, logging no secret', async () => {
    const result = await email.sendResetEmail('person@example.com', 'rst_secret_456');
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'email_disabled');
    assert.equal(result.resetUrl, undefined);
    const allLogged = logged.join('\n') + JSON.stringify(logger.recent());
    assert.ok(!allLogged.includes('person@example.com'));
    assert.ok(!allLogged.includes('rst_secret_456'));
    assert.ok(!allLogged.includes('reset='));
  });
});

describe('branded email output', () => {
  let originalSend;
  let originalRead;
  let originalSkip;
  let sent;
  let settings;
  beforeEach(() => {
    originalSend = SESClient.prototype.send;
    originalRead = db.getSyncData;
    originalSkip = process.env.SKIP_EMAIL;
    process.env.SKIP_EMAIL = 'false';
    sent = [];
    settings = { classroomName: 'École & <Partners>, "東京"', logoAlt: 'Old name', theme: { primary: '#f5c518' } };
    db.getSyncData = async () => ({ data: settings });
    SESClient.prototype.send = async command => { sent.push(command.input); return {}; };
  });
  afterEach(() => {
    SESClient.prototype.send = originalSend;
    db.getSyncData = originalRead;
    if (originalSkip === undefined) delete process.env.SKIP_EMAIL;
    else process.env.SKIP_EMAIL = originalSkip;
  });

  it('escapes branding and inviter text and uses UTF-8 MIME display names', async () => {
    await email.sendInviteEmail('recipient@example.test', 'test-token', '<Admin> & Team');
    const message = sent[0];
    assert.match(message.Message.Body.Html.Data, /École &amp; &lt;Partners&gt;, &quot;東京&quot;/);
    assert.match(message.Message.Body.Html.Data, /&lt;Admin&gt; &amp; Team has invited you/);
    assert.ok(!message.Message.Body.Html.Data.includes('Old name'));
    const words = [...message.Source.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    assert.equal(words.map(word => Buffer.from(word[1], 'base64').toString('utf8')).join(''), settings.classroomName);
    assert.ok(words.every(word => word[0].length <= 75));
    assert.match(message.Source, /^[\x20-\x7e]+$/);
    assert.equal(message.Message.Subject.Charset, 'UTF-8');
    assert.equal(message.Message.Body.Html.Charset, 'UTF-8');
  });

  it('uses readable foregrounds on headers and buttons for invites and resets', async () => {
    for (const primary of ['#f5c518', '#87ceeb', '#ffffff', '#470d99', '#757575']) {
      settings.theme.primary = primary;
      await email.sendInviteEmail('recipient@example.test', 'invite', 'Admin');
      await email.sendResetEmail('recipient@example.test', 'reset');
      const foreground = brandForeground(primary);
      assert.ok(contrastRatio(foreground, primary) >= 4.5);
      for (const message of sent.slice(-2)) {
        assert.equal(message.Message.Body.Html.Data.split(`background: ${primary}; color: ${foreground};`).length - 1, 2);
      }
    }
  });

  it('splits long Unicode sender names into valid MIME words without breaking characters', async () => {
    settings.classroomName = '東京🦉'.repeat(25);
    await email.sendResetEmail('recipient@example.test', 'reset');
    const words = [...sent[0].Source.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    assert.ok(words.length > 1);
    assert.ok(words.every(word => word[0].length <= 75));
    assert.equal(words.map(word => Buffer.from(word[1], 'base64').toString('utf8')).join(''), settings.classroomName);
  });

  it('matches classroom foreground selection over a wide color sweep', () => {
    for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) {
      const color = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
      assert.equal(brandForeground(color), contrastText(color), color);
    }
  });

  it('falls back safely for blank names and malformed legacy colors', async () => {
    settings = { classroomName: '   ', logoAlt: 'Stale', theme: { primary: 'red; background-image: url(https://example.com/)' } };
    await email.sendResetEmail('recipient@example.test', 'reset');
    assert.equal(sent[0].Message.Subject.Data, 'Reset your plato password');
    assert.ok(!sent[0].Message.Body.Html.Data.includes('background-image'));
  });

  it('keeps plain sender names as they were, quotes other ASCII, and sends only the configured address', () => {
    assert.equal(email.formatSender('plato', 'noreply@plato.example'), 'plato <noreply@plato.example>');
    assert.equal(email.formatSender('AI Leaders Academy', 'noreply@plato.example'), 'AI Leaders Academy <noreply@plato.example>');
    assert.equal(email.formatSender('St. Mary\'s, "Online" \\ Co', 'noreply@plato.example'), '"St. Mary\'s, \\"Online\\" \\\\ Co" <noreply@plato.example>');
    assert.equal(email.formatSender('=?UTF-8?B?SGk=?=', 'noreply@plato.example'), '"=?UTF-8?B?SGk=?=" <noreply@plato.example>');
    assert.equal(email.formatSender('plato', 'plato <noreply@plato.example>'), 'plato <noreply@plato.example>');
    assert.match(email.formatSender('École', ' noreply@plato.example '), /^=\?UTF-8\?B\?[^?]+\?= <noreply@plato\.example>$/);
  });

  it('keeps the footer readable and gives near-white brands visible edges', async () => {
    for (const primary of ['#ffffff', '#f5f5f5', '#470d99']) {
      settings.theme.primary = primary;
      await email.sendInviteEmail('recipient@example.test', 'invite', 'Admin');
      const html = sent.at(-1).Message.Body.Html.Data;
      assert.ok(contrastRatio('#666666', '#ffffff') >= 4.5);
      assert.match(html, /color: #666; font-size: 11px/);
      const light = primary !== '#470d99';
      assert.equal(html.includes('border: 1px solid #757575;'), light, primary);
      assert.equal(html.includes('border: 1px solid #e0e0e0; border-bottom: none;'), light, primary);
    }
  });

  it('serializes through the real SES client, even for names that are not well-formed Unicode', async () => {
    const wire = [];
    const realClient = new SESClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: {
        handle: async request => {
          wire.push(new URLSearchParams(request.body));
          const body = '<SendEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendEmailResult><MessageId>m</MessageId></SendEmailResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></SendEmailResponse>';
          return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Readable.from([Buffer.from(body)]) } };
        },
      },
    });
    SESClient.prototype.send = command => originalSend.call(realClient, command);
    settings = { classroomName: 'Acme \ud83e Academy', theme: { primary: '#f5c518' } };
    await email.sendInviteEmail('recipient@example.test', 'invite', 'Ada \udc00');
    await email.sendResetEmail('recipient@example.test', 'reset');
    assert.equal(wire.length, 2);
    for (const form of wire) {
      assert.match(form.get('Source'), /^[\x20-\x7e]+$/);
      assert.equal(form.get('Message.Subject.Charset'), 'UTF-8');
      assert.equal(form.get('Message.Body.Html.Charset'), 'UTF-8');
      assert.ok(form.get('Message.Body.Html.Data').includes('Acme \ufffd Academy'));
    }
    assert.ok(wire[0].get('Message.Body.Html.Data').includes('Ada \ufffd has invited you'));
  });
});
