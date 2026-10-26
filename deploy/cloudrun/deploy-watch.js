#!/usr/bin/env node
// Dry-run-first setup for the independent Cloud Run deployment monitor.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PROJECT = 'idk-4e9b9', REGION = 'us-east1', JOB = 'plato-deploy-watch';
const WATCH_SA = `${JOB}@${PROJECT}.iam.gserviceaccount.com`;
const SCHEDULER_SA = `${JOB}-scheduler@${PROJECT}.iam.gserviceaccount.com`;
const METRIC = 'plato_deploy_watch_completed';
const DOC = 'https://github.com/henryperkins/googleplato/blob/main/docs/DEPLOYMENT_WATCH.md';

export function deploymentWatchResources(channel) {
  if (!/^projects\/idk-4e9b9\/notificationChannels\/\d+$/.test(channel)) throw new Error('An existing idk-4e9b9 notification channel is required');
  const filter = `resource.type="cloud_run_job" AND resource.labels.project_id="${PROJECT}" AND resource.labels.location="${REGION}" AND resource.labels.job_name="${JOB}" AND jsonPayload.event="deployment_watch"`;
  const series = `logging_googleapis_com:user_${METRIC}{monitored_resource="cloud_run_job",project_id="${PROJECT}",location="${REGION}",job_name="${JOB}"}`;
  const common = { enabled: true, combiner: 'OR', notificationChannels: [channel] };
  const policy = (slug, name, conditions, content, alertStrategy) => ({ ...common,
    displayName: `plato: ${name}`, severity: 'ERROR', conditions, alertStrategy,
    userLabels: { 'managed-by': JOB, plato_policy: slug },
    documentation: { mimeType: 'text/markdown', subject: `[plato] ${name}`, content: `${content}\n\n[Investigation and recovery](${DOC})` },
  });
  return {
    metric: { name: METRIC, description: 'Completed deployment checks, including explicit monitoring failures.', filter,
      metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64', unit: '1' } },
    policies: [
      policy('deploy-watch-failure', 'Deployment missing or check unavailable', [{
        displayName: 'Deployment watch returned a finding or an incomplete result',
        conditionMatchedLog: { filter: `${filter} AND jsonPayload.exitCode>0` },
      }], 'The independent deployment check found an overdue/failed deployment or could not read its sources. Inspect the structured status and stage. Recheck current main and active builds before any manual recovery; the monitor never deploys code.',
      { notificationRateLimit: { period: '3600s' }, autoClose: '1800s' }),
      policy('deploy-watch-silent', 'Deployment monitor stopped reporting', [{
        displayName: 'No completed deployment check in 20 minutes',
        conditionPrometheusQueryLanguage: { query: `sum(increase(${series}[20m])) < 1 or absent_over_time(${series}[20m])`,
          duration: '300s', evaluationInterval: '60s', disableMetricValidation: true },
      }], 'The scheduled deployment monitor has stopped reporting. Check the Cloud Scheduler job, Cloud Run job executions, and their service accounts. A missing heartbeat is not evidence that production is healthy.', { autoClose: '3600s' }),
    ],
  };
}

function command(args) {
  const result = spawnSync('gcloud', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`gcloud ${args.slice(0, 4).join(' ')} failed: ${result.error?.message || result.stderr.trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

export function configureDeploymentWatch({ image, channel, apply = false, runCommand = command } = {}) {
  if (!/^us-east1-docker\.pkg\.dev\/idk-4e9b9\/plato\/app(?::(?!0{40}$)[a-f0-9]{40}|@sha256:[a-f0-9]{64})$/.test(image || '')) {
    throw new Error('Use the released Plato image pinned to a commit SHA or digest');
  }
  const resources = deploymentWatchResources(channel);
  const args = (values, format = 'json') => [...values, `--project=${PROJECT}`, '--quiet', `--format=${format}`];
  const read = (values, format) => runCommand(args(values, format));
  const list = (values, format) => {
    const value = read(values, format);
    if (!Array.isArray(value)) throw new Error(`Invalid discovery response: ${values.join(' ')}`);
    return value;
  };
  const notification = read(['beta', 'monitoring', 'channels', 'describe', channel], 'json(name,enabled,type)');
  if (notification.name !== channel || notification.enabled !== true) throw new Error('Notification channel must exist and be enabled');
  const services = list(['services', 'list', '--enabled'], 'json(config.name)');
  const schedulerEnabled = services.some(item => item.config?.name === 'cloudscheduler.googleapis.com');
  const accounts = list(['iam', 'service-accounts', 'list'], 'json(email)');
  const jobs = list(['run', 'jobs', 'list', `--region=${REGION}`, `--filter=metadata.name=${JOB}`], 'json(metadata.name)');
  const metrics = list(['logging', 'metrics', 'list', `--filter=name=${METRIC}`], 'json(name)');
  const policies = list(['beta', 'monitoring', 'policies', 'list'], 'json(name,userLabels)');
  const schedulerName = `projects/${PROJECT}/locations/${REGION}/jobs/${JOB}`;
  const schedules = schedulerEnabled ? list(['scheduler', 'jobs', 'list', `--location=${REGION}`, `--filter=name=${schedulerName}`], 'json(name)') : [];
  const directory = mkdtempSync(join(tmpdir(), 'plato-deploy-watch-'));
  const commands = [];
  const add = values => commands.push(args(values));
  const file = (name, value) => {
    const path = join(directory, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  };
  try {
    if (!schedulerEnabled) add(['services', 'enable', 'cloudscheduler.googleapis.com']);
    for (const [email, name] of [[WATCH_SA, 'Plato deployment read-only monitor'], [SCHEDULER_SA, 'Plato deployment monitor scheduler']]) {
      if (!accounts.some(account => account.email === email)) add(['iam', 'service-accounts', 'create', email.split('@')[0], `--display-name=${name}`]);
    }
    add(['projects', 'add-iam-policy-binding', PROJECT, `--member=serviceAccount:${WATCH_SA}`,
      '--role=roles/cloudbuild.builds.viewer', '--condition=None']);
    add(['run', 'jobs', jobs.some(item => item.metadata?.name === JOB) ? 'update' : 'create', JOB,
      `--region=${REGION}`, `--image=${image}`, `--service-account=${WATCH_SA}`, '--command=node', '--args=scripts/deploy-watch.js',
      '--tasks=1', '--parallelism=1', '--max-retries=0', '--task-timeout=120s', '--cpu=1', '--memory=512Mi',
      `--set-env-vars=DEPLOY_WATCH_PROJECT=${PROJECT},CLOUD_RUN_REGION=${REGION},CLOUD_RUN_SERVICE=plato-shaped`,
      '--labels=managed-by=plato-deploy-watch']);
    add(['run', 'jobs', 'add-iam-policy-binding', JOB, `--region=${REGION}`,
      `--member=serviceAccount:${SCHEDULER_SA}`, '--role=roles/run.invoker']);
    add(['logging', 'metrics', metrics.some(metric => metric.name === METRIC) ? 'update' : 'create', METRIC,
      `--config-from-file=${file('metric.json', resources.metric)}`]);
    for (const policy of resources.policies) {
      const existing = policies.filter(item => item.userLabels?.['managed-by'] === JOB && item.userLabels.plato_policy === policy.userLabels.plato_policy);
      if (existing.length > 1) throw new Error(`Duplicate deployment watch policy: ${policy.userLabels.plato_policy}`);
      add(['beta', 'monitoring', 'policies', ...(existing.length ? ['update', existing[0].name] : ['create']),
        `--policy-from-file=${file(`${policy.userLabels.plato_policy}.json`, policy)}`]);
    }
    add(['scheduler', 'jobs', schedules.some(item => item.name === schedulerName) ? 'update' : 'create', 'http', JOB,
      `--location=${REGION}`, '--schedule=*/5 * * * *', '--time-zone=Etc/UTC', '--http-method=POST',
      `--uri=https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run`,
      `--oauth-service-account-email=${SCHEDULER_SA}`, '--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform',
      '--message-body={}', '--attempt-deadline=30s', '--max-retry-attempts=0',
      '--description=Read-only comparison of GitHub main, Cloud Build, and public serving identity']);
    if (apply) for (const planned of commands) runCommand(planned);
    return { mode: apply ? 'applied' : 'dry-run', projectId: PROJECT, region: REGION, job: JOB, image, channel, resources, commands };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { image: { type: 'string' }, channel: { type: 'string' },
      apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
    if (values.apply && values['dry-run']) throw new Error('Choose --apply or --dry-run');
    console.log(JSON.stringify(configureDeploymentWatch(values), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
