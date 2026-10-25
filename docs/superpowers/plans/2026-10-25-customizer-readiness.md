# Customizer Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every confirmed PR #23 readiness issue with regression evidence.

**Architecture:** Commit branding settings and logo asset changes atomically in
each database. Send explicit color patches from Styles. Validate stored SVG
rendering while preserving originals and exposing safe recovery controls.

**Tech Stack:** JavaScript ES modules, React/Vite, Hono, SQLite, PostgreSQL,
DynamoDB, node:test, Playwright, and the existing linkedom parser.

**Spec:** `docs/reviews/classroom-customizer-readiness-2026-10-25.md`

## Global Constraints

- Use Node.js 20+ and npm; validation uses installed Node 24.
- Every interactive element needs keyboard support and an accessible name.
- Preserve authentication and URL-fetch safeguards.
- Preserve originals on unrelated saves; no production calls or deployment.
- Work on `fix/customizer-review-followups`, commit and push once qualified;
  keep PR #23 Draft. User authorization covers implementation without a new
  plan-approval pause.

## Review Focus

- Restoring the previous logo during replacement must not lose its bytes.
- A failed settings transaction must leave both old settings and assets intact.
- A matched accent and independent accent must survive stale primary-only edits.
- CSS references, inherited resource references and editor namespaces must not
  bypass stored SVG bounds; unsupported originals need recovery controls.
- Failed email delivery/token storage must not disclose account existence or secrets.

### Task 1: Atomic logo publication and cache revalidation

**Files:** `server/src/lib/{branding,db-sqlite,db-dynamodb,postgres-database}.js`,
`server/src/routes/{admin,content}.js`, database and branding route tests.

**Interfaces:** `db.putBrandingSettings(data, expectedVersion, { logo = null,
previousLogoHash = null } = {})` returns `{version, updatedAt}`. `logo` contains
`{hash, dataUrl, legacy?}`. It atomically checks the exact settings version,
stores any supplied logo, publishes settings, and deletes a different previous
hash; stale creates/writes throw `ConditionalCheckFailedException`.

- [x] Add failing real SQLite route regressions for cleanup interleaving,
  concurrent first saves, and rollback, plus adapter contracts for PostgreSQL
  and DynamoDB. Retain ordinary replacement/removal and identical-upload cases.
- [x] Run focused tests; expected failure: active-logo 404 or missing atomic API.
- [x] Implement one transaction per adapter and replace the route's separate
  asset/settings/cleanup writes. Existing settings version conflicts return 409.
- [x] Require public logo revalidation and test 200/304/404 cache behavior.
- [x] Run focused route/adapter tests; expected: all pass. Commit this task.

### Task 2: Independent color patches

**Files:** `client/src/lib/stylesDraft.js`, `server/src/routes/admin.js`,
`client/tests/stylesDraft.test.js`, branding route and browser tests.

**Interfaces:** New clients send `themePatch: { primary?: hex, accent?: hex|null }`.
`accent:null` selects Match primary. The server retains full-replacement `theme`
for compatibility, rejects ambiguous simultaneous forms, and merges a validated
patch into its latest theme. `changedStyles` returns only changed color keys.

- [ ] Add failing stale-primary/stale-accent/explicit-clear tests, including an
  end-to-end stale form with an intervening administrator save.
- [ ] Run focused tests; expected: stale accent is overwritten or patch ignored.
- [ ] Implement the patch contract and update affected payload expectations.
- [ ] Run client draft and branding route tests; expected: all pass. Commit.

### Task 3: Bounded stored SVGs and original recovery

**Files:** `server/src/lib/branding.js`, a focused `svgSafety.js` helper if needed,
`server/src/routes/admin.js`, `client/src/pages/admin/AdminStyles.jsx`,
`client/src/lib/logoUpload.js`, branding/logo unit and browser tests.

**Interfaces:** `parseLogo(value, {legacy})` returns a display-safe logo or null.
The admin theme response retains the raw original as `logoBase64` and includes
`logoBlocked:true` when it must not be displayed. Public metadata has no logo
URL for blocked originals. Unrelated writes retain them; explicit removal or
replacement clears them. Download uses an attachment Blob, never image rendering.

- [ ] Add failing tests for stored expansion via href, stylesheet resources,
  namespace aliases, cycles, and inherited resources. Cover safe editor styles,
  gradients and metadata, and preservation across name/color saves.
- [ ] Run focused tests; expected: unsafe stored originals still render.
- [ ] Share bounded validation across new/stored SVGs with compatibility for
  static editor markup. Bound parser input structure and rendering data. Reject
  unsupported dynamic CSS/rendering features from display, retaining originals.
- [ ] Add a Styles warning, Download original and explicit removal; never put
  blocked bytes into an image or Optimize. Test download bytes and keyboard use.
- [ ] Run unit/routes and browser tests; expected: all pass. Commit.

### Task 4: Reset-response privacy and qualification

**Files:** `server/src/routes/auth.js`, `server/tests/routes/auth.test.js`,
`docs/ARCHITECTURE.md`, `docs/CLOUD_RUN_STORAGE.md`, this review report.

**Interfaces:** Delivery-enabled reset requests return `{ok:true}` for known and
unknown addresses even if token storage or SES fails. Emit
`password_reset_request_failed` with a fixed stage only, without exception text.

- [ ] Add failing route tests using a failing SES client and failed token store;
  assert equal public responses and no secrets in operational logs.
- [ ] Run focused tests; expected: known account receives 500 before the fix.
- [ ] Catch account-dependent processing failures and log their fixed stage.
- [ ] Run full suites against a disposable PostgreSQL database, lint, client
  build, plugin validation, and Customizer browsers. Expected: all pass.
- [ ] Update documentation and record exact results and real-service/device gaps.
- [ ] Commit, obtain one fresh whole-branch agent review, address confirmed
  findings with regressions, then push the Draft PR branch without merging.
