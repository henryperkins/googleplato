#!/usr/bin/env node
// Read-only Cloud Logging analysis. No app credentials, DB writes, model calls,
// GitHub Actions or issue creation. See docs/INFERENCE_TELEMETRY.md.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fetchCloudLoggingLogs } from '../server/src/lib/cloud-logging.js';
import { INFERENCE_CODES, summarizeInferenceLogs } from '../server/src/lib/inference-report.js';

export async function runInferenceReport(args = process.argv.slice(2), env = process.env, readLogs = fetchCloudLoggingLogs) {
  const { values } = parseArgs({ args, options: Object.fromEntries(
    ['since', 'until', 'project', 'service', 'region', 'input', 'rates', 'abandon-hours'].map(key => [key, { type: 'string' }])) });
  const abandonHours = Number(values['abandon-hours'] ?? 24);
  if (!Number.isFinite(abandonHours) || abandonHours <= 0 || abandonHours > 8760) throw new Error('Invalid abandonment interval (hours)');
  const rateCard = values.rates ? JSON.parse(await readFile(values.rates, 'utf8')) : undefined;
  let scan;
  if (values.input) {
    if (values.since || values.until) throw new Error('Offline input already defines its scan window; omit --since and --until');
    scan = JSON.parse(await readFile(values.input, 'utf8'));
  } else {
    if (!values.since) throw new Error('--since is required; choose the full cohort period for lesson cost reporting');
    scan = await readLogs({ since: values.since, until: values.until || new Date().toISOString(),
      projectId: values.project || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT,
      serviceName: values.service || env.CLOUD_RUN_SERVICE || env.K_SERVICE,
      location: values.region || env.CLOUD_RUN_REGION, codes: INFERENCE_CODES });
  }
  const report = summarizeInferenceLogs(scan, { rateCard, abandonAfterMs: abandonHours * 3600_000 });
  return { report, exitCode: report.total.cost_complete && report.lesson_attribution_complete ? 0 : 2 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInferenceReport().then(({ report, exitCode }) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode;
  }).catch(error => {
    console.error('inference-report failed:', error.message);
    process.exitCode = 1;
  });
}
