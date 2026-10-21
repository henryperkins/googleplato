import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataLossGroups, summarizeSaveLogs, runWatch } from '../../../scripts/log-watch.js';
const e = (code, meta = {}) => ({ code, logId: `${code}-${Math.random()}`, ts: '2026-10-21T00:30:00Z', meta });
test('captures failures and recovery separately without assuming recovery erases failures', () => {
  const logs = summarizeSaveLogs([
    e('unhandled_error', { method: 'POST', path: '/v1/ai/messages' }),
    e('unhandled_error', { method: 'PUT', path: '/v1/sync/profile' }),
    e('sync_conflict'), e('sync_validation_failure'), e('client_save_unconfirmed'), e('client_save_recovered'),
    e('unhandled_error', { method: 'DELETE', path: '/v1/sync/messages:lesson' }),
    e('unhandled_error', { method: 'POST', path: '/v1/sync-unrelated' }),
  ]);
  assert.equal(logs.failureCount, 5); assert.equal(logs.recoveryCount, 1);
  assert.equal(dataLossGroups(logs).length, 4);
});
test('read-only watch defaults to Cloud Logging and never silently accepts incomplete results', async () => {
  let reads = 0;
  const report = await runWatch({ env: { GOOGLE_CLOUD_PROJECT: 'test-project', CLOUD_RUN_SERVICE: 'plato' }, readCloud: async () => { reads++; return { entries: [e('sync_conflict')], error: null, complete: true }; } });
  assert.equal(reads, 1); assert.equal(report.failureCount, 1);
  await assert.rejects(runWatch({ env: {}, readCloud: async () => ({ entries: [], error: 'denied', complete: false }) }), /denied/);
});
test('legacy grouped responses still recognize write-path failures and new save codes', () => {
  assert.equal(dataLossGroups({ groups: [
    { code: 'unhandled_error', sample: e('unhandled_error', { method: 'PUT', path: '/v1/sync/profile' }) },
    { code: 'sync_conflict' }, { code: 'client_save_recovered' },
  ] }).length, 2);
});
