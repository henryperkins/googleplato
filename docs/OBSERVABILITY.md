# Error Reporting & Alerting

**Current Cloud Run operations:** use [Save observability](SAVE_OBSERVABILITY.md).
It defines structured save failures/recoveries, the direct Cloud Logging reader,
and read-only `log-watch` usage with ADC. Hosted GitHub Actions are permanently
unavailable for this deployment. Cloud Monitoring emails the alerts in
[Cloud Run alerting](#cloud-run-alerting); `log-watch` remains the read-only
report, and its issue creation is opt-in with `--create-issue`. The
Lambda/CloudWatch and scheduled Actions pipeline below is historical context,
not the active Cloud Run monitoring setup. A protected conflict or unconfirmed
save is a signal to inspect, not proof of irrecoverable data loss.

Inference usage and lesson economics have a separate read-only
[inference telemetry report](INFERENCE_TELEMETRY.md), backed by INFO events in
Cloud Logging. It does not add individual inference events to save alarms.

AI failures emit two WARN events, neither of them Tier A, since no learner
data is lost:

- **`ai_provider_error`** is one per failed invocation, with content-free
  [failure diagnostics](INFERENCE_TELEMETRY.md#failure-diagnostics). It is
  **Tier B**: one failure is retryable, so alert on a threshold, not on each one.
- **`cloudflare_oauth_reconnect_required`** is logged once when the classroom's
  Cloudflare connection is disabled. Every Workers AI request then fails until
  an administrator reconnects. It is still Tier B, but the event marks the start
  of an outage, not a single failed request, so one alert per event is not
  per-occurrence alarming. See [CLOUDFLARE_OAUTH.md](CLOUDFLARE_OAUTH.md#when-ai-requests-fail).

Both have alert policies in [Cloud Run alerting](#cloud-run-alerting). When
learners report that the coach is down, check AI Settings and
`jsonPayload.event="cloudflare_oauth_reconnect_required"` first.

How plato notices when something is wrong, and the framework for adding new
checks. Read this before adding any new error detection or alert.

## Cloud Run alerting

`deploy/cloudrun/monitoring.sh` applies plato's Cloud Monitoring alerting for
`plato-shaped` as code, all sent to one email notification channel.
`deploy/cloudrun/monitoring.js` builds the policies, logs-based metrics and
filters. The save alert's filter is generated from the same definition
`log-watch` uses (`scripts/save-signals.js`), so the two can't drift.

| Policy | Fires when | Severity | Emails |
| --- | --- | --- | --- |
| Save failure signal | Any `log-watch` save signal, except rejections caused by a client upgrade | Critical | At most 1 per hour |
| Health check failing | `GET /v1/health` on `plato-shaped.ai.studio` fails from 2 of 3 US regions; checked every 5 minutes | Critical | While failing |
| Cloudflare connection needs reconnecting | `cloudflare_oauth_reconnect_required` is logged | Error | At most 1 per 5 minutes |
| Server errors above 5% | 5xx responses above 5% over 10 minutes with at least 20 requests, for 5 minutes | Error | While firing |
| AI requests failing | 3 or more `ai_provider_error` in 15 minutes | Warning | While firing |
| Database connection retries at startup | 2 or more `postgres_connect_retry` in an hour | Warning | While firing |
| Cloud SQL connections high, CPU high, disk nearly full | Three policies: more than 15 connections for 5 minutes, CPU above 80% for 15 minutes, disk above 80% for 5 minutes | Warning | While firing |
| Service changed outside the deploy pipeline | Anyone but `plato-deploy@` changes, or tries to change, the Cloud Run service | Warning | At most 1 per 5 minutes |

Each email links to the relevant runbook. In tier terms, the save alert is the
Tier A alarm. The AI, 5xx, database and Cloud SQL alerts are Tier B
thresholds. The health check, reconnect and deploy alerts fire once per outage
or change.

Apply or update everything with an account that can manage Cloud Monitoring
and logs-based metrics in the project, for example with the Monitoring Editor
and Logs Configuration Writer roles. Node is required; `npm install` is not:

```sh
deploy/cloudrun/monitoring.sh --email <address> --dry-run   # look up and print the changes
deploy/cloudrun/monitoring.sh --email <address>             # apply
deploy/cloudrun/monitoring.sh --check                       # read-only: recent matches per log-based alert
```

The script is idempotent. Re-run it after editing `monitoring.js`. It matches
the channel by email address, the uptime check by display name, metrics by
name, and policies by their `plato_policy` label, then updates each in place.
The address is passed at run time and never stored in the repository. If
Cloud Monitoring marks the channel unverified, the script says so: alerts
aren't delivered until it's verified. `--check` counts the last 7 days' log entries matching each log-based alert,
for comparison with `node scripts/log-watch.js --dry-run`.

Things to expect:

- The save alert leaves out two signals: `sync_validation_failure` with
  `reason: client_upgrade_required`, and the client's matching
  `client_save_unconfirmed` with `reason: upgrade_required`. Both are
  protective rejections during a client upgrade. `log-watch` still counts them.
- Any manual service change emails, including AI Studio's Deploy button, a
  `gcloud run services update`, and failed attempts. The next push to `main`
  reapplies the pipeline's settings.
- At current traffic the 5xx alert rarely meets its 20-request minimum. The
  health check covers a full outage.
- Logs-based metrics count only entries written after the metric exists.
  `ai_provider_error` and `cloudflare_oauth_reconnect_required` are logged only
  by deployments that include them.

## Why this exists

A write-size bug silently lost learner conversations in prod for **8 days**
before anyone noticed (#195). The errors were in the logs the whole time —
nothing was watching the right way. The fixes (#197, #198, #199) closed the
gap. This doc keeps it closed: it gives a **decision framework** so new error
reporting is added deliberately and consistently, not ad hoc.

## The pipeline

Every error flows through the same layers:

1. **`server/src/lib/logger.js`** — emits events keyed by a stable snake_case
   `code` (e.g. `unhandled_error`). `code` is the unit everything else groups
   and counts by. The global `onError` handler in `server/src/index.js` logs
   any uncaught throw as `unhandled_error` with `{ path, method, error }`.
2. **`GET /v1/admin/logs`** — merges the in-process ring buffer with
   CloudWatch and aggregates into `groups` by `code` (count, first/last seen,
   a sample). `server/src/lib/cloudwatch-logs.js` pulls and normalizes the
   CloudWatch side.
3. **Consumers** read that endpoint:
   - **plato-pilot** (`pilot.yml`, once per weekday) — reviews every error
     code in the daily report.
   - **log-watch** (`log-watch.yml`, every 2h) — the *alarm*: raises a
     GitHub issue the moment a critical-class error appears.

No consumer needs AWS credentials — they all read the admin endpoint.

## The three tiers

Not every error deserves the same response. Classify first, then act.

### Tier A — Critical: irrecoverable harm

Learner data is **lost or corrupted** — the user cannot get it back.

- Examples: a failed write to `/v1/sync` (lost conversation or lesson
  progress); a write that corrupts a stored record.
- Treatment: **alarm per occurrence**, fast cadence — even a count of 1 is
  worth a page. Speed matters; the harm compounds every minute it continues.
- Mechanism: a detector in **`scripts/log-watch.js`**.

### Tier B — Degraded: recoverable failure, or a trend

Something failed, but the user can retry or recover — *or* it's a volume
signal rather than a single event.

- Examples: a spike in AI-provider errors (the coach didn't answer — the
  learner retries); login failures climbing; a brand-new error code
  appearing; timeouts trending up.
- Treatment: **threshold / trend based, never per-occurrence.** One recoverable
  failure is normal; a *spike* is the signal.
- Mechanism: the **pilot's daily report** already lists every code with
  counts — that is usually enough. Build a dedicated faster check only if
  daily is too slow for that specific signal.

### Tier C — Noise: expected or benign

Not a problem at all.

- Examples: `"Request aborted"` on the AI endpoint (the learner closed the
  tab mid-response); expected 4xx (validation rejections, 401s); Node process
  warnings; Lambda `START`/`END`/`REPORT` lines.
- Treatment: **never alarm.** Filter it out so it doesn't pollute the report
  or bury real errors.
- Mechanism: a filter in `cloudwatch-logs.js` (`isProcessWarning` /
  `isLifecycleLine` are the examples), or don't log it as an `error` in the
  first place — use `logger.warn`, or don't log it.

## Decision guide

You have a new error or failure condition. Ask, in order:

1. **Is the harm irrecoverable** — is a learner's data lost or corrupted? →
   **Tier A.** Add a log-watch detector.
2. **Is it a real failure the user recovers from, or a volume/trend signal?** →
   **Tier B.** The daily pilot report likely covers it; add a threshold check
   only if you need it faster.
3. **Is it expected or benign?** → **Tier C.** Filter it out.

When unsure between A and B, ask: *if this fires once, has someone definitely
lost something?* Yes → A. No → B.

## How to add a check

### Step 0 — always: give the error a meaningful `code`

Everything groups by `code`. If your error currently falls into the
`unhandled_error` catch-all and you need to act on it specifically, either:

- emit an explicit `logger.error('descriptive_snake_code', { ... })` at the
  failure site, **or**
- make sure the `meta` (e.g. `path`, `method`) is specific enough to
  fingerprint it — log-watch's data-loss detector keys off `unhandled_error`
  *plus* `method` + `path`, because a failed write is unambiguous from those.

### Tier A — add a log-watch detector

In `scripts/log-watch.js`, a detector is a pure function
`(logs) => matchingGroups[]`. The existing one:

```js
export function dataLossGroups(logs) {
  return (logs?.groups || []).filter((g) => {
    if (g.code !== 'unhandled_error') return false;
    const m = g.sample?.meta || {};
    const method = String(m.method || '').toUpperCase();
    return (method === 'PUT' || method === 'POST')
      && String(m.path || '').startsWith('/v1/sync');
  });
}
```

To add a new Tier A check:

1. Write a detector with a **precise** signature (specific code + meta match).
   A loose signature ("any `unhandled_error`") is the cry-wolf trap — see
   anti-goals below.
2. Wire it into `main()`: collect its hits, and on a non-empty result raise a
   GitHub issue (reuse the dedup pattern — one open issue per class).
3. Mirror the same signature in `scripts/pilot-report.js`'s "Data-loss watch"
   callout and the **severity interrupt** in `pilot.yml`, so the pilot also
   prioritizes it above the issue queue.

With more than one detector, refactor `log-watch.js` to iterate a list of
detectors rather than hard-coding each — but one detector doesn't need that.

### Tier B — usually nothing; or a threshold check

The pilot's daily "Errors by code" report already surfaces counts, first/last
seen, and a sample for every code. That is the Tier B mechanism. Only if a
specific Tier B signal needs sub-daily detection, add a **threshold** detector
to log-watch — one that fires when a count exceeds a baseline, not on every
occurrence — and give its issue a label distinct from `data-loss`.

### Tier C — add a filter

If a benign log line is showing up as an error, filter it in
`cloudwatch-logs.js` (follow `isProcessWarning`). If plato itself logs the
benign condition, downgrade it to `logger.warn` or stop logging it.

## Anti-goals (never violate)

- **Don't let the critical alarm fire on non-critical signals.** A `data-loss`
  issue that turns out to be a closed tab teaches everyone to ignore the
  label — and then the alarm is worthless. Precision is the whole point.
- **Don't alarm per-occurrence on anything recoverable or routine.** That is
  Tier B at most.
- **Don't log expected conditions (validation 4xx, aborted requests) as
  `error`.** They pollute the report and the ring buffer.
- **Don't add a detector with a loose signature.** Scope it to a precise
  `code` + path/meta match.

## Key files

- `server/src/lib/logger.js` — structured logger; `code` conventions.
- `server/src/lib/cloudwatch-logs.js` — CloudWatch retrieval + noise filters.
- `server/src/routes/admin.js` — `GET /v1/admin/logs` (the `view=groups` aggregation).
- `scripts/log-watch.js` + `.github/workflows/log-watch.yml` — the alarm (Tier A).
- `scripts/pilot-report.js` — the pilot's daily report, incl. the data-loss callout.
- `.github/workflows/pilot.yml` — the severity interrupt in the picking order.
