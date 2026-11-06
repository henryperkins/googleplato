# Upstream integration stopping point — 2026-11-06

The integration has paused twice today, both times at the maintainer's request.
This record describes the **second** stop, after Task 4 resumed. The first
stop's record is this file's previous version (`ad22d73`). This is **not** a
release-ready candidate. This fork has **no actual users**.

## Source and preservation

- Worktree: `/home/ubuntu/.codex/worktrees/660d/googleplato`
- Branch: `feat/upstream-launch-integration`. The working tree is clean.
- Commits since the first stop, all local:
  - `43a25e7` Log oversized sync refusals once and adapt CI to the root workspace
  - `2fa5d6c` Keep menu focus where Tab moves it and name what holds the composer
  - `1326159` Adapt the upstream e2e suite to the fork's contracts
  - `cd6ceaf` Document the launch data contracts and production assembly
  - this record
- Tasks 1–3 were reviewed through `e9a420e`. The Task 4 commits above have
  **not** been independently reviewed.
- Fork base `257680d` equals `origin/main`. A fetch at this stop found upstream
  playground `1105f34` and upstream main `8a01e9f` unchanged.
- No push, pull request, main merge or deployment has happened.
- Evidence root: `/home/ubuntu/.local/state/googleplato/upstream-integration-20261106`.
  The first stop's checkpoint is in `stop-checkpoint/`; this resume's logs,
  traces and results are in `task-4-resume/`.

## Completed work

1. **Backend, administration and authentication, learner** (Tasks 1–3): unchanged
   since the first stop. All six reproduced playground defects are fixed, and
   the fork's signed, server-owned assessment, atomic saves, exact recovery and
   persistence-only retry are preserved.
2. **Task 4, in progress:**
   - The preserved CI and fork-context edits are committed, with a single
     content-free log event for an oversized save (`43a25e7`).
   - Both browser failures left untriaged at the first stop are root-caused
     and fixed (`2fa5d6c`):
     - **Chat send-key failure.** Fixture ordering: the previous test ended
       mid-save, so the server kept the generated reply. That exposed a real
       defect. In any busy state, the composer's hint, which is also its
       accessible description, said "Send when the reply finishes". That
       included a retained reply waiting on Retry saving, when no reply was
       running. LessonChat and both editors now name the actual hold. The
       lesson editor's fixed "Ctrl / ⌘ + Enter" line, which contradicted an
       Enter-to-send preference, is removed.
     - **Admin wait-list focus failure.** A pre-existing fork dropdown defect.
       The queued popover `toggle` event restored focus to the trigger after
       focus had moved, so Tab out of an open menu jumped back to the trigger
       about 300 ms later. The queued restore now only rescues focus left on
       the page body or inside the menu.
   - The full e2e runs found two more defects, both fixed in `2fa5d6c`:
     - the upstream signup hint for an optional username was missing;
     - the mobile Users edit button contained the email, which its accessible
       name lacks (WCAG 2.5.3, pre-existing).
   - The upstream e2e suite is adapted to the fork's contracts (`1326159`). Each
     assertion written for upstream's client-side coaching now checks the
     fork's signed equivalent rather than restoring upstream behavior.
   - The documentation is complete (`cd6ceaf`). It adds the
     `ARCHITECTURE.md#launch-data-contracts-2026-11-06` section that `CLAUDE.md`
     links to, Data migrations, and adapted upstream launch sections. It also
     updates `CLAUDE.md`, `CLOUD_RUN_STORAGE.md`, `SAVE_OBSERVABILITY.md` and
     `OBSERVABILITY.md`, and adds a fork note to upstream's release notes. Every
     internal anchor was checked.

## Verification actually completed

| Check | Result |
| --- | --- |
| `chat.spec.js` on the pre-fix build (RED) | The new Retry-saving test failed on the hint ("Send when the reply finishes"), as intended |
| `chat.spec.js` on the fixed build | 10/10 passed |
| New menu-focus regression | RED on the pre-fix build (Tab ended on the trigger); GREEN after the fix |
| Wait-list focus test, plus the menu test | 5 runs, all passed. The original helper with no focus wait passed 6/6 on the fixed build |
| `client/tests/lesson-composer.test.js` | 6/6 passed |
| Client production build | Passed; it is the build the preview serves |
| Full e2e suite, 117 tests, run 1 | 109 passed, 8 failed; each failure was triaged and addressed |
| Full e2e, run 2 | 116 passed, 1 failed (a hard-coded next-lesson name) |
| Full e2e, run 3 | 115 passed, 2 failed. Both are addressed in `1326159` but **not yet rerun**: a course count that depends on other specs, and a mobile `networkidle` timeout caused by the live Google sign-in SDK, now stubbed |
| Screenshots | Six reviewed by eye: catalog, completed overview (desktop and 320 px), Settings at 320 px, admin wait-list editor at 390 px |

**Not rerun after the Task 4 changes:** the full client unit suite, the full
server suite with PostgreSQL 17, lint, the plugin tests and manifests, and the
fork's full browser suites (only focused admin-responsive tests ran). The last
full results, 864 client and 1,213 server tests, predate these changes.
Renderer evidence isn't device or assistive-technology proof. No live
provider, email, Slack, DynamoDB or Lambda run was made.

## Preview

The public preview now works.
- **Cause of the 404.** An existing zone-level Cloud Connector rule sent every
  hostname not on its exclusion list to an R2 bucket. The task's tunnel and DNS
  record were correct all along. With the maintainer's approval, the preview
  hostname was added to that exclusion list; nothing else in the rule changed.
  Rollback details are in the private evidence directory.
- `https://googleplato-upstream-preview.hperkins.com/` and `/v1/health` return
  200, and the site serves the current client build.
- **Not yet verified over HTTPS:** sign-in and a streamed lesson save.
- The preview's server process started before the Task 4 commits. The
  server-side changes since then are a removed log line and comments, but
  restart it on the final candidate before verifying.

These resources still run: the local mock preview unit
`googleplato-upstream-app-20261106.service` (127.0.0.1:3496, synthetic SQLite,
mock AI, email off), the tunnel unit `googleplato-upstream-tunnel-20261106.service`
(tunnel `2d79c8f0-5323-441e-951d-b6daf7827544`), DNS record
`fae029160bfdca67c4f65059a610fc87`, the Cloud Connector exclusion entry, and the
PostgreSQL helper container `googleplato-upstream-pg-20261106` (localhost:55436).
To tear the preview down, remove the exclusion entry along with the DNS record
and tunnel.

## Resume from here

1. Rerun the full e2e suite and expect 117/117. Then run the fork's browser
   suites, the full client suite, the server suite with PostgreSQL 17, lint
   (after the tests, not alongside them), and the plugin tests and manifests.
2. Get one independent whole-branch review, read-only, covering the priority
   seams in the SDD workspace's `final-review-preparation.md` plus the Task 4
   commits. Then one fix wave and a scoped re-review.
3. Restart the preview on the final candidate. Over HTTPS, verify sign-in and a
   streamed lesson save.
4. Refresh the remote heads, push the feature branch, and open the approved
   **draft** PR with validation and selected screenshots. Merge and deployment
   are a later stage.

Non-blocking observations for the PR:
- On phones the admin bottom nav wraps to two rows with seven destinations.
- Course and unit headings on the lessons page look nearly alike.
- Upstream's #503 injected-authority measurement wasn't repeated against the
  fork's coach prompt.
- The Cloud Build gate doesn't run the e2e suite.

## Decisions recorded

1. The approved six-step proposal was treated as authorization to execute the
   detailed plan. The work stays confined to the integration branch.
2. An isolated worktree and an intermediate merge scaffold were used.
   Intermediate checkpoints are not release qualification.
3. A task-owned named tunnel and an unused personal-domain hostname serve the
   streaming preview, because Quick Tunnels exclude SSE. The maintainer chose
   to add that hostname to the zone's Cloud Connector exclusion list rather
   than move to another zone.
4. Upstream e2e assertions that encode upstream's client-side coaching were
   adapted to the fork's signed contracts, never the reverse.
5. Two pre-existing fork accessibility defects (dropdown focus, mobile
   label-in-name) were fixed because the integrated suites fail on them.
6. `runMigrationsBounded` stays, unused at startup, for upstream parity; its
   comment now says so.
