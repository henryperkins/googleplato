import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendFirebasePasswordReset } from '../js/firebaseClient.js';

describe('sendFirebasePasswordReset', () => {
  it('rejects missing or empty email', async () => {
    await assert.rejects(
      sendFirebasePasswordReset(''),
      (err) => err.code === 'auth/missing-email' && err.message.includes('email'),
    );
    await assert.rejects(
      sendFirebasePasswordReset(null),
      (err) => err.code === 'auth/missing-email',
    );
    await assert.rejects(
      sendFirebasePasswordReset(undefined),
      (err) => err.code === 'auth/missing-email',
    );
  });

  it('is exported as a callable async function', () => {
    assert.equal(typeof sendFirebasePasswordReset, 'function');
  });
});
