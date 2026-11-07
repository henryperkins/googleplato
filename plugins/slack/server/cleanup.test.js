import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
const { default: plugin } = await import('./index.js');
const { default: db } = await import('../../../server/src/lib/db.js');

test('Slack declares metadata capabilities and uninstalls only its own user records', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url)));
  assert.ok(manifest.capabilities.includes('user.metadata.read'));
  assert.ok(manifest.capabilities.includes('user.metadata.write'));
  await db.createUser({ userId: 'usr_cleanup', email: 'cleanup@example.test', name: 'Synthetic', passwordHash: 'hash', role: 'learner' });
  await db.putSyncData('usr_cleanup', 'userMeta:slack', { autoInvite: { status: 'failed' } });
  await db.putSyncData('usr_cleanup', 'userMeta:other', { keep: true });
  await plugin.onUninstall({ pluginId: 'slack' });
  assert.equal(await db.getSyncData('usr_cleanup', 'userMeta:slack'), null);
  assert.deepEqual((await db.getSyncData('usr_cleanup', 'userMeta:other')).data, { keep: true });
});
