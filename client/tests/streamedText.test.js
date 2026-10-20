/**
 * Streamed reply reveal (client/src/hooks/useStreamedText.js): a reply that
 * has already arrived lands in about a second and a half instead of typing
 * out at a fixed ~33 characters a second, which also held the composer's
 * send for 6–20 seconds per exchange.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextRevealLength } from '../src/hooks/useStreamedText.js';

// Ticks needed to show `length` characters that are all available at once.
function ticksToReveal(length) {
  let shown = 0;
  let ticks = 0;
  while (shown < length) {
    shown = nextRevealLength(shown, length, 30);
    ticks += 1;
  }
  return ticks;
}

describe('nextRevealLength', () => {
  it('lands a whole reply in about a second and a half, whatever its length', () => {
    for (const length of [230, 600, 2000]) {
      const ms = ticksToReveal(length) * 30;
      assert.ok(ms <= 1800, `${length} characters took ${ms} ms`);
    }
  });

  it('still types a slow stream at least one character per tick', () => {
    assert.equal(nextRevealLength(10, 11, 30), 11);
    assert.equal(nextRevealLength(10, 13, 30), 11);
  });

  it('catches up after a throttled background tab', () => {
    assert.ok(nextRevealLength(0, 500, 1000) >= 33);
  });

  it('never runs past the text that has arrived', () => {
    assert.equal(nextRevealLength(40, 40, 30), 40);
    assert.equal(nextRevealLength(0, 5, 10_000), 5);
  });
});
