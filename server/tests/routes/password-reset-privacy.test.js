import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { SESClient } from '@aws-sdk/client-ses';
import auth from '../../src/routes/auth.js';
import db from '../../src/lib/db.js';
import { logger } from '../../src/lib/logger.js';

describe('password reset response privacy with delivery enabled', () => {
  const known = 'known@example.test';
  const unknown = 'unknown@example.test';
  const secret = 'provider-secret-reset-token';
  let original;
  let app;
  let sent;
  let stored;
  let logged;

  beforeEach(() => {
    original = { getUserByEmail: db.getUserByEmail, storeResetToken: db.storeResetToken,
      getSyncData: db.getSyncData, send: SESClient.prototype.send, skip: process.env.SKIP_EMAIL,
      log: console.log, warn: console.warn, error: console.error };
    process.env.SKIP_EMAIL = 'false';
    logger._reset();
    sent = [];
    stored = [];
    logged = [];
    console.log = console.warn = console.error = (...args) => logged.push(args.join(' '));
    db.getUserByEmail = async email => email === known ? { userId: 'u_reset', email: known } : null;
    db.storeResetToken = async (...args) => { stored.push(args); };
    db.getSyncData = async () => ({ data: { classroomName: 'Reset test' } });
    SESClient.prototype.send = async command => { sent.push(command.input); return {}; };
    app = new Hono().route('/', auth);
  });

  afterEach(() => {
    db.getUserByEmail = original.getUserByEmail;
    db.storeResetToken = original.storeResetToken;
    db.getSyncData = original.getSyncData;
    SESClient.prototype.send = original.send;
    if (original.skip === undefined) delete process.env.SKIP_EMAIL;
    else process.env.SKIP_EMAIL = original.skip;
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  });

  async function response(email) {
    const res = await app.request('/v1/auth/forgot-password', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    return { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() };
  }

  const expected = { status: 200, contentType: 'application/json', body: '{"ok":true}' };

  for (const stage of ['lookup', 'token', 'email']) {
    it(`keeps the public response identical after a ${stage} failure and logs only its stage`, async () => {
      const fail = async () => { throw new Error(`${known} ${secret} https://example.test/reset?token=${secret}`); };
      if (stage === 'lookup') db.getUserByEmail = fail;
      if (stage === 'token') db.storeResetToken = fail;
      if (stage === 'email') SESClient.prototype.send = fail;

      assert.deepEqual(await response(known), expected);
      assert.deepEqual(await response(unknown), expected);
      const entries = logger.recent();
      assert.equal(entries.length, stage === 'lookup' ? 2 : 1);
      for (const entry of entries) {
        assert.equal(entry.code, 'password_reset_request_failed');
        assert.equal(entry.level, 'warn');
        assert.deepEqual(entry.meta, { stage });
      }
      const output = logged.join('\n') + JSON.stringify(entries);
      for (const sensitive of [known, unknown, secret, 'token=', '/reset?']) assert.ok(!output.includes(sensitive));
      assert.equal(sent.length, 0);
      assert.equal(stored.length, stage === 'email' ? 1 : 0);
    });
  }

  it('still creates a hashed token and sends a real formatted message through the stubbed SES transport', async () => {
    assert.deepEqual(await response(known), expected);
    assert.deepEqual(await response(unknown), expected);
    assert.equal(stored.length, 1);
    assert.match(stored[0][0], /^[a-f0-9]{64}$/);
    assert.equal(stored[0][1], 'u_reset');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].Destination.ToAddresses, [known]);
    assert.match(sent[0].Message.Body.Html.Data, /Reset password/);
    assert.equal(logger.recent().length, 0);
  });
});
