# Save observability on Cloud Run

Cloud Run uses structured process output as the shared logging surface. The
in-process ring buffer is a diagnostic cache for one container; it cannot show
all instances, survive replacement, or establish that a query window is healthy.
The production service is `plato-shaped` in project `idk-4e9b9`, region
`us-east1`. Learner data remains in Cloud SQL PostgreSQL.

## Event contract

`logger.js` emits one JSON object per line with `logId`, `timestamp`, `level`,
`severity`, and identical `code` / `event` names. Recovery uses `INFO`; handled
save failures use `WARNING`; unhandled errors use `ERROR`. Cloud Run promotes
`severity` into the Cloud Logging entry and keeps the event fields in
`jsonPayload`. Metadata cannot replace the event envelope.

| Code | Meaning | Source |
| --- | --- | --- |
| `sync_conflict` | Conditional write or generated-turn lineage conflict; rejected without overwriting saved work | Server |
| `sync_validation_failure` | A sync mutation was rejected, including invalid input, oversize data, forbidden writes, or `client_upgrade_required` | Server |
| `client_save_unconfirmed` | The browser could not confirm a generic record or generated-turn save | Authenticated client report |
| `client_save_recovered` | A previously unconfirmed save was subsequently acknowledged and validated by the client | Authenticated client report |
| `unhandled_error` | Existing unexpected-error signal; the monitor selects PUT/POST/DELETE paths at `/v1/sync` | Server |

Server handled-failure metadata includes operation, method, status, reason, and
an SHA-256 `actorRef` of the authenticated account ID. Paths, raw data keys,
account IDs, emails, transcripts, screenshots, tokens, and exception text are
not included in the new events. Batch failures emit one event per rejected
item, even when the enclosing HTTP response is 200; `itemIndex` identifies the
position, not its content. Stale-client rejections use validation failure with
reason `client_upgrade_required`, rather than masquerading as version conflicts.
Successful first saves and exact server replay acknowledgements are not failures.
Existing unhandled-error logs retain their existing diagnostic format.

Client reports carry a random `eventId`, a random `incidentId` shared across a
failure/recovery sequence, operation, bounded reason, and HTTP status (zero for
unknown/network outcomes). The endpoint adds the account hash and `source: client`.
These are **client-reported observations**, not independent proof of database
state. For generic records, recovery means a later accepted write to the same
key; generated turns use the same lesson and stable turn identity. Failed or
malformed acknowledgements never count as recovery. No event triggers inference.

## Browser delivery and recovery

The metadata outbox is separate from the generated-reply journal. It retains up
to 50 events and 50 active incident associations per account in sessionStorage,
with an in-memory fallback. It survives same-tab reloads when storage is
available. Delivery runs asynchronously after save outcomes, on startup sync,
and when the browser comes online; batches contain at most 20 events and time
out after five seconds. Telemetry uses the existing access token without refreshing it or triggering
session-expiry behavior. A 401 remains queued for later application activity.
The queue drains only for its original signed-in account.
The server also verifies that owner before logging. It never holds up saving,
clears a generated reply, or calls a model.

Delivery is best effort, not a durable job queue or exact loss counter. Closing
the tab, unavailable browser storage, a long outage overflowing the bounded
queue, or a server rejection can lose telemetry. Lost telemetry acknowledgements
can duplicate delivery: Cloud Logging reads deduplicate by account hash and
`eventId`, including across instances. Log ingestion can also lag; use overlapping
monitor windows. A reported recovery does not cancel a failure or justify an
automatic issue closure.

`POST /v1/client-events` requires normal authentication, permits only the two
client event codes and exact content-free fields, limits the body to 16 KiB and
20 events, and caps each account at 120 events/minute per instance. It performs
no learner-data writes or inference. It is deliberately outside the client
compatibility fence so an outdated page can report an upgrade rejection. It is
not a global rate-limit or deduplication store.
The route is mounted in the Cloud Run HTTP entrypoint, Lambda, and both local
development launchers. HTTP startup regressions verify authentication, accepted
reports from clients without compatibility headers, and structured failure and
recovery output from the actual HTTP launchers.

## Run the monitor

Install the repository dependencies with `npm ci`. The reader uses
`google-auth-library` Application Default Credentials (ADC), with the
`logging.read` OAuth scope and the `logging.logEntries.list` permission (for
example, the Logs Viewer role) on the named project. A local ADC login or an
attached service account on an external scheduler can provide credentials.
No application admin password is needed for Cloud Logging.

```sh
GOOGLE_CLOUD_PROJECT=idk-4e9b9 \
CLOUD_RUN_SERVICE=plato-shaped \
CLOUD_RUN_REGION=us-east1 \
LOG_WATCH_HOURS=24 \
node scripts/log-watch.js --dry-run
```

Read-only is the default. The JSON report contains aggregate counts and event
names, not log samples or learner identifiers. Exit codes:

- `0`: complete query, no matching failure signals.
- `2`: complete query with failure signals; investigate conflicts/rejections as
  well as unknown saves. Counts are event signals, not unique lost replies.
- `1`: invalid configuration, unavailable credentials/API, or incomplete query.
  This is a monitoring failure, never a green save-health report.

The reader scopes every request to the project, service, optional region, and a
fixed time window. It includes all revisions and instances, follows pagination
through empty pages, and deduplicates results. A repeated token, malformed page,
100-page / 10,000-entry cap, or 30-second scan deadline is an explicit incomplete
result. Narrow the time window after a cap. `LOG_WATCH_HOURS` accepts up to 168.
Do not restrict the routine monitor to the newest revision during rollouts.

An operator can explicitly opt into the existing GitHub issue channel:

```sh
GH_REPO=henryperkins/googleplato \
GOOGLE_CLOUD_PROJECT=idk-4e9b9 CLOUD_RUN_SERVICE=plato-shaped \
node scripts/log-watch.js --create-issue
```

This requires the `gh` CLI and its authenticated issue-write access. One open
`data-loss` issue suppresses duplicates. Run one scheduler job at a time to avoid
racing issue creation; exit 2 still denotes findings even if an issue already
exists. No issues are created by a default or `--dry-run` invocation.

Use a local or external scheduler and alert on exit 1 as well as 2. GitHub-hosted
Actions are permanently unavailable for this deployment; do not rely on or
retry `.github/workflows/log-watch.yml`. This implementation does not provision
a scheduler, alter IAM, deploy code, or change Cloud SQL.

## Other consumers and deployments

On Cloud Run (`K_SERVICE` set), `GET /v1/admin/logs` selects Cloud Logging,
exposes `remoteSource: cloud-logging` and `cloudlogging.error/complete`, and
merges its results with the local buffer. `cloudlogging=0` explicitly requests
buffer-only diagnostics. A failed remote read remains visible; an empty buffer
is not evidence of a healthy fleet. Configure `GOOGLE_CLOUD_PROJECT` and
optionally `CLOUD_RUN_REGION` for the reader's scope, and grant read access to
its service account only if this admin endpoint needs it.

Lambda installations retain CloudWatch and `cloudwatch=0`. The monitor's legacy
`LOG_WATCH_SOURCE=api` mode uses `PLATO_API_URL`, `PLATO_ADMIN_EMAIL`, and
`PLATO_ADMIN_PASSWORD` and refuses remote-reader failures. The base URL must use
HTTPS without embedded credentials, a query, or a fragment. Login and log reads
reject redirects so admin credentials stay on the configured origin. Its historical grouped
API can hide a sync error behind a different sample with the same code; use the
direct Cloud Logging mode on Cloud Run. Recovery severity is retained by both
readers. Neither deployment stores logs in the learner database.

## Validation and deployment boundary

Regression coverage includes server rejections and batch item outcomes,
authenticated bounded telemetry, no content in new events, offline/reload and
account isolation, lost acknowledgement recovery with unchanged model-call
counts, malformed acknowledgements, and multi-page/multi-revision log reads.
Run `npm test` with the PostgreSQL test database and Firestore rules emulator
configured, then `npm run lint` and `npm run build:client`.

A local read-only smoke test on October 21, 2026 successfully queried the
production service's preceding two-hour window. The new emitters require a
separate code deployment. Local tests are authoritative for this change until
that deployment is explicitly requested and verified.

References: [Cloud Run logging](https://docs.cloud.google.com/run/docs/logging),
[structured JSON fields](https://docs.cloud.google.com/logging/docs/structured-logging),
and the [paginated entries.list API](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list).
