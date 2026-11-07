import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
globalThis.awslambda = { streamifyResponse: fn => fn };
const { default: db } = await import('../../src/lib/db.js');
const { pluginRegistry } = await import('../../src/lib/plugins/registry.js');
const event = {
  version: '2.0', rawPath: '/v1/health', rawQueryString: '', headers: { host: 'example.test' },
  requestContext: { http: { method: 'GET', path: '/v1/health', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1' } },
};

test('a warm Lambda retries migration initialization and completes seed/plugin boot after failure', async () => {
  const { handler } = await import('../../src/index.js?retry-init');
  const read = db.getSyncData;
  const boot = pluginRegistry.boot;
  let failMigration = true;
  let boots = 0;
  db.getSyncData = async (owner, key, ...args) => {
    if (owner === '_system' && key === 'migrations' && failMigration) { failMigration = false; throw new Error('transient migration read failure'); }
    return read(owner, key, ...args);
  };
  pluginRegistry.boot = async () => {
    assert.ok((await db.getSyncDataByPrefix('_system', 'prompt:')).length, 'seed completes before plugin boot');
    boots++;
  };
  try {
    assert.equal((await handler(event, {})).statusCode, 500);
    assert.equal(boots, 0);
    assert.equal((await handler(event, {})).statusCode, 200);
    assert.ok(await db.getSyncData('_system', 'migrations'), 'migrations retried before serving');
    assert.equal(boots, 1);
    assert.equal((await handler(event, {})).statusCode, 200);
    assert.equal(boots, 1, 'successful initialization is cached');
  } finally { db.getSyncData = read; pluginRegistry.boot = boot; }
});

test('concurrent Lambda requests await the same unfinished initialization', async () => {
  const { handler } = await import('../../src/index.js?concurrent-init');
  const boot = pluginRegistry.boot;
  let bootStarted;
  const started = new Promise(resolve => { bootStarted = resolve; });
  let finishBoot;
  const gate = new Promise(resolve => { finishBoot = resolve; });
  let boots = 0;
  pluginRegistry.boot = async () => { boots++; bootStarted(); await gate; };
  let secondDone = false;
  const first = handler(event, {});
  try {
    await started;
    const second = handler(event, {}).then(result => { secondDone = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondDone, false, 'no concurrent request bypasses pending boot');
    finishBoot();
    assert.deepEqual((await Promise.all([first, second])).map(result => result.statusCode), [200, 200]);
    assert.equal(boots, 1);
  } finally { finishBoot(); await first; pluginRegistry.boot = boot; }
});
