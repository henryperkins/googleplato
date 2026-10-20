import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, TransactGetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import db from '../../src/lib/db-dynamodb.js';

afterEach(() => mock.restoreAll());

test('DynamoDB reads conversation and progress in one consistent snapshot', async () => {
  mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
    assert.ok(command instanceof TransactGetCommand);
    assert.deepEqual(command.input.TransactItems.map(item => item.Get.Key), [
      { userId: 'learner', dataKey: 'messages:lesson' }, { userId: 'learner', dataKey: 'lessonKB:lesson' },
      { userId: 'learner', dataKey: 'lessonGeneration:lesson' },
    ]);
    return { Responses: [{ Item: { data: [{ content: 'Saved' }], version: 3 } }, {}, { Item: { data: 'reset-1' } }] };
  });
  assert.deepEqual(await db.getLessonState('learner', 'lesson'), {
    generation: 'reset-1', messages: { data: [{ content: 'Saved' }], version: 3 }, lessonKB: { data: null, version: 0 },
  });
});

test('DynamoDB atomically guards both old values and versions, and requires absence for creation', async () => {
  const base = { generation: 'reset-1', messages: { data: [], version: 0 }, lessonKB: { data: { progress: 2 }, version: 3 } };
  mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
    assert.ok(command instanceof TransactWriteCommand);
    const [messages, kb] = command.input.TransactItems.map(item => item.Put);
    assert.equal(messages.ConditionExpression, 'attribute_not_exists(version)');
    assert.equal(kb.ConditionExpression, 'version = :v AND #data = :previous');
    assert.equal(kb.ExpressionAttributeValues[':v'], 3);
    assert.deepEqual(kb.ExpressionAttributeValues[':previous'], { progress: 2 });
    assert.equal(messages.Item.userId, 'learner');
    assert.equal(kb.Item.userId, 'learner');
    const marker = command.input.TransactItems[2].ConditionCheck;
    assert.equal(marker.Key.dataKey, 'lessonGeneration:lesson');
    assert.equal(marker.ExpressionAttributeValues[':generation'], 'reset-1');
    return {};
  });
  const saved = await db.commitLessonTurn('learner', 'lesson', base, { messages: [{ content: 'Generated' }], lessonKB: { progress: 6 } });
  assert.equal(saved.messages.version, 1);
  assert.equal(saved.lessonKB.version, 4);
});

test('DynamoDB conditional conflicts are recoverable but capacity failures remain failures', async () => {
  const base = { generation: null, messages: { data: [], version: 0 }, lessonKB: { data: null, version: 0 } };
  let reason = 'ConditionalCheckFailed';
  mock.method(DynamoDBDocumentClient.prototype, 'send', async () => {
    throw Object.assign(new Error('Transaction failed'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: reason }] });
  });
  await assert.rejects(db.commitLessonTurn('learner', 'lesson', base, {}), { name: 'ConditionalCheckFailedException' });
  reason = 'ProvisionedThroughputExceeded';
  await assert.rejects(db.commitLessonTurn('learner', 'lesson', base, {}), { name: 'TransactionCanceledException' });
});

test('DynamoDB reset deletes the record and rotates its durable generation in one transaction', async () => {
  mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
    assert.ok(command instanceof TransactWriteCommand);
    const [deletion, marker] = command.input.TransactItems;
    assert.deepEqual(deletion.Delete.Key, { userId: 'learner', dataKey: 'messages:lesson' });
    assert.equal(marker.Put.Item.dataKey, 'lessonGeneration:lesson');
    assert.equal(typeof marker.Put.Item.data, 'string');
    return {};
  });
  await db.deleteSyncData('learner', 'messages:lesson', { invalidateLesson: true });
});
