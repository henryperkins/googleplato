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

test('legacy monitor rejects unsafe URLs before sending admin credentials', async t => {
  const requests = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  for (const url of ['http://example.test', 'not a URL', 'https://user:secret@example.test',
    'https://example.test/?token=secret', 'https://example.test/#secret']) {
    await assert.rejects(runWatch({ env: { LOG_WATCH_SOURCE: 'api', PLATO_API_URL: url,
      PLATO_ADMIN_EMAIL: 'admin@example.test', PLATO_ADMIN_PASSWORD: 'private-password' } }), /HTTPS base URL/);
  }
  assert.equal(requests.mock.callCount(), 0);
});

test('legacy monitor keeps credential requests on the configured HTTPS origin', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(url.endsWith('/login')
      ? { accessToken: 'test-access-token' }
      : { groups: [{ code: 'sync_conflict', count: 2 }] }));
  });
  const report = await runWatch({ env: { LOG_WATCH_SOURCE: 'api', PLATO_API_URL: 'https://example.test/',
    PLATO_ADMIN_EMAIL: 'admin@example.test', PLATO_ADMIN_PASSWORD: 'private-password' } });
  assert.equal(report.failureCount, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://example.test/v1/auth/login');
  assert.match(requests[1].url, /^https:\/\/example.test\/v1\/admin\/logs\?/);
  assert.equal(requests[1].options.headers.Authorization, 'Bearer test-access-token');
});
