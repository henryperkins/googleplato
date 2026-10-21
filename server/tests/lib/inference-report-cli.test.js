import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../../../scripts/inference-report.js', import.meta.url);
test('read-only CLI reports unpriced abandoned work and fails closed on incomplete reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-inference-'));
  try {
    const file = join(dir, 'logs.json');
    const scan = { complete: true, since: '2026-10-19T00:00:00Z', until: '2026-10-21T12:00:00Z', entries: [{
      ts: '2026-10-20T00:00:00Z', code: 'inference_started', meta: {
        schema_version: 1, inference_id: 'one', provider: 'bedrock', model: 'qwen3-vl-235b', attempt_ref: 'attempt', agent_role: 'coach',
      },
    }] };
    writeFileSync(file, JSON.stringify(scan));
    const run = () => spawnSync(process.execPath, [script.pathname, '--input', file], { encoding: 'utf8' });
    const partial = run();
    assert.equal(partial.status, 2, partial.stderr);
    const report = JSON.parse(partial.stdout);
    assert.equal(report.total.estimated_cost_usd, null);
    assert.equal(report.attempts[0].status, 'abandoned');
    writeFileSync(file, JSON.stringify({ ...scan, complete: false, error: 'permission denied' }));
    const failure = run();
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /incomplete/i);
    writeFileSync(file, JSON.stringify({ ...scan, entries: [] }));
    assert.equal(run().status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
