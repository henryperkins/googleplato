import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('production startup refuses ephemeral storage and development credentials before connecting', () => {
  const start = env => spawnSync(process.execPath, ['start.js'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, DB_BACKEND: 'postgres', JWT_SECRET: 'x'.repeat(48), APP_URL: 'https://example.test', ...env },
    encoding: 'utf8', timeout: 5000,
  });
  for (const backend of ['', 'sqlite', 'misspelled']) {
    const result = start({ DB_BACKEND: backend });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production requires DB_BACKEND/);
  }
  const secret = start({ JWT_SECRET: 'dev-secret' });
  assert.equal(secret.status, 1);
  assert.match(secret.stderr, /stable JWT_SECRET/);
  const origin = start({ APP_URL: 'http://localhost:3000' });
  assert.equal(origin.status, 1);
  assert.match(origin.stderr, /HTTPS APP_URL/);
});

for (const entrypoint of ['start.js', 'dev.js', 'dev-sqlite.js', 'src/index.js']) {
  test(`${entrypoint} rejects an invalid compatibility epoch before serving or bootstrapping data`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'plato-invalid-epoch-'));
    const sqlitePath = join(directory, 'must-not-exist.db');
    try {
      const args = entrypoint === 'src/index.js'
        ? ['--input-type=module', '-e', 'globalThis.awslambda = { streamifyResponse: handler => handler }; await import("./src/index.js");']
        : [entrypoint];
      const result = spawnSync(process.execPath, args, {
        cwd: new URL('../../', import.meta.url),
        env: { ...process.env, CLIENT_COMPATIBILITY_EPOCH: 'invalid epoch!',
          DB_BACKEND: 'dynamodb', DYNAMODB_ENDPOINT: 'http://127.0.0.1:9', SQLITE_PATH: sqlitePath,
          AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1',
          JWT_SECRET: 'x'.repeat(48), APP_URL: 'https://example.test', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', PORT: '0' },
        encoding: 'utf8', timeout: 3000,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid CLIENT_COMPATIBILITY_EPOCH/);
      assert.doesNotMatch(result.stdout, /server_ready|Server running/);
      assert.equal(existsSync(sqlitePath), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
