import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configureDeploymentWatch, deploymentWatchResources } from '../../../deploy/cloudrun/deploy-watch.js';

const channel = 'projects/idk-4e9b9/notificationChannels/123';
const image = `us-east1-docker.pkg.dev/idk-4e9b9/plato/app:${'a'.repeat(40)}`;
const job = 'plato-deploy-watch';

function gcloudFixture({ existing = false, denied = false, disabledChannel = false } = {}) {
  const reads = [], writes = [], files = [];
  return { reads, writes, files, runCommand(args) {
    assert.ok(args.includes('--project=idk-4e9b9'));
    assert.ok(args.includes('--quiet'));
    const command = args.slice(0, 4).join(' ');
    if (denied) throw new Error('Permission denied');
    const read = args.includes('list') || args.includes('describe');
    (read ? reads : writes).push(args);
    if (command.startsWith('services list')) return existing ? [{ config: { name: 'cloudscheduler.googleapis.com' } }] : [];
    if (command.startsWith('beta monitoring channels describe')) return { name: channel, enabled: !disabledChannel, type: 'email' };
    if (command.startsWith('iam service-accounts list')) return existing ? [
      { email: 'plato-deploy-watch@idk-4e9b9.iam.gserviceaccount.com' },
      { email: 'plato-deploy-watch-scheduler@idk-4e9b9.iam.gserviceaccount.com' },
    ] : [];
    if (command.startsWith('run jobs list')) return existing ? [{ metadata: { name: job } }] : [];
    if (command.startsWith('scheduler jobs list')) return existing ? [{ name: `projects/idk-4e9b9/locations/us-east1/jobs/${job}` }] : [];
    if (command.startsWith('logging metrics list')) return existing ? [{ name: 'plato_deploy_watch_completed' }] : [];
    if (command.startsWith('beta monitoring policies list')) return existing ? ['deploy-watch-failure', 'deploy-watch-silent'].map((slug, i) => ({
      name: `projects/idk-4e9b9/alertPolicies/${i + 1}`, userLabels: { 'managed-by': job, plato_policy: slug },
    })) : [];
    for (const arg of args) if (/^--(config|policy)-from-file=/.test(arg)) files.push(JSON.parse(readFileSync(arg.slice(arg.indexOf('=') + 1), 'utf8')));
    return {};
  } };
}

test('dry run reads existing resources and makes no cloud changes', () => {
  const fake = gcloudFixture();
  const result = configureDeploymentWatch({ image, channel, runCommand: fake.runCommand });
  assert.equal(result.mode, 'dry-run');
  assert.equal(fake.writes.length, 0);
  assert.ok(fake.reads.length >= 5);
  assert.ok(result.commands.some(args => args.slice(0, 2).join(' ') === 'services enable'));
  assert.ok(result.commands.some(args => args.slice(0, 3).join(' ') === 'run jobs create'));
});

test('activation provisions only a read-only monitor and a job-scoped scheduler', () => {
  const fake = gcloudFixture();
  const result = configureDeploymentWatch({ image, channel, apply: true, runCommand: fake.runCommand });
  assert.equal(result.mode, 'applied');
  const bindings = fake.writes.filter(args => args.includes('add-iam-policy-binding'));
  assert.equal(bindings.length, 2);
  assert.ok(bindings.some(args => args[0] === 'projects' && args.includes('--role=roles/cloudbuild.builds.viewer')));
  assert.ok(bindings.some(args => args.slice(0, 4).join(' ') === 'run jobs add-iam-policy-binding plato-deploy-watch'
    && args.includes('--role=roles/run.invoker')));
  assert.ok(!fake.writes.some(args => args.includes('services') && args[0] === 'run'));
  const createJob = fake.writes.find(args => args.slice(0, 3).join(' ') === 'run jobs create');
  assert.ok(createJob.includes(`--image=${image}`));
  assert.ok(createJob.includes('--args=scripts/deploy-watch.js'));
  assert.ok(createJob.includes('--max-retries=0'));
  assert.ok(createJob.includes('--task-timeout=120s'));
  assert.ok(!createJob.some(arg => /secret|cloudsql|vpc/.test(arg)));
  const schedule = fake.writes.find(args => args.slice(0, 4).join(' ') === 'scheduler jobs create http');
  assert.ok(schedule.includes('--schedule=*/5 * * * *'));
  assert.ok(schedule.includes('--uri=https://run.googleapis.com/v2/projects/idk-4e9b9/locations/us-east1/jobs/plato-deploy-watch:run'));
  assert.ok(schedule.includes('--oauth-service-account-email=plato-deploy-watch-scheduler@idk-4e9b9.iam.gserviceaccount.com'));
  assert.equal(fake.files.filter(file => file.notificationChannels?.includes(channel)).length, 2);
});

test('reapplying updates the same resources without creating duplicate accounts or alerts', () => {
  const fake = gcloudFixture({ existing: true });
  configureDeploymentWatch({ image, channel, apply: true, runCommand: fake.runCommand });
  assert.ok(fake.writes.length > 0);
  assert.ok(!fake.writes.some(args => args.includes('create') || args[0] === 'services'));
  assert.ok(fake.writes.some(args => args.slice(0, 3).join(' ') === 'run jobs update'));
  assert.ok(fake.writes.some(args => args.slice(0, 4).join(' ') === 'scheduler jobs update http'));
  assert.equal(fake.writes.filter(args => args.slice(0, 4).join(' ') === 'beta monitoring policies update').length, 2);
});

test('failed discovery is not interpreted as absent resources', () => {
  const fake = gcloudFixture({ denied: true });
  assert.throws(() => configureDeploymentWatch({ image, channel, apply: true, runCommand: fake.runCommand }), /Permission denied/);
  assert.equal(fake.writes.length, 0);
});

test('a disabled notification channel stops activation', () => {
  const fake = gcloudFixture({ disabledChannel: true });
  assert.throws(() => configureDeploymentWatch({ image, channel, apply: true, runCommand: fake.runCommand }));
  assert.equal(fake.writes.length, 0);
});

for (const [name, options] of [
  ['mutable image tag', { image: 'us-east1-docker.pkg.dev/idk-4e9b9/plato/app:latest', channel }],
  ['another project image', { image: `us-east1-docker.pkg.dev/other/plato/app:${'a'.repeat(40)}`, channel }],
  ['another project channel', { image, channel: 'projects/other/notificationChannels/123' }],
]) test(`${name} is rejected before discovery`, () => {
  const fake = gcloudFixture();
  assert.throws(() => configureDeploymentWatch({ ...options, runCommand: fake.runCommand }));
  assert.equal(fake.reads.length, 0);
});

test('findings and monitor failures alert through the existing channel and heartbeat covers silence', () => {
  const resources = deploymentWatchResources(channel);
  assert.equal(resources.policies?.length, 2);
  const failure = resources.policies.find(p => p.userLabels.plato_policy === 'deploy-watch-failure');
  assert.deepEqual(failure.notificationChannels, [channel]);
  assert.match(failure.conditions[0].conditionMatchedLog.filter, /resource.type="cloud_run_job"/);
  assert.match(failure.conditions[0].conditionMatchedLog.filter, /resource.labels.job_name="plato-deploy-watch"/);
  assert.match(failure.conditions[0].conditionMatchedLog.filter, /jsonPayload.exitCode>0/);
  assert.equal(failure.alertStrategy.notificationRateLimit.period, '3600s');
  assert.match(resources.metric.filter, /jsonPayload.event="deployment_watch"/);
  const silent = resources.policies.find(p => p.userLabels.plato_policy === 'deploy-watch-silent');
  const condition = silent.conditions[0].conditionPrometheusQueryLanguage;
  assert.match(condition.query, /increase\(.+\[20m\]\)\) < 1/);
  assert.match(condition.query, /absent_over_time/);
  assert.match(condition.query, /job_name="plato-deploy-watch"/);
  assert.deepEqual(silent.notificationChannels, [channel]);
});
