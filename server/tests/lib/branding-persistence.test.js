import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresDatabase } from '../../src/lib/postgres-database.js';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const first = { hash: 'a'.repeat(64), dataUrl: 'first' };
const second = { hash: 'b'.repeat(64), dataUrl: 'second' };
const conditional = { name: 'ConditionalCheckFailedException' };

async function contract(t, db, other = db) {
  await t.test('replacement, restoration, and removal keep pointers and bytes together', async () => {
    await db.putBrandingSettings({ logoHash: first.hash }, 0, { logo: first });
    await other.putBrandingSettings({ logoHash: second.hash }, 1, { logo: second, previousLogoHash: first.hash });
    assert.equal(await db.getSyncData('_branding', `logo:${first.hash}`), null);
    await db.putBrandingSettings({ logoHash: first.hash }, 2, { logo: first, previousLogoHash: second.hash });
    assert.equal((await other.getSyncData('_branding', `logo:${first.hash}`)).data.dataUrl, 'first');
    assert.equal(await other.getSyncData('_branding', `logo:${second.hash}`), null);
    await db.putBrandingSettings({}, 3, { previousLogoHash: first.hash });
    assert.equal(await other.getSyncData('_branding', `logo:${first.hash}`), null);
  });
  await t.test('stale writes cannot store orphan assets or delete the active asset', async () => {
    await db.putBrandingSettings({ logoHash: first.hash }, 4, { logo: first });
    await assert.rejects(other.putBrandingSettings({ logoHash: second.hash }, 4,
      { logo: second, previousLogoHash: first.hash }), conditional);
    assert.equal((await db.getSyncData('_system', 'settings')).data.logoHash, first.hash);
    assert.equal((await db.getSyncData('_branding', `logo:${first.hash}`)).data.dataUrl, 'first');
    assert.equal(await db.getSyncData('_branding', `logo:${second.hash}`), null);
  });
  await t.test('only one competing initial settings creation succeeds', async () => {
    await db.deleteAllSyncData('_system');
    await db.deleteAllSyncData('_branding');
    const results = await Promise.allSettled([db.putBrandingSettings({ logoHash: first.hash }, 0, { logo: first }),
      other.putBrandingSettings({ logoHash: second.hash }, 0, { logo: second })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.name, conditional.name);
    const current = await db.getSyncData('_system', 'settings');
    assert.ok(await db.getSyncData('_branding', `logo:${current.data.logoHash}`));
    assert.equal((await db.getAllSyncData('_branding')).length, 1);
  });
  await t.test('reusing identical logo content succeeds without duplicate insert failures', async () => {
    const current = await db.getSyncData('_system', 'settings');
    const logo = current.data.logoHash === first.hash ? first : second;
    await db.putBrandingSettings({ logoHash: logo.hash, classroomName: 'Updated' }, current.version,
      { logo, previousLogoHash: logo.hash });
    assert.equal((await other.getSyncData('_branding', `logo:${logo.hash}`)).data.dataUrl, logo.dataUrl);
  });
}

test('SQLite branding transaction', async t => {
  process.env.SQLITE_PATH = ':memory:';
  const { default: db } = await import('../../src/lib/db-sqlite.js');
  await contract(t, db);
});

test('PostgreSQL branding transaction across connections', { skip: !process.env.POSTGRES_TEST_URL }, async t => {
  const schema = `branding_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { connectionString: process.env.POSTGRES_TEST_URL, options: `-c search_path=${schema}`, max: 4 };
  const pool = new pg.Pool(options);
  const otherPool = new pg.Pool(options);
  t.after(async () => {
    await Promise.all([pool.end(), otherPool.end()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const db = await createPostgresDatabase(pool);
  const other = await createPostgresDatabase(otherPool);
  await contract(t, db, other);
  await t.test('a failure after the asset write rolls back all branding changes', async () => {
    const before = await db.getSyncData('_system', 'settings');
    const assets = await db.getAllSyncData('_branding');
    await pool.query(`CREATE FUNCTION fail_branding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id = '_system' THEN RAISE EXCEPTION 'test settings failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_branding BEFORE UPDATE ON sync_data FOR EACH ROW EXECUTE FUNCTION fail_branding()`);
    try {
      const logo = { hash: 'c'.repeat(64), dataUrl: 'third' };
      await assert.rejects(other.putBrandingSettings({ logoHash: logo.hash }, before.version,
        { logo, previousLogoHash: before.data.logoHash }), /test settings failure/);
      assert.deepEqual(await db.getSyncData('_system', 'settings'), before);
      assert.deepEqual(await db.getAllSyncData('_branding'), assets);
    } finally {
      await pool.query('DROP TRIGGER fail_branding ON sync_data; DROP FUNCTION fail_branding()');
    }
  });
});

test('DynamoDB branding is one conditional transaction with safe error mapping', async () => {
  const { default: db, setDocumentClientForTests } = await import('../../src/lib/db-dynamodb.js');
  let command;
  setDocumentClientForTests({ send: async cmd => { command = cmd; return {}; } });
  await db.putBrandingSettings({ logoHash: second.hash }, 7, { logo: second, previousLogoHash: first.hash });
  assert.ok(command instanceof TransactWriteCommand);
  const operations = command.input.TransactItems;
  assert.equal(operations.length, 3);
  const settings = operations.find(item => item.Put?.Item.userId === '_system').Put;
  assert.equal(settings.ConditionExpression, 'version = :v');
  assert.deepEqual(settings.ExpressionAttributeValues, { ':v': 7 });
  assert.equal(settings.Item.version, 8);
  assert.deepEqual(operations.find(item => item.Delete).Delete.Key, { userId: '_branding', dataKey: `logo:${first.hash}` });
  assert.equal(operations.find(item => item.Put?.Item.userId === '_branding').Put.Item.data.dataUrl, 'second');
  await db.putBrandingSettings({ logoHash: first.hash }, 0, { logo: first, previousLogoHash: first.hash });
  assert.equal(command.input.TransactItems.length, 2, 'no Put and Delete targeting the same asset');
  assert.equal(command.input.TransactItems[0].Put.ConditionExpression, 'attribute_not_exists(version)');
  setDocumentClientForTests({ send: async () => { throw Object.assign(new Error('conflict'), {
    name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  }); } });
  await assert.rejects(db.putBrandingSettings({}, 0), conditional);
  const failure = new Error('unavailable');
  setDocumentClientForTests({ send: async () => { throw failure; } });
  await assert.rejects(db.putBrandingSettings({}, 0), error => error === failure);
});
