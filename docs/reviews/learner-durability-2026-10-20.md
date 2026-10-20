# Learner data durability — 2026-10-20

Generated lesson replies now have a separate save state and an exact retained
copy. A failed or unacknowledged save keeps the learner's submission and the
generated reply visible, blocks another Send, and offers a persistence-only
retry. Reloading the same tab restores that copy without inference.

## Persistence contract

- Read conversation, progress, and reset generation together before inference.
- Stage stable turn/message IDs and the already-applied coach result before
  attempting persistence. Retry that same payload without invoking any model.
- Commit messages and lesson KB atomically in SQLite or DynamoDB. Check both
  versions and prior values. Reject a competing session's changes instead of
  overwriting them; acknowledge an identical committed replay without duplicates.
- Rotate a durable reset marker when a sync delete removes either lesson record.
  A lost opening acknowledgement followed by Reset cannot resurrect the old turn.
- Update the browser cache and optional Firestore mirror only after the API
  acknowledges the generated turn. Failed image writes stop before inference.
- Run optional profile/course model enrichment only after an acknowledged
  initial save. Recovery saves authoritative completion and does not run those
  optional models or their derived bookkeeping updates.

## Verification

The original rejected-write regression and the review regressions for premature
completion effects and opening replay after reset were observed failing before
their fixes. The buffered-stream navigation defect was also reproduced in
Chromium before the conversation remount fix.

| Check | Result |
| --- | --- |
| Full `npm test` | 350 client + 526 server tests passed; zero failures |
| `npm run build:client` | Passed |
| `npm run lint` | Passed; zero errors, 21 client warnings |
| `git diff --check` | Passed |
| Independent code review | All five findings addressed; no remaining actionable findings |
| Chromium with synthetic model replies and actual in-memory SQLite sync routes | Six scenarios passed; no browser exceptions or unmapped requests |

Browser scenarios covered failed save → reload → retry, lost acknowledgement
without duplicates, concurrent history, retained conflicts and explicit discard
at a 390px viewport, navigation during a delayed response, navigation with an
already-buffered animation, and opening replay after reset. The delayed-response
and buffered-animation cases are separate checks; failed-save reload and retry
are one scenario. Recovery attempts left the model-call count unchanged.

The checked-in regressions are in `client/tests/learner-durability.test.js`,
`client/tests/generatedTurns.test.js`, `client/tests/storage-messages.test.js`,
`server/tests/routes/lesson-turn.test.js`, and
`server/tests/lib/db-lesson-turn.test.js`. DynamoDB tests inspect transaction
commands and conditional-failure handling; they do not contact AWS. Existing
SAM DynamoDB CRUD policies include the conditional-check permission used by the
new transaction ([AWS policy reference](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-policy-template-list.html#dynamodb-crud-policy)).

Local logs, the browser harness, screenshots, red-test evidence, and the original
file hash baseline are retained in
`/tmp/googleplato-durability-20261020T211156Z/`.

## Limits and preservation

Recovery is scoped to the account, lesson, and current browser tab/session.
`sessionStorage` survives reload and navigation; closing the tab can discard it.
When browser storage is unavailable or full, memory still retains the reply and
the UI warns to keep the tab open. Attempts are bounded to 15 seconds; attachment
hydration is bounded to five seconds so unavailable images cannot indefinitely
hide the retained text or retry controls.

Verification used synthetic inference, Chromium desktop/mobile emulation, and
local SQLite. Live DynamoDB, Firestore, physical devices, and assistive technology
were not exercised. No paid model calls or deployment changes were made. The
server endpoint must be available before clients use this implementation.

All 739 original tracked/nonignored files were compared against the initial
hash baseline: only the eight intended existing files changed; the other 731
are unchanged. The original untracked critique, Playwright logs, and output
artifacts remain intact. This preservation check was performed before committing
the durability changes, with HEAD and the Git index still unchanged.
