import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, deployDriftFilter, monitoringConfig, saveFailureFilter } from '../../../deploy/cloudrun/monitoring.js';
import { SAVE_FAILURE_CODES, isSaveFailure } from '../../../scripts/save-signals.js';

const script = fileURLToPath(new URL('../../../deploy/cloudrun/monitoring.sh', import.meta.url));
const channel = 'projects/idk-4e9b9/notificationChannels/123';
const config = monitoringConfig({ channel, uptimeCheck: 'plato-health-abc' });
const policy = slug => config.policies.find(item => item.slug === slug).policy;
const directories = [];
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

describe('monitoring config', () => {
  it('gives every policy the channel, a stable label, documentation and a valid strategy', () => {
    const slugs = config.policies.map(item => item.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    assert.equal(new Set(config.policies.map(item => item.policy.displayName)).size, slugs.length);
    for (const { slug, policy: p } of config.policies) {
      assert.match(p.displayName, /^plato: /);
      assert.deepEqual(p.notificationChannels, [channel]);
      assert.equal(p.userLabels.plato_policy, slug);
      assert.equal(p.userLabels['managed-by'], 'plato-monitoring');
      assert.ok(['CRITICAL', 'ERROR', 'WARNING'].includes(p.severity), slug);
      assert.equal(p.combiner, 'OR');
      assert.match(p.documentation.subject, /^\[plato\] /);
      assert.ok(p.documentation.content.length > 40, slug);
      const logMatch = p.conditions.some(condition => condition.conditionMatchedLog);
      // Cloud Monitoring requires a rate limit (at least 5 minutes) on log-match policies.
      if (logMatch) assert.ok(Number.parseInt(p.alertStrategy.notificationRateLimit.period, 10) >= 300, slug);
      else assert.equal(p.alertStrategy.notificationRateLimit, undefined, slug);
      assert.ok(p.alertStrategy.autoClose, slug);
      // Cloud Monitoring rejects a PromQL policy with more than one condition.
      if (p.conditions.some(condition => condition.conditionPrometheusQueryLanguage)) assert.equal(p.conditions.length, 1, slug);
    }
  });

  it('emails about exactly the log-watch save signal, minus upgrade rejections', () => {
    const filter = saveFailureFilter(DEFAULTS);
    assert.equal(policy('save-failure').conditions[0].conditionMatchedLog.filter, filter);
    for (const code of SAVE_FAILURE_CODES) assert.ok(filter.includes(`jsonPayload.event="${code}"`), code);
    assert.ok(filter.includes('jsonPayload.event="unhandled_error"'));
    assert.ok(filter.includes('jsonPayload.path=~"^/v1/sync(/|$)"'));
    for (const method of ['PUT', 'POST', 'DELETE']) assert.ok(filter.includes(`jsonPayload.method="${method}"`), method);
    assert.ok(filter.includes('NOT jsonPayload.reason="client_upgrade_required"'));
    assert.ok(filter.includes('NOT jsonPayload.reason="upgrade_required"'));
    assert.ok(filter.startsWith('resource.type="cloud_run_revision" AND resource.labels.service_name="plato-shaped" AND ('));
    // log-watch reads the same shared definition.
    assert.equal(isSaveFailure('unhandled_error', { method: 'put', path: '/v1/sync/profile' }), true);
    assert.equal(isSaveFailure('unhandled_error', { method: 'POST', path: '/v1/sync-other' }), false);
  });

  it('alerts on Cloud Run changes by anyone but the deploy account, including failed attempts', () => {
    const filter = deployDriftFilter(DEFAULTS);
    assert.equal(policy('deploy-drift').conditions[0].conditionMatchedLog.filter, filter);
    assert.ok(filter.includes('NOT protoPayload.authenticationInfo.principalEmail="plato-deploy@idk-4e9b9.iam.gserviceaccount.com"'));
    assert.ok(filter.includes('"Services.UpdateService"') && filter.includes('"Services.ReplaceService"'));
    assert.doesNotMatch(filter, /status\.code/);
  });

  it('builds metric conditions for the right service, database and logs-based metrics', () => {
    const queries = config.policies.flatMap(({ policy: p }) => p.conditions)
      .map(condition => condition.conditionPrometheusQueryLanguage).filter(Boolean);
    assert.equal(queries.length, 6);
    for (const metric of config.metrics) {
      const uses = queries.filter(q => q.query.includes(`logging_googleapis_com:user_${metric.name}{`));
      assert.equal(uses.length, 1, metric.name);
      assert.equal(uses[0].disableMetricValidation, true, 'a new metric has no data yet');
      assert.match(metric.filter, /^resource\.type="cloud_run_revision" AND resource\.labels\.service_name="plato-shaped" AND jsonPayload\.event="/);
    }
    assert.match(policy('http-5xx').conditions[0].conditionPrometheusQueryLanguage.query, /response_code_class="5xx".*> 0\.05\) and \(.*>= 20\)$/);
    for (const slug of ['cloud-sql-connections', 'cloud-sql-cpu', 'cloud-sql-disk']) {
      assert.match(policy(slug).conditions[0].conditionPrometheusQueryLanguage.query, /database_id="idk-4e9b9:plato-durable"/);
    }
    assert.match(policy('health-check').conditions[0].conditionThreshold.filter, /metric\.label\.check_id="plato-health-abc"$/);
  });

  it('requires a channel and an uptime check', () => {
    assert.throws(() => monitoringConfig({ uptimeCheck: 'x' }), /channel/);
    assert.throws(() => monitoringConfig({ channel }), /uptime/);
  });
});

// A stand-in gcloud that records calls and keeps resources in a JSON file.
const FAKE_GCLOUD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.env.FAKE_GCLOUD_STATE;
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const words = args.filter(arg => !arg.startsWith('--'));
const flag = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const command = words.slice(0, 4).join(' ');
const mutation = /\\b(create|update|delete)\\b/.test(words.join(' '));
state.calls.push(args);
const done = (output = '', code = 0) => { fs.writeFileSync(path, JSON.stringify(state)); if (output) console.log(output); process.exit(code); };
if (mutation && process.env.FAKE_GCLOUD_READ_ONLY) done('', 3);
const body = file => JSON.parse(fs.readFileSync(file, 'utf8'));
if (command === 'beta monitoring channels list') {
  done(state.channels.find(c => flag('filter').includes('"' + c.email + '"'))?.name);
} else if (command === 'beta monitoring channels describe') {
  done(state.channels.find(c => c.name === words[4])?.status || '');
} else if (command === 'beta monitoring channels create') {
  const name = 'projects/idk-4e9b9/notificationChannels/' + (state.channels.length + 1);
  state.channels.push({ name, email: flag('channel-labels').replace('email_address=', '') });
  done(name);
} else if (command === 'monitoring uptime list-configs') {
  done(state.uptime.find(u => flag('filter') === 'displayName="' + u.displayName + '"')?.name);
} else if (words.slice(0, 3).join(' ') === 'monitoring uptime create') {
  const name = 'projects/idk-4e9b9/uptimeCheckConfigs/plato-health-1a2b';
  state.uptime.push({ name, displayName: words[3] });
  done(name);
} else if (words.slice(0, 3).join(' ') === 'monitoring uptime update') {
  done();
} else if (words.slice(0, 3).join(' ') === 'logging metrics describe') {
  done(state.metrics.includes(words[3]) ? words[3] : '', state.metrics.includes(words[3]) ? 0 : 1);
} else if (['logging metrics create', 'logging metrics update'].includes(words.slice(0, 3).join(' '))) {
  body(flag('config-from-file'));
  if (words[2] === 'create') state.metrics.push(words[3]);
  done();
} else if (command === 'monitoring policies list') {
  done(state.policies.find(p => flag('filter') === 'userLabels.plato_policy=' + p.slug)?.name);
} else if (['monitoring policies create', 'monitoring policies update'].includes(words.slice(0, 3).join(' '))) {
  const policy = body(flag('policy-from-file'));
  state.bodies[policy.userLabels.plato_policy] = policy;
  if (words[2] === 'create') state.policies.push({ name: 'projects/idk-4e9b9/alertPolicies/' + (state.policies.length + 1), slug: policy.userLabels.plato_policy });
  done();
} else if (words.slice(0, 2).join(' ') === 'logging read') {
  done(Array.from({ length: state.readLines }, () => '2026-10-25T00:00:00Z').join('\\n'));
} else {
  console.error('fake gcloud: unexpected command ' + args.join(' '));
  done('', 4);
}
`;

function fakeGcloud(initial = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'plato-monitoring-'));
  directories.push(directory);
  writeFileSync(join(directory, 'gcloud'), FAKE_GCLOUD);
  chmodSync(join(directory, 'gcloud'), 0o755);
  const statePath = join(directory, 'state.json');
  writeFileSync(statePath, JSON.stringify({ channels: [], uptime: [], metrics: [], policies: [], bodies: {}, calls: [], readLines: 0, ...initial }));
  return {
    run: (args, env = {}) => spawnSync('bash', [script, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env, PATH: `${directory}:${process.env.PATH}`, FAKE_GCLOUD_STATE: statePath },
    }),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}

const mutations = state => state.calls.filter(call => call.some(word => /^(create|update|delete)$/.test(word)));

describe('monitoring.sh', () => {
  it('creates the channel, uptime check, metrics and policies, then updates them in place', () => {
    const gcloud = fakeGcloud();
    const first = gcloud.run(['--email', 'ops@example.test']);
    assert.equal(first.status, 0, first.stderr);
    let state = gcloud.state();
    assert.deepEqual(state.channels.map(c => c.email), ['ops@example.test']);
    assert.equal(state.uptime.length, 1);
    assert.deepEqual(state.metrics.sort(), ['plato_ai_provider_error', 'plato_postgres_connect_retry']);
    assert.equal(state.policies.length, 10);
    const created = state.calls.find(call => call.slice(0, 3).join(' ') === 'monitoring uptime create');
    for (const expected of ['--resource-labels=host=plato-shaped.ai.studio,project_id=idk-4e9b9', '--protocol=https',
      '--path=/v1/health', '--validate-ssl=true', '--status-codes=200', '--regions=usa-iowa,usa-oregon,usa-virginia']) {
      assert.ok(created.includes(expected), expected);
    }
    for (const call of state.calls) assert.ok(call.includes('--project=idk-4e9b9'), call.join(' '));
    for (const body of Object.values(state.bodies)) assert.deepEqual(body.notificationChannels, ['projects/idk-4e9b9/notificationChannels/1']);
    assert.match(state.bodies['health-check'].conditions[0].conditionThreshold.filter, /check_id="plato-health-1a2b"/);
    assert.match(first.stdout, /created policy save-failure/);

    const second = gcloud.run(['--email', 'ops@example.test']);
    assert.equal(second.status, 0, second.stderr);
    state = gcloud.state();
    assert.equal(state.channels.length, 1);
    assert.equal(state.policies.length, 10, 'policies are updated, not duplicated');
    const repeat = mutations(state).slice(mutations(state).length - 13);
    assert.equal(repeat.filter(call => call.includes('create')).length, 0);
    assert.equal(repeat.filter(call => call.slice(0, 3).join(' ') === 'monitoring policies update').length, 10);
    assert.match(second.stdout, /updated policy deploy-drift/);
  });

  it('warns when the existing channel is unverified', () => {
    const gcloud = fakeGcloud({ channels: [{ name: 'projects/idk-4e9b9/notificationChannels/9', email: 'ops@example.test', status: 'UNVERIFIED' }] });
    const result = gcloud.run(['--email', 'ops@example.test']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /notificationChannels\/9 is unverified/);
    assert.equal(gcloud.state().channels.length, 1);
  });

  it('changes nothing on a dry run and prints the planned commands', () => {
    const gcloud = fakeGcloud();
    const result = gcloud.run(['--email', 'ops@example.test', '--dry-run'], { FAKE_GCLOUD_READ_ONLY: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(mutations(gcloud.state()).length, 0);
    assert.match(result.stdout, /dry-run: gcloud beta monitoring channels create/);
    assert.match(result.stdout, /would create policy save-failure/);
    assert.match(result.stdout, /dry run; nothing was changed/);
  });

  it('counts recent matches for each log-based alert without changing anything', () => {
    const gcloud = fakeGcloud({ readLines: 3 });
    const result = gcloud.run(['--check'], { FAKE_GCLOUD_READ_ONLY: '1' });
    assert.equal(result.status, 0, result.stderr);
    for (const slug of ['save-failure', 'cloudflare-reconnect', 'ai-errors', 'db-connect-retry', 'deploy-drift']) {
      assert.match(result.stdout, new RegExp(`^${slug}: 3 matching log entries in the last 7 days$`, 'm'));
    }
    assert.equal(mutations(gcloud.state()).length, 0);
  });

  it('rejects a missing or unsafe address before calling gcloud', () => {
    for (const args of [[], ['--email', 'not-an-address'], ['--email', 'a@b.test,c@d.test'], ['--check', '--email', 'ops@example.test']]) {
      const gcloud = fakeGcloud();
      const result = gcloud.run(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(gcloud.state().calls.length, 0);
    }
  });
});
