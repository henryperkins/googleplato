# Task 5 — Group assignment reconciliation

Implemented in isolated worktree `/home/ubuntu/.codex/worktrees/pr43-groups/googleplato`, branch `fix/pr43-groups`, base `64b45d8`. No changes to primary/other implementation worktrees, push, merge or deployment.

## Behavior and bounded scope

- `settleGroupAssignment` reads the current account and settings strongly, clears only an absent group with `updateUserProfileIf`, and recomputes after a lost comparison, bounded to three attempts. A valid current concurrent rename or another assignment is preserved.
- External/password admission, `acceptInvite`, wait-list apply and admin PATCH invoke settlement after assignment. Admission settlement is best-effort before hooks, invite consumption and session issuance. `admission_group_settle_failed` logs no metadata/exception text; `admission_group_dropped` includes only the stale group name.
- Cleanup strongly scans users, invites and system data after its settings write. DynamoDB accepts `consistentRead` on all three APIs; SQL already reads committed rows and ignores extra options. Admin user lists request strong reads; authentication already did so at the base.
- Cleanup user moves use the existing profile CAS and settle their own writes. This preserves a new assignment made after R1 and clears a late B write from overlapping A→B / B→C renames.
- Admin PATCH validates against strongly read settings and accepts explicit null. Raw settings PUT rejects `userGroups` and directs callers to `/v1/admin/groups`.
- Ruling agreed with controller: preserve initial validated invitation precedence when a supplied choice was invalid from the outset. Drop fallback during reconciliation. A selected group removed after validation is cleared even when the invitation group remains valid.
- Kept account-invite return/audit semantics: `userGroup` reports a group applied by that acceptance, rather than reporting a pre-existing membership when nothing was applied.
- Atomic-invite fixtures that represent valid concurrent Admin/Racing/Existing groups now list those groups. Existing cleanup fault tests inject the conditional write boundary instead of the replaced unconditional boundary.

## Evidence

All server commands ran with `PLATO_REQUIRE_RC232=1`. Node v24.21.0. Dependencies were reused via links; no npm install/ci.

Original-behavior RED used its own disposable scratch Git worktree at exact `6d02058`: `/home/ubuntu/.codex/worktrees/pr43-groups-red/googleplato`. Copied only the new matrix and reusable test fake into it, with dependency links. No source fixes were present.

```sh
cd /home/ubuntu/.codex/worktrees/pr43-groups-red/googleplato
PLATO_REQUIRE_RC232=1 POSTGRES_TEST_URL=postgres://postgres:plato-test@127.0.0.1:55443/postgres node --test server/tests/lib/group-assignment-races.test.js > /tmp/task5-red-final.log 2>&1
```

RED: 96 tests, 16 passed, 80 failed, zero cancelled/skipped. Failures include stale A after (a), missing post-write R2 under (d), DynamoDB stale cleanup under (c), raw-list PUT accepted, removed group accepted by admin PATCH, admin/wait-list late assignment, missing settlement helper, late B after overlapping renames, and cleanup clobbering Keep. Some SQL (b)/(c) cases already passed and are preserved regression coverage. Initial fixture-only PG `audit_logs` typo was corrected to `audit_log` before the reported RED/GREEN runs.

GREEN in implementation worktree:

```sh
cd /home/ubuntu/.codex/worktrees/pr43-groups/googleplato
PLATO_REQUIRE_RC232=1 POSTGRES_TEST_URL=postgres://postgres:plato-test@127.0.0.1:55443/postgres node --test server/tests/lib/group-assignment-races.test.js server/tests/lib/groups.test.js server/tests/lib/migration-dynamodb.test.js server/tests/lib/account-invites-atomic.test.js server/tests/lib/external-auth-groups.test.js server/tests/routes/auth.test.js server/tests/routes/admin.test.js server/tests/routes/admin-authorization.test.js > /tmp/task5-targeted-final2.log 2>&1
```

GREEN: 294 tests passed, zero failed/cancelled/skipped, 33 suites. New matrix: 96 tests including three adapter parent tests; actual SQLite, disposable-schema PostgreSQL 17, and the actual DynamoDB adapter with a fail-loud stale DocumentClient.

The named W1/R1/W2/R2 gates use promises, with no sleeps. For each external/password/acceptInvite path, (a)–(c) cover delete and rename, and (d) forces a post-write read outage. Final membership is asserted from a fresh adapter read, GET `/v1/me`, admin-list group filtering, and `isRecipient`. Creation hooks read actual stored accounts at the point the hook runs (for (c), the hook correctly sees A before the later W1). `acceptInvite` does not create an account or emit `userCreated`; it verifies final actual account and consumed invite instead. Creation (d) also asserts access/refresh tokens and the hook read. Strong invite/message cleanup reads are asserted, as are the dropped-group/no-PII logs.

Changed-files lint:

```sh
cd /home/ubuntu/.codex/worktrees/pr43-groups/googleplato/server
PLATO_REQUIRE_RC232=1 node node_modules/eslint/bin/eslint.js src/lib/groups.js src/lib/account-invites.js src/lib/external-auth.js src/lib/db-dynamodb.js src/routes/auth.js src/routes/admin.js tests/lib/groups.test.js tests/lib/account-invites-atomic.test.js tests/lib/group-assignment-races.test.js tests/helpers/stale-document-client.js
```

Exit 0, no lint output. `git diff --check` passed. Expected existing auth setup fixture output includes a nonfatal missing-AWS-region content-seed message; no billable/live external provider calls were used.

## Limits and integration notes

No full npm suite, browser/E2E, Cloud Run or live DynamoDB service checks; controller owns the combined integration matrix. DynamoDB tests exercise actual adapter expressions through the condition-checking fake. Best-effort admission deliberately continues during R2 outage, so a missed membership may need operational follow-up; no claim that an unavailable post-check can guarantee membership repair.

Task 4 may independently add `getAllSyncData` consistency options. Keep both changes when integrating; Task 5 changes to that signature are only the optional `consistentRead` flag and its DynamoDB query field. No notification behavior files were changed. Architecture edits are confined to the groups section, plus two observability rows.
