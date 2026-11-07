# Task 4 — independent stamped unit order

Implemented in isolated `/home/ubuntu/.codex/worktrees/pr43-units/googleplato`, branch `fix/pr43-units`, starting at `64b45d8`.

## Result

- Custom order is written only to `_system:unitOrder:<unitId>` as `{ lessonIds, unitCreatedAt }`. No course or unit receives an order mirror. Removed all mirror property reads/writes and helpers.
- The route strongly reads the unit, order and lesson membership; validates the current snapshot; uses create-only or strictly versioned order writes; retries conditional conflicts three times, then returns 409. Membership remains on each lesson. A joining lesson follows ordered lessons by name; leaving lessons disappear without hiding or duplicating other lessons.
- Hierarchy uses a stamped order only for the same unit incarnation, otherwise the legacy unit order. Migration `m006_unit_order` is appended, leaves m004 unchanged, and creates missing stamped records only. Bundled seed creates its own stamped order after migration on first fork startup.
- New unit deletion removes the unit before conditionally removing the observed order. Startup cleanup conditionally removes orphaned or mismatched orders and has its own `unit_orders_reconciled` / `unit_order_reconcile_failed` log codes.
- Owner repair restores only missing ownership/bundled metadata with one owner. Explicit null remains unchanged; ambiguous ownership is separate. Result shape is `{ repaired, ambiguous, conflicted }` and consumers/docs are updated.
- Order 400/409 reloads the client hierarchy, announces through the polite live region, and refocuses the pressed control using the existing boundary fallback. Announcement clears between repeated actions.
- RC-232 allowances, m006 assertions, first-start migrate/seed/repair ordering, actual old-release delete mode and rollback documentation are updated.

## Interface rulings

- Extended existing `deleteSyncData` options with optional `expectedVersion` on SQLite, PostgreSQL and DynamoDB. A stale or missing version throws `ConditionalCheckFailedException`; an omitted version retains current behavior. This closes the cleanup-read/new-order/delete race without a new adapter operation.
- DynamoDB `getAllSyncData` now forwards optional `consistentRead` to QueryCommand, required for the route's membership snapshot and startup reconciliation. SQL accepts the same caller option naturally.
- Legacy units with no data `createdAt` use a null order stamp consistently in migration, hierarchy, cleanup and route. Newly created units have their existing timestamp incarnation identifier.
- Preview databases with the removed mirror must be recreated. No fallback to the mirror is retained.

## RED evidence

Tests first committed in `4b02e67` (`test: reproduce unit order loss across rollback and move races`). Original behavior was run in a real detached Git worktree `/home/ubuntu/.codex/worktrees/pr43-units-red`, at `6d02058`, with test/helper copied in and only dependency links added. Git was retained for RC-232 compatibility tooling. No baseline export was used.

Command, from scratch `server/`:

```sh
PLATO_REQUIRE_RC232=1 POSTGRES_TEST_URL=postgres://postgres:plato-test@127.0.0.1:55443/postgres node --test tests/lib/unit-order.test.js
```

`task-4-evidence/red-original.log` is the final reproduction run: six expected leaf assertion failures (two per SQLite/PostgreSQL/DynamoDB), plus the three failing parent cases. Each requested `['l3','l1','l2']` order becomes `['l1','l2','l3']`. Before simulated restart, the DynamoDB replica is advanced to the committed RC-232 rename, so the reproduction cannot accidentally pass by reading the older unit with its legacy order. Races use promise barriers, no sleeps.

## GREEN evidence

All server commands used `PLATO_REQUIRE_RC232=1`. Actual PostgreSQL reports **17.11** (`postgres-version.log`). PostgreSQL schemas and SQLite files are disposable; DynamoDB tests use the actual adapter with `StaleDocumentClient`, extended with fail-loud query/delete conditions.

From task `server/`:

```sh
PLATO_REQUIRE_RC232=1 POSTGRES_TEST_URL=postgres://postgres:plato-test@127.0.0.1:55443/postgres node --test tests/lib/unit-order.test.js tests/lib/unit-repair.test.js tests/lib/hierarchy.test.js tests/lib/bundled-lessons.test.js tests/routes/hierarchy.test.js tests/migrations/upgrade-from-rc232.test.js
```

**100 passed, 0 failed/skipped** (`green-focused.log`). Includes both review reproductions, join/leave races, real SQLite/PostgreSQL trigger-injected failure, DynamoDB conditional failure with bounded retries, byte-identical failed writes, recreated IDs, stamp fallback/override, stale-replica snapshot, migration create-only/idempotence, conditional delete refusal, racing cleanup and normal deletion of matching/mismatched orders. RC-232 is mandatory and its real rename/delete handlers run.

```sh
PLATO_REQUIRE_RC232=1 POSTGRES_TEST_URL=postgres://postgres:plato-test@127.0.0.1:55443/postgres node --test tests/lib/migrations.test.js tests/lib/migration-dynamodb.test.js tests/lib/migration-real-adapters.test.js tests/migrations/migrate-script.test.js
```

**18 passed, 0 failed/skipped** (`migration-compat.log`).

From task root:

```sh
PLATO_REQUIRE_RC232=1 npm run build:client
PLATO_REQUIRE_RC232=1 PLATO_TEST_EVIDENCE=/home/ubuntu/.codex/worktrees/pr43-units/googleplato/.superpowers/sdd/2026-11-06-pr43-review-remediation/task-4-evidence/browser node --test --test-name-pattern='lesson order (400|409)' client/tests/browser/admin-responsive.test.js
```

Build passed (`client-build.log`; existing chunk-size advisory). **2 browser tests passed** (`browser-focused.log`): actual rendered UI on an owned isolated SQLite server, intercepted 400/409, hierarchy reload count, polite live-region message and active pressed control after keyboard activation. Screenshots: `browser/unit-order/chromium/{400,409}-reloaded.png`. Browser plugin unavailable, so the existing regular Playwright fixture was used.

Changed server JavaScript files and test/helper/scripts were linted with the local ESLint binary: **0 errors/warnings** (`server-lint.log`). Changed client component/browser test: **0 errors, one existing `react-hooks/set-state-in-effect` warning** on the unchanged initial load effect (`client-lint.log`). `git diff --check` passes. Logs have trailing whitespace normalized.

## Limits and integration

- No full npm test, all-browser matrix, e2e sweep, deployment, push or merge was run; controller will run its single combined matrix after integration.
- DynamoDB evidence is real adapter plus a condition-aware stale fake, not a live AWS service. Rendered evidence is desktop Chromium, not physical-device/assistive-technology qualification.
- Root's Task 3 follow-up alters migrations runner hooks and rehearsal prerequisite ordering on another branch. Cherry-picking may require resolving nearby migration/rehearsal/docs hunks; preserve those controller changes and append m006.
- Task-owned RED scratch worktree remains available for audit, with uncommitted copied test/helper files. Primary/other worktrees were not edited.
