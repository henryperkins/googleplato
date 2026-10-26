#!/usr/bin/env node
// Read-only deployment reconciliation, independent of GitHub push delivery.
// See docs/DEPLOYMENT_WATCH.md. This process cannot submit or replay a deploy.
import { pathToFileURL } from 'node:url';

const SHA = /^(?!0{40}$)[a-f0-9]{40}$/;
const ACTIVE = new Set(['PENDING', 'QUEUED', 'WORKING']);
const FAILED = new Set(['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);
const MINUTE = 60000;

class WatchError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireValue(condition, code) {
  if (!condition) throw new WatchError(code);
}
function timestamp(value, now) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  requireValue(Number.isFinite(time) && time <= now + MINUTE, 'invalid_timestamp');
  return time;
}
function validateMain(main, now) {
  requireValue(SHA.test(main?.sha), 'invalid_main');
  return timestamp(main.committedAt, now);
}

export function evaluateDeployment({ main, health, builds, projectId, region, service, now = Date.now() }) {
  const committedAt = validateMain(main, now);
  requireValue(SHA.test(health?.sha) && typeof health.revision === 'string'
    && health.revision.startsWith(`${service}-`) && /^[a-z0-9-]{1,63}$/.test(health.revision), 'invalid_serving_identity');
  requireValue(Array.isArray(builds), 'invalid_builds');
  const matches = builds.filter(build => build?.projectId === projectId
    && build.substitutions?._SHA === main.sha && build.substitutions?._SERVICE === service
    && build.substitutions?._REGION === region).map(build => {
    requireValue(typeof build.id === 'string' && build.id.length > 0, 'invalid_build');
    requireValue(ACTIVE.has(build.status) || FAILED.has(build.status) || build.status === 'SUCCESS', 'invalid_build_status');
    const created = timestamp(build.createTime, now);
    const finished = ACTIVE.has(build.status) ? null : timestamp(build.finishTime, now);
    requireValue(finished === null || finished >= created, 'invalid_build_times');
    return { build, created, finished };
  }).sort((a, b) => b.created - a.created);
  const latest = matches[0];
  const result = { expectedCommit: main.sha, servedCommit: health.sha, revision: health.revision,
    ...(latest ? { build: { id: latest.build.id, status: latest.build.status, createTime: latest.build.createTime,
      ...(latest.build.finishTime ? { finishTime: latest.build.finishTime } : {}),
      automatic: Boolean(latest.build.buildTriggerId) } } : {}) };
  const verdict = (status, exitCode = 0) => ({ ...result, status, exitCode, severity: exitCode ? 'WARNING' : 'INFO' });
  if (health.sha === main.sha) return verdict('healthy');
  if (!latest) return now - committedAt < 5 * MINUTE ? verdict('awaiting_build') : verdict('missing_build', 2);
  if (ACTIVE.has(latest.build.status)) return now - latest.created < 30 * MINUTE
    ? verdict('building') : verdict('build_stalled', 2);
  if (FAILED.has(latest.build.status)) return verdict('build_failed', 2);
  return now - latest.finished < 5 * MINUTE ? verdict('rolling_out') : verdict('deployment_stale', 2);
}

function configuration(env) {
  // A developer's ambient SDK project must not silently select another fleet.
  const projectId = env.DEPLOY_WATCH_PROJECT || 'idk-4e9b9';
  const region = env.CLOUD_RUN_REGION || 'us-east1';
  const service = env.CLOUD_RUN_SERVICE || 'plato-shaped';
  const repository = env.DEPLOY_WATCH_REPOSITORY || 'henryperkins/googleplato';
  const healthUrl = new URL(env.DEPLOY_WATCH_HEALTH_URL || 'https://plato-shaped.ai.studio/v1/health');
  requireValue(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)
    && /^[a-z]+-[a-z]+[0-9]$/.test(region) && /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(service)
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'invalid_configuration');
  requireValue(healthUrl.protocol === 'https:' && !healthUrl.username && !healthUrl.password
    && !healthUrl.search && !healthUrl.hash, 'invalid_configuration');
  return { projectId, region, service, repository, healthUrl: healthUrl.href };
}

// Bound even credential discovery or an injected transport that ignores abort.
function bounded(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new WatchError('deadline_exceeded'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function accessToken() {
  const { GoogleAuth } = await import('google-auth-library');
  return new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getAccessToken();
}

export async function runDeploymentWatch({ env = process.env, fetchImpl = fetch, getAccessToken = accessToken,
  now = Date.now, signal } = {}) {
  let stage = 'configuration';
  let config;
  const deadline = AbortSignal.any([AbortSignal.timeout(40000), ...(signal ? [signal] : [])]);
  const report = { event: 'deployment_watch', checkedAt: new Date(now()).toISOString() };
  try {
    config = configuration(env);
    Object.assign(report, { projectId: config.projectId, region: config.region, service: config.service, repository: config.repository });
    async function read(url, headers = {}) {
      return bounded(async () => {
        const response = await fetchImpl(url, { headers, redirect: 'error',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]) });
        requireValue(response.ok, `http_${response.status}`);
        // Cloud Build projections and a bounded reader keep malformed upstreams small.
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          requireValue(size <= 1024 * 1024, 'response_too_large');
          chunks.push(chunk);
        }
        return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), headers: response.headers };
      }, deadline);
    }
    const mainUrl = `https://api.github.com/repos/${config.repository}/commits/main`;
    const readMain = async () => {
      const { body } = await read(mainUrl, { Accept: 'application/vnd.github+json',
        'User-Agent': 'plato-deployment-watch', 'Cache-Control': 'no-cache' });
      const main = { sha: body.sha, committedAt: body.commit?.committer?.date };
      validateMain(main, now());
      return main;
    };
    stage = 'github';
    const main = await readMain();
    stage = 'health';
    const { body: healthBody, headers } = await read(config.healthUrl, { 'Cache-Control': 'no-cache' });
    requireValue(healthBody.status === 'ok', 'unhealthy_response');
    const health = { sha: headers.get('x-plato-commit'), revision: headers.get('x-plato-revision') };
    stage = 'credentials';
    const token = await bounded(getAccessToken, deadline);
    requireValue(typeof token === 'string' && token.length > 0, 'missing_credentials');
    stage = 'builds';
    const builds = [], seen = new Set();
    const since = new Date(now() - 7 * 24 * 60 * MINUTE).toISOString();
    let pageToken;
    for (let page = 0; ; page++) {
      requireValue(page < 10, 'build_page_limit');
      const url = new URL(`https://cloudbuild.googleapis.com/v1/projects/${config.projectId}/locations/${config.region}/builds`);
      url.searchParams.set('filter', `create_time>="${since}"`);
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('fields', 'builds(id,name,projectId,buildTriggerId,status,createTime,finishTime,substitutions),nextPageToken');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const { body } = await read(url.href, { Authorization: `Bearer ${token}` });
      requireValue(body && typeof body === 'object' && !Array.isArray(body)
        && (body.builds === undefined || Array.isArray(body.builds)), 'invalid_build_page');
      requireValue((body.builds || []).every(build => build && typeof build === 'object'
        && typeof build.id === 'string' && typeof build.projectId === 'string'
        && typeof build.status === 'string' && typeof build.createTime === 'string'), 'invalid_build_entry');
      builds.push(...(body.builds || []));
      requireValue(builds.length <= 1000, 'build_count_limit');
      requireValue(body.nextPageToken === undefined || typeof body.nextPageToken === 'string', 'invalid_page_token');
      pageToken = body.nextPageToken;
      if (!pageToken) break;
      requireValue(!seen.has(pageToken), 'repeated_page_token');
      seen.add(pageToken);
    }
    stage = 'github_recheck';
    const current = await readMain();
    if (main.sha !== current.sha) return { ...report, status: 'main_changed', expectedCommit: current.sha,
      observedCommit: main.sha, severity: 'INFO', exitCode: 0 };
    stage = 'evaluation';
    return { ...report, mainCommittedAt: main.committedAt,
      ...evaluateDeployment({ ...config, main, health, builds, now: now() }) };
  } catch (error) {
    return { ...report, status: 'incomplete', severity: 'ERROR', exitCode: 1, stage,
      reason: error instanceof WatchError ? error.code : 'upstream_unavailable' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runDeploymentWatch();
  // Flush the single structured result, then stop even if an SDK request ignored abort.
  process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(report.exitCode));
}
