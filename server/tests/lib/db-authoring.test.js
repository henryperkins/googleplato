import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import db from '../../src/lib/db-dynamodb.js';

afterEach(() => mock.restoreAll());

test('authoring can request a consistent lesson read without changing other readers', async () => {
  const requests = [];
  mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
    requests.push(command.input);
    return { Item: { version: 2, data: {} } };
  });
  assert.equal((await db.getSyncData('_system', 'lesson:test', { consistentRead: true })).version, 2);
  await db.getSyncData('_system', 'settings');
  assert.equal(requests[0].ConsistentRead, true);
  assert.equal(requests[1].ConsistentRead, false);
});

test('strict DynamoDB writes require absence on creation and matching version on updates', async () => {
  const requests = [];
  mock.method(DynamoDBDocumentClient.prototype, 'send', async command => { requests.push(command.input); return {}; });
  await db.putSyncData('_system', 'lesson:test', { name: 'New' }, 0, { strictVersion: true });
  await db.putSyncData('_system', 'lesson:test', { name: 'Edited' }, 3, { strictVersion: true });
  assert.equal(requests[0].ConditionExpression, 'attribute_not_exists(version)');
  assert.equal(requests[1].ConditionExpression, 'version = :v');
  assert.equal(requests[1].ExpressionAttributeValues[':v'], 3);
  assert.equal(requests[1].Item.version, 4);
});
