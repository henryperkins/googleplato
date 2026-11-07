import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../scripts/migrate.js';

function fakeDb(state, { failMarker = false } = {}) {
  let row = state ? { data: structuredClone(state), version: 1 } : null;
  return {
    async getSyncData() { return structuredClone(row); },
    async createSyncData(user, key, data) { row = { data: structuredClone(data), version: 1 }; },
    async putSyncData(user, key, data) { if (failMarker && Object.keys(data.applied).length) throw new Error('marker storage failed'); row = { data: structuredClone(data), version: row.version + 1 }; },
    async listAllUsers() { return []; },
    async getAllSyncData() { return []; },
  };
}
test('migrate apply fails on a held lock', async () => {
  assert.equal(await main({ db: fakeDb({ applied: {}, lock: { owner: 'other', until: Date.now() + 60000 } }), argv: ['--apply'] }), 1);
});
test('migrate apply fails on a marker storage fault', async () => {
  assert.equal(await main({ db: fakeDb(null, { failMarker: true }), argv: ['--apply'] }), 1);
});
test('migrate dry run succeeds without lock verification', async () => {
  assert.equal(await main({ db: fakeDb({ applied: {}, lock: { owner: 'other', until: Date.now() + 60000 } }), argv: [] }), 0);
});

for (const outcome of [
  { ran: [], skipped: 'locked' },
  { ran: [], skipped: 'lost_race' },
  { ran: [], skipped: 'unexpected' },
  { ran: [{ id: 'failed', result: { scanned: 1, updated: 0, skipped: 0, errors: 1 } }], skipped: null },
  null,
]) test(`migrate apply rejects unverified outcome ${outcome?.skipped || (outcome ? 'errors' : 'missing')}`, async () => {
  assert.equal(await main({ db: fakeDb(null), argv: ['--apply'], migrate: async () => outcome }), 1);
});
