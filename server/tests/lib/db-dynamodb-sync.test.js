/**
 * DynamoDB sync-data read/delete paths (PR-8) against an in-memory fake
 * DocumentClient. The fake evaluates the KeyCondition / FilterExpression
 * shapes the adapter sends, and records concurrency so the bulk read can
 * prove it never fans out unbounded.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PutCommand, QueryCommand, ScanCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const { default: db, setDocumentClientForTests } = await import('../../src/lib/db-dynamodb.js');

const keyOf = (userId, dataKey) => `${userId}\0${dataKey}`;

class FakeSyncDoc {
  constructor() {
    this.sync = new Map();
    this.users = [];
    this.calls = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  seedUser(userId) { this.users.push({ userId, role: 'user' }); }

  seed(userId, dataKey, data) {
    this.sync.set(keyOf(userId, dataKey), { userId, dataKey, data, version: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
  }

  async send(cmd) {
    this.calls.push(cmd);
    const input = cmd.input;
    if (cmd instanceof PutCommand) {
      this.seed(input.Item.userId, input.Item.dataKey, input.Item.data);
      return {};
    }
    if (cmd instanceof ScanCommand) {
      return { Items: this.users.map(u => ({ ...u })) };
    }
    if (cmd instanceof QueryCommand) {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      this.inFlight--;
      const values = input.ExpressionAttributeValues || {};
      const userId = values[':uid'];
      let items = [...this.sync.values()].filter(i => i.userId === userId);
      if (input.KeyConditionExpression?.includes('begins_with')) {
        items = items.filter(i => i.dataKey.startsWith(values[':p']));
      }
      if (input.FilterExpression?.includes('begins_with')) {
        const prefixes = Object.entries(values)
          .filter(([name]) => name.startsWith(':ex'))
          .map(([, v]) => v);
        if (input.FilterExpression.includes('NOT')) {
          items = items.filter(i => !prefixes.some(p => i.dataKey.startsWith(p)));
        }
      }
      if (input.ProjectionExpression) {
        items = items.map(i => ({ userId: i.userId, dataKey: i.dataKey }));
      }
      return { Items: items.map(i => ({ ...i })) };
    }
    if (cmd instanceof BatchWriteCommand) {
      for (const requests of Object.values(input.RequestItems)) {
        assert.ok(requests.length <= 25, 'BatchWrite chunk must not exceed 25');
        for (const req of requests) {
          this.sync.delete(keyOf(req.DeleteRequest.Key.userId, req.DeleteRequest.Key.dataKey));
        }
      }
      return {};
    }
    throw new Error(`unexpected command ${cmd.constructor.name}`);
  }
}

describe('db-dynamodb sync reads and deletes (PR-8)', () => {
  let fake;
  beforeEach(() => {
    fake = new FakeSyncDoc();
    setDocumentClientForTests(fake);
  });

  it('getAllSyncData excludes prefixes via a NOT begins_with filter', async () => {
    fake.seed('u1', 'profile', { name: 'A' });
    fake.seed('u1', 'screenshot:s1', 'data:image/jpeg;base64,abc');
    fake.seed('u1', 'userMeta:plugin', { note: 'x' });
    const items = await db.getAllSyncData('u1', { excludePrefixes: ['screenshot:', 'userMeta:'] });
    assert.deepEqual(items.map(i => i.dataKey), ['profile']);
    const query = fake.calls.find(c => c instanceof QueryCommand);
    assert.match(query.input.FilterExpression, /NOT/);
    assert.match(query.input.FilterExpression, /begins_with/);
  });

  it('getAllSyncData without options returns every row', async () => {
    fake.seed('u1', 'profile', {});
    fake.seed('u1', 'screenshot:s1', 'x');
    const items = await db.getAllSyncData('u1');
    assert.equal(items.length, 2);
  });

  it('bulk prefix read covers all users with bounded concurrency and no Scan of sync data', async () => {
    for (let n = 1; n <= 6; n++) {
      fake.seedUser(`u${n}`);
      fake.seed(`u${n}`, 'lessonKB:l1', { status: 'completed' });
      fake.seed(`u${n}`, 'screenshot:s1', 'big');
    }
    const items = await db.getSyncDataByPrefixForAllUsers('lessonKB:');
    assert.equal(items.length, 6);
    assert.ok(items.every(i => i.dataKey.startsWith('lessonKB:')));
    assert.ok(fake.maxInFlight <= 4, `concurrency ${fake.maxInFlight} exceeds 4`);
    assert.ok(fake.maxInFlight > 1, 'bulk read should still parallelise');
    const scans = fake.calls.filter(c => c instanceof ScanCommand);
    assert.ok(scans.every(c => c.input.TableName !== 'plato-sync-data' && !String(c.input.TableName).includes('sync')));
  });

  it('deleteAllSyncData removes every row for one user in BatchWrite chunks', async () => {
    for (let n = 0; n < 30; n++) fake.seed('u1', `messages:l${n}`, []);
    fake.seed('u2', 'messages:l0', []);
    await db.deleteAllSyncData('u1');
    assert.equal([...fake.sync.values()].filter(i => i.userId === 'u1').length, 0);
    assert.equal([...fake.sync.values()].filter(i => i.userId === 'u2').length, 1);
    const batches = fake.calls.filter(c => c instanceof BatchWriteCommand);
    assert.ok(batches.length >= 2, '30 rows need at least two BatchWrite chunks');
  });
});
