import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogSourceStatus, formatDataLossWatch, formatGroups } from '../../../scripts/pilot-report.js';
test('an unavailable Cloud Logging reader never appears as a successful empty CloudWatch read', () => {
  const logs = { remoteSource: 'cloud-logging', cloudlogging: { error: 'denied', complete: false }, cloudwatch: { error: null, logGroups: [] }, groups: [] };
  assert.match(formatLogSourceStatus(logs), /Cloud Logging.*incomplete/i);
  assert.doesNotMatch(formatLogSourceStatus(logs), /successfully/);
  assert.match(formatDataLossWatch(logs), /incomplete/i);
  assert.match(formatGroups(logs), /incomplete/i);
  assert.match(formatLogSourceStatus({ ...logs, cloudlogging: null }), /incomplete/i);
});
test('report includes handled failures and distinguishes recoveries', () => {
  const logs = { remoteSource: 'cloud-logging', cloudlogging: { complete: true, projectId: 'test', serviceName: 'plato' }, groups: [
    { code: 'sync_conflict', count: 2 }, { code: 'client_save_unconfirmed', count: 1 }, { code: 'client_save_recovered', count: 1 },
  ] };
  const watch = formatDataLossWatch(logs);
  assert.match(watch, /sync_conflict/); assert.match(watch, /client_save_unconfirmed/);
  assert.doesNotMatch(watch, /client_save_recovered/);
  assert.match(formatLogSourceStatus(logs), /Cloud Logging.*complete/i);
});
