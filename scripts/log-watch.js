#!/usr/bin/env node
// Read-only by default. Run from any local or external scheduler with Google
// ADC; hosted GitHub Actions is not required. See docs/SAVE_OBSERVABILITY.md.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchCloudLoggingLogs } from '../server/src/lib/cloud-logging.js';

const FAILURE_CODES = new Set(['sync_conflict', 'sync_validation_failure', 'client_save_unconfirmed']);
const DEDUP_LABEL = 'data-loss';
function isSaveFailure(code, meta = {}) {
  return FAILURE_CODES.has(code) || (code === 'unhandled_error'
    && ['PUT', 'POST', 'DELETE'].includes(String(meta.method).toUpperCase())
    && /^\/v1\/sync(?:\/|$)/.test(meta.path || ''));
}
export function dataLossGroups(logs) {
  return (logs?.groups || []).filter(group => isSaveFailure(group.code, group.sample?.meta));
}
export function summarizeSaveLogs(entries) {
  const groups = new Map();
  let failureCount = 0, recoveryCount = 0;
  for (const entry of entries) {
    const failure = isSaveFailure(entry.code, entry.meta);
    if (!failure && entry.code !== 'client_save_recovered') continue;
    if (failure) failureCount++; else recoveryCount++;
    let group = groups.get(entry.code);
    if (!group) {
      group = { code: entry.code, count: 0, firstSeen: entry.ts, lastSeen: entry.ts };
      groups.set(entry.code, group);
    }
    group.count++;
    if (entry.ts < group.firstSeen) group.firstSeen = entry.ts;
    if (entry.ts > group.lastSeen) group.lastSeen = entry.ts;
    // Preserve only the write classification; never publish error text or IDs.
    if (entry.code === 'unhandled_error') group.sample = { meta: { method: 'PUT', path: '/v1/sync' } };
  }
  return { groups: [...groups.values()], failureCount, recoveryCount };
}

async function readLegacyApi(env, since) {
  if (!env.PLATO_API_URL || !env.PLATO_ADMIN_EMAIL || !env.PLATO_ADMIN_PASSWORD) throw new Error('Legacy API source requires PLATO_API_URL and admin credentials');
  const login = await fetch(`${env.PLATO_API_URL}/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ email: env.PLATO_ADMIN_EMAIL, password: env.PLATO_ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { accessToken } = await login.json();
  if (!accessToken) throw new Error('login returned no accessToken');
  const response = await fetch(`${env.PLATO_API_URL}/v1/admin/logs?view=groups&since=${encodeURIComponent(since)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`logs API failed: ${response.status}`);
  const logs = await response.json();
  if (logs.cloudwatch?.error || logs.cloudlogging?.error) throw new Error('Remote log source is unavailable');
  // Grouped legacy responses cannot recover errors hidden by a mixed sample.
  // Kept only for Lambda installations; Cloud Run always uses the direct reader.
  const hits = dataLossGroups(logs);
  return { groups: hits.map(({ code, count, firstSeen, lastSeen }) => ({ code, count, firstSeen, lastSeen })),
    failureCount: hits.reduce((n, group) => n + group.count, 0),
    recoveryCount: (logs.groups || []).filter(g => g.code === 'client_save_recovered').reduce((n, g) => n + g.count, 0) };
}
export async function runWatch({ env = process.env, readCloud = fetchCloudLoggingLogs, now = Date.now() } = {}) {
  const hours = Number(env.LOG_WATCH_HOURS || 24);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('LOG_WATCH_HOURS must be greater than zero and at most 168');
  const since = new Date(now - hours * 3600000).toISOString(), until = new Date(now).toISOString();
  const source = env.LOG_WATCH_SOURCE || 'cloud-logging';
  if (source === 'api') return { source, since, until, ...await readLegacyApi(env, since) };
  if (source !== 'cloud-logging') throw new Error('LOG_WATCH_SOURCE must be cloud-logging or api');
  const logs = await readCloud({ since, until, projectId: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT,
    serviceName: env.CLOUD_RUN_SERVICE || env.K_SERVICE, location: env.CLOUD_RUN_REGION });
  if (logs.error || logs.complete !== true) throw new Error(logs.error || 'Incomplete Cloud Logging scan');
  return { source, since, until, projectId: logs.projectId, serviceName: logs.serviceName,
    ...summarizeSaveLogs(logs.entries) };
}

function createIssue(report) {
  const repo = process.env.GH_REPO;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Set GH_REPO=owner/repository for issue creation');
  const gh = args => execFileSync('gh', [...args, '--repo', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const open = JSON.parse(gh(['issue', 'list', '--label', DEDUP_LABEL, '--state', 'open', '--json', 'number']));
  if (open.length) { console.log(`log-watch: issue #${open[0].number} already open`); return; }
  gh(['label', 'create', DEDUP_LABEL, '--color', 'B60205', '--description', 'Learner saves need investigation', '--force']);
  const dir = mkdtempSync(join(tmpdir(), 'plato-log-watch-'));
  try {
    const body = join(dir, 'body.md');
    writeFileSync(body, ['Automated save-observability alert from `log-watch`.', '',
      `Window: ${report.since} to ${report.until}. Source: ${report.source}.`,
      `${report.failureCount} failure signals; ${report.recoveryCount} client-reported recoveries.`,
      'Counts are events, not unique lost replies. Conflicts can be protective rejections; recoveries do not cancel failures.', '',
      ...report.groups.map(g => `- ${g.code}: ${g.count}`), '',
      'Investigate the structured Cloud Logging events. See docs/SAVE_OBSERVABILITY.md.',
    ].join('\n'));
    console.log(gh(['issue', 'create', '--title', `Save alert: ${report.failureCount} failure signals`, '--body-file', body, '--label', DEDUP_LABEL]).trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const flags = process.argv.slice(2);
    if (flags.some(flag => !['--dry-run', '--create-issue'].includes(flag)) || (flags.includes('--dry-run') && flags.includes('--create-issue'))) throw new Error('Use --dry-run (default) or --create-issue');
    const report = await runWatch();
    console.log(JSON.stringify(report, null, 2));
    if (report.failureCount && flags.includes('--create-issue')) createIssue(report);
    process.exitCode = report.failureCount ? 2 : 0;
  })().catch(error => { console.error(`log-watch failed: ${error.message}`); process.exitCode = 1; });
}
