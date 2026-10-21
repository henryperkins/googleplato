# Cloudflare OAuth release follow-up

The release adds a shared classroom Cloudflare connection to AI Settings. Browser
sign-in, account selection, encrypted credentials, coordinated renewal, reconnect,
disconnect and revocation retry are implemented. Connecting does not activate a
different provider or model; the administrator tests and saves pending settings.

## Automated review triage

Reviewed all seven Amazon Q threads on PR #4 against the implementation:

| Thread | Decision and evidence |
| --- | --- |
| `providerFetch` masks structured errors | The only application error thrown inside this wrapper is already `failed`/502. Callers parse responses outside its `try`. Sanitizing network/provider errors is intentional and avoids leaking credentials or upstream bodies. No behavior change. |
| Repeated configuration reads during account activation | Configuration comes from the process environment, which normal server requests do not mutate. The suggested transient configuration race is not an observed runtime failure. No behavior change. |
| `flowConsumed` clears a still-valid callback | The flow is written as `exchanging` before entering the `try` whose errors receive this flag. Every error in that block follows consumption of the one-use browser callback. Clearing its cookie is correct; retaining it would not make the callback reusable. Existing disconnect and overlapping-callback regression tests cover these cases. |
| Refresh polling lacks an elapsed-time deadline | The wait yields through `node:timers/promises`; it does not block the event loop. Slow database reads can nevertheless extend the total wait beyond the iteration-count estimate. Added a monotonic 15-second budget that stops further polling, retaining the existing attempt cap and lease rules. |
| Callback reflects an untrusted provider error | Both the library and redirect builder restrict results to known codes. Unknown provider errors are dropped and become `failed`. Raw query values are deliberately not logged. No behavior change. |
| Malformed disconnect JSON escapes handling | Hono already catches these exceptions and returns a sanitized 500. Improved both account-selection and disconnect routes to return a sanitized 400 for malformed JSON or a non-object body, without changing the connection. |
| Draft version type confusion | Drafts use administrator-scoped session storage and strict `!==` comparison. A boolean or string version cannot match the numeric server version. No coercion or credential bypass exists. No behavior change. |

Both behavior changes have regression tests that failed before the implementation
and passed afterward. The refresh-budget test simulates slow database reads
without a real 15-second wait and verifies that existing credentials remain
connected rather than being revoked or refreshed by the waiting request.

## Registration and release state

The private Plato OAuth client was registered in the intended Cloudflare account
through the configured API token. Its only redirect is
`https://plato-shaped.ai.studio/v1/oauth/cloudflare/callback`; it supports the
authorization-code and refresh-token grants with PKCE and no client secret.
Registration metadata and deployment recovery records are kept outside Git.

Production deployment, live verification, final validation and review results are
recorded below as they complete. Real Cloudflare consent requires a browser
session belonging to the account member; synthetic tests do not establish that
consent or model access.

## Release validation

- Full `npm test`: 934 passing tests (355 client, 579 server), no failures or
  skips. The real PostgreSQL 17 persistence and concurrent-writer suite ran
  against a disposable local container and schema.
- `npm run build:client`: passed.
- `npm run lint`: passed; server has no findings, client retains its 21 existing
  warnings and has no errors.
- Focused OAuth routes: 38 tests passed, including the new malformed-request,
  elapsed-time, synchronization-boundary and credential-ownership regression
  cases. `git diff --check` passed.
- Hosted GitHub test/lint jobs have not started because the GitHub account is
  locked for a billing issue. The operator confirmed this lock will never be
  removed. Release validation therefore uses the full local checks and
  independent technical review; no hosted CI pass is claimed.

## Independent review and credential ownership fixes

The initial independent review found three important issues: reserved integration
records could be read through admin user-sync impersonation; reconnect could
overwrite tokens awaiting revocation; and late callback/refresh credentials lacked
a reliable cleanup path. The follow-up fixes block reserved sync principals and
retain credentials in independent encrypted cleanup records before handoff.
An independent retry endpoint preserves any newer active classroom connection.

The review of this new handoff found activation/cleanup races and an old-client
cleanup starvation case. Regression tests reproduced these before the fixes.
Activation now owns an explicit conditional flow state, while cleanup conditionally
invalidates expired flows and rereads active ownership after acquiring its lease.
Rows for a retired OAuth client cannot consume the batch budget for grants the
current client can revoke. Late operations only release their own unique record.

Additional checks cover account-discovery failure, abandoned selection, immediate
revocation if durable retention fails, late-authorization cleanup retry, and a
late refresh completing after a replacement connection. A simultaneous database
outage and provider revocation outage can still require manual revocation through
the Cloudflare profile; the application cannot durably record credentials while
its database is unavailable.

The independent reviewer approved the final ownership follow-up with no remaining
actionable findings and independently reran the three adversarial activation and
cleanup schedules using strict in-memory version checks and stubbed providers.
This is a technical approval, not a GitHub approving review or live qualification.

Desktop (1280 × 900) and phone (390 × 844) Chromium checks used the real local
application, authentication and SQLite with synthetic Cloudflare transport. They
verified draft restoration, explicit account selection, testing and saving,
failed revocation followed by reconnect, and keyboard retry through the dedicated
revocation endpoint. Retry sent no disconnect request, preserved the replacement
account and cleared the pending warning. No phone horizontal overflow occurred.
This is viewport emulation, not physical-device or screen-reader qualification.

- [Desktop cleanup with the replacement connection](cloudflare-oauth-2026-10-21/retry-with-new-connection-desktop.png)
- [Phone cleanup with the replacement connection](cloudflare-oauth-2026-10-21/retry-with-new-connection-phone.png)
