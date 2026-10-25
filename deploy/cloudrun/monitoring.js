#!/usr/bin/env node
// Cloud Monitoring alerting for plato on Cloud Run, as code. monitoring.sh
// applies what this builds; see docs/OBSERVABILITY.md#cloud-run-alerting.
// It only writes JSON files and has no dependencies, so it runs from a plain
// checkout. Alerts email; they never page or change the service.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SAVE_FAILURE_CODES, SYNC_PATH_PREFIX, SYNC_WRITE_METHODS } from '../../scripts/save-signals.js';

export const DEFAULTS = {
  project: 'idk-4e9b9',
  service: 'plato-shaped',
  sqlInstance: 'plato-durable',
  deployServiceAccount: 'plato-deploy@idk-4e9b9.iam.gserviceaccount.com',
};

const DOCS = 'https://github.com/henryperkins/googleplato/blob/main/docs';
// Rejections that protect saved work during a client upgrade. log-watch and
// its counts still include them; only the email alert leaves them out.
const UPGRADE_REASONS = { sync_validation_failure: 'client_upgrade_required', client_save_unconfirmed: 'upgrade_required' };

// Cloud Logging and PromQL both accept JSON-style double-quoted strings.
const quote = JSON.stringify;

function serviceLogs({ service }) {
  return `resource.type="cloud_run_revision" AND resource.labels.service_name=${quote(service)}`;
}

/** Log entries the save alert emails about: scripts/log-watch.js's signal, minus upgrade rejections. */
export function saveFailureFilter(options) {
  const codes = SAVE_FAILURE_CODES.map(code => UPGRADE_REASONS[code]
    ? `(jsonPayload.event=${quote(code)} AND NOT jsonPayload.reason=${quote(UPGRADE_REASONS[code])})`
    : `jsonPayload.event=${quote(code)}`);
  const writes = SYNC_WRITE_METHODS.map(method => `jsonPayload.method=${quote(method)}`).join(' OR ');
  const unhandled = `(jsonPayload.event="unhandled_error" AND (${writes}) AND jsonPayload.path=~${quote(`^${SYNC_PATH_PREFIX}(/|$)`)})`;
  return `${serviceLogs(options)} AND (${[...codes, unhandled].join(' OR ')})`;
}

/** Cloud Run service changes made by anyone other than the deploy pipeline, including failed attempts. */
export function deployDriftFilter({ project, service, deployServiceAccount }) {
  return [
    `logName=${quote(`projects/${project}/logs/cloudaudit.googleapis.com%2Factivity`)}`,
    'protoPayload.serviceName="run.googleapis.com"',
    `resource.labels.service_name=${quote(service)}`,
    'protoPayload.methodName:("Services.UpdateService" OR "Services.ReplaceService" OR "Services.DeleteService")',
    `NOT protoPayload.authenticationInfo.principalEmail=${quote(deployServiceAccount)}`,
  ].join(' AND ');
}

function logMetrics(options) {
  const counter = labels => ({ metricKind: 'DELTA', valueType: 'INT64', unit: '1', ...(labels ? { labels } : {}) });
  return [{
    name: 'plato_ai_provider_error',
    description: 'Failed plato AI invocations (ai_provider_error), by classified error code and stage.',
    filter: `${serviceLogs(options)} AND jsonPayload.event="ai_provider_error"`,
    metricDescriptor: counter([
      { key: 'error_code', valueType: 'STRING', description: 'Classified code the browser received' },
      { key: 'stage', valueType: 'STRING', description: 'settings, credentials or provider' },
    ]),
    labelExtractors: { error_code: 'EXTRACT(jsonPayload.error_code)', stage: 'EXTRACT(jsonPayload.stage)' },
  }, {
    name: 'plato_postgres_connect_retry',
    description: 'Database connection retries while a plato instance starts (postgres_connect_retry).',
    filter: `${serviceLogs(options)} AND jsonPayload.event="postgres_connect_retry"`,
    metricDescriptor: counter(),
  }];
}

const logMatch = (displayName, filter) => ({ displayName, conditionMatchedLog: { filter } });

// newMetric: a logs-based metric has no data until its first matching entry.
function promql(displayName, query, { duration = '0s', newMetric = false } = {}) {
  return { displayName, conditionPrometheusQueryLanguage: {
    query, duration, evaluationInterval: '60s', ...(newMetric ? { disableMetricValidation: true } : {}),
  } };
}

const runSelector = ({ service }, extra = '') =>
  `{monitored_resource="cloud_run_revision",service_name=${quote(service)}${extra}}`;
const sqlSelector = ({ project, sqlInstance }) =>
  `{monitored_resource="cloudsql_database",database_id=${quote(`${project}:${sqlInstance}`)}}`;

function policies(options, { uptimeCheck }) {
  const run = runSelector(options);
  const sql = sqlSelector(options);
  return [{
    slug: 'save-failure', name: 'Save failure signal', severity: 'CRITICAL', rateLimit: '3600s',
    conditions: [logMatch('Save failure log entry', saveFailureFilter(options))],
    content: `A learner save was rejected, conflicted, or couldn't be confirmed: \`sync_conflict\`, \`sync_validation_failure\`, \`client_save_unconfirmed\`, or an \`unhandled_error\` on a \`/v1/sync\` write. Rejections caused by a client upgrade are left out. This is a signal to inspect, not proof of lost data. At most one email per hour.\n\nRun \`node scripts/log-watch.js --dry-run\` for counts, then follow the [save observability guide](${DOCS}/SAVE_OBSERVABILITY.md).`,
  }, {
    slug: 'cloudflare-reconnect', name: 'Cloudflare connection needs reconnecting', severity: 'ERROR', rateLimit: '300s',
    conditions: [logMatch('cloudflare_oauth_reconnect_required logged', `${serviceLogs(options)} AND jsonPayload.event="cloudflare_oauth_reconnect_required"`)],
    content: `The classroom's Cloudflare connection was disabled after a failed or uncertain token renewal. Every Workers AI request fails until an administrator selects **Reconnect Cloudflare** in Admin → AI Settings. The log entry's \`trigger\`, \`http_status\` and \`cause_code\` say how the renewal failed. See [When AI requests fail](${DOCS}/CLOUDFLARE_OAUTH.md#when-ai-requests-fail).`,
  }, {
    slug: 'ai-errors', name: 'AI requests failing', severity: 'WARNING',
    conditions: [promql('3 or more failed AI requests in 15 minutes',
      `sum(increase(logging_googleapis_com:user_plato_ai_provider_error${run}[15m])) >= 3`, { newMetric: true })],
    content: `At least 3 AI requests failed within 15 minutes. Group \`jsonPayload.event="ai_provider_error"\` in Cloud Logging by \`error_code\`, \`stage\` and \`reason\` to find the cause. See [failure diagnostics](${DOCS}/INFERENCE_TELEMETRY.md#failure-diagnostics).`,
  }, {
    slug: 'http-5xx', name: 'Server errors above 5%', severity: 'ERROR',
    labels: { 'created-with-google-skill': 'cloud-run-alert-configuration' },
    conditions: [promql('5xx responses above 5% over 10 minutes, with 20 or more requests',
      `(sum(rate(run_googleapis_com:request_count${runSelector(options, ',response_code_class="5xx"')}[10m])) by (service_name)`
      + ` / sum(rate(run_googleapis_com:request_count${run}[10m])) by (service_name) > 0.05)`
      + ` and (sum(increase(run_googleapis_com:request_count${run}[10m])) by (service_name) >= 20)`, { duration: '300s' })],
    content: `More than 5% of requests returned 5xx over 10 minutes, with at least 20 requests, for 5 minutes. Check recent deploys and \`severity>=ERROR\` entries for the service in Cloud Logging. Low traffic never triggers this alert; the health check covers a full outage.`,
  }, {
    slug: 'health-check', name: 'Health check failing', severity: 'CRITICAL',
    conditions: [{ displayName: 'GET /v1/health failing from 2 or more regions', conditionThreshold: {
      filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id=${quote(uptimeCheck)}`,
      aggregations: [{ alignmentPeriod: '1200s', perSeriesAligner: 'ALIGN_NEXT_OLDER', crossSeriesReducer: 'REDUCE_COUNT_FALSE', groupByFields: ['resource.label.*'] }],
      comparison: 'COMPARISON_GT', thresholdValue: 1, duration: '60s', trigger: { count: 1 },
    } }],
    content: `The public health endpoint isn't returning 200 from at least 2 of the 3 checking regions, so learners likely can't reach plato. Check the serving revision (\`x-plato-revision\` on \`/v1/health\`), recent deploys, and the Cloud Run service status.`,
  }, {
    slug: 'db-connect-retry', name: 'Database connection retries at startup', severity: 'WARNING',
    conditions: [promql('2 or more connection retries in 1 hour',
      `sum(increase(logging_googleapis_com:user_plato_postgres_connect_retry${run}[1h])) >= 2`, { newMetric: true })],
    content: `Starting instances retried their Cloud SQL connection at least twice in an hour, which slows cold starts. A lasting failure stops instances from becoming ready. Check Cloud SQL status and Direct VPC egress. See the [Cloud Run storage guide](${DOCS}/CLOUD_RUN_STORAGE.md).`,
  }, {
    slug: 'cloud-sql', name: 'Cloud SQL capacity', severity: 'WARNING',
    conditions: [
      promql('More than 15 connections for 5 minutes', `sum by (database_id) (cloudsql_googleapis_com:database_postgresql_num_backends${sql}) > 15`, { duration: '300s' }),
      promql('CPU above 80% for 15 minutes', `max by (database_id) (cloudsql_googleapis_com:database_cpu_utilization${sql}) > 0.8`, { duration: '900s' }),
      promql('Disk above 80% for 5 minutes', `max by (database_id) (cloudsql_googleapis_com:database_disk_utilization${sql}) > 0.8`, { duration: '300s' }),
    ],
    content: `The Cloud SQL instance is near a capacity limit. Each app instance holds at most 5 connections, and a rollout can briefly run two revisions. Check instance counts before scaling and see the [connection budget](${DOCS}/CLOUD_RUN_STORAGE.md).`,
  }, {
    slug: 'deploy-drift', name: 'Service changed outside the deploy pipeline', severity: 'WARNING', rateLimit: '300s',
    conditions: [logMatch('Cloud Run service change by someone other than the deploy account', deployDriftFilter(options))],
    content: `Someone other than the Cloud Build deploy account changed or tried to change the Cloud Run service, for example AI Studio's Deploy button or a manual \`gcloud run services update\`. Failed attempts count too. The next push to \`main\` reapplies the pipeline's settings. See the [deploy guide](${DOCS}/DEPLOY.md).`,
  }].map(({ slug, name, severity, conditions, content, rateLimit, labels }) => ({ slug, policy: {
    displayName: `plato: ${name}`,
    severity,
    combiner: 'OR',
    enabled: true,
    conditions,
    documentation: { mimeType: 'text/markdown', subject: `[plato] ${name}`, content },
    // Log-match policies need a notification rate limit; metric incidents
    // close on their own once the condition clears.
    alertStrategy: rateLimit ? { notificationRateLimit: { period: rateLimit }, autoClose: '1800s' } : { autoClose: '604800s' },
    userLabels: { 'managed-by': 'plato-monitoring', plato_policy: slug, ...labels },
  } }));
}

/** Everything monitoring.sh applies, for one notification channel and uptime check. */
export function monitoringConfig({ channel, uptimeCheck, ...overrides }) {
  if (!channel) throw new Error('A notification channel name is required');
  if (!uptimeCheck) throw new Error('An uptime check ID is required');
  const options = { ...DEFAULTS, ...overrides };
  return {
    metrics: logMetrics(options),
    policies: policies(options, { uptimeCheck }).map(({ slug, policy }) => ({ slug, policy: { ...policy, notificationChannels: [channel] } })),
    logFilters: [
      ['save-failure', saveFailureFilter(options)],
      ['cloudflare-reconnect', `${serviceLogs(options)} AND jsonPayload.event="cloudflare_oauth_reconnect_required"`],
      ['ai-errors', `${serviceLogs(options)} AND jsonPayload.event="ai_provider_error"`],
      ['db-connect-retry', `${serviceLogs(options)} AND jsonPayload.event="postgres_connect_retry"`],
      ['deploy-drift', deployDriftFilter(options)],
    ],
  };
}

/** Writes metric-*.json, policy-*.json and a tab-separated manifest for monitoring.sh. */
export function writeMonitoringFiles(out, config) {
  mkdirSync(out, { recursive: true });
  const lines = [];
  for (const metric of config.metrics) {
    const file = join(out, `metric-${metric.name}.json`);
    writeFileSync(file, `${JSON.stringify(metric, null, 2)}\n`);
    lines.push(['metric', metric.name, file]);
  }
  for (const { slug, policy } of config.policies) {
    const file = join(out, `policy-${slug}.json`);
    writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
    lines.push(['policy', slug, file]);
  }
  for (const [slug, filter] of config.logFilters) lines.push(['filter', slug, filter]);
  writeFileSync(join(out, 'manifest.tsv'), lines.map(line => line.join('\t')).join('\n') + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, channel: { type: 'string' }, 'uptime-check': { type: 'string' },
    project: { type: 'string' }, service: { type: 'string' }, 'sql-instance': { type: 'string' },
    'deploy-service-account': { type: 'string' },
  } });
  if (!values.out) throw new Error('--out is required');
  const defined = Object.fromEntries(Object.entries({
    project: values.project, service: values.service, sqlInstance: values['sql-instance'],
    deployServiceAccount: values['deploy-service-account'],
  }).filter(([, value]) => value));
  writeMonitoringFiles(values.out, monitoringConfig({ channel: values.channel, uptimeCheck: values['uptime-check'], ...defined }));
}
