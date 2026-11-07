import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_CEILING, DEVICE_TOKEN_TTL_MS, FIRST_DELAY_MS, FORGET_AFTER_MS, FREE_FAILURES, MAX_DELAY_MS,
  attemptSucceeded, beginAttempt, delayAfter, issueDeviceToken, requesterFor, verifyDeviceToken, waitFor, _resetSignInGuard,
} from '../../src/lib/sign-in-guard.js';

const fail = (requester, times, now = 0) => {
  let last;
  for (let i = 0; i < times; i++) last = beginAttempt(requester, now);
  return last;
};

describe('sign-in guard', () => {
  beforeEach(() => _resetSignInGuard());

  it('lets 5 failures through, then delays 30 s, doubling to 15 minutes', () => {
    assert.deepEqual([1, 2, 3, 4].map(delayAfter), [0, 0, 0, 0]);
    assert.equal(delayAfter(FREE_FAILURES), FIRST_DELAY_MS);
    assert.equal(delayAfter(FREE_FAILURES + 1), 2 * FIRST_DELAY_MS);
    assert.equal(delayAfter(FREE_FAILURES + 20), MAX_DELAY_MS);
  });

  it('refuses an attempt while the requester must wait, and counts it up front otherwise', () => {
    const learner = requesterFor({ accountKey: 'usr_a', ip: '203.0.113.7' });
    assert.equal(fail(learner, 4).next, 0);
    const fifth = beginAttempt(learner, 0);
    assert.deepEqual(fifth, { wait: 0, next: FIRST_DELAY_MS }, 'the fifth wrong password starts the delay');
    assert.equal(beginAttempt(learner, 1000).wait, FIRST_DELAY_MS - 1000, 'the sixth attempt is not checked');
    assert.equal(waitFor(learner, FIRST_DELAY_MS), 0, 'the delay passes');
  });

  it('a right password starts the requester over', () => {
    const learner = requesterFor({ accountKey: 'usr_a', ip: '203.0.113.7' });
    fail(learner, 4);
    attemptSucceeded(learner);
    assert.equal(fail(learner, 4).next, 0, 'four more mistakes are free again');
  });

  it('forgets a requester after an hour without failures', () => {
    const learner = requesterFor({ accountKey: 'usr_a', ip: '203.0.113.7' });
    fail(learner, FREE_FAILURES);
    assert.equal(fail(learner, 1, FORGET_AFTER_MS + 1).next, 0);
  });

  it('a stranger elsewhere cannot delay the learner, and a device token is never delayed by others', () => {
    const stranger = requesterFor({ accountKey: 'usr_a', ip: '198.51.100.9' });
    fail(stranger, 10);
    assert.equal(waitFor(requesterFor({ accountKey: 'usr_a', ip: '203.0.113.7' }), 0), 0);
    const sameRoom = requesterFor({ accountKey: 'usr_a', ip: '198.51.100.9', deviceId: 'a'.repeat(32) });
    assert.equal(waitFor(sameRoom, 0), 0, 'the learner’s own device, even on the stranger’s address');
  });

  it('delays untrusted attempts on an account once failures from many addresses pass the ceiling', () => {
    for (let i = 0; i < ACCOUNT_CEILING; i++) beginAttempt(requesterFor({ accountKey: 'usr_a', ip: `198.51.100.${i % 250}` }), 0);
    assert.ok(waitFor(requesterFor({ accountKey: 'usr_a', ip: '203.0.113.7' }), 0) > 0, 'guessing spread across addresses is slowed');
    assert.equal(waitFor(requesterFor({ accountKey: 'usr_a', ip: '203.0.113.7', deviceId: 'b'.repeat(32) }), 0), 0, 'the owner’s device still signs in');
    assert.equal(waitFor(requesterFor({ accountKey: 'usr_b', ip: '203.0.113.7' }), 0), 0, 'other accounts are untouched');
  });

  it('counts unknown names like real ones', () => {
    const unknown = requesterFor({ accountKey: 'unknown:nobody@example.com', ip: '203.0.113.7' });
    assert.equal(fail(unknown, FREE_FAILURES).next, FIRST_DELAY_MS);
  });
});

describe('device tokens', () => {
  it('verify only for the account they were issued for, and only untampered and unexpired', () => {
    const token = issueDeviceToken('usr_a', { now: 0 });
    const deviceId = token.split('.')[0];
    assert.equal(verifyDeviceToken(token, 'usr_a', 1000), deviceId);
    assert.equal(verifyDeviceToken(token, 'usr_b', 1000), null, 'another account');
    assert.equal(verifyDeviceToken(`${token.slice(0, -2)}AA`, 'usr_a', 1000), null, 'tampered');
    assert.equal(verifyDeviceToken(token, 'usr_a', DEVICE_TOKEN_TTL_MS + 2000), null, 'expired');
    assert.equal(verifyDeviceToken('nonsense', 'usr_a'), null);
    assert.equal(verifyDeviceToken(undefined, 'usr_a'), null);
    assert.equal(issueDeviceToken('usr_a', { deviceId, now: 5000 }).split('.')[0], deviceId, 'reissued for the same device');
  });
});
