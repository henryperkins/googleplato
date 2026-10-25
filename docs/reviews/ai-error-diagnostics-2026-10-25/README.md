# AI failure diagnostics verification

This change logs why AI requests fail, reports credential failures with
honest codes, keeps the Cloudflare connection when a token renewal never
reached Cloudflare, and warns in AI Settings when Bedrock has no AWS
credentials. It changes no prompts, models, reasoning settings or completion
rules, and it makes no paid model calls in tests.

## Tests

Local validation on Node 24 passed: 501 client tests and 694 server tests,
with zero skips using a disposable PostgreSQL 17 instance. Lint reported zero
errors and 20 existing client warnings, none in files this change touches.

The Cloud Build test gate was reproduced in Docker: `npm ci && npm run lint &&
npm test` in `node:24-bookworm-slim` against `postgres:17-bookworm` on a
user-defined Docker network. The last run used a `git archive` export of `main`
(500b2f3, which includes #15) merged with this branch's code at 0e74a33. Lint
reported zero errors and 21 warnings; the new one came from `main`. 504 client
tests and 694 server tests passed with zero skips.

Restoring the previous behavior in `cloudflare-oauth.js` (every credential
failure reported as Reconnect, and every failed renewal disabling the
connection) made three new tests fail: the busy lease, the database read
failure and the renewal that never reached Cloudflare. Restoring the 10-second
renewal abort, or removing the 30-second pause, each failed its own test.

## Fetch failure shapes

The "never reached Cloudflare" rule depends on how Node 24's `fetch` reports
network failures. These shapes were observed locally against a closed
localhost port and an unresolvable `.invalid` host, with no external requests:

| Failure | `fetch` rejection |
| --- | --- |
| Refused connection | `TypeError`, cause `ECONNREFUSED` with `syscall: 'connect'` |
| Refused on every address (Happy Eyeballs) | cause `AggregateError`, `code: 'ECONNREFUSED'`, each inner error with `syscall: 'connect'` |
| Unresolvable host | `TypeError`, cause `ENOTFOUND` |
| `AbortSignal.timeout` | `TimeoutError` with no cause; treated as ambiguous |
| Connection never opens | `TypeError`, cause `ConnectTimeoutError` (`UND_ERR_CONNECT_TIMEOUT`), after about 10.5 s |

Only failures from the host lookup or the connect attempt, on every address
tried, count as never sent. A timeout after connecting, a reset after
connecting, a redirect or any HTTP response still disables the connection, as
before.

The independent review found that the first version of this rule never applied
to connection timeouts. The renewal's own 10-second abort fired before undici's
10-second connect timeout, so a silent network produced an ambiguous
`TimeoutError`. Measured with Node 24.21 and undici 7.29.1, against a local
listener that accepts TCP but never answers TLS, and against a non-routable
address that drops packets:

| Renewal abort | Result |
| --- | --- |
| 10 s (before) | `TimeoutError` at 10,002 ms: ambiguous, so the connection was disabled |
| 15 s (now) | `UND_ERR_CONNECT_TIMEOUT` at about 10,520 ms in both cases: never sent |

A route test now runs the real 10-second hang against the silent local listener.
It fails if the abort no longer outlasts undici's connect timeout.

## AI Settings warning

Headless Chromium against a local SQLite server whose environment has no AWS
credentials. The warning appears on the Bedrock option and in its card. Checked
on a light desktop and a dark 390 px viewport, with no horizontal scroll.

![Bedrock warning, light desktop](ai-settings-bedrock-warning-desktop-light.png)

![Bedrock warning, dark phone](ai-settings-bedrock-warning-phone-dark.png)

With Workers AI active, selecting Bedrock made **Save AI settings** use
`aria-describedby="ai-pending-changes bedrock-credentials-warning"`, both
elements present, and the button stayed enabled: the check warns and never
blocks, because it cannot see an EC2 instance role. Selecting Workers AI
removes the card warning. This was headless Chromium only, not Safari, Firefox
or a physical device.

## Review follow-ups

- **Version churn during an outage.** Every never-sent renewal wrote a lease
  and a release, so each AI request bumped the connection version twice. An
  administrator's Disconnect could then fail with "changed in another session".
  After an unreachable renewal, requests now fail fast for 30 seconds without
  writing. A test checks that the version stays put across repeated requests
  and that Disconnect succeeds.
- **Settings read failures were silent.** An invalid `AI_PROVIDER`, or a
  database error while reading the saved selection, failed every AI request
  with nothing logged. These now log `ai_provider_error` with `stage: settings`.
  A database error is classified as `ai_error`, not as an unreachable provider.
- **Plugin hook logging.** Plugin hook failures still log the error message, as
  before this change. A Bedrock access error during lesson enrichment can
  therefore name the AWS account and role in the server logs. The `ai-errors.js`
  comment now says so; sanitizing errors passed to plugins is a separate change.
- **Known limit.** If the lease release after a never-sent renewal fails with a
  database error, the lease expires 30 seconds later. The next request then
  disables the connection, logging `refresh-lease-expired`. This needs a network
  failure and a database failure back to back.

## Not verified here

No Cloud Run deployment or production log query was part of this check. The
first production `ai_provider_error` events will show the cause of the Workers
AI failures that previously logged only `ai_unavailable`.
