import { after, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

const directory = await mkdtemp(join(tmpdir(), 'plato-branding-race-'));
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = join(directory, 'test.sqlite');
const { default: db } = await import('../../src/lib/db.js');
const { default: admin } = await import('../../src/routes/admin.js');
const { default: content } = await import('../../src/routes/content.js');
const { signAccessToken } = await import('../../src/lib/jwt.js');
const app = new Hono();
app.route('/', admin);
app.route('/', content);
await db.createUser({ userId: 'admin', email: 'branding@example.test', username: 'branding', passwordHash: 'unused', role: 'admin' });
const token = await signAccessToken('admin', 'admin');
const svg = color => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="${color}"/></svg>`).toString('base64')}`;
const put = body => app.request('/v1/admin/theme', { method: 'PUT', headers: {
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
}, body: JSON.stringify(body) });
const branding = async () => (await app.request('/v1/branding')).json();

beforeEach(async () => {
  await db.deleteAllSyncData('_system');
  await db.deleteAllSyncData('_branding');
});
after(() => rm(directory, { recursive: true, force: true }));

it('restoring a previous logo cannot race with deletion from an earlier save', async () => {
  assert.equal((await put({ logoBase64: svg('red') })).status, 200);
  const original = await branding();
  let reached;
  let release;
  const atDelete = { promise: new Promise(resolve => { reached = resolve; }), resolve: () => reached() };
  const releaseDelete = { promise: new Promise(resolve => { release = resolve; }), resolve: () => release() };
  const remove = db.deleteSyncData;
  let intercepted = false;
  db.deleteSyncData = async (owner, key, ...rest) => {
    if (!intercepted && owner === '_branding' && key.endsWith(original.logoUrl.split('/').pop())) {
      intercepted = true;
      atDelete.resolve();
      await releaseDelete.promise;
    }
    return remove(owner, key, ...rest);
  };
  try {
    const replace = put({ logoBase64: svg('blue') });
    // The fixed implementation finishes atomically; the old implementation
    // reaches a separate deletion that another request can overtake.
    await Promise.race([atDelete.promise, replace]);
    assert.equal((await put({ logoBase64: svg('red') })).status, 200);
    releaseDelete.resolve();
    assert.equal((await replace).status, 200);
    assert.equal((await branding()).logoUrl, original.logoUrl);
    assert.equal((await app.request(original.logoUrl)).status, 200);
  } finally {
    releaseDelete.resolve();
    db.deleteSyncData = remove;
  }
});

it('a failed asset write rolls back settings and keeps the old asset', async () => {
  assert.equal((await put({ logoBase64: svg('red') })).status, 200);
  const original = await branding();
  const connection = new Database(process.env.SQLITE_PATH);
  connection.exec("CREATE TRIGGER fail_logo BEFORE INSERT ON sync_data WHEN NEW.userId = '_branding' BEGIN SELECT RAISE(ABORT, 'test asset failure'); END");
  try {
    assert.equal((await put({ logoBase64: svg('blue') })).status, 500);
    assert.deepEqual(await branding(), original);
    assert.equal((await app.request(original.logoUrl)).status, 200);
    assert.equal((await db.getAllSyncData('_branding')).length, 1);
  } finally {
    connection.exec('DROP TRIGGER fail_logo');
    connection.close();
  }
});

it('a failed settings write leaves no unpublished asset behind', async () => {
  assert.equal((await put({ logoBase64: svg('red') })).status, 200);
  const original = await branding();
  const connection = new Database(process.env.SQLITE_PATH);
  connection.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON sync_data WHEN NEW.userId = '_system' BEGIN SELECT RAISE(ABORT, 'test settings failure'); END");
  try {
    assert.equal((await put({ logoBase64: svg('blue') })).status, 500);
    assert.deepEqual(await branding(), original);
    assert.equal((await app.request(original.logoUrl)).status, 200);
    assert.equal((await db.getAllSyncData('_branding')).length, 1);
  } finally {
    connection.exec('DROP TRIGGER fail_settings');
    connection.close();
  }
});

it('logo clients must revalidate both ordinary and conditional responses', async () => {
  assert.equal((await put({ logoBase64: svg('red') })).status, 200);
  const { logoUrl } = await branding();
  const response = await app.request(logoUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-cache/);
  const headers = { 'If-None-Match': response.headers.get('etag') };
  const cached = await app.request(logoUrl, { headers });
  assert.equal(cached.status, 304);
  assert.match(cached.headers.get('cache-control'), /no-cache/);
  assert.equal((await put({ logoBase64: null })).status, 200);
  const removed = await app.request(logoUrl, { headers });
  assert.equal(removed.status, 404);
  assert.equal(removed.headers.get('cache-control'), 'no-store');
});
