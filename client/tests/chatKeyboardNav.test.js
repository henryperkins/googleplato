/**
 * Alt+Arrow message navigation (client/src/hooks/useChatKeyboardNav.js).
 * From the log itself, Alt+ArrowUp lands on the newest message (the one a
 * learner wants after "New message from coach"), not the first of the lesson.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextMessageIndex } from '../src/hooks/useChatKeyboardNav.js';

describe('nextMessageIndex', () => {
  it('enters the conversation at the newest message with Alt+ArrowUp', () => {
    assert.equal(nextMessageIndex(-1, 12, 'ArrowUp'), 11);
  });

  it('enters at the oldest message with Alt+ArrowDown', () => {
    assert.equal(nextMessageIndex(-1, 12, 'ArrowDown'), 0);
  });

  it('moves one message at a time and stops at either end', () => {
    assert.equal(nextMessageIndex(5, 12, 'ArrowUp'), 4);
    assert.equal(nextMessageIndex(5, 12, 'ArrowDown'), 6);
    assert.equal(nextMessageIndex(0, 12, 'ArrowUp'), 0);
    assert.equal(nextMessageIndex(11, 12, 'ArrowDown'), 11);
  });

  it('returns -1 when there are no messages', () => {
    assert.equal(nextMessageIndex(-1, 0, 'ArrowUp'), -1);
  });
});
