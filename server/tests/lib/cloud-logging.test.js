import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCloudLoggingLogs } from '../../src/lib/cloud-logging.js';
const options = { projectId: 'test-project', serviceName: 'plato', location: 'us-east1', since: '2026-10-21T00:00:00Z', until: '2026-10-21T01:00:00Z' };
const entry = (id, code = 'sync_conflict', revision = 'a') => ({ insertId: id, timestamp: '2026-10-21T00:30:00Z', jsonPayload: { code, logId: id, level: code.endsWith('recovered') ? 'info' : 'warn' }, resource: { labels: { revision_name: revision } } });
test('queries one service across revisions and follows empty pages, deduplicating deliveries', async () => {
  const calls = [];
  const pages = [{ entries: [entry('1')], nextPageToken: 'a' }, { nextPageToken: 'b' }, { entries: [entry('1'), entry('2', 'client_save_recovered', 'b')] }];
  const result = await fetchCloudLoggingLogs(options, { request: async body => { calls.push(body); return pages.shift(); } });
  assert.equal(result.error, null); assert.equal(result.entries.length, 2);
  assert.equal(calls.length, 3); assert.equal(calls[2].pageToken, 'b');
  assert.deepEqual(calls[0].resourceNames, ['projects/test-project']);
  assert.match(calls[0].filter, /resource.labels.service_name="plato"/);
  assert.match(calls[0].filter, /resource.labels.location="us-east1"/);
  assert.doesNotMatch(calls[0].filter, /revision_name/);
  assert.match(calls[0].filter, /client_save_recovered/);
});
test('deduplicates a client event delivered again on a different instance', async () => {
  const a = entry('1'); a.jsonPayload = { ...a.jsonPayload, code: 'client_save_unconfirmed', source: 'client', actorRef: 'one', eventId: 'same' };
  const b = structuredClone(a); b.jsonPayload.logId = '2';
  const c = structuredClone(b); c.jsonPayload.actorRef = 'two';
  const result = await fetchCloudLoggingLogs(options, { request: async () => ({ entries: [a, b, c] }) });
  assert.equal(result.entries.length, 2);
});
test('incomplete scans and permission failures never look like a clean empty window', async () => {
  const capped = await fetchCloudLoggingLogs(options, { maxPages: 2, request: async () => ({ nextPageToken: 'more' }) });
  assert.ok(capped.error); assert.equal(capped.complete, false);
  const denied = await fetchCloudLoggingLogs(options, { request: async () => { throw Object.assign(new Error('SECRET bearer token'), { status: 403 }); } });
  assert.match(denied.error, /403/); assert.doesNotMatch(denied.error, /SECRET/);
  const malformed = await fetchCloudLoggingLogs(options, { request: async () => ({ entries: 'not an array' }) });
  assert.ok(malformed.error);
});
test('rejects missing scope and filter injection before querying', async () => {
  let calls = 0;
  for (const bad of [{ projectId: '' }, { serviceName: '" OR true' }, { since: 'bad-date' }, { until: '2020-01-01' }]) {
    const result = await fetchCloudLoggingLogs({ ...options, ...bad }, { request: async () => { calls++; return {}; } });
    assert.ok(result.error);
  }
  assert.equal(calls, 0);
});
test('bounds a stalled reader including credential discovery', async () => {
  const result = await fetchCloudLoggingLogs(options, { maxDurationMs: 10, request: () => new Promise(() => {}) });
  assert.equal(result.complete, false);
  assert.match(result.error, /timed out/);
});

test('rejects primitive pages rather than reporting a successful empty scan', async () => {
  for (const response of ['unavailable', [], true, 1]) {
    const result = await fetchCloudLoggingLogs(options, { request: async () => response });
    assert.equal(result.complete, false);
    assert.ok(result.error);
  }
});
