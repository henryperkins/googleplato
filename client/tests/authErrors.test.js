/**
 * Sign-in error copy (client/src/lib/authErrors.js): learners never see raw
 * Firebase codes or console instructions, and a closed Google window isn't
 * reported as an error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFLINE_MESSAGE, googleSignInError, passwordSignInError, requestError, missingFieldsMessage,
} from '../src/lib/authErrors.js';

function firebaseError(code) {
  const err = new Error(`Firebase: Error (${code}).`);
  err.code = code;
  return err;
}

describe('googleSignInError', () => {
  it('stays quiet when the person closed the Google window', () => {
    assert.equal(googleSignInError(firebaseError('auth/popup-closed-by-user')), '');
    assert.equal(googleSignInError(firebaseError('auth/cancelled-popup-request')), '');
  });

  it('explains blocked pop-ups and network failures with a next step', () => {
    assert.match(googleSignInError(firebaseError('auth/popup-blocked')), /Allow pop-ups/);
    assert.match(googleSignInError(firebaseError('auth/network-request-failed')), /internet connection/);
  });

  it('points learners to an alternative and admins to the Firebase setting', () => {
    const learner = googleSignInError(firebaseError('auth/unauthorized-domain'));
    assert.match(learner, /email and password/);
    assert.doesNotMatch(learner, /Firebase console/);
    const admin = googleSignInError(firebaseError('auth/unauthorized-domain'), { audience: 'admin' });
    assert.match(admin, /Firebase console/);
  });

  it('never shows a raw Firebase message', () => {
    const msg = googleSignInError(firebaseError('auth/internal-error'));
    assert.doesNotMatch(msg, /auth\//);
    assert.doesNotMatch(msg, /Firebase:/);
  });

  it("passes plato's own reasons through", () => {
    assert.equal(
      googleSignInError(new Error('This invite is for a different email address')),
      'This invite is for a different email address',
    );
  });

  it('reports an unreachable server as offline', () => {
    assert.equal(googleSignInError(new TypeError('Failed to fetch')), OFFLINE_MESSAGE);
  });
});

describe('passwordSignInError', () => {
  it('turns a rejected sign-in into a plain mismatch message', () => {
    const err = new Error('Invalid credentials');
    err.status = 401;
    assert.match(passwordSignInError(err), /don't match/);
  });

  it('keeps other server reasons and reports offline', () => {
    const err = new Error('Email/username and password are required');
    err.status = 400;
    assert.equal(passwordSignInError(err), 'Email/username and password are required');
    assert.equal(passwordSignInError(new TypeError('Failed to fetch')), OFFLINE_MESSAGE);
  });
});

describe('requestError', () => {
  it("prefers the server's reason, then the fallback", () => {
    assert.equal(requestError(new Error('Username already taken'), 'fallback'), 'Username already taken');
    assert.equal(requestError(new Error(''), 'fallback'), 'fallback');
    assert.equal(requestError(new TypeError('Failed to fetch'), 'fallback'), OFFLINE_MESSAGE);
  });
});

describe('missingFieldsMessage', () => {
  it('names exactly the missing fields', () => {
    assert.equal(missingFieldsMessage(['a password']), 'Enter a password.');
    assert.equal(missingFieldsMessage(['your name', 'a password']), 'Enter your name and a password.');
    assert.equal(
      missingFieldsMessage(['your name', 'your email', 'a password']),
      'Enter your name, your email, and a password.',
    );
  });
});
