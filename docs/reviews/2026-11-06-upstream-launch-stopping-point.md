# Upstream integration stopping point — 2026-11-06

Stopped at the maintainer's request: **assess progress, document, and come to a stopping point**. Tasks 1–3 are implemented, committed and independently reviewed. Task 4 is incomplete. This is not a release-ready candidate. This fork has **no actual users**.

## Source and preservation

- Worktree: `/home/ubuntu/.codex/worktrees/660d/googleplato`
- Branch: `feat/upstream-launch-integration`
- Reviewed implementation checkpoint: `e9a420edd66bbf9d20c600b6b663027389a9f7f4`
- Fork base and unchanged primary `main`: `257680dacebcf37a107e9b0c511dea396e15872e`
- Integrated upstream playground: `1105f340a7ebd48185ab287277e779ad8be2fddc`; upstream main: `8a01e9fad990176fc4fa2019fb1414133ab9cebe`
- Fresh fetch before stopping found those remote heads unchanged and local/remote fork main at 0/0. The primary checkout remains clean. Unrelated worktrees and services were preserved.
- No feature branch push, draft PR, main merge or production deployment occurred.

Fifteen tracked Task 4 files remain **uncommitted** and intentionally intact. They contain partial CI/docs/test-harness work and one focused logging correction. Do not discard them or treat them as reviewed. This handoff is a separate documentation-only commit.

The durable evidence root is `/home/ubuntu/.local/state/googleplato/upstream-integration-20261106`. `source-recovery.bundle` preserves the original history. `stop-checkpoint/` preserves the working diff, file hashes, copied task/review reports, and a verified incremental branch bundle. The live SDD ledger remains at `.superpowers/sdd/2026-11-06-upstream-launch/progress.md`; it must not be deleted while the plan is incomplete.

## Completed implementation

1. **Backend:** role/name/hierarchy and invitation contracts, notifications and schedules, PostgreSQL helpers, actual Cloud Run initialization, and plugin adaptations. Corrected unsafe export paths, initial conditional-write races and failed delivery retry behavior. Independent review passed after delivery-finalization and retryable-initialization fixes.
2. **Administration/authentication:** role-aware routes and tables, split names, groups, course structure, messages, existing-account invitations and complete session-bound identity refresh. Independent review passed after notification acknowledgement and keyboard focus fixes.
3. **Learner:** overview, canonical objective evidence, truthful signed agent activity, hierarchy navigation, chat preferences, profile corrections and complete independent recovery journals. Preserved server-owned assessment, signed receipts, atomic transcript/progress saves, exact replay and persistence-only retry. Independent review passed after same-user re-login acknowledgement guards, delayed preference hydration and canonical first-name fixes. The final test-only correction preserves truthful durable acknowledgement and newer-account cache/version isolation.

The six originally reproduced playground defects are addressed in those reviewed tasks. The separate agreement/ping proposals and historical product ideas are excluded by the approved scope. Existing Bedrock/Workers AI selection, authentication, branding, URL safeguards and fork persistence protections remain binding contracts.

## Verification actually completed

| Check | Result and boundary |
| --- | --- |
| Full client suite | 864 passed; zero failures/skips |
| Full server suite with real local PostgreSQL 17 | 1,213 passed; zero failures/skips; before the uncommitted Task 4 logging change |
| Baseline lint | Exit 0; client 0 errors / 24 warnings, server clean; before Task 4 edits |
| Client production build | Passed; existing bundle-size advisory |
| Executed plugin suite / manifest validation | 7 tests passed; all 3 manifests valid |
| Task 4 oversized-save logging correction | Regression failed first; 53 focused server tests passed after correction; full server/PostgreSQL rerun pending |
| Local synthetic preview | Root, JS asset, health, QA sign-in and real signed atomic mocked lesson completion passed; desktop/390px/320px overview smoke passed |

Task 1–3 scoped tests and browser evidence remain valid within their recorded scope. Full integrated browser qualification is **unfinished**:

| Browser attempt | Passed | Failed | Interrupted/cancelled | Did not run |
| --- | ---: | ---: | ---: | ---: |
| Full launch suite, 116 planned | 25 | 2 | 1 | 88 |
| Focused a11y/chat/flows, 70 planned | 30 | 1 | 0 | 39 |
| Fork runner's final summary | 14 | 1 | 7 | Not fully enumerated |

The initial launch failures involved obsolete account-menu/dialog selectors. The pending test changes passed the corrected desktop axe checks in the focused run. Two failures remain untriaged: the chat send-key test sees the composer's busy description, and the fork admin test times out checking focus after inviting/removing a wait-list row. Do not assume either is only a fixture problem. Cancellation entries are consequences of stopping, not independent application failures. All owned test runners and their leftover test server were stopped; port 3497 is clear.

Detailed commands, logs, failure anchors, traces and limitations are in `stop-checkpoint/sdd/task-4-stopping-report.md` and `task-4-evidence/`. Repository Playwright was used because the Browser plugin is unavailable. No physical-device, screen-reader, live provider, external email/Slack, real DynamoDB/Lambda or production qualification is claimed. Browser smoke used SQLite, not PostgreSQL.

## Preview and resources left running

The **local** preview remains available at `http://127.0.0.1:3496` via `googleplato-upstream-app-20261106.service`. It uses a dedicated SQLite database, synthetic accounts, `AI_PROVIDER=mock`, disabled email and a sanitized environment without inherited live provider credentials. The fresh demo learner is untouched; QA used a separate account.

Private synthetic access details and environment files are mode 0600 in `task-4-evidence/preview/{access.json,preview.env}`. Its database, logs, HTTP/browser smoke reports and screenshots are in the same directory. Screenshots have not yet been visually reviewed or selected for the PR.

The **public preview is not working yet**: `https://googleplato-upstream-preview.hperkins.com/` and `/v1/health` returned Cloudflare HTML 404. Local requests with that same Host returned 200. The zone is active, public DNS resolves, the dedicated tunnel reports healthy with four connections, and its configured ingress points to 127.0.0.1:3496. The cause is unproven; routing investigation stopped at the maintainer's request. Do not share this as a verified usable preview.

Only these new task resources were added; existing DNS, tunnels and services were not changed:

- Tunnel: `googleplato-upstream-20261106`, ID `2d79c8f0-5323-441e-951d-b6daf7827544`
- Tunnel user unit: `googleplato-upstream-tunnel-20261106.service`
- DNS CNAME ID: `fae029160bfdca67c4f65059a610fc87`, zone `50896d7393e8c876951df2eb422b6414`
- PostgreSQL helper container: `googleplato-upstream-pg-20261106`, localhost port 55436

Resource IDs, origin and status are recorded in `preview-routing-plan.json`. Connector credentials remain private under `preview-private/`; no credentials belong in Git or the handoff. Public request evidence is retained in `public-root*`, `public-health-response.txt` and `local-preview-host-response.html`.

## Exact unfinished source scope

```text
.github/workflows/a11y.yml
.github/workflows/code-review.yml
AGENTS.md
CLAUDE.md
REVIEW.md
client/tests/browser/invite-required.test.js
client/tests/browser/lesson-publishing.test.js
e2e/README.md
e2e/playwright.config.js
e2e/tests/a11y.spec.js
e2e/tests/flows.spec.js
server/src/lib/jobs.js
server/src/lib/migrations.js
server/src/routes/sync.js
server/tests/routes/save-observability.test.js
```

The config now uses a unique test database without deleting a shared `/tmp` path. CI changes adapt to the root workspace lock and Node 24; factual fork-context edits remove upstream live-user assumptions. The only server runtime change removes duplicate, metadata-bearing oversize logging in favor of the existing single content-free observation. Jobs/migrations edits are comments. A known incomplete doc link in CLAUDE.md targets `docs/ARCHITECTURE.md#launch-data-contracts-2026-11-06`, which has not been written.

## Resume from here, only when requested

1. Read this handoff, the copied Task 4 stopping report, plan/brief and current diff. Do not restart completed Tasks 1–3.
2. Investigate the two recorded browser failures with their existing traces; fix substantiated behavior or fixture issues without weakening signed-save, role, recovery, focus or axe assertions. Complete the unfinished architecture/storage/observability documentation and review representative screenshots.
3. Rerun focused failures, then complete the 116-scenario launch matrix and meaningful fork browser suites. Rerun the full server/PostgreSQL suite after the logging change; repeat other gates only when subsequent changes require it.
4. Complete one independent whole-branch review and address substantiated findings. The approved plan's review procedure and source base are recorded in the SDD workspace.
5. Diagnose the public 404 without changing existing services or routes. Account Worker custom-domain configuration and effective tunnel ingress remain possible next read-only checks, not established causes. Verify root/assets/health/sign-in and actual streamed lesson saving over HTTPS.
6. When qualification and review pass, refresh remote heads, push the feature branch and open the approved draft PR with validation and screenshots. Main merge/deployment remain a later stage.

## Decisions recorded during execution

1. Treated the approved six-step proposal as authorization to execute the detailed plan without another approval checkpoint. If that interpretation was wrong, the work is confined to the integration branch for rework.
2. Used an isolated worktree and an intermediate merge scaffold that temporarily retained fork conflict versions until each task reconciled them. Intermediate checkpoints were not release qualification; any missed reconciliation must be corrected before merge.
3. Chose a new task-owned named tunnel and unused personal-domain hostname for the approved streaming preview because Quick Tunnels exclude SSE. If that host choice is unwanted, only the recorded task DNS/tunnel/units need removal; no product or production migration is involved.
