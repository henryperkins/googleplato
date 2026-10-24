/**
 * DynamoDB adapter token tests (SEC-2, SEC-3) against an in-memory fake
 * DocumentClient. The fake honours ConditionExpression on deletes the way
 * DynamoDB does, and records every command so tests can pin that consume is
 * a single conditional delete — not a get-then-delete race.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const { default: db, setDocumentClientForTests } = await import('../../src/lib/db-dynamodb.js');

function conditionalError() {
  return Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });
}

class FakeDoc {
  constructor() {
    this.items = new Map();
    this.calls = [];
    this.indexAvailable = true;
  }

  async send(cmd) {
    this.calls.push(cmd);
    const input = cmd.input;
    if (cmd instanceof PutCommand) {
      this.items.set(input.Item.tokenHash, { ...input.Item });
      return {};
    }
    if (cmd instanceof GetCommand) {
      const item = this.items.get(input.Key.tokenHash);
      return item ? { Item: { ...item } } : {};
    }
    if (cmd instanceof DeleteCommand) {
      const key = input.Key.tokenHash;
      const item = this.items.get(key);
      if (input.ConditionExpression) {
        const values = input.ExpressionAttributeValues || {};
        const wanted = Object.values(values).find((v) => v === 'refresh' || v === 'reset');
        let ok = !!item && item.ttl >= values[':now'];
        if (input.ConditionExpression.includes('attribute_not_exists')) {
          ok = ok && (item.type === undefined || item.type === wanted);
        } else {
          ok = ok && item.type === wanted;
        }
        if (!ok) throw conditionalError();
        this.items.delete(key);
        return { Attributes: { ...item } };
      }
      this.items.delete(key);
      return {};
    }
    if (cmd instanceof QueryCommand) {
      if (!this.indexAvailable) {
        throw Object.assign(new Error('no such index'), { name: 'ValidationException' });
      }
      const userId = input.ExpressionAttributeValues[':userId'];
      return { Items: [...this.items.values()].filter((i) => i.userId === userId).map((i) => ({ tokenHash: i.tokenHash })) };
    }
    if (cmd instanceof ScanCommand) {
      const userId = input.ExpressionAttributeValues[':userId'];
      return { Items: [...this.items.values()].filter((i) => i.userId === userId) };
    }
    if (cmd instanceof BatchWriteCommand) {
      for (const requests of Object.values(input.RequestItems)) {
        for (const req of requests) this.items.delete(req.DeleteRequest.Key.tokenHash);
      }
      return {};
    }
    throw new Error(`unexpected command ${cmd.constructor.name}`);
  }
}

describe('db-dynamodb tokens (SEC-2, SEC-3)', () => {
  let fake;
  beforeEach(() => {
    fake = new FakeDoc();
    setDocumentClientForTests(fake);
  });

  it('stores refresh type and rejects a reset token as refresh', async () => {
    await db.storeRefreshToken('h_refresh', 'usr_1');
    await db.storeResetToken('h_reset', 'usr_1');
    assert.equal(fake.items.get('h_refresh').type, 'refresh');
    assert.equal((await db.getRefreshToken('h_refresh')).userId, 'usr_1');
    assert.equal(await db.getRefreshToken('h_reset'), null);
    assert.equal(await db.consumeRefreshToken('h_reset'), null);
  });

  it('treats a legacy item with no type as refresh, and rejects expired', async () => {
    const now = Math.floor(Date.now() / 1000);
    fake.items.set('h_legacy', { tokenHash: 'h_legacy', userId: 'usr_1', ttl: now + 3600 });
    fake.items.set('h_expired', { tokenHash: 'h_expired', userId: 'usr_1', type: 'refresh', ttl: now - 5 });
    fake.items.set('h_exp_reset', { tokenHash: 'h_exp_reset', userId: 'usr_1', type: 'reset', ttl: now - 5 });
    assert.equal((await db.getRefreshToken('h_legacy')).userId, 'usr_1');
    assert.equal(await db.getRefreshToken('h_expired'), null);
    assert.equal(await db.getResetToken('h_exp_reset'), null);
    assert.equal((await db.consumeRefreshToken('h_legacy')).userId, 'usr_1');
  });

  it('consume is one conditional delete and succeeds exactly once', async () => {
    await db.storeRefreshToken('h_once', 'usr_1');
    fake.calls = [];
    const first = await db.consumeRefreshToken('h_once');
    assert.equal(first.userId, 'usr_1');
    const deletes = fake.calls.filter((c) => c instanceof DeleteCommand);
    assert.equal(deletes.length, 1);
    assert.ok(deletes[0].input.ConditionExpression);
    assert.equal(deletes[0].input.ReturnValues, 'ALL_OLD');
    assert.equal(fake.calls.filter((c) => c instanceof GetCommand).length, 0);
    assert.equal(await db.consumeRefreshToken('h_once'), null);
  });

  it('revokes by user via the GSI, falling back to scan', async () => {
    await db.storeRefreshToken('h_a', 'usr_x');
    await db.storeResetToken('h_b', 'usr_x');
    await db.storeRefreshToken('h_keep', 'usr_y');
    await db.revokeUserTokens('usr_x');
    assert.equal(await db.getRefreshToken('h_a'), null);
    assert.equal(await db.getResetToken('h_b'), null);
    assert.equal((await db.getRefreshToken('h_keep')).userId, 'usr_y');

    await db.storeRefreshToken('h_c', 'usr_x');
    fake.indexAvailable = false;
    await db.revokeUserTokens('usr_x');
    assert.equal(await db.getRefreshToken('h_c'), null);
  });
});
