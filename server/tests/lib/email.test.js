/**
 * Email delivery-off contract (SEC-1, EML-1, EML-2): with SKIP_EMAIL=true
 * nothing secret may reach the logs — no recipient, no tokenized URL — and
 * callers get an explicit not-delivered result instead of a fake success.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../src/lib/logger.js';

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
