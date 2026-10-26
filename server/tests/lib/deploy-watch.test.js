import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeployment, runDeploymentWatch } from '../../../scripts/deploy-watch.js';

const SHA = 'a'.repeat(40), OLD = 'b'.repeat(40), NEXT = 'c'.repeat(40);
const NOW = Date.parse('2026-10-26T08:00:00Z');
const ago = minutes => new Date(NOW - minutes * 60000).toISOString();
const scope = { projectId: 'idk-4e9b9', region: 'us-east1', service: 'plato-shaped' };
const main = { sha: SHA, committedAt: ago(10) };
const health = { sha: OLD, revision: 'plato-shaped-00041-skw' };
const build = (status, overrides = {}) => ({
  id: 'build-1', name: 'projects/idk-4e9b9/locations/us-east1/builds/build-1', projectId: 'idk-4e9b9',
  status, createTime: ago(9), finishTime: ['SUCCESS', 'FAILURE'].includes(status) ? ago(6) : undefined,
  substitutions: { _SHA: SHA, _SERVICE: 'plato-shaped', _REGION: 'us-east1' }, ...overrides,
});
const evaluate = overrides => evaluateDeployment({ ...scope, now: NOW, main, health, builds: [], ...overrides });

// These cases catch missed-event false greens and alerts during ordinary releases.
for (const { name, input, status, exitCode } of [
  { name: 'matching production is healthy without relying on a recent build', input: { health: { ...health, sha: SHA } }, status: 'healthy', exitCode: 0 },
  { name: 'a newly merged commit gets five minutes for a build to appear', input: { main: { ...main, committedAt: ago(4) } }, status: 'awaiting_build', exitCode: 0 },
  { name: 'missing webhook is reported once startup grace expires', input: { main: { ...main, committedAt: ago(5) } }, status: 'missing_build', exitCode: 2 },
  { name: 'running builds are allowed to finish', input: { builds: [build('WORKING')] }, status: 'building', exitCode: 0 },
  { name: 'queued builds cannot suppress alerts indefinitely', input: { builds: [build('QUEUED', { createTime: ago(30) })] }, status: 'build_stalled', exitCode: 2 },
  { name: 'pending approval also has a deadline', input: { builds: [build('PENDING', { createTime: ago(31) })] }, status: 'build_stalled', exitCode: 2 },
  { name: 'a failed build explains stale production', input: { builds: [build('FAILURE')] }, status: 'build_failed', exitCode: 2 },
  { name: 'a successful build gets a bounded rollout grace', input: { builds: [build('SUCCESS', { finishTime: ago(2) })] }, status: 'rolling_out', exitCode: 0 },
  { name: 'successful build with an old serving commit is an alert', input: { builds: [build('SUCCESS')] }, status: 'deployment_stale', exitCode: 2 },
  { name: 'a newer recovery attempt supersedes an older failure', input: { builds: [build('WORKING', { createTime: ago(1) }), build('FAILURE')] }, status: 'building', exitCode: 0 },
  { name: 'a build for another service does not explain this deployment', input: { builds: [build('WORKING', { substitutions: { _SHA: SHA, _SERVICE: 'elsewhere', _REGION: 'us-east1' } })] }, status: 'missing_build', exitCode: 2 },
  { name: 'a build for an older SHA does not suppress a missing build', input: { builds: [build('WORKING', { substitutions: { _SHA: OLD, _SERVICE: 'plato-shaped', _REGION: 'us-east1' } })] }, status: 'missing_build', exitCode: 2 },
]) {
  test(name, () => {
    const result = evaluate(input);
    assert.equal(result.status, status);
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.expectedCommit, SHA);
  });
}

for (const [name, input] of [
  ['invalid main SHA', { main: { ...main, sha: 'unknown' } }],
  ['zero main SHA', { main: { ...main, sha: '0'.repeat(40) } }],
  ['future main time', { main: { ...main, committedAt: ago(-5) } }],
  ['invalid main time', { main: { ...main, committedAt: 'not-a-date' } }],
  ['unknown serving identity', { health: { ...health, sha: 'unknown' } }],
  ['unknown matching build status', { builds: [build('STATUS_UNKNOWN')] }],
  ['malformed matching build time', { builds: [build('WORKING', { createTime: 'broken' })] }],
  ['missing successful build finish time', { builds: [build('SUCCESS', { finishTime: undefined })] }],
  ['future successful build finish time', { builds: [build('SUCCESS', { finishTime: ago(-5) })] }],
]) test(`${name} cannot yield a deployment verdict`, () => assert.throws(() => evaluate(input)));

function upstream({ builds = [build('SUCCESS')], secondMain = SHA, githubStatus = 200, healthStatus = 200,
  healthSha = SHA, pages, onRequest } = {}) {
  let mainReads = 0, buildReads = 0;
  return async (input, options = {}) => {
    const url = new URL(input);
    onRequest?.(url, options);
    assert.equal(options.method || 'GET', 'GET', 'monitor must not write to any API');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.hostname === 'api.github.com') {
      assert.equal(url.pathname, '/repos/henryperkins/googleplato/commits/main');
      assert.equal(new Headers(options.headers).has('authorization'), false);
      const sha = ++mainReads === 1 ? SHA : secondMain;
      return Response.json({ sha, commit: { committer: { date: ago(10) } } }, { status: githubStatus });
    }
    if (url.hostname === 'cloudbuild.googleapis.com') {
      assert.equal(url.pathname, '/v1/projects/idk-4e9b9/locations/us-east1/builds');
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-only-token');
      assert.match(url.searchParams.get('filter'), /^create_time>=/);
      return Response.json(pages ? pages[buildReads++] : { builds });
    }
    assert.equal(url.href, 'https://plato-shaped.ai.studio/v1/health');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    return Response.json({ status: 'ok' }, { status: healthStatus,
      headers: { 'x-plato-commit': healthSha, 'x-plato-revision': health.revision } });
  };
}
const run = options => runDeploymentWatch({ env: {}, now: () => NOW, getAccessToken: async () => 'test-only-token', ...options });

test('runner reports actual identity and scopes credentials to the Google API', async () => {
  const result = await run({ fetchImpl: upstream() });
  assert.equal(result.event, 'deployment_watch');
  assert.equal(result.status, 'healthy');
  assert.equal(result.servedCommit, SHA);
  assert.equal(result.revision, 'plato-shaped-00041-skw');
});

test('a main update during the scan is deferred instead of called stale or healthy', async () => {
  const result = await run({ fetchImpl: upstream({ secondMain: NEXT }) });
  assert.equal(result.status, 'main_changed');
  assert.equal(result.exitCode, 0);
});

test('missing build detection follows empty pages with a next token', async () => {
  const result = await run({ fetchImpl: upstream({ healthSha: OLD, pages: [
    { nextPageToken: 'page-two' }, { builds: [build('WORKING')] },
  ] }) });
  assert.equal(result.status, 'building');
});

test('pagination keeps a fixed query window even while the clock advances', async () => {
  const filters = [];
  let time = NOW;
  const result = await run({ now: () => time++, fetchImpl: upstream({ pages: [
    { nextPageToken: 'page-two' }, { builds: [build('SUCCESS')] },
  ], onRequest: url => { if (url.hostname === 'cloudbuild.googleapis.com') filters.push(url.searchParams.get('filter')); } }) });
  assert.equal(result.status, 'healthy');
  assert.equal(filters.length, 2);
  assert.equal(filters[0], filters[1]);
});

for (const [name, fetchImpl] of [
  ['GitHub rate limit', upstream({ githubStatus: 403 })],
  ['unhealthy HTTP response', upstream({ healthStatus: 503 })],
  ['missing serving header', upstream({ healthSha: '' })],
  ['malformed build list', upstream({ pages: [{ builds: {} }] })],
  ['malformed build entry', upstream({ pages: [{ builds: [null] }] })],
  ['repeated page token', upstream({ pages: [{ nextPageToken: 'same' }, { nextPageToken: 'same' }] })],
  ['too many pages', upstream({ pages: Array.from({ length: 12 }, (_, i) => ({ nextPageToken: `p-${i}` })) })],
  ['network failure', async () => { throw new Error('private upstream error detail'); }],
]) test(`${name} is a monitoring failure, never a missing-build finding`, async () => {
  const result = await run({ fetchImpl });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.exitCode, 1);
  assert.equal(result.severity, 'ERROR');
  assert.ok(!JSON.stringify(result).includes('private upstream'));
});

test('unavailable Google credentials cannot produce a green report', async () => {
  const result = await run({ fetchImpl: upstream(), getAccessToken: async () => { throw new Error('token-private'); } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.exitCode, 1);
  assert.ok(!JSON.stringify(result).includes('token-private'));
});

test('an ambient SDK project cannot silently retarget the deployment monitor', async () => {
  const result = await run({ env: { GOOGLE_CLOUD_PROJECT: 'unrelated-project' }, fetchImpl: upstream() });
  assert.equal(result.projectId, 'idk-4e9b9');
  assert.equal(result.status, 'healthy');
});

test('unsafe configuration is rejected before any outbound request', async () => {
  let calls = 0;
  const result = await run({ env: { DEPLOY_WATCH_HEALTH_URL: 'https://user:password@example.com/health' },
    fetchImpl: async () => { calls++; throw new Error(); } });
  assert.equal(result.status, 'incomplete');
  assert.equal(calls, 0);
});

test('an aborted scan cannot hang on an uncooperative credential provider', async () => {
  const controller = new AbortController();
  const promise = run({ fetchImpl: upstream(), signal: controller.signal,
    getAccessToken: () => new Promise(() => {}) });
  setTimeout(() => controller.abort(), 10);
  const result = await promise;
  assert.equal(result.status, 'incomplete');
  assert.equal(result.exitCode, 1);
});
