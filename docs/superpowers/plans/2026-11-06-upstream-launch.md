# Upstream Launch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Integrate the approved upstream launch into this fork and deliver a verified preview and draft PR.

**Architecture:** Preserve the fork's Cloud Run/PostgreSQL, provider/authentication and signed-turn contracts. Reconcile upstream launch modules against those contracts, fixing the six reviewed defects and carrying their features into the existing frontend boundaries.

**Tech Stack:** Node 24, npm workspaces, React/Vite, Hono, SQLite/PostgreSQL/DynamoDB, Playwright.

**Spec:** docs/superpowers/specs/2026-11-06-upstream-launch-design.md

## Global Constraints

- This fork has no actual users; priorities describe integration and launch readiness.
- Fork base is 257680dacebcf37a107e9b0c511dea396e15872e; upstream launch is 1105f340a7ebd48185ab287277e779ad8be2fddc.
- Deliver an isolated integration branch, usable verified preview and draft PR. Do not merge main or deploy.
- Preserve server/start.js + PostgreSQL, SQLite and DynamoDB options, Firebase Google/password auth, Bedrock/Workers AI and the root workspace lock.
- Preserve signed coach receipts, atomic progress/transcript saves, source provenance, owner/generation/version guards, request deduplication and persistence-only recovery.
- Preserve fork branding/accessibility, nested startup, URL-fetch and auth safeguards, authoring/reviewed-save behavior, and public-only KPI semantics.
- Read AGENTS.md, REVIEW.md and applicable architecture/persistence/plugin docs. Every interactive element is keyboard-operable with an accessible name.
- Preview/test identities are synthetic; email/Slack and AI calls are mocked unless already explicitly authorized. Do not expose credentials.
- Keep all unrelated worktrees and services intact; record decisions and verification in the plan ledger.

## Shared file and interface map

- Database contract: server/src/lib/db-{sqlite,dynamodb}.js and postgres-database.js own conditional sync creates and role/name/invite fields.
- Production assembly: server/start.js wires migrations, middleware, routes and bounded jobs. Local/Lambda entry points retain matching behavior.
- Roles/hierarchy/messages: upstream server lib/routes plus client permissions and admin routes share role strings and response shapes.
- Learner turns: server lesson-coaching/shared modules and client lessonEngine/coachTransport/turnPersistence remain one trusted protocol.
- Profile changes: client profileQueue serializes owner-bound profile/model/note updates; Settings consumes its public functions.
- UI: existing fork base-nova components and extracted editors remain; imported UI is adapted to those APIs.
- Reports/repros: /home/ubuntu/.local/state/googleplato/upstream-reviews/20261106-zwxl1xem.
- Execution evidence: /home/ubuntu/.local/state/googleplato/upstream-integration-20261106.
- Task reports, review packages and progress: this plan's .superpowers/sdd workspace.

### Task 1: Reconcile backend release contracts and correctness

**Files:** server/src/{lib,routes,middleware}, server/{start.js,dev-sqlite.js,template.yaml}, server/scripts, server/tests, plugins/slack, packages/plugin-sdk, server/package.json and root package-lock.json.

**Interfaces:**
- Consume reviewed upstream modules and fork database/HTTP/AI contracts.
- Produce createSyncData(userId,dataKey,data) -> {version,updatedAt}, setUserRoleIf(userId,expectedRole,nextRole), setUserNameSplitIf(userId,expectedName,parts) with the same semantics as upstream adapters; preserve existing adapter API.
- Produce firstName,lastName,nameSource,forUserId persisted by create functions. New clients consume names/roles/hierarchy/account-invite/message endpoints from upstream.
- Keep fork AI endpoints and signed turn API. Frontend tasks use the existing coach protocol; do not replace it with generic AI calls.

- [x] Capture baseline tests and original merge stages; reconcile server diffs using the recorded base/fork/upstream sources. Preserve fork safeguards rather than replacing whole protected modules.
- [x] Add real-adapter regression assertions before fixing the reviewed defects and new PostgreSQL helpers:

```js
assert.equal((await Promise.allSettled([
  db.createSyncData('test', 'notify:state', { optOut: { messages: true } }),
  db.createSyncData('test', 'notify:state', { emailed: {} }),
])).filter(x => x.status === 'fulfilled').length, 1);
assert.equal((await db.getUserById('test')).firstName, 'Mary Ann');
```

- [x] Implement the missing helpers/fields, roles/names/hierarchy/content and invitation route changes. Keep strict writes, auth, branding, public-only metrics, receipt/sync and logging protections.
- [x] Fix notify/scheduler first-write races, message delivery retry/dispatch errors and export-path containment with focused tests that fail before the fix. Preserve token-free delivery-off result semantics in templated invitation email.
- [x] Wire migrations and startup/new middleware/routes/jobs into Cloud Run. Verify app startup, unsubscribe and view-as enforcement through the actual HTTP assembly. Preserve bootstrap credential cleanup/graceful shutdown.
- [x] Update Slack manifest/runtime behavior using existing extension APIs; execute plugin tests and manifest validation.
- [x] Run focused tests during edits, then full server suite with disposable PostgreSQL 17 and server lint. Record any compatibility test updates with a reason. Commit the task and self-review.

### Task 2: Integrate authentication, administration and course UI

**Files:** client/src/{App.jsx,contexts/AuthContext.jsx,components/AppShell.jsx,pages/admin/*,pages/{Login,Signup,Setup,SignedInInvite,Waitlist,ForgotPassword,ResetPassword}.jsx}, client/js/auth.js, client/src/lib/permissions.js, new names/invite/notification components, client/tests and applicable browser tests, client/src/index.css.

**Interfaces:**
- Consume Task 1 roles (admin,educator,tester,learner with legacy user mapping), split names, course/unit hierarchy and notification/invitation routes.
- Produce session-bound refreshCurrentUser and existing context refreshUser behavior, preserving expectedUserId/sessionGeneration protections.
- Keep current base-nova dialog/button/table APIs, current branding provider boundaries, Google auth, return-path and setup loading behavior.

- [x] Compare every conflicted admin/auth/UI path to the upstream diff and fork base; bring across features while preserving fork forms, focus handling, branding, deep links and extracted editors.
- [x] Write a delayed-body/refresh test that changes session A to B and asserts A is never published or saved with B credentials; implement the owner/session check on the complete response-to-cache/context chain.
- [x] Integrate role-aware admin navigation, CourseStructure, Users filtering/columns, group rename/order, notifications, split names and existing-account invite UI.
- [x] Keep current nested startup/error handling, invitation-only Google flow, code-reviewed knowledge/lesson saving and current theme/logo handling.
- [x] Update/extend meaningful unit and browser coverage for new role/route/name/invite/hierarchy behavior, without weakening existing regressions.
- [x] Run focused tests then client suite, lint and production build; self-review and commit. Task 3 will supply learner overview/chat/profile feature integration.

### Task 3: Integrate learner features with signed turns and durable recovery

**Files:** client/src/pages/{LessonChat,LessonsList,Settings,HowAssessmentWorks}.jsx; client/src/components/chat; client/src/lib/{lessonEngine,profileQueue,lessonOrder,lessonWork,agentActivity,chatPrefs}.js; client/js/{orchestrator,storage,lessonOwner,api}.js; client/prompts; server/src/lib/{lesson-coaching,coach-receipt}.js and shared modules where trusted metadata is generated; client/server tests.

**Interfaces:**
- Consume authenticated names/role/course APIs, preserve server-owned coachTransport and turnPersistence.
- Agent details are generated before signed receipt or derived outside the signed turn. All progress/completion remains trusted and atomic.
- Existing submission/draft journals hold failed submissions independently of newer text/images/links.
- Learner note add/remove APIs serialize read/edit/save in profileQueue with expectedUserId.

- [x] Compare all upstream learner changes against fork base and integrate lesson overview, objective checklist, agent details, next-lesson hierarchy, compose/send-key preferences, direct streaming, learner notes and onboarding content.
- [x] Add regressions for attachment recovery (old four-image/three-link submission plus newer draft), profile-note additions/removals concurrent with deferred model responses, and account changes before persistence.
- [x] Implement learner-note queueing/rebasing with the existing owner guards; retain user-owned notes regardless of model output.
- [x] Preserve signed assessment, task continuity, atomically saved transcript/progress, source evidence, request identity, replay and persistence-only Retry saving. Update metadata tests to verify tampered signed payloads still fail.
- [x] Keep the fork's extracted authoring hook callers working; adapt assessment/onboarding copy to selected providers and actual semantics.
- [x] Run focused tests then full client/server suites covering modified protocol and client build/lint; self-review and commit.

### Task 4: Qualify, document, preview and open the draft PR

**Files:** docs/{ARCHITECTURE,CLOUD_RUN_STORAGE,SAVE_OBSERVABILITY}.md, CLAUDE.md/README/AGENTS where outdated; browser test fixtures/scenarios, e2e fixtures/config as necessary; evidence and plan ledger.

**Interfaces:** Consume the integrated app from Tasks 1-3 and prove its actual HTTP/PostgreSQL and browser contracts.

- [x] Run full root npm test with PostgreSQL 17, root lint, client build, plugin tests and manifests once on the final candidate. Include meaningful new six-defect and adapter/HTTP regressions.
- [x] Run browser journeys on seeded isolated SQLite and/or PostgreSQL: setup/sign-in/accounts, admin/educator/tester/learner permissions, invitations, hierarchy and lesson authoring, signed lesson completion/save retry, profile corrections, notification composing/read/opt-out/unsubscribe. Include desktop and 390px/320px layout/keyboard checks.
- [x] Repair discovered implementation defects with focused tests and rerun only the relevant checks until final code changes justify a full gate.
- [x] Document hierarchy/roles/names/notifications, data contracts/production assembly and known validation boundaries. Correct documentation that assumes this fork has active users.
- [x] Request independent whole-branch review using a diff package and verification logs; fix substantiated issues and obtain scoped re-review.
- [x] Start a persistent synthetic preview on unused ports with a task-owned database; verify root, assets, health, sign-in and core journeys. Expose a usable link through an existing supported preview path and verify it before sharing.
- [x] Commit final docs/tests, push feat/upstream-launch-integration, open a draft PR against main with scope, validation and screenshots. Verify remote branch SHA and PR head/base. Report preview access and evidence, preserving the main checkout.

### Task 5: Close the complete-review findings on the existing launch candidate

**Files:** `server/src/lib/account-invites.js`, `server/src/lib/{db-sqlite,db-dynamodb,postgres-database}.js`, focused server adapter/invitation tests, focused client/browser tests if an uncovered review finding requires them, and the current design/review documentation.

**Interfaces:** Preserve the existing invitation response `{ userGroup, fields }`, deriving both from fields actually filled at the atomic write. The database mutation must read/compare current group and custom-field state at commit and must not recreate a deleted account. Preserve names, roles, authentication metadata and unrelated custom fields. Keep all three backends equivalent.

- [x] Reproduce acceptance with an authentication-time profile snapshot followed by a concurrent saved field/group edit. Assert the saved values survive and the response/audit report only newly filled values. Include contention between reading the latest user and committing the merge; a second ordinary read alone is insufficient.
- [x] Implement the smallest atomic fill-only adapter operation or conditional read/retry protocol. For PostgreSQL exercise independent connections against the dedicated PostgreSQL 17 helper; for SQLite use the real adapter; for DynamoDB exercise generated conditional commands with controlled transport without external AWS calls.
- [x] Verify learner-note queueing, exact-audience previews, notification claims/retries/dispatch recovery, PostgreSQL create-only/name/invitation fields, and fresh startup against the later review. Reuse prior successful evidence on unchanged code and execute focused checks where the later findings require new proof.
- [x] Run the amended server suite with isolated PostgreSQL schemas, lint, and the meaningful invitation/browser flow. Run broader gates only if amended code or an unresolved concern warrants them. Keep external AI/email/Slack mocked or off.
- [x] Obtain an independent review of the closeout diff and resolve substantiated findings. Refresh the synthetic preview on the final candidate, update the existing draft PR #43, verify remote SHA, and record accurate final evidence. Preserve the primary checkout and every unrelated service/database.

