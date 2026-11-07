import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('rehearsal stops before seed and repair writes when migration lock is held', () => {
  const preload = fileURLToPath(new URL('../helpers/rehearsal-write-sentinel.js', import.meta.url));
  const script = fileURLToPath(new URL('../../scripts/rehearse-upgrade.js', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', preload, script, 'local-rehearsal'], { encoding: 'utf8', env: { ...process.env, DB_BACKEND: 'sqlite', SQLITE_PATH: ':memory:', PLATO_REQUIRE_RC232: '1' } });
  assert.ifError(result.error);
  assert.match(result.stderr, /PROBE held lock armed/);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /PROBE unexpected write/);
  assert.match(result.stderr, /migration.*(?:lock|complete)/i);
});
