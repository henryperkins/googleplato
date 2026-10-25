# Sync read-path verification

This change stops the hot read paths from reading sync data they throw away,
bounds classroom-wide fan-out, and makes the lesson-stats stale refresh work
off Lambda. It touches persistence code behind the earlier lost-data
incidents (#191/#193), so response shapes were pinned before changing the
queries.

## What changed

- `GET /v1/sync` asks every adapter for
  `excludePrefixes: ['screenshot:', 'userMeta:', 'lessonGeneration:']`.
  Postgres and SQLite filter with `left()`/`substr()` comparisons (never
  `LIKE`, so `%`/`_` stay literal); DynamoDB uses a `NOT begins_with`
  FilterExpression (saves payload, not RCU). The response body is unchanged.
- New adapter methods on all three backends:
  `getAllSyncData(userId, { excludePrefixes })`,
  `getSyncDataByPrefixForAllUsers(prefix)` (one query on Postgres/SQLite;
  per-user prefix queries bounded to 4 in flight on DynamoDB, never a Scan),
  and `deleteAllSyncData(userId)` (one locked transaction on Postgres, one
  statement on SQLite, key-only query plus BatchWrite chunks of 25 on
  DynamoDB).
- `GET /v1/lessons/time-stats` and `computeLessonStats` use the bulk
  `lessonKB:` read. `computeLessonStats` fetches `messages:<lessonId>`
  lazily, only for a completed public lesson missing
  `startedAt`/`completedAt`. `?include=stats` uses the bulk read, and its
  heal/backfill writes run with concurrency bounded to 4.
- Admin and self user deletion call `deleteAllSyncData` after the unchanged
  `userDeleted` hook, instead of a full read plus one delete per row.
- Batch sync writes sequentially. Per-item results and throw-to-500 are
  unchanged; items after an unexpected error are no longer attempted.
- In the stats stale window, non-Lambda runtimes start or join a
  single-flight recompute and await up to 2 s (fresh if it lands, stale
  otherwise). The Lambda self-invoke path is unchanged, and the Lambda SDK
  is imported lazily.

## Validation

Local validation on Node 24:

- Client: 503/503 passed.
- Server: 694/694 passed with `POSTGRES_TEST_URL` set against a disposable
  PostgreSQL 17 container, zero skipped. Without it, 681 passed and the 2
  PostgreSQL suites skipped.
- Lint: 0 errors, 21 warnings, all in files this change does not touch.

The new adapter tests were observed failing before the implementation
(`getSyncDataByPrefixForAllUsers is not a function`, excluded rows returned)
and pass after it, on SQLite, PostgreSQL, and the injected DynamoDB
DocumentClient fake. The DynamoDB fake is not qualification against a live
AWS deployment.

`computeLessonStats` equivalence is pinned by a fixture covering the legacy
messages-duration fallback, private, draft, and custom lessons, and an admin
completion (counted for pacing, excluded from the engagement denominator).
The test asserts the transcript is read only for the one completed public
lesson that needs the fallback.

## Not verified here

- No production deploy or live Cloud Run check; merging deploys, so the
  release checklist items (synthetic screenshot reload, dashboard/Users/
  lesson-list number equivalence against production) still need to run
  against the deployed revision before this is treated as released.
- No live DynamoDB run (AWS deployment path is exercised only through the
  injected fake).
