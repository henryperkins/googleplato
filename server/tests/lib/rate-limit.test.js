import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, createLimiter, readJson } from '../../src/lib/rate-limit.js';

// A minimal Hono context: the header and, on Lambda, the request context.
const ctx = (forwardedFor, sourceIp) => ({
  req: { header: (name) => (name === 'x-forwarded-for' ? forwardedFor : undefined) },
  env: sourceIp ? { requestContext: { http: { sourceIp } } } : undefined,
});

describe('clientIp', () => {
  it('takes the address the edge appended, not what the sender wrote', () => {
    assert.equal(clientIp(ctx('6.6.6.6, 203.0.113.7')), '203.0.113.7');
  });

  it('skips the internal hop Cloud Run’s nginx ingress appends', () => {
    assert.equal(clientIp(ctx('203.0.113.7, 169.254.169.126')), '203.0.113.7');
    assert.equal(clientIp(ctx('spoofed, 2001:db8::1, fd00::1, 10.0.0.4')), '2001:db8::1');
  });

  it('drops the Lambda source address when the Function URL appended it', () => {
    assert.equal(clientIp(ctx('203.0.113.7, 52.84.1.1', '52.84.1.1')), '203.0.113.7');
    assert.equal(clientIp(ctx(undefined, '52.84.1.1')), '52.84.1.1');
  });

  it('returns no address rather than an internal one, so limits turn off instead of sharing one bucket', () => {
    assert.equal(clientIp(ctx('169.254.169.126')), '');
    assert.equal(clientIp(ctx('127.0.0.1, ::1')), '');
    assert.equal(clientIp(ctx(undefined)), '');
    assert.equal(clientIp(ctx('not-an-address')), '');
  });
});

describe('createLimiter', () => {
  it('limits a key past its count within the window, never an empty key', () => {
    const limiter = createLimiter({ limit: 2, windowMs: 1000 });
    assert.deepEqual([limiter.hit('a', 0), limiter.hit('a', 10), limiter.hit('a', 20)], [false, false, true]);
    assert.equal(limiter.hit('a', 2000), false, 'the window slides');
    assert.equal(limiter.hit('', 0) || limiter.hit('', 0) || limiter.hit('', 0), false);
  });
});

describe('readJson', () => {
  it('returns the body, or null for malformed JSON or a non-object', async () => {
    const body = (json) => ({ req: { json: async () => JSON.parse(json) } });
    assert.deepEqual(await readJson(body('{"a":1}')), { a: 1 });
    assert.equal(await readJson(body('{nope')), null);
    assert.equal(await readJson(body('"text"')), null);
  });
});
