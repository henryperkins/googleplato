import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const preload = fileURLToPath(new URL('../helpers/migration-cli-fault-preload.js', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/migrate.js', import.meta.url));
function invoke(target, apply) {
  return spawnSync(process.execPath, ['--import', preload, script, ...(apply ? ['--apply'] : [])], {
    encoding: 'utf8',
    env: { ...process.env, DB_BACKEND: 'sqlite', SQLITE_PATH: ':memory:', PLATO_REQUIRE_RC232: '1', PLATO_TEST_MARKER_FAULT: target },
  });
}
for (const target of ['m003_role_learner', 'm004_default_program']) {
  test(`CLI apply fails closed when marker ${target} repeatedly conflicts`, () => {
    const result = invoke(target, true);
    assert.ifError(result.error);
    assert.match(result.stderr, new RegExp(`PROBE marker-conflict ${target} attempt=1`), 'fault must be reached');
    assert.equal(result.status, 1, `expected failure after injected marker conflict; stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, new RegExp(`PROBE marker-conflict ${target} attempt=2`), 'runner retries one conflict');
    assert.match(result.stderr, /Migration state failure/);
    assert.doesNotMatch(result.stderr, /"migration":"m005_name_split"/);
  });
  test(`CLI dry run succeeds with marker ${target} fault armed`, () => {
    const result = invoke(target, false);
    assert.ifError(result.error);
    assert.match(result.stderr, new RegExp(`PROBE armed ${target}`));
    assert.doesNotMatch(result.stderr, /PROBE marker-conflict/);
    assert.equal(result.status, 0, `dry run failed; stdout=${result.stdout}\nstderr=${result.stderr}`);
  });
}
