# Inference telemetry and lesson cost estimates

This slice measures the existing inference behavior. It does not change model
selection, prompts, reasoning effort, token allowances, retry policy, or lesson
completion rules. DeepSeek still uses `reasoning_effort: 'max'` and the existing
8,192-token reasoning headroom. Tests use provider transport fixtures, not paid
model calls. Deployment and production measurement are separate release steps.

## Collection

`server/src/lib/ai-provider.js` instruments the shared invocation boundary for
Workers AI and Bedrock, including non-streaming extraction, streaming coaching,
background profile/course agents, admin connection tests, and SDK plugin calls.
Each invocation emits single-line structured JSON through `logger.js`:

| Event | Meaning |
| --- | --- |
| `inference_started` | An invocation entered the selected provider adapter. |
| `inference_finished` | Success, error, or cancellation; includes available usage, timings, and retry metadata. |
| `lesson_attempt_saved` | The server acknowledged an atomic lesson turn, including exact replay after a lost acknowledgement. Status comes from the saved lesson KB. |
| `ai_provider_error` | WARN. Why an invocation failed, as fixed identifiers; see [Failure diagnostics](#failure-diagnostics). |

The first three are INFO events. They are measurements, not individual save alarms.
Cloud Run captures process output in Cloud Logging across instances/revisions.
`log-watch.js` keeps its existing save-event query and counting behavior. The
new report explicitly selects the three inference/lifecycle codes. No additional
database table, browser beacon, persistent enrichment queue, or runtime Logging
API permission is needed to emit telemetry.

The schema is version 1. Common fields include a server-generated `inference_id`,
actual selected `provider`, `model`, `region`, `stream`, `agent_role`, and optional
`actor_ref`, `lesson_ref`, `attempt_ref`, `turn_ref`, `operation_ref`, and
`client_retry_index`. References are SHA-256 hashes scoped to the authenticated
principal. They support correlation; they are pseudonymous operational data,
not anonymized public data. Keep normal access and retention controls on logs.
No prompts, messages, reasoning traces, screenshots, email addresses, credentials,
or raw lesson/account identifiers are logged by this instrumentation. Browser
tags are allowlisted and never forwarded in the provider request body.

## Failure diagnostics

A failed invocation also emits one `ai_provider_error` at WARN, so failures can
be counted and alerted on apart from the INFO measurements. Cancelled streams
emit none. It shares `inference_id` with that invocation's `inference_finished`
and repeats `provider`, `model`, `stream` and `agent_role`. `error_code` is the
classified code the browser receives (`ai_unavailable`, `ai_overloaded`, ...),
matching `inference_finished.error_code`. When the AI selection itself can't be
read (`stage: settings`), no invocation starts, so `inference_id`, `provider` and
`model` are `null` and no `inference_finished` follows.

| Field | Meaning |
| --- | --- |
| `stage` | `settings` when the saved selection or `AI_PROVIDER` couldn't be read or is invalid; `credentials` when obtaining credentials failed (Workers AI OAuth or manual credentials, Bedrock's credential chain); otherwise `provider`. |
| `reason` | Fixed reason, or `null`. Settings: `invalid-settings`. Credentials: `reconnect-required`, `setup-required`, `missing-credentials`, `busy`, `unreachable`. Workers AI provider: `http`, `error-payload`, `empty` (finished without visible text), `incomplete`, `malformed`. |
| `error_name` | The failing error's name. For credentials, the underlying cause's name, such as a database error. |
| `http_status` | The provider's HTTP status, or the status in a Workers AI stream error event. `null` when none was received. |
| `cause_code` | A transport or database code, such as `ECONNRESET`, `UND_ERR_SOCKET` or a PostgreSQL SQLSTATE. |
| `credential_source` | For a Workers AI HTTP failure: `oauth`, `oauth-refreshed` (renewed during this request) or `environment`. |
| `token_expires_in_s` | For an OAuth HTTP failure: seconds left on the access token, as stored. |

Values are names, codes and statuses only, each checked against a fixed pattern.
Error messages, provider bodies, tokens, account IDs and hostnames are never
logged: AWS messages can include the account ID and IAM role name, and database
errors can include connection details.

Find failures with the Cloud Logging filter
`jsonPayload.event="ai_provider_error"` and group them by `error_code`, `stage`
and `reason`. [OBSERVABILITY.md](OBSERVABILITY.md) classifies the event as a
trend signal. For the Workers AI OAuth connection,
[CLOUDFLARE_OAUTH.md](CLOUDFLARE_OAUTH.md#when-ai-requests-fail) lists which
failures need **Reconnect Cloudflare**, and describes the separate
`cloudflare_oauth_reconnect_required` event.

## Tokens, timing, and retries

`prompt_tokens` and `output_tokens` retain provider-reported counts. Workers AI
prompt counts include cache reads. Bedrock Converse/Anthropic input counts
exclude separately reported cache reads/writes; `cached_input_tokens` and
`cache_write_tokens` preserve those fields for pricing. Missing/invalid fields
are `null`, never fabricated zero usage. Reasoning is a subset of output:
`reasoning_tokens` comes from a reported breakdown, and `visible_output_tokens`
is output minus reasoning only when both counts are known. Converse does not
provide a standard separate reasoning count, so that breakdown remains unknown.
Provider usage snapshots are cumulative and are not summed across SSE frames.

`time_to_first_visible_token_ms` measures from entering the provider adapter to
the first non-whitespace text available to the server. It excludes role-only,
reasoning-only, and empty deltas. `ttft_scope: 'server_provider'` explicitly
distinguishes this from browser paint time: network delivery, client tag stripping,
rendering, prompt/context loading and the preceding AI-settings read are outside
this measurement. Non-streaming TTFT is the time the full text response becomes
available. `latency_ms` covers the entire adapter/stream lifetime, including
retry delays and stream consumption. The report supplies sample counts and
p50/p95 for both timing fields; missing samples are not zero milliseconds.

Browser overload retries and lesson-owner validation retries retain an
`operation_ref` and increase `client_retry_index`. Each actual invocation gets
a fresh server `inference_id` and contributes its own usage/cost. Bedrock SDK
`provider_attempts`, `provider_retries`, and `provider_retry_delay_ms` are captured
on success or error without altering SDK configuration. Workers AI makes one
fetch attempt and adds no retries. SDK retries expose final-attempt usage, not
the usage of failed attempts; their costs are therefore marked incomplete.

`usage_complete` requires terminal reported input/output usage and exactly one
known provider attempt. Interrupted streams retain any available counts. A
process killed before its terminal log leaves a start without a finish, which
the report counts explicitly as unknown usage. Log delivery itself is best
effort: this is operational telemetry, not a transactional billing ledger.
Telemetry failures cannot change a provider response or a lesson save.

## Lesson outcomes and recovery

An attempt is one learner/lesson/reset generation, not one page visit. The
existing server reset marker joins initialization, coaching, observation updates,
completion enrichment, reloads, and subsequent turns. Resetting creates a new
attempt. Queued model work captures its originating turn/context and checks the
account before issuing inference. Authoring/admin operations and callers without
lesson context appear under `unattributed`, never silently in a learner's total.
Calls during the server's `lessonStarted` hook inherit its request context as
`lesson-enrichment`, including work that continues after a hook timeout. Other
plugin calls use the shared meter but require explicit context to join a lesson.
Agent/attempt tags are client-reported attribution, not an authorization decision.

Only acknowledged atomic saves supply completion evidence. A generated score 10
whose save failed does not count as a completed lesson. Exact save replay emits
another acknowledgement with the same attempt/turn identity, so recovery can
repair missing outcome evidence. The report deduplicates invocations by their
server ID and counts each completed attempt once in its scan window. The save
retry path still performs no inference or model enrichment.

Without a saved completion, an attempt is `active` until its last observed
inference/save has been inactive for 24 hours, then `abandoned`. Override that
interval with `--abandon-hours`. This is an explicit analytical definition,
not proof that the learner will never return. A later return or recovered
completion reclassifies the same attempt on a subsequent report. Tab-close
delivery is not required. Abandoned attempts include initialization failures,
cancelled/failed turns and generated replies never confirmed saved.

## Read-only reporting

Use operator ADC with Logging Viewer access, as for
[save observability](SAVE_OBSERVABILITY.md). No application login or hosted
GitHub Actions is involved:

```sh
node scripts/inference-report.js \
  --project idk-4e9b9 --service plato-shaped --region us-east1 \
  --since 2026-10-21T00:00:00Z --until 2026-10-28T00:00:00Z \
  --abandon-hours 24 > inference-report.json
```

Choose an actual measurement window after deployment. The query fully paginates
across service revisions and fails on permission errors, invalid pages, deadlines,
or truncation. It shares the bounded reader (10,000 entries / 100 pages / 30 s).
For larger cohorts, collect complete adjacent windows externally and deduplicate
their events before reporting over the combined cohort period; do not add their
per-lesson averages or assume each window has the same completion denominator.

The JSON contains `total`, `lessons`, `unattributed`, `by_agent`, `by_status`, and
individual `attempts`. Each summary includes reported token totals and missing
counts, inference failures/cancellations, application and provider retries,
observation frequency per coaching turn, latency/TTFT distributions, estimated
USD, and cost completeness. `cost_per_completed_lesson_usd` divides **all
attributed lesson spend in the window** (completed + abandoned + active,
including enrichment and retries) by the number of observed completed attempts.
Unattributed authoring/admin/plugin spend is shown separately. Missing lesson
context on learner or unknown-role calls (including older tabs) sets
`lesson_attribution_complete: false` and prevents a complete lesson cost claim.
With no completed attempt, the ratio is `null`.

Reports are explicitly `window_only`. They cannot see usage or completion
outside the scan window or before instrumentation was deployed. Choose the full
cohort period for a cohort cost estimate; a short rolling window is only an
operational snapshot. An empty successful scan means no matching telemetry,
not proof that there was no inference. Re-read after log-ingestion delay before
treating the end of a window as settled.

Exit codes: **0** complete cost/attribution coverage for observed invocations;
**2** a valid report with unpriced, missing, assumed, or incomplete usage/context; **1** invalid input
or an incomplete Cloud Logging scan (no report). For offline analysis, `--input`
accepts the shared reader's JSON `{ entries, complete, since, until, error }`;
entries have `{ code, ts, meta }`, not raw Cloud Logging export envelopes.

## Pricing and limits

The default rate card is a dated snapshot of Cloudflare list prices, verified
2026-10-21: DeepSeek $0.30/M input, $0.006/M cached input, $1.20/M output;
Mistral Small 3.1 $0.351/M input and $0.555/M output. Output already includes
reasoning, so it is never charged twice in estimates. Missing cache breakdowns
use the uncached input rate and set `cache_assumed_invocations`; they cannot
claim complete coverage. Missing cache-write counts with a configured write
tariff are also flagged as assumed. Rates are estimates before discounts, free allowances,
taxes, hosting, storage, and log-ingestion fees, not invoice totals.

Bedrock requires an explicit card for the actual region and commercial terms.
Unknown models/regions or missing input/output usage remain unpriced. Supply
`--rates /path/to/rates.json` to replace the default card:

```json
{
  "version": "operator-verified-YYYY-MM-DD",
  "rates": [
    {
      "provider": "bedrock",
      "model": "qwen3-vl-235b",
      "region": "us-east-2",
      "input_usd_per_million": "REPLACE_WITH_VERIFIED_NUMBER",
      "output_usd_per_million": "REPLACE_WITH_VERIFIED_NUMBER"
    }
  ]
}
```

Replace the placeholder strings with verified numeric rates; validation rejects
them until configured. Optional `cached_input_usd_per_million` and
`cache_write_usd_per_million` are required when billing reported Bedrock cached
tokens. Cards match provider/model/region exactly and reject duplicate or invalid
rates. `estimated_cost_usd` sums only priceable reported usage; it is a partial
subtotal when coverage is incomplete. Check `cost_complete`, missing usage,
unpriced calls, and unmetered SDK retries before comparing lesson economics.
An entirely unpriced set has `null` estimated cost, not $0.

Provider references: [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[DeepSeek model contract](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/),
[Bedrock token usage](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_TokenUsage.html),
[Bedrock cache accounting](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html),
and [AWS SDK retries](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).

Production baselines and lower-reasoning benchmarks remain subsequent tasks.
This implementation neither changes reasoning settings nor makes benchmark calls.
