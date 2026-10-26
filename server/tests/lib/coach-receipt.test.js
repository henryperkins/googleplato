import { test } from 'node:test';
import assert from 'node:assert/strict';
test('receipts bind all generated fields and remain verifiable after reload', async () => {
  const mod = await import('../../src/lib/coach-receipt.js').catch(() => ({}));
  assert.equal(typeof mod.signCoachTurn, 'function');
  const turn = { userId: 'u', lessonId: 'l', turnId: 't', base: { generation: 'g' }, messages: [{ content: 'exact' }], lessonKB: { progress: 10 }, phase: 'completed', achieved: true };
  const signed = { ...turn, receipt: mod.signCoachTurn(turn) };
  assert.equal(mod.verifyCoachTurn(signed), true);
  const reload = await import('../../src/lib/coach-receipt.js?reload');
  assert.equal(reload.verifyCoachTurn(signed), true);
  for (const [key, value] of Object.entries({ userId: 'v', lessonId: 'x', turnId: 'n', base: { generation: 'h' }, messages: [], lessonKB: { progress: 0 }, phase: 'learning', achieved: false })) {
    assert.equal(mod.verifyCoachTurn({ ...signed, [key]: value }), false, key);
  }
  assert.equal(mod.verifyCoachTurn({ ...signed, receipt: 'bad' }), false);
});
test('receipt signing rejects the development key in production', async () => {
  const mod = await import('../../src/lib/coach-receipt.js').catch(() => ({}));
  assert.equal(typeof mod.receiptKey, 'function');
  assert.throws(() => mod.receiptKey('dev-secret-change-me', { NODE_ENV: 'production' }), /stable/);
});
