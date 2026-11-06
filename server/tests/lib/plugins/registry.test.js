import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../../../src/lib/plugins/registry.js';
import ai, { LLM } from '../../../src/lib/ai-provider.js';

const origWarn = console.warn;
console.warn = () => {};
after(() => { console.warn = origWarn; });

describe('buildContext — narrowed user view', () => {
  it('normalizes legacy roles and stale split-name records for single and list reads', async () => {
    const legacy = {
      userId: 'usr_legacy', email: 'legacy@example.test', role: 'user',
      firstName: 'Stale', lastName: 'Record', name: 'Current Name', nameSource: 'user',
    };
    const registry = {
      _db: {
        getUserById: async () => legacy,
        listAllUsers: async () => [legacy],
      },
    };
    const ctx = buildContext('test-plugin', {}, registry);
    for (const user of [await ctx.db.getUserById('usr_legacy'), ...(await ctx.db.listAllUsers())]) {
      assert.equal(user.role, 'learner');
      assert.deepEqual(
        [user.firstName, user.lastName, user.name, user.nameSource],
        ['Current', 'Name', 'Current Name', 'auto'],
      );
      assert.equal(user.email, legacy.email);
      assert.notStrictEqual(user, legacy, 'the raw adapter record is not mutated or exposed');
    }
  });
});

describe('buildContext — ctx.ai and ctx.LLM', () => {
  it('provides ctx.ai as the host ai provider instance', () => {
    const ctx = buildContext('test-plugin', {});
    assert.strictEqual(ctx.ai, ai, 'ctx.ai must be the same instance the host uses');
    assert.equal(typeof ctx.ai.invoke, 'function', 'ctx.ai must expose invoke()');
  });

  it('provides ctx.LLM matching the host LLM constant', () => {
    const ctx = buildContext('test-plugin', {});
    assert.strictEqual(ctx.LLM, LLM, 'ctx.LLM must match the host LLM constant');
    assert.equal(typeof ctx.LLM, 'string', 'ctx.LLM must be a string model identifier');
  });
});
