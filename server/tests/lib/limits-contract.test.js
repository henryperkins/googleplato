/**
 * Cross-package limits contract (PERF-1).
 *
 * client/src/lib/constants.js is the canonical source; the server mirrors
 * what it must enforce. Nothing asserted this mirror before, and the
 * screenshot caps lived in different units (client decoded bytes vs server
 * encoded record), which made ~285-350 KiB screenshots unsaveable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const client = await import('../../../client/src/lib/constants.js');
const lessonLimits = await import('../../src/lib/lesson-limits.js');
const { MAX_SCREENSHOT_RECORD_BYTES } = await import('../../src/lib/sync-limits.js');

describe('mirrored lesson limits', () => {
  it('server lesson-limits equal the canonical client constants', () => {
    assert.equal(lessonLimits.MAX_EXCHANGES, client.MAX_EXCHANGES);
    assert.equal(lessonLimits.MIN_OBJECTIVES, client.MIN_OBJECTIVES);
    assert.equal(lessonLimits.MAX_OBJECTIVES, client.MAX_OBJECTIVES);
    assert.equal(lessonLimits.MINS_PER_EXCHANGE, client.MINS_PER_EXCHANGE);
  });
});

describe('screenshot caps', () => {
  it('a maximum-length client data URL fits the server record cap', () => {
    const data = 'x'.repeat(client.SCREENSHOT_MAX_DATA_URL_CHARS);
    const record = {
      userId: 'u'.repeat(36),
      dataKey: `screenshot:${'k'.repeat(64)}`,
      data,
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    const size = JSON.stringify(record).length;
    assert.ok(size <= MAX_SCREENSHOT_RECORD_BYTES,
      `record ${size} exceeds server cap ${MAX_SCREENSHOT_RECORD_BYTES}`);
  });
});
