# plato Architecture — subsystem deep-dives

Detailed design notes and incident history for plato's load-bearing subsystems.
`CLAUDE.md` carries the one-line invariants; this doc carries the *why* and the
*how it broke*. Read the relevant section before changing one of these systems.

## Data & content model

- Login required — all data is server-side, no offline mode. Auth: JWT access
  tokens (15 min) + refresh tokens (30 day), stored in localStorage
  (`plato_auth`). Login accepts email or username. Users have a unique
  `username` (auto-generated if unset, editable, 3–30 chars
  alphanumeric/hyphens/underscores).
- 2 Lambda functions: API Gateway (buffered CRUD) + Function URL (streaming SSE
  for AI chat).
- 5 DynamoDB tables: users, invites, refresh-tokens, sync-data, audit-log.
- Cloud Run uses the same database contract through PostgreSQL in Cloud SQL,
  outside the application containers. `server/start.js` selects the configured
  durable backend; `dev-sqlite.js` is for local development. See
  [Cloud Run storage](CLOUD_RUN_STORAGE.md) for deployment and recovery details.
- Content stored as `_system` sync-data: `prompt:*`, `lesson:*`,
  `knowledgeBase`, `settings`.
- Prompts are bundled in `client/prompts/*.md` and upserted to DB on every
  server startup — admins cannot edit prompts directly.
- User-created lessons stored under the user's own sync-data:
  `lessons:custom-*`. User-created lesson IDs start with `custom-`.
- Classroom branding metadata (colors, name, logo hash) lives in `_system`
  settings. `/v1/branding` returns only this public metadata and a same-origin
  logo URL. Bounded images live separately as `_branding:logo:<sha256>` records,
  outside shared settings and bulk `_system` reads. The public
  `/v1/branding/logo/:hash` endpoint serves image bytes with an ETag, `nosniff`,
  a restrictive CSP sandbox, and `no-cache, must-revalidate`. Logo storage,
  settings publication and deletion of the previous asset commit together in
  `putBrandingSettings`, with an exact settings-version check. A conflict or
  storage failure rolls back every change; restoring a previous logo cannot
  race with delayed cleanup. This uses an immediate SQLite transaction, the
  PostgreSQL `_system` advisory transaction lock, or one DynamoDB transaction.
  Removed assets return 404 even for conditional requests. Copies already
  downloaded or cached under earlier immutable responses cannot be revoked.
  A logo that fails to load shows the classroom name instead.
  No schema migration is required on any database adapter.
- Compatible logos saved by earlier versions stay visible. Stored logos (inline
  legacy values and existing assets) accept data URLs up to 8 MiB and bounded
  static SVG editor metadata/styles. New and stored SVGs share a rendering
  budget: sandboxed image rendering alone does not prevent expensive expansion.
  Unsupported originals remain stored, are omitted from public metadata, and
  return 404 at the image endpoint. Styles shows a recovery notice and an
  attachment download, with replacement/removal controls; blocked bytes never
  enter its previews or Optimize action. The
  next theme save moves a readable inline logo into its own asset, marked
  `legacy`. An inline value that can't be shown, such as a URL, is never deleted
  by an unrelated save; replacing or removing the logo clears it. Sending back
  the current logo unchanged, within the request size limit, is not treated as
  an upload, unless its asset is missing, when it is stored again. The
  Customizer flags raster logos saved by earlier versions, which padded them
  into 512 × 512 squares, and **Optimize logo** trims that padding and prepares
  the logo again. Earlier versions stored SVG files unchanged, so they get no flag.
- The theme write accepts only primary/accent hex colors, an optional trimmed
  classroom name of at most 100 characters of well-formed text without control
  characters, and a PNG/JPEG/WebP/static-SVG base64 image or `null`. First-run
  setup (`/v1/auth/setup` and Google setup) checks the name the same way, and
  the raw `PUT /v1/admin/settings` merge refuses branding fields. Encoded logos
  are capped at 128 KiB, raster dimensions at 4096 pixels per edge and 1024 × 1024
  pixels in area; a request-body limit also bounds parsing. SVG accepts only
  static geometry/text/gradient elements with local references, unique ids, and
  a shared 10,000-unit expansion budget (one per element plus one per 64
  characters of rendering data). References include `<use>` and other hrefs
  under any prefix, local URLs in attributes and supported CSS, and inherited
  fill/stroke resources, including use instances, and explicitly inherited
  masks/clipping paths. Gradients do not instantiate
  geometry. Input structure is limited to 10,000 elements and depth 128; rendering
  data is limited to 128 KiB, excluding inert descriptions/metadata text. Cycles,
  external references (including `image-set`, `image`, and `src`), entities,
  animation, filters, context paints, dynamic CSS, `!important` overrides,
  conditional selectors and unsupported declarations are not displayed. Legacy SVGs may
  retain ordinary editor DOCTYPEs, namespaces and static stylesheets; these
  features stay unavailable to new API uploads. The Customizer
  accepts source files up to 5 MiB and rasterizes them to transparent PNG,
  preserving proportions within 1024 × 128 pixels (vector sources grow to fill
  it), shrinking in halving steps, and further to meet the cap. The classroom
  name is read by code point, so a stored name is never cut inside a character.

## Data migrations

Schema and data changes ship as append-only migrations in
`server/src/lib/migrations.js` (`MIGRATIONS`): today `m003_role_learner`,
`m004_default_program`, `m005_name_split`, and `m006_unit_order`. Every install, self-hosted ones
included, runs them once, on startup. `initializeLaunch()`
(`server/src/lib/launch.js`) awaits them in every entry point, **before**
content seeding and before any request is served: Cloud Run's `start.js`, the
Lambda handler's shared initialization promise (`server/src/index.js`) and
`dev-sqlite.js`.

This differs from upstream, which bounds startup migrations to 20 s and serves
regardless. The fork fails startup rather than serving partly migrated data:
- A migration that finishes with errors throws `Launch migrations failed`, so
  a Cloud Run revision never becomes ready. Lambda clears its initialization
  promise, so the next invocation retries.
- If another instance holds the migration lock, startup waits up to 20 s for it
  to finish, then throws `Timed out waiting for launch migrations`.

A migration is recorded in `_system:migrations.applied` only after it finishes
with zero errors, so a failed one reruns on the next start. The lock lives in the same record. DynamoDB state reads are strongly
consistent; acquisition uses a create-only or strict version-checked write.
Before each marker and release, the runner rereads state, checks the owner,
and uses a strict version write, retrying one conflict. It verifies each marker
before starting the next migration. Lost ownership or a failed/unverified marker
raises `MigrationStateError`; release is attempted without masking the failure.
An operator deleting and recreating the state between a read and write remains
a residual race. The lock records the process owner and release revision.
A release failure after verified markers logs `migration_lock_release_failed`
and returns a stale-lock diagnostic without blocking readiness. A later start
with pending migrations waits for its five-minute expiry; with none pending it
can start immediately. Results log as `migration_applied` / `migration_failed`.
Before m004 receives its marker, a verified repair restores a missing
`programId` only when one program lists that unit. A conflicting or unverified
repair leaves m004 pending and fails readiness, including the apply CLI.
Explicit `programId: null`, names and custom order are preserved. Rehearsals
check the migration outcome and released lock before any seeding or repair;
dry-run reports do not claim verified durable state.

**Rules every migration follows** (from upstream #444):
- **Additive and idempotent.** Add fields or records, or change a value only
  through a conditional write that still sees the exact old value. Never delete
  or rename. Learner work (`messages:*`, `screenshot:*`, `lessonKB:*`,
  `courseProgress:*`, `lessons:*`) is never rewritten.
- **Rollback-compatible with the release being upgraded from** (Beta-RC-232):
  that release's code must keep serving the migrated data, so redeploying it is
  a safe rollback.

**Before merging a migration:**
- `server/tests/migrations/upgrade-from-rc232.test.js` seeds an RC-232-shaped
  fixture (`tests/migrations/fixtures/rc232.js`), runs every migration, and
  fails on any record removed or any change outside its `ALLOWED` list. It
  checks that a second run is a no-op. Then it runs **Beta-RC-232's own route
  handlers** against the migrated database: from `PLATO_RC232_SRC` when CI
  extracted them already (Cloud Build), otherwise extracted from the pinned
  commit (`ROLLBACK_BASELINE` in `lib/migrations.js`; this fork's remote has
  no tags). Without either it fails under `CI` or `PLATO_REQUIRE_RC232`, and
  skips locally with the `git fetch` command that fixes it. ESLint and
  `.dockerignore` skip the extracted `server/.rc232` tree. Extend `ALLOWED`
  and the fixture in the same PR as the migration.
- `node server/scripts/migrate.js` reports, read-only, what each pending
  migration would change on any backend. `--apply` exists for rehearsals on
  restored copies. It exits 1 unless the migrations are actually complete:
  a held or lost lock (`locked`, `lost_race`) means nothing ran, so it isn't
  success, while `none_pending` is. `server/scripts/rehearse-upgrade.js`
  fails the same way, checks that every migration is recorded as applied, and
  requires the second run to report `none_pending`. Both use
  `incompleteMigrations()` (`lib/migrations.js`).

`putSyncData` with no expected version is an unconditional overwrite. Use
`db.createSyncData` when you mean "create only if absent".

## Launch data contracts (2026-11-06)

The upstream launch release (playground `1105f34`, #451) was integrated on
`feat/upstream-launch-integration`. This section lists the data and runtime
contracts it added, and where the fork deliberately differs from upstream.
Feature detail is in the linked sections. This fork has no actual users, so
nothing here describes a live-user migration.

Launch qualification starts with an empty, task-owned application database.
The adapters initialize the current tables, setup creates the initial
administrator and settings, and startup installs the three-lesson Getting
Started course in its final Course–Unit–Lesson structure. The retained migration
registry is idempotent and has no historical learner data to convert on a fresh
installation. Historical backfills and upgrade rehearsals are not required
operator steps for this launch. Existing authored content, settings and
databases are preserved separately; an empty test installation does not reset
an existing environment.

**Records.**

| Record | Holds | Written by |
|---|---|---|
| user `role` | `admin`, `educator`, `learner` or `tester`. A legacy stored `user` reads as `learner` (`normalizeRole`) | role route, signup, `m003_role_learner` |
| user `firstName`, `lastName`, `nameSource` | entered or inferred name parts. `name` stays, derived from them | `server/src/lib/names.js`, `m005_name_split` |
| `_system:program:<id>` | a **Course**: `{ name, description, unitIds }` | `/v1/admin/programs*`, `m004_default_program` |
| `_system:unitOrder:<unitId>` | lesson order: `{ lessonIds, unitCreatedAt }`, stamped with the unit incarnation | unit order route, `m006_unit_order`, bundled seed |
| `_system:course:<id>` | a **Unit**: `{ name, programId, createdAt }` | `/v1/admin/units*`, with `/v1/admin/courses*` as an alias |
| `_system:message:<id>` | a message, its audience and its delivery state | `server/src/lib/messages.js` |
| `<userId>:notify:state` | optOut, bounded read, emailPending, emailed, nudges, lastNudgeAt, lastDigestAt | server only. `/v1/sync` can't write it, and a progress reset keeps it |
| `_system:jobs:schedule` | when each scheduled job last ran | `server/src/lib/schedule.js` |
| `_system:automations`, `_system:emailTemplate:<id>` | automation switches, admin-edited templates | `server/src/routes/admin-notifications.js` |
| `_system:migrations` | applied migrations and the run lock | `server/src/lib/migrations.js` |
| `_system:bundled:*` | install markers for the bundled course and lessons | `server/src/lib/bundled-lessons.js` |

**Adapter parity.** SQLite, PostgreSQL and DynamoDB implement the same
conditional operations:
- `createSyncData(userId, key, data)` creates only if the record is absent. A
  collision throws `ConditionalCheckFailedException`.
- `setUserRoleIf(userId, expected, next)` and
  `setUserNameSplitIf(userId, expectedName, parts)` change the user only while
  it still holds the expected value. They leave `updatedAt` alone and report
  whether they wrote.
- `updateUserProfileIf(userId, expected, updates)` compares the current group
  and complete custom-field map with the supplied snapshot, then updates only
  those profile attributes and `updatedAt`. It returns false on a changed or
  missing account and never recreates a deleted user. Invitation acceptance
  re-reads consistently and retries a lost comparison up to five times, so it
  fills only values still missing at commit. Exhausted contention returns 409
  with the invitation still pending; the response and audit name only fields
  actually filled. Names, roles, credentials and unrelated fields are retained.

PostgreSQL's create-only insert runs inside the existing per-user advisory
transaction. `server/tests/lib/launch-adapters.test.js` proves a single winner
for concurrent first writes on real SQLite and PostgreSQL 17. DynamoDB is
covered by its adapter contract tests, not a live table.

**Decisions read the latest write.** `readAutomations`, `readNotifyState`,
and `updateNotifyState` read strongly consistently, so on DynamoDB an
automation turned off doesn't run once more and an unsubscribe stops the next
email (`server/tests/lib/consistent-decisions.test.js` models replication
lag). SQLite and PostgreSQL are always consistent.

**First writes are create-only.** An absent `notify:state` (an unsubscribe, a
read receipt, a delivery claim), `_system:automations` (the switches), or
`_system:jobs:schedule` is created with `createSyncData` and re-read on a
collision. Two admins turning on different automations at once both keep
their switch. A concurrent first write therefore
can't erase an acknowledged opt-out, and two instances can't both dispatch the
same scheduled job. Upstream used a version-0 upsert, which allowed both.

**Message delivery** (`server/src/lib/messages.js`, upstream behavior in
[Notifications](#notifications-388-389-400)):
- A message's `status` is `sending`, `sent`, `failed` or `closed`. Before it handles any
  recipient, a delivery attempt takes a version-checked execution lease on the
  message record (`deliveryLease: { owner, until }`, 10 minutes, renewed while
  the attempt runs). A competing attempt reports the active one instead of
  finishing the message a second time. An attempt whose lease expired can't
  overwrite a newer attempt's outcome or clear its lease.
- Each recipient is claimed in `notify:state.emailPending[messageId]` before
  the send. The claim moves to `emailed[messageId]` only after the transport
  confirms it. A known transport failure releases only that attempt's own
  claim, so a retry tries the person again. Recipients already emailed are
  skipped.
- Those `emailed` receipts are what stop a retry from emailing someone twice,
  so a message inside its retry window keeps every receipt however many messages follow it. Finished (`sent`, `closed`, or in-app only) messages share a cap of the newest 49 receipts per person. Each attempt reads the current finished states and prunes terminal receipts and claims before growing a recipient's item. Successful finalization also applies the cap. A message absent from the snapshot stays unfinished; terminal cleanup is safe to repeat after interruption.
- An **uncertain** outcome, such as an attempt that died mid-send, keeps its
  pending claim. It isn't resent automatically and isn't counted as delivered.
  Counts can under-report but never double-send: this is at most once, not
  exactly once.
- `POST /v1/admin/notifications/messages` and
  `POST /v1/admin/notifications/messages/:id/retry` return **503**, with the
  stored message, when delivery failed. History shows the outcome counts
  (including "not sent (email delivery disabled)" and "pending confirmation")
  and offers Retry to anyone with `notifications.write`. Composing again with
  the same `requestId` reuses the same message id (`msg_r…`), so it can
  re-dispatch a message that is neither `sent` nor `closed`, but never creates a duplicate.
- Admins with `notifications.write` can choose **Stop retrying** in History (`POST /v1/admin/notifications/messages/:id/close`). This closes a message permanently, prunes its pending claims, and keeps its in-app content and recorded delivery outcomes. An active delivery lease must finish or expire before closing. Incomplete email messages automatically close after 30 days when delivery/history is next accessed; no timer or migration is required. Both delivery claims and the retry route refuse closed messages. A late worker cannot overwrite closure because finalization still requires its durable lease owner and exact version.
- `notify:state.read` accepts only `/^msg_[a-z0-9]{8,40}$/` IDs visible to that caller in `messagesFor`. Each acknowledgement write keeps only that visible set (at most 50), rather than accumulating arbitrary client input. Receipt/read pruning preserves every other field, including `optOut`, `nudges`, `lastNudgeAt` and `lastDigestAt`. No additional key family or storage model is introduced.

The notification composer binds each resolved audience preview to the exact
current audience. A changed, pending or failed preview cannot enable Send or
reuse an earlier count. Confirmation and submission use the same reviewed
audience and message snapshot, so the displayed count cannot describe another
recipient selection. While a send is pending, Compose remains editable. Success clears only the unchanged submitted draft; a newer subject, body or selection stays in Compose with its focus and an acknowledgement naming the sent message. Every acknowledged send rotates the request ID, including when a newer draft is retained. History refreshes in place for a retained draft. The disabled Send button stays focusable.

**Jobs.** On Cloud Run and in local development, `dispatchJob` runs a job in
process and the HTTP request awaits it, because Cloud Run doesn't guarantee CPU
after a response. A large email audience therefore occupies its request: size
the service's request timeout for it. Lambda keeps upstream's asynchronous
self-invocation of the API function (`JOBS_FUNCTION`). Scheduled jobs are
checked by request middleware (`scheduleLaunchJobs`), at most every 10 minutes
per instance, and claimed with a version-checked write.

**Email delivery off.** With `SKIP_EMAIL=true`, nothing is emailed. In-app
messages still reach the bell, email results record
`{ delivered: false, reason: 'email_disabled' }` and count as "not sent", and
an invitation returns its signup link to the admin who sent it. Neither the
link nor the address is logged.

**Lesson export and apply** (`server/src/lib/lesson-rewrite.js`, see
[Rewriting lessons in bulk](#rewriting-lessons-in-bulk-261)). Upstream named
each exported file `<lessonId>.md`, so a stored id such as `../AGENTS` could
write outside the export directory. The fork:
- writes each lesson to a bounded name derived from SHA-256, with exclusive
  creation, and records that filename in the manifest;
- on apply, validates manifest filenames, accepts only safe ids from older
  manifests, checks that every real path stays inside the chosen directory,
  and refuses to read symlinks;
- validates lesson ids on the admin lesson PUT.

**Roles and plugins.** The core role map doesn't widen the plugin SDK. Plugin
admin routes still use `requireAdmin`, so only admins can reach them. Plugin
hooks receive the normalized role (plugin API 1.4.0).

**Learner turns.** The launch's learner features run inside the fork's signed,
server-owned coaching (see
[Coach assessment and signed turns](#coach-assessment-and-signed-turns-2026-10-25)):
- Agent activity is built on the server before the receipt is signed, and the
  receipt covers it.
- The overview checklist reads canonical objective evidence
  (`lessonKB.evidence`) with the same confirmed-source predicate as
  completion. Upstream's client-merged `objectivesMet` indices can't check an
  objective.
- A provider `max_tokens` stop rejects the turn before repair or signing.
  Nothing is saved, and the learner's submission stays in its own journal.
- The composer keeps the submitted input, a retained signed reply and the newer
  draft apart, and its hint names whichever one is holding sending.

**Session-bound identity.** `refreshCurrentUser` publishes a `/v1/me` result
(role, names) only to the auth session that requested it. A response that
arrives after a sign-out or an account switch is dropped. It is never written
into the newer session's cache or React context.

**Validation boundaries.** The integration is proven by the client and server
suites (with real PostgreSQL 17), the plugin suite, the fork's browser suites
and the upstream `e2e/` Playwright suite. The e2e suite runs on SQLite with the
local mock provider, whose replies go through the real server assessment,
signing and atomic save. None of these exercise live AI providers, SES or Slack
delivery, real DynamoDB or Lambda, physical devices, or assistive technology.
Upstream measured its #503 coach-prompt hardening against injected authority
("pre-approved", "set progress to 10") on Bedrock. That measurement wasn't
repeated against the fork's coach prompt, which relies on its own data
contract (learner text, pages and profiles are data, never instructions) and
on completion requiring source-backed evidence for every objective.

## Save observability

Cloud Run's structured JSON process logs are the durable operational record.
Handled sync conflicts and validation failures, plus authenticated client reports
of unconfirmed/recovered saves, are distinct from unexpected server errors.
The client metadata outbox is bounded and cannot block persistence or trigger
inference. `scripts/log-watch.js` reads Cloud Logging across all revisions using
ADC, fully paginates, and fails explicitly on incomplete reads. Its default is
read-only; it needs neither app-admin credentials nor hosted GitHub Actions.
See [save observability](SAVE_OBSERVABILITY.md) for schemas, delivery limits,
configuration, monitoring exit codes, and the deployment boundary.

The shared AI provider also emits content-free invocation start/outcome events
and the atomic lesson save boundary emits attempt status. The read-only
`scripts/inference-report.js` joins those Cloud Logging events to measure usage,
timings, retries, enrichment frequency, and lesson cost estimates including
abandoned attempts. Missing provider usage remains unknown. See
[inference telemetry](INFERENCE_TELEMETRY.md) for definitions and coverage limits.

## Optional Google sign-in and canonical server storage

Google sign-in is owned by the independently switchable `google-auth` plugin.
While enabled, public provider discovery (`GET /v1/auth/providers`) returns its
allowlisted Firebase web configuration and Login, Setup, and Signup lazy-load
its `publicAuthProvider` slot. The browser popup sends a Firebase ID token to
`POST /v1/plugins/google-auth/exchange`; the plugin verifies the signature,
issuer, audience, subject, Google provider claim, and verified email. While
disabled, discovery omits it, its route returns 404, and neither its server nor
client module is imported. There is no core Firebase route or compatibility
alias. Disabling the plugin does not revoke existing plato sessions.

The plugin delegates the verified identity to core `completeExternalAuth`.
Core alone performs account lookup/creation, invitation checks, role assignment,
classroom setup, `userCreated` hooks (including Slack), and plato token issuance.
A verified email that matches an existing account signs in to it. A new account
needs an invitation, as password signup does: an invite token (email or link) or
a pending email invite for that address, whose profile it takes. The one
exception is the operator's `ADMIN_EMAIL`, which may create its own account and
is the only address made an admin; no address is hard-coded anywhere. Anyone
else gets `403 { code: 'invite_required', email, name, waitlisted, inviteExpired }`
and nothing is created or consumed, so a wait-list entry stays for an admin to
invite. Google has verified the address, so telling its owner where they stand
reveals nothing about anyone else. The sign-in page then replaces its form with
the invitation page (`InviteRequired`): it names the address, says whether the
person is on the wait list or holds an expired invitation, and offers **Join the
wait list**, prefilled with Google's email and name, when the list is open.

Google and password sessions use the same server storage paths. `storage.js`
only writes through the API and caches acknowledged atomic lesson commits.
`sync.js` replaces cached state with the current server response; no Firestore
backfill, subscription, profile initialization, or mirror write remains.
The retired `firebaseClient.js` module is removed. `firestore.rules` denies all
client access, including former owners/admins, and `firebase.json` targets only
the named Plato database. Keep the Firebase project and its unrelated databases.
See [Firestore retirement](FIRESTORE_RETIREMENT.md) for inventory evidence,
local rules testing, cutover order, and publication status.

- **Firebase Auth is plugin-lazy.** Only an enabled provider's client chunk can
  import Firebase. The plugin opens the popup synchronously from the click and
  signs out Firebase's temporary browser state after every exchange attempt,
  including rejected admissions and failures. Ordinary plato logout and refresh
  never import Firebase or probe its IndexedDB state.
- **Password reset is plato's.** `/forgot-password` uses the server's
  `POST /v1/auth/forgot-password` endpoint. Firebase resets are not used for
  plato password accounts. With delivery enabled, the public endpoint returns
  HTTP 200 `{ok:true}` for known and unknown addresses even if account lookup,
  token storage or email delivery fails. Failures log
  `password_reset_request_failed` with a fixed stage only, without addresses,
  tokens, links or provider exception text. This response is not confirmation
  of delivery and does not promise equal response timing. Reset links are
  single-use, and completing a reset
  revokes every existing refresh session for the account on all three
  database backends, so learners on other devices are signed out. Changing
  the password in Settings (`PATCH /v1/me`) revokes them the same way, then
  returns a `session` token pair bound to the new credential. The client
  saves that pair, so only the device that made the change stays signed in.
  Refresh rotation consumes the old token atomically: only the request that
  deletes the stored row may issue its replacement, and reset tokens are never
  accepted as refresh tokens. New refresh tokens carry a SHA-256 fingerprint
  of the password hash used at issuance, never a second copy of that hash.
  Refresh checks that fingerprint against the current user credential, using
  a strongly consistent user read on DynamoDB. Legacy tokens are read before
  the user lookup and consumed after it; a reset therefore deletes the old
  token or invalidates its credential-bound replacement. A refresh that
  observes a credential change after storing its replacement removes it and
  returns 401. A login already in progress may finish with an access JWT, but
  its old-credential refresh token cannot continue after reset. Existing
  access JWTs keep their normal 15-minute expiry.
  DynamoDB revocation uses a strongly consistent, paginated scan of the token
  table and bounded retries for unprocessed batch deletes. An eventually
  consistent index is not sufficient for this security boundary; exhausted
  retries fail explicitly.

Sign-in attempts share a non-secret `plato_auth_attempt` localStorage record
containing a cryptographically random `attemptId` and local diagnostic epoch.
Password submit, signup before account creation, setup before its request, and
validated external-provider starts all claim an intent. A later start cancels
older attempts even when the later popup is cancelled. Begin, commit, and
logout/invalidation take the exclusive Web Lock `plato:auth-session`; commit
re-reads the intent immediately before its synchronous credential write.
Web Locks serialize callbacks, but localStorage visibility can lag across
renderer processes by milliseconds: that residual cross-process window is an
accepted limitation, not a claim of transactional storage. Without Web Locks
(for example insecure LAN HTTP), a per-tab guard plus the stored intent is used
and the client emits `auth_coordination_unavailable` in its console. This
fallback does not provide full cross-process serialization.

`plato_auth` remains the sole credential record. New sessions store their
`attemptId` alongside tokens, user, and provider in one replacement write;
legacy records without an attempt ID remain valid. Refresh rotations, password
changes, and profile refreshes preserve the ID and retain their exact-token
compare-and-replace guards outside the lock. Stale password and external
completions reject with `stale_auth_exchange` and explain that another sign-in
or sign-out started in this browser. Their own unused refresh token is revoked
outside the lock, best effort, with a five-second deadline.

Sign-out immediately fences module-local requests and protected React state.
Credential snapshot/removal waits for the same lock, then remote revocation
uses the removed token outside the lock without delaying local sign-out.
The same-tab session generation still fences requests and React publications.
Storage events read one complete current credential record, ignoring stale
event payloads; only a committed attempt/user change or removal advances that
generation. Token rotations and profile rewrites therefore leave sibling-tab
requests running. Same-user logout/relogin changes the committed attempt and
invalidates old requests and delayed React publications.

A cross-tab identity change clears the shared sync cache, blocks further
requests from the old page, unmounts classroom children, and hard-navigates to
`/lessons` for a new session or `/login` on sign-out. This prevents mounted old
account drafts, including cleanup saves without an explicit owner, from writing
as the next account. Mounted Login, Signup, and Setup screens register their
public-auth ownership with AuthContext, independent of URL or saved session
state. First-run Setup can occupy the wildcard route, including `/`. These
screens are kept mounted with cleared auth state: a pending exchange must be
allowed to finish so its unused token can be revoked and its stale-sign-in error
shown. They do
not publish the other tab's account into mounted UI or automatically navigate;
a fresh local sign-in or reload establishes their next session.

Credential adoption succeeds only after the synchronous `plato_auth` write
commits inside the auth lock. A denied write leaves the previous record and
React account intact, throws `auth_storage_unavailable`, and revokes the newly
issued unused refresh token outside the lock. A completed setup whose adoption
fails directs the admin to sign in; it does not offer another account creation.
Initialization always settles its loading state. Invalid session records are
rechecked under the lock and discarded without removing owner-scoped drafts;
malformed or matching stale coordination records are removed too, while a valid
newer pending intent survives. Complete legacy sessions without `attemptId`
remain valid.

Legacy Firebase-provider probing cannot delay local
sign-out or overwrite a newer provider decision. Firebase detection/import is
bounded to five seconds, and stale cleanup is skipped after another login
starts. Once an SDK sign-out has actually started, another Google popup is
rejected with a retry message until that SDK operation settles; password login
remains available. Cleanup first awaits Firebase Auth restoration, so a cold SDK cannot skip a
persisted Google user that is still loading. This prevents late SDK cleanup from
signing out a new Google account without delaying local sign-out.

## Client loading

The login page, lesson list, and lesson conversation ship in the entry bundle.
Everything else (admin, settings, signup, setup, password reset, wait list,
privacy) is a lazy route with a spinner fallback, and `ErrorBoundary` recovers
when a chunk is stale after a deploy. `App` starts the `/v1/branding` request at
boot alongside the setup check. `client/src/lib/publicBranding.js` shares that
one request between auth pages (`usePublicBranding`) and the classroom
(`BrandingProvider`), caches the result for the page session, and doesn't cache
failures. Auth pages apply the cached colors in a layout effect, before first
paint, so they never flash plato's default purple. Saving in the Customizer
replaces the cache with the acknowledged metadata. A request generation prevents
older in-flight requests, including their original callers, from restoring stale
branding after a save. Logo loading no longer delays the metadata response.

The Customizer loads Appearance and Program knowledge independently, with per-tab retry.
Appearance tracks edits against its last acknowledged save; discard restores that
snapshot, and reset stages the seeded defaults for an explicit Save. A data-router
navigation blocker protects links and browser history, and `beforeunload` protects
reloads/closing the page. The existing route tree remains in `App`. Knowledge
viewer/editor state is derived from `/plato/customizer/knowledge/edit`; `?mode=text`
opens direct text editing without starting an assistant request.
An omitted accent, or one equal to the primary, means “Match primary”; new
classrooms use that mode, while a different saved accent stays independent.
Unmatching starts the accent from the color it was showing, and an accent equal
to the primary is saved as Match primary. Save sends only the fields that would
publish something different, so an unchanged logo is never resent and a stale
form can't overwrite another admin's name or logo, then reloads the saved styles
so the form shows the server's state. Colors use `themePatch`: omitted primary
or accent leaves the latest value untouched, while `accent:null` explicitly
selects Match primary. The older `theme` request remains a full replacement;
using both forms in one request is rejected. Same-field edits still use the
last accepted value, while independent edits are preserved. Edits that publish nothing (trailing
spaces, a matched accent) don't count as unsaved. Both
previews use real button styles, classroom identity, and isolated light/dark
tokens; their sample controls are inert. Partial hex input keeps the last
complete color until blur or Save accepts a shorthand value, with or without the
`#`. Pressing an action button keeps focus in a hex field, so committing a
shorthand value can't reflow the button away before the click lands.

Knowledge Base conversation drafts mark turns after the last publication as
`unpublished`. Before publishing the reviewed Markdown, the editor waits for
all draft requests tracked by the current browser application to settle,
including requests from an earlier editor mount. A rejected draft still allows
the explicit save to publish the complete current conversation. This barrier
orders local requests; it does not coordinate independent tabs or administrators.
Once publication is acknowledged, the Customizer shows that content and
navigates immediately. A background GET refreshes attribution/timestamps,
retains the acknowledged content on failure, and never initiates navigation.

The shared lesson Markdown parser recognizes section headings only outside
backtick or tilde fences. It accepts the renderer's container indentation and
recognizes CRLF boundaries without changing the preserved section body, so
example headings do not become descriptions or hide later objectives.

Invitation and reset emails use the validated primary with the same WCAG
foreground selection as the classroom; a primary under 3:1 against white gets a
visible header and button edge, and the footer is #666 (5.7:1). All inserted
names are HTML escaped and made well-formed, since a lone surrogate makes the
SES SDK's encoding throw. The SES display name stays plain for simple names,
is quoted for other ASCII, and otherwise uses bounded UTF-8 MIME words; only the
address of a `Name <address>` sender setting is used. Subject and body declare
UTF-8. The current `classroomName` takes precedence over the legacy `logoAlt` field.

The light/dark choice works the same way. The header's **Dark mode** toggle
(`ThemeToggle`) puts `.dark` on `<html>` and saves `plato_theme` in
localStorage. Below 30rem the same choice is a checkbox item in the account
menu, and the sign-in page has its own toggle; all of them read one store
(`subscribeTheme` in `client/src/lib/theme.js`, through `useTheme`), whose
single storage listener follows a choice made in another tab. An inline script
in `client/index.html` reapplies the choice before the bundle loads, so a dark
page never flashes light. That script and
`client/src/lib/theme.js` must share the key; `client/tests/theme.test.js` runs
the script to hold them together. With no saved choice, the first paint and the
theme store follow `prefers-color-scheme`, including later device changes;
`main.jsx` keeps one subscription for the page's life, so pages without a theme
control follow them too. An
explicit light/dark choice takes precedence, even if storage is unavailable for
the current page session. Clearing the saved choice resumes device following.

A classroom's dark colors are derived, not configured. `buildThemeVars`
(`client/src/lib/branding.js`) computes a dark header, fill, learner bubble,
text color, and surface tint from the saved primary and sets them as
`--classroom-*-dark` variables beside the light ones; `index.css` applies them
under `.dark .classroom-theme`. The bubble is the fill unless the fill would
carry dark text, since a pale fill glares across a whole message; then it
deepens until white text reads on it. Two rules hold that cascade together. A custom
property resolves where it is declared, so the tinted surface tokens are
declared again on every `.classroom-theme` element; declared once on `.dark`,
they would keep plato's hue. `--bubble: var(--primary)` is likewise declared
on each `.classroom-theme`, or a Customizer preview's bubble would take the
admin page's fill instead of the preview's. And the dark `--primary` and `--ring` are
`!important`, because `buildThemeVars` also sets the light ones inline on the
same element. `.light` re-declares the light tokens for the Customizer's light
preview inside a dark page, and the classroom's dark rules skip anything inside
it (`:not(.light *)`).

Lesson loading distinguishes a successful empty classroom from an unavailable
`/v1/lessons` response. `AppContext` uses one load path for startup, foreground
refresh, and manual retry. A failed refresh preserves the last rendered lessons
and displays an error with **Try again**. Retry invalidates the lesson cache;
failed requests are never cached as empty lists. Request generations prevent an
older load from replacing the active cache or updating state
after logout. Optional course-agent catalog context falls back to an empty list
during an outage, so it does not block completion updates. Retrying
parks focus on the lesson heading so removing the error banner keeps focus in
the classroom.

## AI agents

9 AI agents, all sharing the admin-selected provider and model (prompt files in
`client/prompts/`; see [AI provider & model choice](#ai-provider--model-choice)).
Each prompt file has an HTML comment header documenting what it reads, who calls
it, and its purpose:

- **coach** — Reads: lesson prompt, lesson KB, learner profile, program KB, course name + cross-lesson progress note. The main learner-facing agent.
- **lesson-creator** — Reads: program KB. Helps admins design lessons via conversation (and is aware lessons can belong to a persistent course).
- **lesson-owner** — Reads: lesson prompt, learner profile. Initializes per-lesson KB.
- **lesson-extractor** — Reads: conversation text only. Extracts lesson markdown from creation chat.
- **knowledge-base-editor** — Reads: program KB. Helps admins create/edit the KB via conversation.
- **knowledge-base-extractor** — Reads: existing KB + conversation. Merges changes into updated KB markdown. **Summarizes, doesn't transcribe** — it produces a concise reference (a few KB), because the full KB is re-appended to every coach turn and an unbounded KB overflows the context window (and silently truncates against the extractor's own `maxTokens`). The editor (`AdminCustomizer`/`AdminKBSetup`) windows live turns to the last 15, like the lesson creator.
- **learner-profile-owner** — Reads: learner profile, lesson KB. Full profile update on lesson completion. Only revises the "soft" fields (name, goal, strengths, weaknesses, preferences, summary); `masteredLessons`/`activeLessons` are **stripped from its input and not requested in its output** — they are system-managed bookkeeping arrays that grow without bound, and `mergeProfile` reunions them from the stored profile. The completion path records the just-mastered `lessonId` in code (`profileQueue.js`). Echoing those arrays used to inflate the agent's JSON past `maxTokens`, truncating it into an unparseable response (#228).
- **learner-profile-update** — Reads: learner profile (minus the bookkeeping arrays), activity context. Incremental profile updates during lessons; same soft-fields-only contract as `learner-profile-owner`.
- **course-progress-update** — Reads: prior course summary, just-completed lesson KB, course lesson list. Maintains the per-learner `courseProgress:<courseId>` note injected into the coach as `course.progress`.

Context assembled at runtime (server `lesson-coaching.js` for the coach;
`client/js/orchestrator.js` for authoring agents):

- **Program Knowledge Base** appended to agent system prompts for agents in `KB_AGENTS`.
- **Lesson Catalog**: lessons the learner can access for coaching; finalized
  public/private lessons with `[PRIVATE]` tags for authoring agents. Drafts are
  excluded.
- Knowledge base is created/edited by admins via the KB Editor agent in the
  Customizer (not directly editable).

### Learner language (#240)

Every agent writes in the learner's browser language (`navigator.languages[0]`
/ `navigator.language`). `client/js/language.js` maps the code to a language
name and `withLanguage()` appends a `## Language` section to each of the 9
agents' system prompts in `orchestrator.js`. Rules:

- **English or an unmapped language adds nothing**, so English learners'
  prompts are byte-for-byte what they were. Unknown codes fall back to
  English rather than guessing.
- **The directive names every literal plato parses out of agent output** as
  "keep in English": the bracketed tags (`[PROGRESS: N]`, `[KB_UPDATE:]`,
  `[PROFILE_UPDATE:]`, `[READINESS: N]`, `[DRAFT]`), JSON keys and fixed values
  (`"status": "active"`), lesson markdown headings (`## Learning Objectives`,
  `## Exemplar`, `## Coach Directive`), and the `- Can ` objective prefix that
  `validateLessonMarkdown` requires. A translated tag or heading would break
  parsing silently, so if you add a new parsed literal to a prompt, add it to
  the directive too.
- Admin-side agents (lesson creator/extractor, KB editor/extractor) follow
  the *admin's* browser, so lessons and the KB are authored in that language.
- Verified against Qwen3-VL on Bedrock (Spanish, 3 runs × 7 agents, outputs
  run through plato's own parsers): all tags, JSON, headings, and `- Can `
  objectives parsed; prose came back in Spanish. Internal KB fields the coach
  reads but learners never see (`evidence`, `learnerPosition`) sometimes stay
  English because their input (the lesson) is English — harmless.

## AI provider & model choice

plato runs **one model for all nine agents** — no per-agent routing. Admins
choose **Amazon Bedrock** or **Cloudflare Workers AI** at `/plato/ai`. The
admin-only `/v1/admin/ai-settings` API stores `{ provider, workersAiModel }` in
`_system:ai-settings`, separately from branding and other settings. Saves use
strict version checks. Every inference consistently reads the saved selection
once, so it applies to the next request across server instances without changing
an in-flight stream. No provider fallback occurs.

AI Settings retains unsaved provider/model choices in administrator-scoped
session storage, with an in-memory navigation fallback when storage is blocked.
Drafts contain only the settings version and selections; they are never
automatically saved and cannot rebase onto a newer server version. Confirmed
Save and explicit discard clear ordinary and OAuth-handoff snapshots. Page
departure invalidates asynchronous UI continuations, including authorization
redirects. Complete API responses are checked before replacing the form, and
connection completion messages require refreshed, explicit OAuth status.

`server/src/lib/ai-provider.js` routes both invocation modes and plugin calls
through the selected adapter. `LLM` / `ctx.LLM` remain compatibility hints;
browser and plugin model arguments do not override the admin choice.
Before the first save, `AI_PROVIDER` and `WORKERS_AI_MODEL` supply optional
defaults. Existing installations default to Bedrock, so a deployment without AWS
credentials, such as Cloud Run, needs `AI_PROVIDER=workers-ai` or a saved
selection. Otherwise every request goes to Bedrock and fails. AI Settings warns
when the server shows no AWS credential source. The check looks at environment
variables and shared credential files only, so it can't see an EC2 instance role.
It warns and never blocks.

A failed invocation logs `ai_provider_error` (WARN) beside `inference_finished`,
with content-free diagnostics ([INFERENCE_TELEMETRY.md](INFERENCE_TELEMETRY.md#failure-diagnostics)).
So does a selection that can't be read, such as an invalid `AI_PROVIDER`
(`stage: settings`).
Only configuration states an administrator must fix are reported to the browser
as `ai_unavailable`. A Workers AI credential read that fails temporarily or
unexpectedly reports `ai_overloaded` or `ai_error` instead
([CLOUDFLARE_OAUTH.md](CLOUDFLARE_OAUTH.md#when-ai-requests-fail)).

Bedrock uses **`qwen.qwen3-vl-235b-a22b`** and the AWS credential chain.
Workers AI defaults to **`@cf/deepseek-ai/deepseek-v4.1-flash-1017`**, hosted by
Cloudflare, with **`reasoning_effort: 'max'`** on every request. Mistral Small 3.1
24B is an optional non-reasoning model. The server maintains the supported-model
allowlist in `ai-settings.js`; model IDs cannot redirect inference to external
providers. Both choices support images.

`workers-ai.js` calls Cloudflare's Chat Completions endpoint using the connected
OAuth account, or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the
server environment when no browser connection is active. An expired or invalid
OAuth connection fails explicitly instead of switching accounts through the
environment fallback. Settings responses expose credential-presence booleans,
connection state and authorized account names/IDs; they never expose tokens.
SAM passes the optional manual and OAuth configuration to both Lambda functions.

The browser connection begins with an authenticated admin POST. Cloudflare's
public redirect callback at `/v1/oauth/cloudflare/callback` validates a random
state, a host-only HttpOnly SameSite=Lax cookie and an expiring server transaction,
then rechecks the initiating user's admin role. A strict version write consumes
the transaction before the PKCE code exchange. All provider endpoints and return
paths are fixed. Invalid callbacks cannot clear another attempt's cookie.
The account selector accepts only accounts returned by Cloudflare for that grant.

`cloudflare-oauth.js` stores AES-256-GCM encrypted tokens and PKCE verifiers under
the reserved `_integrations` database principal, separately from `_system:ai-settings`
and user sync records. The stable encryption key is supplied by the server owner;
there is no development-key fallback. Database reads are strongly consistent and
all writes use strict versions. A database lease coordinates refresh-token rotation
across instances. Ambiguous refresh failures require reconnect rather than retrying
a potentially rotated token. A renewal that never opened a connection to Cloudflare
didn't send the token, so it keeps the connection; after a 30-second pause, the next
request renews. The request that disables a connection logs
`cloudflare_oauth_reconnect_required` once.
Failed refresh credentials remain encrypted solely for explicit revocation. Disconnect first disables local access with a versioned
tombstone, then revokes the grant; failed revocation remains visible and retryable.
Late callbacks and refresh completions cannot restore a disconnected connection.
Issued credentials have a unique encrypted cleanup record until ownership passes
to the active connection. Replacement and disconnect preserve independent copies
before changing that connection; failed and late revocations remain retryable.
Account activation claims its flow conditionally, and cleanup must claim that
same flow before revoking an expired pending grant. Cleanup rechecks active
ownership after taking its lease and never disconnects a newer connection. The
user-sync view-as-user API rejects reserved server principals, including
`_integrations` and `_system`.
See [Cloudflare OAuth setup](CLOUDFLARE_OAUTH.md) for registration and deployment.

The adapter translates system prompts, text, and base64 images into Chat
Completions messages and converts responses/SSE back into the existing Messages
wire format. Reasoning traces never enter visible replies or tag parsing.
DeepSeek gets 8,192 additional completion tokens for reasoning on top of the
caller's existing output budget. Both adapters have a 115-second timeout.
Partial, malformed, and reasoning-only Cloudflare streams fail explicitly;
they do not become successful empty replies. The admin connection test makes
a small non-streaming request without saving or activating the draft settings.

### Historical Bedrock model selection

The following evaluation describes the original Bedrock deployment. Its
Bedrock-only constraint no longer applies to installations selecting Workers AI.
Cloudflare models need separate coaching/tag-compliance evaluation; the earlier
Bedrock results do not qualify them.

Selected against the models available on Bedrock in us-east-2 by applying four
constraints in the following order — the fourth is what ultimately decides it:

1. **Bedrock-only is an institutional requirement** (UIC). Published weights are
   irrelevant if AWS doesn't host the SKU in our region — the Bedrock catalog,
   not the open-weight ecosystem, defines the candidate pool. It also means
   third-party latency benchmarks don't transfer; latency is a property of the
   host.
2. **Image input is a hard filter.** Learners paste screenshots into the coach
   (`metadata.imageKeys`), so a text-only model can't serve plato at all. Of the
   43 open-weight model IDs in us-east-2, only 12 accept `IMAGE`, and most of
   those are small (Ministral 3B–14B, Nemotron Nano, Palmyra Vision 7B, Gemma 3
   4B/12B). That rules out GLM 5, DeepSeek V3.2, gpt-oss, Nemotron Super,
   MiniMax, plain Qwen3-235B, Llama 3.3, and `kimi-k2-thinking` regardless of
   how they score.
3. **Reasoning models are disqualified.** plato's contract is *literal tags in
   visible text* — `[PROGRESS: n]`, `[KB_UPDATE: {…}]`, `[PROFILE_UPDATE: {…}]`,
   parsed by regex plus a brace-walk in `lessonEngine.js`. Models that emit
   `reasoningContent` spend output budget on traces that never reach the parser.
4. **Tag compliance and completion filter the rest.** Measured against the real
   `coach.md` across five scenarios: Qwen3-VL hit 3/3 on the required
   `[PROGRESS]`+`[KB_UPDATE]` pair and awarded `10` on 5/5 exemplar-achieved
   trials (plato completes a lesson only at `progress >= 10`). Gemma 3 27B
   dropped a `[PROGRESS]` tag (2/3). Mistral Large 3 and Pixtral Large failed
   outright — Mistral called a solid red image "black".
5. **The license must be OSI-approved — and this decides it.** plato is
   **AGPL-3.0**; the goal was an *open source* model, not merely an open-weight
   one. "Open weight" only means the parameters download. The **Llama 4 Community
   License** (700M-MAU threshold, acceptable-use policy, "Built with Llama"
   naming) and the **Gemma Terms of Use** both fail the Open Source Definition on
   field-of-use and non-discrimination grounds and are not OSI-approved.
   **Qwen3-VL's Apache-2.0 is the only OSI-approved license in the eligible set**,
   which leaves the set with exactly one member.

   Don't re-derive this as a liability question. Because plato calls Bedrock and
   never redistributes weights, the Llama clauses are close to inert *as legal
   exposure* — that reasoning nearly selected Llama 4 on an earlier draft. The bar
   is definitional (is the model open source?), not a risk assessment.

Note when scoring tag compliance: `[PROGRESS]` and `[KB_UPDATE]` are required
every response, but `[PROFILE_UPDATE]` is **conditional** on the learner
revealing something. Scoring all three as mandatory produces false failures.

**The trade this makes:** `us.meta.llama4-maverick-17b-instruct-v1:0` measured
faster (p50 526 ms vs ~1.1 s TTFT), cheaper, with no observed latency tail, and
equal on every correctness measure — but it is **license-ineligible**. It is the
tested one-line fallback if Qwen's tail becomes a production problem; taking it
means **knowingly dropping below the open source bar**, so treat that as a
conscious, documented trade rather than a config tweak. Against the incumbent
Haiku the eligible choice costs only ~100 ms of p50 latency and saves 1.9× on
cost, so open source did not mean a worse product.

**Latency caveat:** Qwen3-VL's p50 TTFT is ~1 s, but two ad-hoc runs saw **47 s**
and **36 s** on the same payload. Neither reproduced across 30 controlled
samples, so the frequency is unmeasured. Watch for >5 s TTFT in the log-watch
alarm.

**Known limitation, not model-specific:** no model tested — including Haiku 4.5 —
reliably detects learner *regression*. Given a retraction from `progress: 8`,
Gemma scored 4/2/2 (appropriate), Haiku 5/6/4, Qwen3-VL 7/5/5, Llama 4 7/7/7.
That's a `coach.md` prompt weakness, independent of which model runs behind it.

Any replacement model must clear all five bars above — including the license one.
Anthropic model IDs stay in `MODEL_MAP`, so falling back to Claude is a one-line
`LLM` change, with the same open-source caveat as Llama 4 (more so — Haiku is
proprietary). Full evaluation, tables, and rejected candidates:
[`docs/MODEL_SELECTION.md`](MODEL_SELECTION.md).

### Why the Converse API

Non-Anthropic Bedrock models are only reachable through **Converse /
ConverseStream**. This matters because the legacy `InvokeModel` path does **not**
reject them: called with `qwen.*` or `openai.*`, it returns **HTTP 200** with an
OpenAI-shaped body (`choices[0].message.content`), so callers reading
`content[0].text` silently get `undefined`. A wrong-API mistake here fails
quietly, not loudly.

Rather than teach every caller a second dialect, plato keeps the **Anthropic
Messages shape as its internal wire format** and translates only at the Bedrock
boundary, in `server/src/lib/converse.js`:

- Request: `{ max_tokens, system, messages }` → `{ inferenceConfig.maxTokens,
  system: [{text}], messages: [{role, content: [{text} | {image}]}] }`. Base64
  image blocks are decoded to bytes and their media type mapped to a Converse
  `format`.
- Response: `output.message.content[]` → `{ content: [{type:'text', text}],
  usage: {input_tokens, output_tokens}, stop_reason }`. Multiple text blocks are
  **concatenated** so a tag split across blocks still parses; `reasoningContent`
  blocks are dropped.
- Stream: `contentBlockDelta` → `content_block_delta` / `text_delta`, which is
  the only event shape `parseSSEStream` in `client/js/api.js` matches on.

Converse event order was verified identical for Anthropic and open-weight
models (`messageStart → contentBlockDelta* → contentBlockStop → messageStop →
metadata`), so no per-provider chunk handling is needed. Because the translation
is pure functions with no AWS SDK dependency, it's unit-tested without network
access (`server/tests/lib/converse.test.js`).

Converse authorizes under the same `bedrock:InvokeModel` /
`bedrock:InvokeModelWithResponseStream` IAM actions, so `template.yaml` needed no
change.

### No prompt caching

Prompt caching is **Claude-exclusive on Bedrock**. Verified: Haiku 4.5 accepts
`cachePoint`, while Qwen3, Kimi K2.5, DeepSeek v3.2, GLM 5, and gpt-oss-120b all
hard-error with `AccessDeniedException: You invoked an unsupported model or your
request did not allow prompt caching`. Do not add cache-point plumbing while
plato runs a non-Anthropic model — it cannot work. (For the record, Claude's
minimum cacheable prefix is 4096 tokens, and `coach.md` alone is ~3,685 — below
the floor, where Bedrock silently no-ops rather than erroring.)

### Cost

Qwen3-VL is **~2.2× cheaper** than Haiku 4.5: $0.53/$2.66 per 1M input/output
tokens versus $1.00/$5.00. At measured token counts that's ~$0.040 per
16-exchange lesson versus ~$0.088. Note that Haiku 4.5 is absent from the AWS
Pricing API, so its rate is the Anthropic first-party price used as a proxy,
while Qwen3-VL's is real us-east-2 on-demand.

**Latency is the trade, not cost.** Measured on the real `coach.md` payload,
Qwen3-VL's time-to-first-token is roughly 2–6 s against Haiku's ~1.3–3.8 s, and
it is less consistent — one observed outlier hit 47 s TTFT. Streaming hides some
of this, and `BEDROCK_TIMEOUT_MS` (115 s) still bounds the worst case, but the
tail is real and worth watching in the log-watch alarm.

### Errors shown to users

A failed AI call should say what failed and what to do next, and never echo
provider internals. On either invocation mode, `server/src/routes/ai.js` classifies
the provider error with `server/src/lib/ai-errors.js` into a stable code
(`ai_unavailable`, `ai_rate_limited`, `ai_overloaded`, `ai_timeout`,
`ai_invalid_request`, `ai_error`) and streams
`{ type: 'error', error: { code, message } }` with a generic message for streams
(or `{ code, error }` with a classified HTTP status for ordinary requests), because raw
AWS text can include the account ID and IAM role name. Server streaming logs keep the
error. The empty-content guard answers with `code: 'empty_message'`.
Missing credentials or model access are not retried as transient overloads.
Closing a streaming response aborts the upstream provider request.

The client must surface these. `parseSSEStream` throws on an error event, and
`converseStream` drops empty turns before sending and treats an empty reply as
a failure. Before this, a failed stream looked like an empty reply: the admin
chats kept it as a blank turn, and the next send failed with the guard's
"messages must have non-empty content" instead of the real cause.

`client/src/lib/aiErrors.js` maps the code, plus the surface that made the call,
to the copy each page shows. Learners get plain language; admins also get the
configuration hint pointing to Admin → AI Settings. Errors that don't come
from an AI call keep their own message. Add a surface there when a new page
calls an agent.

## Image & conversation persistence (#191, #193)

Unsent composer text, images, and link context are stored in the current tab under
an encoded account and lesson key (`plato_lesson_draft:<userId>:<lessonId>`).
Existing account-scoped text in `plato_compose_draft_v2:<userId>:<lessonId>` is
restored when no rich draft exists, and removed only after the rich draft passes
readback verification. An explicit empty rich draft takes precedence over old
text. Neither namespace can collide with legacy lesson-only keys, including IDs
containing colons.
`LessonChat` remounts when
the account, impersonated account, or lesson changes and initializes from only
that owner's draft. Read-only impersonation never reads or writes a composer
draft. Sign-out preserves these drafts for the owner's next login in the same
tab. Older lesson-only draft keys have no reliable owner: they remain intact in
storage but are never automatically restored or assigned to an account.
The composer reports whether its current draft passed storage readback. A failed
write keeps the exact draft in memory and shows a persistent warning to keep the
tab open, with **Retry keeping draft** and **Copy draft text**. Retrying verifies
the full draft, including attachments; copying text does not back up attachments.
Only a verified retry or later successful edit clears the warning. This is tab
recovery, not server persistence, and cannot protect a failed write if the page
is reloaded or closed before recovery succeeds.
A nonempty draft whose retention failed also activates the existing unload
warning. The warning clears after verified retention; browsers may suppress
native prompts, and OS termination or mobile tab discard is not protected.

A learner's chat history for a lesson lives in one `messages:<lessonId>`
sync-data record; progress lives separately in `lessonKB:<lessonId>`.
Generated learner turns commit both records together through
`POST /v1/sync/lesson-turn/:lessonId` (a PostgreSQL/SQLite transaction or DynamoDB
`TransactWrite`). The engine first reads a consistent snapshot through the GET of that endpoint.
`POST /v1/ai/coach/:lessonId` loads the authorized lesson, profile and saved
history on the server, generates once, applies the shared assessment contract,
and returns stable turn/message IDs with a signed receipt. The commit compares the original versions, values, and
reset generation; it never merges a stale turn over another session's work.
An exact replay acknowledges the existing messages without appending again
or reapplying completion effects. Sync deletes of either lesson record rotate
an internal `lessonGeneration:<lessonId>` marker, so a retained opening cannot
recreate a lesson after a reset even when both records are missing again.

Before requesting the commit, `generatedTurns` stores the exact output and
base snapshot in memory and in account/lesson-scoped `sessionStorage`.
`LessonChat` displays an unconfirmed reply with **Retry saving**, blocks another
Send, and restores the retained conversation after navigation or reload in the
same tab. `retryLessonSave` only submits that retained turn; it never calls any
model, reapplies tags, or rebuilds the reply. Unknown save outcomes retain the
same IDs. Conflicts preserve the copy and require an explicit discard to load
the current saved conversation. The browser cache receives a generated turn only
after the authoritative API acknowledges it.
Save retries share the account/lesson request registry with initial submissions.
Reopening while a retry is in flight waits for its result, so the new view cannot
keep an obsolete failure after a successful retry. A failed retry still exposes
the retained turn and its persistence-only recovery action.

Save confirmations are transient UI state, separate from transcript messages
and coach request context. After the submitted input passes recovery-journal
readback, “Your reply is saved in this tab.” pulses once and fades over 1.6
seconds before the coach's text is revealed. Generation and server saving run
during this brief acknowledgment; a normal server save does not repeat it.
After retrying a failed save, “Your reply is saved.” appears only on server
acknowledgment and fades on the same timer. Starting another response clears
the previous confirmation immediately. Reduced motion uses only the fade.
Save failures, retry controls and changed-requirements notices stay visible.
Separate composer feedback distinguishes waiting for the coach, **Saving
progress…**, **Progress saved.**, and unconfirmed saves. The submission store's
`saving` phase begins when the generated turn enters persistence, so a reopened
view also observes it. Server acknowledgment drives the saved state; the
local-input acknowledgment alone never does. This feedback is not transcript
content and does not change generation, commit, or retry semantics.

The local journal remains scoped to the current tab/session. The server also
retains the latest generated result for each learner/lesson, recovered through
`GET /v1/ai/coach/:lessonId?turnId=...` without inference. Compressed fragments
are each at most 300,000 ASCII bytes so the combined base, conversation and KB
cannot exceed a DynamoDB item limit. A manifest is published after its fragments,
and strongly consistent reads check its digest and signed receipt. A small
`coachAttempt:<lessonId>` marker lets clear-all resets fence in-flight openings
before any conversation or assessment has committed. When local storage is unavailable
or full, the existing UI still conservatively asks the learner to keep the tab open. Save attempts time out after 15 seconds;
image hydration is bounded to five seconds so a stalled image read cannot hide
retained text and retry controls indefinitely. Missing images keep their keys.
Optional profile/course model enrichment runs only after an acknowledged initial
save. A recovered turn saves authoritative progress/completion but skips these
optional model calls and their derived profile/course summaries and bookkeeping.
They are not durably queued or backfilled by recovery.

### Client upgrades and conditional sync writes

Authenticated mutations under `/v1/sync` and `/v1/ai`, plus the admin model probe
`POST /v1/admin/ai-settings/test`, require both
`X-Plato-Client-Protocol: 1` and an exact `X-Plato-Client-Epoch`. A mismatch
returns HTTP 409 with `code: client_upgrade_required` before database writes,
plugin lesson-start hooks, or model invocation. Reads and authentication remain
available for recovery. The read that discovers a protocol rejection also
continues without compatibility headers; later reads do not repeat the status
handshake, and concurrent or later mutations remain blocked.
`GET /v1/sync/status` supplies the protocol/epoch with
`Cache-Control: no-store`. All server entry points allow these headers in CORS.
Handshake cancellation/deadlines, including token refresh, use `AbortController`, without requiring
`AbortSignal.any` or `AbortSignal.timeout`. Admin settings writes retain their
existing authorization and strict version checks; other admin and OAuth routes
are outside this learner-data compatibility fence.

The client negotiates once per loaded page. Its epoch and upgrade block survive
logout and account changes; a rejected page cannot refresh its epoch and resume
writes over old in-memory state. A fresh page is required. Each authenticated
request checks account ownership and the session generation, and token refresh
compares the captured credentials before replacing them or reporting expiration.
This request-level guard does not yet bind an entire multi-request generation or
enrichment operation to its original session; that pre-existing gap is tracked in
[#6](https://github.com/henryperkins/googleplato/issues/6).

`CLIENT_COMPATIBILITY_EPOCH` defaults to `1` and must match across all serving
instances and any compatible rollback build. It is a coordinated upgrade
boundary, not a deployment revision or an authentication mechanism. The first
deployment of this gate rejects legacy clients that omit the headers; changing
the epoch later fences already-open compatible pages. Application and rules
publication are separate operations; see [Firestore retirement](FIRESTORE_RETIREMENT.md).
All four server entrypoints validate the epoch before serving or running their
application bootstrap, so invalid configuration cannot report a healthy server.

`LessonChat` offers **Preserve work and reload** after rejection. Before reload,
the engine refuses any active generation anywhere in the page, then writes and
reads back every retained reply and draft, including other visited lessons and
accounts. Draft text, image data, and fetched link context use account/lesson
scoped `sessionStorage`. Failure leaves the tab open with a copy-work warning.
Only a verified upgrade reload bypasses the pending-work unload warning; ordinary
navigation still warns while a reply or generation is pending or a nonempty
draft failed retention.
After reload, the original turn IDs, base snapshot, reply, and progress restore;
**Retry saving** only submits the original atomic commit. It neither generates
a replacement nor runs optional profile/course models. A lost acknowledgement
still reconciles through the existing idempotent commit contract.

Explicitly discarding a generated reply replaces its local record with a small,
verified dismissal for that account, lesson, and turn ID. Server recovery ignores
that exact turn after navigation or reload, while a newer turn remains eligible.
If browser storage cannot retain the dismissal, the reply stays available and
the action reports the failure instead of claiming it was discarded.

Already-open legacy bundles cannot acquire this UI retroactively. Their existing
account-scoped generated-turn journal remains readable after manual reload, but
legacy `plato_compose_draft:<lessonId>` text has no owner identity and is left
untouched rather than assigned to whichever account signs in next. Copy that
unsent text before upgrading a legacy tab. Recovery remains limited to the same
tab/session, not browser closure or another device.

Submitted learner input has a separate journal in `lessonSubmissions.js`, keyed
by encoded account and lesson IDs. `ComposeBar` lets its owner synchronously
retain the exact text, image names/data and fetched link context **before**
clearing the editor. A failed or silently ignored browser-storage write refuses
Send and leaves the input intact. The journal never replaces a newer editable
draft. A failed response offers **Retry response**, **Move to draft** (only when
the current draft is empty), and a confirmed **Discard response**. Moving it
verifies the complete draft copy before removing its submission record.

Generation uses the submission's stable turn ID and stays owned by its original
account/lesson after the React view unmounts. Reopening joins the active request;
reload checks the authoritative saved IDs before offering recovery. No recovery
automatically invokes a model. A retry of an already committed submission returns
the saved conversation. Once generation succeeds, the existing generated-turn
journal owns **Retry saving**, without repeating inference. Input is removed only
after a save or a verified, readable generated-reply copy. If the larger reply
cannot fit in browser storage, its input remains available for reload recovery
and the existing keep-this-tab-open warning still applies. Upgrade reload also
verifies every retained submission. Owner-bound image/model/profile requests
reject an account change before sending, and late profile acknowledgements do
not populate the next account's cache or credentials.

Background profile and course enrichment capture the account when queued. They
recheck it before reading context and after inference, and bind each save to
that account. Owner-bound reads also reject late cache population. These writes
are already awaited and are not repeated by an unowned debounce. An account
switch stops the optional enrichment instead of applying it to the new account.

Generic single and batch PUTs require an explicit nonnegative safe integer
`version` below `Number.MAX_SAFE_INTEGER`: `0` creates only an absent key;
positive values update only an existing exact version. Invalid input returns
`sync_validation_failure` (400), and a failed condition returns `sync_conflict`
(409). Batch metadata is validated before writes, while valid batches retain
their existing per-item conflict results. Batch items are written
sequentially (never in parallel — each write holds a pool client under the
per-user advisory lock), and an unexpected error fails the request without
attempting the remaining items. The client retains an unsuccessful
payload and its original base; it never fetches a new version and blindly
resends that payload. Deletes clear the cache only after acknowledgement.
Rejected lesson reset/delete operations display an error instead of navigating
away. Failed screenshot creation discards optimistic cache bytes; verification
can cache only the server's actual image, including a conflicting image.

**Pasted/uploaded images are NOT embedded in the messages record.** Each image
is its own `screenshot:<key>` record, and the message stores only
`metadata.imageKeys`. This is load-bearing:

- DynamoDB caps a single item at 400 KB. Inlining base64 screenshots blew the
  `messages:` record past that limit. The write then failed, but
  `client/js/storage.js`'s `putSyncData` swallowed the non-409 error, so the
  in-memory cache looked fine until the next `loadAll()` (on tab refocus)
  replaced it with the stale server copy — the learner's conversation silently
  vanished while the small `lessonKB` record survived.
- Images are compressed client-side on paste
  (`client/src/lib/imageCompression.js`) to stay well under the per-record
  limit, persisted one-per-record, and excluded from the bulk `GET /v1/sync`
  payload (fetched on demand by key). The exclusion happens in the adapter
  query itself (`getAllSyncData(userId, { excludePrefixes })` on every
  backend, alongside `userMeta:*` and `lessonGeneration:*`), so screenshot
  bodies are never read on login or tab refocus. The cap is measured on the encoded
  record: the client caps the data URL at `SCREENSHOT_MAX_DATA_URL_CHARS`
  (370 KiB chars) and the server rejects the whole JSON record over
  `MAX_SCREENSHOT_RECORD_BYTES` (380 KiB) in `server/src/lib/sync-limits.js`.
- `ComposeBar.addImagesFromFiles` reads files via `FileReader` with
  `Promise.allSettled` (not `all`) so one unreadable file can't discard a whole
  batch, and surfaces the underlying `DOMException.name` in the alert
  (e.g. `NotReadableError` = file locked by antivirus / in use, `NotFoundError`
  = a OneDrive "files on-demand" entry not downloaded locally). Reads can also
  be blocked by a browser extension injecting a content script into the page.
  The opaque "Failed to read image" message that hid all of this was issue #228.
- `resumeLesson` re-hydrates `imageKeys` → data URLs for rendering via
  `hydrateMessageImages`. Legacy messages that still embed `imageDataUrls`
  directly render unchanged. Hydration keeps positions: `imageDataUrls[i]`
  belongs to `imageKeys[i]`, and an image that can't be loaded stays in place
  as `null` (the chat skips it), so a later image never stands in for an
  earlier key. `messageImageUrls()` (`client/src/lib/lessonWork.js`) is the one
  reader, shared by the chat and Shared work; it also covers the single
  `imageDataUrl` of messages from before multiple images.
- A lazy, idempotent migration (`migrateLegacyImages`, run from `resumeLesson`)
  heals pre-fix conversations whose embedded base64 already bloated the record:
  it extracts each embedded image into a compressed `screenshot:*` record and
  rewrites the conversation record slim so the lesson can be continued. The
  migration is **skipped while impersonating** (`resumeLesson` must stay
  read-only for the "View as User" audit — writes lack `?asUserId` and would
  land on the admin's own account).
- Screenshots use immutable create-only writes. If creation fails, a fresh
  authoritative read may confirm identical bytes already saved by an interrupted
  migration or a lost acknowledgement. Different content at the same key is
  never overwritten, including when its version is cached.
- `putSyncData` returns a durability boolean and logs rejected/failed writes
  instead of swallowing them.
- The `LessonChat` resume effect keys on stable values (`lessonGroupId`, lesson
  presence) — **never the `lesson` object identity**, which changes on every tab
  refocus and used to re-run the effect and reset the conversation mid-lesson.

## Link attachments

A learner attaches a web page to a coach message via a link button in
`ComposeBar` (next to the image button). Fetching + extraction happen
**server-side** — the browser can't fetch cross-origin pages (CORS), and
server-side is where the SSRF defense must live.

- **Endpoint:** `POST /v1/links/fetch` (`server/src/routes/links.js`, buffered
  API function); `client/src/lib/links.js`'s `fetchLinkContent` calls it on
  attach so the chip shows the real title immediately.
- **Extraction** (`server/src/lib/link-extractor.js`): `fetchUrlContent` does a
  plain fetch, `extractReadable` runs `@mozilla/readability` over a `linkedom`
  DOM and converts the cleaned HTML to block-preserving text (Readability's
  `textContent` fuses words across elements), falling back to a whole-body strip
  for non-article pages. This is the **pluggable seam** — swap only the fetch
  step for a headless browser / reader service to handle JS-rendered SPAs later
  (the **known v1 gap**: SPAs return little text).
- **SSRF defense** (`server/src/lib/url-guard.js`) — the headline risk, since
  the server fetches user URLs from inside AWS. http/https + port allowlist, no
  embedded credentials; rejects any loopback/private/link-local/reserved address
  (incl. `169.254.169.254` and every IPv6 representation of those ranges —
  compressed, expanded, hex/dotted IPv4-mapped); manual redirects (≤5 hops)
  re-validated each hop; 10 s timeout, 3 MB cap, content-type allowlist, ~50 k
  char truncation. **DNS rebinding is closed by pinning:** the fetch agent's
  `connect.lookup` (`safeLookup`) validates the resolved address and the socket
  connects to *that* IP, so a low-TTL host can't pass an up-front check then
  re-resolve to an internal IP (the classic resolve-then-fetch TOCTOU). Uses
  undici's own `fetch` + `Agent` (Node's built-in `fetch` rejects an external
  undici dispatcher).
- **Link text is untrusted, user-controlled content.** It's whatever the linked
  page says, so it can contain prompt-injection attempts ("ignore previous
  instructions…"). It's framed to the coach as `[REFERENCE CONTEXT — Learner
  attached a web page for your review]` with an explicit trailing instruction
  that this is reference material, not evidence of completion unless the learner
  confirms it. Claude is generally robust to injection, but treat page content
  as untrusted — don't add code paths that act on it as instructions.
- **Recall is this-turn-only (image parity).** `buildUserParts` (`lessonEngine.js`)
  injects the page text into the coach call on the attach turn (ordered text →
  links → images); it's never persisted or re-sent (later turns see a `[link]`
  placeholder). Only `metadata.links: [{ url, title }]` is persisted — so no
  400 KB risk, no new sync record, no hydration; chips render straight from that
  metadata on resume.
- **Coach interpretation guidance** (`client/prompts/coach.md`): the prompt
  explicitly tells the coach NOT to treat page content as evidence of completion
  unless the learner confirms it — e.g., if a lesson asks them to publish a blog
  post and they share their site, the coach should ask "Is this the published
  post you're submitting?" rather than assuming visible content is final. This
  prevents the hallucination failure mode where a learner shares their
  work-in-progress portfolio site for reference and the coach infers completion
  from content that doesn't exist or isn't finished yet.

## Composing and showing replies (#247)

**Composing during a reply.** `ComposeBar` has two locks. `disabled` makes the
whole composer read-only (View as User). `busy` only holds sending: the
textarea, attachments and links stay usable, so a learner can write the next
message while the coach replies, and the mobile keyboard stays open. While
busy, the send button is disabled and the shortcut does nothing. The hint next
to Send says what is holding it, and because that hint is also the textarea's
accessible description, it must be true for every busy state:

| What holds sending (lesson chat) | Hint |
|---|---|
| a reply streaming (ComposeBar's default) | Send when the reply finishes |
| progress saving | Send when progress is saved |
| a generated reply not yet confirmed saved | Send after the reply is saved |
| a failed or interrupted submission | Send after recovering the earlier response |
| the lesson loading | Send when the lesson loads |
| an update the page must reload for | Reload this page to send |

`LessonChat` derives the hint (`busyHint`) and `busyMessage`, which is
announced when a send is attempted while held, from one cascade, so they
always agree. The lesson and knowledge-base editors pass their own: saving, a
failed reply ("Send after retrying the reply"), an unconfirmed lesson save, a
save conflict, or a preview being generated. The lesson editor derives its description and attempted-send status from the pure `lessonEditorComposerHint` cascade, in this order:

| Lesson-editor state | Recovery instruction |
|---|---|
| Save conflict (409) | Choose “Load saved lesson”, then send. |
| Final save rejected (400) | Choose “Revise lesson” in Preview, then send. |
| Starting or receiving a reply | Wait for the reply to finish, then send. |
| Saving conversation, lesson or visibility | Wait for saving to finish, then send. |
| Recovered visibility save rejected (400) | Choose a visibility again in Visibility and sharing, then send. |
| Failed pending visibility or final save | Choose “Retry saving”, then send. |
| Idle pending final save | Choose “Retry saving lesson” in Preview, then send. |
| Idle pending visibility save | Wait for saving to finish, then send. |
| Failed reply | Choose “Retry reply”, then send. |

**Send key.** The `sendKey` preference (`'mod-enter'`, the default, or
`'enter'`) decides whether plain Enter sends. Cmd/Ctrl+Enter always sends,
Shift+Enter is always a new line, and Enter that confirms an IME composition
never sends (`isSendKeystroke` in `client/src/lib/chatPrefs.js`). Every chat
shows the shortcut next to Send, as the textarea's accessible description,
whenever nothing holds sending. The preference lives in the learner's
`preferences` record and is set in Settings → Chat, which saves on change. The
name and chat-preference saves hold each other's controls, so a stale
whole-preferences snapshot can't overwrite a newer choice.

**Replies show as they stream in.** The learner chat renders streamed text as
it arrives, with no artificial typing pace. (Upstream removed its typewriter
and the `instantText` preference after the #451 review; a stored `instantText`
is ignored.) The lesson and knowledge-base editors keep their shared
`useStreamedText` reveal hook.

**One composer, separate journals.** The single sticky composer keeps three
things apart: the submitted input, in its own journal (*Retry response*, or
*Move to draft* when the draft is empty); a generated reply retained until the
server confirms it saved (*Retry saving* repeats only the save, never the
generation); and the newer draft. Upstream merged a failed turn back into the
composer ahead of the new draft. The fork never merges them, so neither can
truncate the other.

## Behind this response (#411)

Every chat reply can show which of plato's agents worked on it, what each read,
and what it did: a collapsed **"Behind this response: Coach"** button between a
message and its reply (`client/src/components/chat/AgentActivity.jsx`). It's a
real button with `aria-expanded`, reachable by Tab in the chat log, and
Alt+Arrow message navigation is unchanged.

In lessons the content is **built on the server, before the turn is signed.**
`server/src/lib/lesson-coaching.js` assembles it with the shared formatter
`server/src/shared/agentActivity.js` (the client's `agentActivity.js`
re-exports it) once the assessment is accepted. The signed receipt covers it,
so a tampered activity list fails on commit and on replay. It reports only what
happened before signing:
- the opening's lesson planner and the coach;
- progress before and after, evidence recorded for an objective, the coach's
  notes and the learner's position;
- a server assessment repair ("Repaired assessment metadata on the server") or
  a continuity clarification;
- an accepted, sourced profile observation, and the images and readable link
  text actually supplied.

It never claims an optional post-save model ran. The learner-profile rewrite
and the unit-progress note run after the save, and recovery never backfills
them. It never infers a profile update from generic insights, and it never
shows the model's raw reasoning (`converse.js` drops reasoning blocks). Notes
are clipped to 280 characters, at most 5 per agent.

The assistant message carries `metadata.agents` =
`[{ agent, label, read?, did?, notes? }]`, persisted in `messages:<lessonId>`
inside the signed turn. Messages from before #411 have no disclosure. The admin
chats (lesson editor, KB editor, KB setup) build their activity on the client
from the authoring agent's readiness change (`authoringActivity`). A new lesson
draft starts at readiness 0, so its first reply shows "Readiness 0 → 3 of 10".

## Chat auto-scroll (#319, #321)

`useStickToBottom` (consumed by `ChatArea`) follows streamed output while the
learner is at the bottom, holds still when they've scrolled up, and always jumps
on send. Three traps here each produced a shipped-but-broken fix:

1. **The chat log is not the scroll container** — it has no `overflow`, so it
   never emits `scroll`. #321 listened there, so its handler never fired and
   auto-scroll re-fired on every streamed character. Hence the **capturing**
   `window` listener: `scroll` doesn't bubble but does capture, so it sees
   whichever element scrolls without naming it.
2. **The learner shell scrolls the document, and must keep doing so.** An
   `overflow` of `auto`, `scroll`, or `hidden` on `<main>` (or any other
   ancestor of the lesson header) makes that element the sticky header's scroll
   container, and the header silently stops sticking. With no clipping
   ancestor, wide content must contain its own horizontal overflow
   (`.coach-copy` wraps anywhere, and markdown tables scroll inside their own
   `.md-table-scroll` wrapper, with `role="region"`, `tabindex="0"`, and visible
   focus rings for keyboard-only panning). The footer isn't pinned to the viewport
   either, so the fixed compose overlay sits at `bottom-0`. Embedded authoring
   views can still have an element scrollport, and setting `scrollTop` on a
   non-scrolling element is a **silent no-op**, indistinguishable from an
   unwired feature — so the pin writes to every scrollable ancestor plus
   `window`.
3. **The compose bar sits inside the scroll container**, after the log, so
   `scrollIntoView` on a sentinel stops short of the true bottom and hides the
   newest message behind the fixed overlay. Request `scrollTop = scrollHeight`
   and let the browser clamp. **Don't restructure the compose layout to work
   around scrolling** — the inline+fixed pair is deliberate (inline reserves
   space in flow).

Verify changes by hand with the compose bar in *both* states (fixed mid-lesson,
inline at the end of a short one); `client/tests/stickToBottom.test.js` covers
only the decision layer.

The admin lesson editor passes an explicit `scrollTargetRef` at the end of its
inline composer. Scrolling its container to the absolute bottom can instead
land at the end of the adjacent preview. The optional target changes both
pinning and the "at bottom" calculation. `scrollOnMount` defaults to true;
authoring passes false so opening an editor preserves its title, saved status
and workspace tabs. Explicit submission still resumes following. Hidden chat logs
never scroll their ancestors, including when a reply arrives behind the mobile Preview tab.
When a hidden log reappears, its pin state is recomputed from the current
position and its offset snapshot is refreshed before mutation, resize or
animation callbacks can follow it again.
Returning to Refine therefore keeps the selected tab in view; a new submitted
message still explicitly resumes following the conversation.
For the explicit authoring endpoint, scroll events with unchanged offsets do
not stop following: WebKit can emit them when content grows. Programmatic pins
record their resulting offsets, and a newly active scrollport is measured from
zero so its first actual movement can resume following after a layout change.
Learner chat continues to use full-scrollport pinning.

The lesson page fills `<main>` (`#main-content:has(> .lesson-page)` is a flex
column, still with no `overflow`) rather than taking
`min-height: calc(100dvh - 5rem)`. That guess assumed 80 px of shell: the real
shell is taller on phones and with the admin strip, so every lesson page
overflowed and opened partly scrolled, clipping the header. Keyboard focus
scrolls clear of the sticky header and composer: `useStickyScrollPadding` sets
`--sticky-top` and `--sticky-bottom` from their measured heights, and `html`'s
scroll padding uses them (WCAG 2.4.11). A fixed `4rem` let a three-line title
cover a focused link entirely.

On short viewports (`@media (max-height: 34em)` in `index.css`) the lesson
header and composer go `position: static`, the scroll padding drops to
`0.5rem`, and
`useVisualViewportKeyboardOffset` stops lifting the composer
(`SHORT_VIEWPORT_QUERY`; keep the two in step). The query is in `em` so page
zoom and an enlarged default font size count as short, not only landscape
phones.

## Focus and failure states

Rules that keep keyboard, screen reader, and mobile users oriented when work is
async or something fails:

- **Never disable the control that has focus.** A disabled control loses focus to
  `<body>` (and closes the mobile keyboard). `ComposeBar` takes `busy` (holds only
  the send while a reply streams; the textarea stays editable) separately from
  `disabled` (read-only View as User). Forms make fields `readOnly` while saving
  and keep the submit button focusable with Base UI's `focusableWhenDisabled`
  (rendered as `aria-disabled`, which `button.jsx` styles like `disabled`).
  Handlers guard against double submits themselves.
- **Confirmations that replace a form take focus** (Reset Password, Wait List,
  and the invitation page that replaces sign-in, whose **Back to sign in**
  returns focus to the Sign in heading), and a failed lesson start offers Try
  again in place, parking focus on the lesson heading while the loading view
  replaces the error.
- **Page titles name the page.** `client/src/lib/routeTitles.js` names lesson
  routes after their lesson for the title and the "Navigated to …" announcement;
  admin views that share a route component set their title per view.
- **An admin page change works like a page load.** `adminPageName` names each
  admin page by its first segment after `/plato`, so a view inside a page (a
  user's edit view, the lesson editor) shares its page's name. When that name
  changes, `ScreenReaderAnnounce` announces it and titles the tab
  (`<page> — plato`), and `AdminLayout` scrolls the page to its top and focuses
  `<main id="main-content">` in a layout effect, unless the new page already
  placed focus itself. Moving within a page keeps scroll and focus. A skip link
  leads to the same `<main>`, as in the classroom.
- **The admin shell is one breakpoint.** Below `lg` (64rem) a top bar (brand,
  theme, account menu) and bottom tabs frame a scrolling `<main>`; the tabs show
  labels from 30rem. A text-relative container query lets labelled tabs use two
  rows of three when enlarged text needs more room; each label stays inside its
  target. From `lg` a fixed sidebar takes over and scrolls when the window is
  short. Under 34em tall the frame lets go: the whole page scrolls, bars included,
  and `<main>` keeps its content-based basis in the phone column (`flex: 1 0
  auto`; a 0% basis would leave it short, with the page running under the tabs).
  The desktop row restores `flex: 1 1 0%` so content shrinks beside the sidebar.
- **Refreshes don't unmount pages.** Admin pages show the full-page spinner only
  on the first load, so a refresh after a save or delete keeps the page, its
  scroll position, and any open dialog in place.
- **A colored header keeps its focus color to itself.** The classroom header's
  controls take its text color as their ring through `.header-control`, and the
  admin top bar's through `.sidebar-control`. The account menu is a native
  popover mounted inside the header, so a ring set on `<header>` itself would
  reach the menu items and draw white on a white menu.
- **An expired session returns to its page.** `RequireAuth` records the page in
  the sign-in redirect's state. After sign-in, `returnPath`
  (`client/src/lib/returnPath.js`) goes back there; only in-app paths qualify,
  never an auth page. `AppShell` signs out with `logout({ reason: 'expired' })`
  rather than navigating itself, so the redirect keeps that state, and the
  sign-in page explains why the learner was signed out.
- **Auth errors are written for people.** `client/src/lib/authErrors.js` turns
  Firebase codes into plain messages, so learners never see a raw
  `auth/…` message or a Firebase console instruction (only first-run Setup
  explains how to enable Google sign-in). A closed Google window isn't an
  error, an unreachable server reads as offline, and a missing-fields summary
  names only the fields that are actually empty.
- **Unknown is not "none".** When the invite-link or wait-list status fails to
  load, the controls that would replace a live credential stay hidden behind a
  Try again prompt, so a failed fetch can't skip the replacement confirmation.
- **Error boundaries.** `ErrorBoundary` (wrapping the routes in `App.jsx`, reset
  on navigation) shows a recovery screen instead of a blank page, which also
  covers a stale lazy chunk after a deploy. Each plugin slot component has its
  own boundary, so a failing plugin drops out instead of blanking the host page.

## Invite system

Admins invite users via email or shareable link. Every new account needs an invitation, whether the person signs up with a password or with Google (see [Google sign-in](#google-sign-in-and-canonical-server-storage)). Invites expire after 7 days (TTL enforced in DynamoDB/SQLite). All invite operations are audit-logged.

### Email invites

- **Creation:** `POST /v1/admin/invites` (single) or `/v1/admin/invites/bulk` (up to 200). Bulk supports CSV upload.
- **Delivery:** SES email (`server/src/lib/email.js`) with signup URL: `{APP_URL}/signup?token={inviteToken}`. With `SKIP_EMAIL=true` nothing is sent or logged with the link: invite responses report `emailDelivery: 'off'` (bulk results use status `link_only` with separate `sent`/`linkOnly`/`skipped` counts) and return the signup URL so the admin can share it. Admin → Users shows each returned link (and the shareable invite link) in `CopyLinkField`: a read-only field plus a Copy button whose result is announced in a polite status region; when the clipboard is denied or unavailable, the field is focused and selected with instructions to copy by hand. Password-reset responses never include a link; with email off, `/v1/auth/forgot-password` and the admin reset create no token, answer `emailDelivery: 'off'`, and the forgot-password answer is identical for known and unknown addresses.
- **Validation:** Invite token must exist, status `pending`, TTL not expired, and **email must match** the invite.
- **One-time:** Marked `used` on signup; cannot be reused.

### Link invites (shareable, reusable)

Added to enable bulk onboarding without collecting emails upfront (e.g., sharing in company Slack channels).

- **Creation:** `POST /v1/admin/invites/link` creates a single organization-wide link. If one exists, it's deleted first (regenerate = delete old + create new).
- **Retrieval:** `GET /v1/admin/invites/link` returns the active link or `null`.
- **Deletion:** `DELETE /v1/admin/invites/link` revokes the link immediately.
- **Schema:** Same `invites` table, but `email: null` and `isLink: true`. Added fields: `usageCount` (incremented on each signup), `maxUsages` (optional limit, currently `null` = unlimited).
- **Validation:** Any email accepted (vs. email invites that must match). TTL and status still checked.
- **Usage tracking:** `incrementLinkUsage()` atomically increments `usageCount` on signup with a conditional update that enforces `maxUsages` if set. This prevents race conditions where concurrent signups could exceed the limit. The check-then-increment at the route level would be racy; the database operation is the authoritative gate. Link is marked `used` only if `maxUsages` reached (rare; currently unlimited).
- **Security:** 7-day TTL, audit-logged, clear UI warnings about sharing risks, email still required at signup (no anonymous accounts).
- **UI:** Admin → Users → Invite Users → "Link" tab. Shows URL with copy button, usage stats, expiry date, and security warning. Regenerate/delete actions have confirmations.

### Wait list (#363)

People ask to join; an admin invites them later. Integrator-facing API guide: [`WAITLIST_API.md`](WAITLIST_API.md).

- **Join:** `/waitlist` page, linked from sign-in when the list is open. It asks for name, email, group (optional), and the custom user fields, with required fields enforced.
- **API:** `POST /v1/waitlist` (public) takes `{ name, email, userGroup, customFields }`. It works when the list is open, or with `Authorization: Bearer <key>` from an outside form, even when closed. Send the key from a server, not a web page. The reply is `202 { ok: true }` for any valid input, including an email that already has an account, invite, or entry, so it never reveals who is registered. A submission from someone who already has an account or a pending invite is still stored; `GET /v1/admin/waitlist` marks it `alreadyRegistered: 'account' | 'invite'` (worked out at read time) and the Users page shows "Has an account" / "Invited". An account's entry can't be invited (409); instead `POST /v1/admin/waitlist/:token/apply` ("Copy to account") fills in what the account is missing (a group if it has none and the group still exists; blank custom fields with valid answers), never the name, removes the entry, and writes a `waitlist_applied` audit entry. Only a repeat join for an email already on the wait list stores nothing. `GET /v1/waitlist` returns `{ open }`.
- **Storage:** rows in the `invites` table with `status: 'waitlist'`, no `ttl` (they never expire), and a `profile` of `{ name, userGroup, customFields }`. Pending-only lookups skip them, so a wait-list token can't sign up.
- **Config:** `_system:waitlist` = `{ open, apiKeyHash }`, kept out of `_system:settings` so a stale settings save can't bring back a revoked key. The key is shown once; only its SHA-256 is stored.
- **Admin:** Users → **Wait List** filter, with Invite (Copy to account when the email already has an account) and Remove per row; click a row to edit the entry (`/plato/users/waitlist/:token`: name, email, group, custom fields — same validation as joining, and a new email must not belong to a user, pending invite, or other entry). An entry runs one action at a time: its row and editor hold every control until the request settles, and only the running action's control shows progress, so a removal never reads as "Copying…". An editor action that finishes after the admin has opened another entry leaves that editor open. Users → **Wait List** button to open or close the form and make or revoke the key. Routes: `GET /v1/admin/waitlist`, `PUT /v1/admin/waitlist/settings`, `POST`/`DELETE /v1/admin/waitlist/key`, `PUT /v1/admin/waitlist/:token` (edit; conditional on the row still being an entry, so it can't race an Invite), `POST /v1/admin/waitlist/:token/invite`, `DELETE /v1/admin/waitlist/:token`.
- **Invite:** creates a normal email invite that carries the entry's `profile`, sends the invite email, and deletes the entry. Resend keeps the profile.
- **Not an invitation:** a Google sign-in from a wait-listed address creates no account and leaves the entry in place; the invitation page tells the person they're on the list (see [Google sign-in](#google-sign-in-and-canonical-server-storage)).
- **Signup:** the form is prefilled from `GET /v1/auth/invite/:token`; values the person submits win. A stored group that has since been renamed or deleted is ignored rather than assigned.
- **Custom fields:** deleting a custom user field also erases its answers from wait-list entries and the invites made from them (`setInviteProfile`), and `GET /v1/admin/waitlist` only returns answers to fields that still exist.
- **No rate limit.** Like the rest of the public API, `POST /v1/waitlist` has none; an open list accepts any number of entries. The public form carries a **honeypot**: a hidden `website` input (off-screen, `aria-hidden`, out of the tab order). An unkeyed request that fills it gets the normal `202` and nothing is stored. Keyed requests skip the check, so an outside form may send any fields.

### Signup flow

`POST /v1/auth/signup` accepts `inviteToken`, `email`, `name`, `password`, `username` (optional), `userGroup` (optional), `customFields` (optional — see [Custom user fields](#custom-user-fields-364); format-validated, required-ness not enforced at signup).

- **Email invites:** `email` must match `invite.email`.
- **Link invites:** `email` can be any valid address (required field).
- **Wait-list invites:** `GET /v1/auth/invite/:token` returns the email, name, group, and field answers so the form starts filled in. Signup falls back to the invite's group and fields when the form leaves them out.
- All check TTL expiration, duplicate user, and username availability. On success, user is auto-logged in and invite is marked used (or usage count incremented for link invites).

Plugins can enrich lessons at start time by providing additional reference
material — e.g., WordPress docs, React API updates, internal knowledge bases.
Enrichment is computed **once** when the learner starts the lesson (after Lesson
Owner KB init, before Coach opens), cached on `lessonKB.enrichments`, and
injected into the coach's system context. The learner sees enrichments in the
"Additional Context" section of the lesson overview dialog (alongside exemplar
and objectives), where they can reference it throughout the lesson.

### Lifecycle

1. **Lesson start** — `client/src/lib/lessonEngine.js#startLesson()` calls
   `POST /v1/sync/lesson-started` (server route in `sync.js`)
2. **Hook emit** — server emits `lessonStarted` with `{ userId, lessonId, lesson: { name, markdown, exemplar, learningObjectives }, lessonKB }`
3. **Plugin handlers** — each plugin with `hook.lessonStarted` + `lessonEnrichment`
   capability runs; non-null return values are collected
4. **Return to client** — `{ enrichments: [...] }` returned to `startLesson()`
5. **Storage** — if enrichments exist, stored on `lessonKB.enrichments` and synced
6. **Coach context** — `buildContext()` injects enrichments into coach system prompt
   as `enrichmentContext: [{ source, context, reasoning }]`
7. **UI display** — `LessonChat` displays enrichments in the "Additional Context"
   section of the lesson overview dialog (opened via "Lesson Overview" button)
8. **Resume** — enrichments are read from cached `lessonKB` (never re-computed)

### Enrichment data contract

A plugin's `lessonStarted` hook handler returns:

```js
{
  pluginId: 'wordpress-info',       // Required: plugin id
  label: 'WordPress.org',            // Required: display name
  context: 'When building...',       // Required: ~300 word summary
  reasoning: 'This lesson focuses...', // Required: why this matters
  sources: [                         // Optional: citation links
    { url: 'https://...', title: '...', excerpt: '...' }
  ]
}
```

Return `null` (or omit return) when the plugin doesn't enrich this lesson. The
host filters out nulls — only non-null returns are stored.

### UI components

- **LessonLoadingView** (`client/src/components/chat/LessonLoadingView.jsx`) —
  stepped progress UI showing: (1) Planning the lesson (Lesson Owner), (2) Adding
  context (plugins — only shown when active), (3) Starting conversation (Coach).
  Labels describe the work, not the agent doing it: learners never see agent
  names. The enrichment step expands to show per-plugin progress when multiple
  plugins are active. Includes `role="status"` and `aria-live="polite"` for screen reader
  announcements.
- **Lesson Overview Dialog** (`client/src/pages/LessonChat.jsx`) — modal dialog
  displaying lesson name, description, exemplar, learning objectives, and an
  "Additional Context" section showing enrichment data from plugins. Each enrichment
  is a semantic `<section>` with heading (`<h4>`), reasoning text, context paragraph,
  and source links in a `<nav>` with proper aria-labels and focus styles. The dialog
  content is scrollable (`max-h-[85vh]`) to handle long enrichments.

### WordPress Info plugin (reference implementation)

Three-agent pipeline (`plugins/wordpress-info/`):

1. **Planner** (`prompts/wordpress-info-planner.md`) — detects WordPress keywords
   in lesson objectives, outputs `{ shouldEnrich: bool, queries: [{ text, sources }] }`
2. **Query executor** (`server/query-executor.js`) — fetches from wordpress.org
   REST API, Make WordPress blogs, GitHub code search in parallel (8s timeout per
   source, fail-open on errors)
3. **Synthesizer** (`prompts/wordpress-info-synthesizer.md`) — distills query
   results into lesson-specific ~300 word summary: relevant APIs, best practices,
   common pitfalls

Hook handler (`server/index.js`) orchestrates the pipeline, returns enrichment
data or `null`. SSRF defense: all fetched URLs validated against `ALLOWED_HOSTS`
(`developer.wordpress.org`, `make.wordpress.org`, `api.github.com`).

### Design invariants

- **Fail-open, always.** Enrichment errors (planner fails, executor times out,
  synthesizer throws) must never block lesson start. Plugin handlers return `null`,
  the lesson proceeds normally.
- **Coach-owned completion.** Enrichment provides reference material the coach can
  draw on, but MUST NOT override completion semantics. `applyCoachResponseToKB`
  remains the single owner of `progress` and the exemplar. The enrichment context
  is framed as informational background, never as requirements.
- **One-shot computation.** Enrichment runs once at start, cached on `lessonKB`.
  Never re-runs on resume (learner sees same artifacts every time), never re-runs
  per chat turn (that would be the chat-context contributor pattern, not enrichment).
- **Timing budget.** Enrichment should complete in ~3-5 seconds to keep lesson
  start snappy. Plugins with slow sources should use timeouts, caching, or
  background jobs. The UI progress indicator keeps the learner informed.
- **Synthesis, not inlining.** Don't inline full documentation pages into the coach
  context — the synthesizer should distill to ~300 words of lesson-specific info.
  Sources are cited via links in the artifact panel.

### Why at start, not per-turn?

Enrichment is a **lesson-level** concern: "what background does the coach need
for *this lesson*?" Chat-context contributors (link attachments, image analysis)
are **turn-level**: "what context does the coach need for *this message*?"

Start-time enrichment:
- **Pro:** computed once, cached; no per-turn latency; learner sees what the coach
  has in mind from the beginning
- **Con:** can't adapt to learner questions mid-lesson (but the coach can still
  reference enrichment context when relevant)

Per-turn enrichment would:
- Add 1-3s latency to every coach reply (unacceptable for microlearning pacing)
- Bloat every turn's context with retrieval results (coach context is already dense)
- Force learners to wait through "Searching docs…" spinners repeatedly

The trade-off: enrichment is less dynamic but preserves the lesson's 20-minute
pacing target. If a learner asks a question the enrichment doesn't cover, the
coach still has the full lesson context + link attachments to draw on.

### Extension point for other plugins

Any plugin with `lessonEnrichment` capability + `lessonStarted` hook can provide
enrichment. Examples:
- **React Docs** — detect React keywords, fetch from react.dev
- **Internal KB** — query Confluence/Notion when lesson mentions company concepts
- **Recent updates** — pull latest bug reports, release notes, deprecations
- **Security policies** — inject org-specific code standards, compliance notes

The pattern is the same: detect relevance → fetch sources → synthesize summary →
return enrichment object or `null`.

### Known gaps & future work

- **Phase 1 agent calling** — plugins currently import `orchestrator.js` and call
  `converseStream` directly; Phase 3's `agent` capability will formalize prompt
  upsertion to sync-data and agent invocation via SDK
- **Structured output** — agents are instructed to return JSON, parsing happens in
  the hook handler; native structured-output tool would be cleaner
- **Hook return-value collection** — the hook system was extended to collect
  non-null returns; this pattern could extend to other hooks (e.g., `lessonCompleted`
  for summary generation)
- **Multi-lesson caching** — WordPress Info queries the same sources for every
  WordPress lesson; a shared cache (Redis or sync-data) could dedupe across lessons

## Lessons: visibility, drafts, courses, classroom

### Visibility

Lessons have three statuses:

- `public` — visible to all (legacy `published`, and legacy lessons with markdown but no status, normalize to `public`).
- `private` — visible only to users in `sharedWith`.
- `draft` — in-progress, admin-only, no markdown yet.

A record is a **true draft** iff `status === 'draft'` AND markdown is empty;
legacy `status: 'draft'` records that *do* have markdown are treated as
`private` to preserve pre-rework semantics. Drafts surface as a `Draft` pill in
Admin → Lessons and are never exposed to learner-facing endpoints.

Missing status on an existing lesson with markdown preserves the public visibility
it had before statuses were introduced, including during an admin edit. Unknown
statuses and incomplete status-less records remain private. Creating a new lesson
through the admin API without an explicit status defaults to private.

New lessons start as `draft` the moment the Lesson Creator conversation begins
(one `lesson:<id>` record per draft in `_system` sync-data), so admins can pause
and resume drafts or work on several in parallel. After reviewing the preview,
admins choose **Save privately** (shared only with the author) or **Save & make
public** (visible to all learners in the classroom). Both finalize the same
record, saving the reviewed markdown and chosen visibility together.

The finalized lesson's **Private/Public** button opens **Visibility & Sharing**
from either the lesson list or the editor. A saved private lesson also offers
**Make public** directly in the editor. This changes only visibility, preserving
the saved content, shares and any unsaved preview. Drafts retain a noninteractive
Draft badge until finalized. Visibility success is shown after acknowledgement;
failed dialog saves keep their selection and show the error inside the dialog.
An empty share list is valid: **Make Private** removes classroom-wide visibility
without adding recipients. During an unknown visibility save, the editor header
keeps the last confirmed status while the dialog shows the pending choice that
**Retry saving** will resend, including when reopened or recovered after reload.

The share list is independent of visibility and survives a public/private round
trip in the Share modal. Public lessons ignore the list for access checks.
The admin API requires `sharedWith` to be an array of user ID strings; omitting
it preserves the current list, and an explicit empty array clears it.

### Courses, units, and lessons (#408)

Lessons are organized as **Course → Unit → Lesson**. Every part is optional:
a lesson can sit outside any unit, and a unit outside any course. Everything
here is organization only. Lesson visibility (public/private/draft +
`sharedWith`) is unchanged, and nothing here affects completion.

**Storage keeps its pre-hierarchy names** (glossary: storage `course` = UI
**Unit**; storage `program` = UI **Course**). Nothing that references a unit
had to move: `lesson.course`, learners' `courseProgress:<unitId>` memory, and
stats.

| UI | Record | Membership | Order |
|---|---|---|---|
| Course | `_system:program:<id>` `{ name, description, unitIds }` | top level | by name |
| Unit | `_system:course:<id>` `{ name, programId, createdAt }` | `unit.programId` | `program.unitIds` |
| Lesson | `_system:lesson:<id>` | `lesson.course` (the unit id) | `_system:unitOrder:<unitId>.lessonIds` |

`server/src/lib/hierarchy.js` is the single place that reads it:
- **The lesson PUT doesn't touch the unit order record.** A lesson moved into an
  ordered unit appears after the ordered ones, by name, until an admin
  reorders the unit.
- **An install with no units at upgrade gets no default Course** (m004 only
  creates one to hold existing units). Units made later start outside any
  course until an admin puts them in one.
- **Order arrays only order.** `orderIds()` lists the ids an array names that
  are still members, then any members it's missing by name (the
  pre-hierarchy behavior). A stale or missing array can't hide or duplicate
  anything; it falls back to alphabetical.
- Reorders must be an exact permutation of the members
  (`PUT /v1/admin/units/:id/order` and `/programs/:id/order`).
- `buildHierarchy()` gives positions. The learner reads (`GET /v1/lessons`
  and `/v1/lessons/:id`) inline `unit: { id, name, position, lessonPosition }`
  and `program: { id, name, position } | null`. They keep `course: { id, name }`
  (the unit) for one release, for cached clients.

Admin routes live in `server/src/routes/admin-hierarchy.js`:
- `/v1/admin/units*`, with `/v1/admin/courses*` kept as the deprecated alias.
- `/v1/admin/programs*`.
- Unit `PUT` **preserves fields it doesn't set**. The pre-hierarchy handler
  rebuilt the record and would have dropped `programId` and `lessonIds`.

**Cascades:**
- Deleting a unit sets `course: null` on its lessons (re-reading each and
  skipping any another admin already moved) and removes it from its course's
  order.
- Deleting a course leaves its units, unassigned.

**Admin UI:** Admin → Lessons → **Courses & Units**
(`/plato/lessons/structure`, `client/src/pages/admin/CourseStructure.jsx`)
replaced the old Courses modal.
- It adds, renames, and deletes courses and units, and puts a unit in a course.
- It orders units within a course and lessons within a unit with **Move up /
  Move down** buttons (no drag and drop). Each button names its item, and every
  move is announced in a polite live region. Focus is restored after the
  reloaded list renders. When an item reaches the top or bottom, focus moves
  to the opposite button, so the same item can keep moving.
- The lesson editor's picker is **Unit**, grouped by course (`<optgroup>`). The
  lessons table shows "Course › Unit".

**Migration:** `m004_default_program` puts every existing unit into one
default Course, named after the classroom, with the name-sorted lesson order
it already had, so nothing reorders on upgrade.

**Rollback and rolling-deploy repair** (`server/src/lib/unit-repair.js`).
Releases from before the hierarchy (Beta-RC-232, and this fork's own before
the launch integration) save a unit by replacing its record, so a rename made
there, during a rollback or by an old instance mid-deploy, drops `programId`,
`lessonIds`, and the Getting Started unit's `bundled` marker. m004 is already
recorded and the bundled course installs once, so neither would run again.
Those releases ignore `_system:unitOrder:*`, so custom lesson order survives
renames without depending on course ownership:
- `PUT /v1/admin/units/:id/order` strongly reads the unit, its order record,
  and current lesson membership, validates an exact permutation, and writes
  only `{ lessonIds, unitCreatedAt }` in `unitOrder:<id>`. Missing records use
  create-only writes; existing records use strict versions, with three attempts
  for version conflicts. `m006_unit_order` copies legacy `unit.lessonIds` with
  create-only writes. New bundled units get their order from the seed after
  migrations. No order is mirrored on unit or course records. Preview databases
  holding the removed course order mirror must be recreated; it is not read
  as a fallback.
- `buildHierarchy()` uses the order only when `unitCreatedAt` matches the
  unit's data `createdAt`; otherwise it uses legacy `unit.lessonIds`. A missing
  timestamp is represented as null for legacy units. Reused IDs have a new
  stamp, so an old unit's custom order cannot reappear.
- Every start (`seedDefaultContent`, after bundled content) restores absent
  `programId` and bundled metadata only when exactly one course lists a unit.
  Explicit `programId: null` stays unchanged; multiple owners are reported
  separately. Repair never restores order. Conflicting repairs wait until
  the next start (`units_repaired`: `repaired`, `ambiguous`, `conflicted`).
- Unit deletion removes the unit before its stamped order. Best-effort startup
  reconciliation removes orphaned or mismatched order records. Both deletion
  paths pass the observed `expectedVersion` to the existing `deleteSyncData`
  interface; a concurrently updated order survives. Cleanup logs separately
  as `unit_orders_reconciled` or `unit_order_reconcile_failed`.
- The RC-232 gate uses the fork's migrate, seed, repair startup sequence and
  exercises actual RC-232 rename and delete handlers. A 400 or 409 reorder
  response reloads the UI, announces the reload politely, and restores focus
  to the pressed control (or the existing boundary fallback).

**Learner side:** `loadLessons()` carries `unit` and `program` onto each lesson
and returns them in hierarchy order. `client/src/lib/lessonOrder.js` holds the
pure helpers (tested in `client/tests/lessonOrder.test.js`):
- `compareLessons`/`sortLessons`: course position, unit position, lesson
  position, then name. Units outside a course come after courses; lessons
  outside a unit (including the learner's `custom-*` lessons) come last.
- `nextLessonAfter`: "Continue to Next Lesson" goes to the next lesson in the
  unit, then on into the next unit **of the same course**. It never jumps to
  another course. A unit outside any course stays within itself.
- `groupForDisplay` and `completionBy('program' | 'unit')` drive the lessons
  page (see [Learner classroom](#learner-classroom)).

**Coach Directive is a trusted-author channel.** Anyone with
`content.write` (admins and educators) can put instructions in front of every
learner's coach. The coach is told the directive never overrides completion,
but that's prose. The code guarantees are these: completion happens only in
`applyCoachResponseToKB` (`server/src/shared/lessonAssessment.js`), run by the
server's coaching route, and needs source-backed evidence for every objective
and the exemplar; scores are clamped 0–10. Grant `content.write` only to people
you'd trust to write the coach's instructions.

**Coach context:** `server/src/shared/coachContext.js` sends `unit: { name, progress? }` (the
cross-lesson note is per unit) and `course: { name }` (the course above it).
Before #408 the unit was sent as `course`. The `course-progress-update`
agent's input keys (`courseName`, `lessonsInCourse`) keep their old names; the
prompt says they describe the unit.

### Learner classroom

`/lessons` (`client/src/pages/LessonsList.jsx`): lessons render as a responsive
grid (1 col mobile / 2 col `sm:` / 3 col `lg:`) with 12 per page. A course
filter dropdown sits above the grid; it's hidden when no courses exist. When the
filter is set to a course that no longer exists, it snaps back to "All courses"
automatically. Filter and page changes are announced via an always-mounted
`role="status" aria-live="polite"` region — no visible "N lessons" subhead.

Lessons are grouped by course, and each course on the page gets a header with
an "N of M public lessons" progress bar (#395). Grouping uses course IDs, so
courses whose names sort equally still have one group each on the page. The counts come from
`courseCompletion()` (`client/src/lib/courseCompletion.js`) over **all** of
the course's public lessons — never the filtered or paginated view, so a status
filter like "Not started" can't turn "5 of 8" into "0 of 3". The learner's own
`custom-*` lessons and private lessons shared with the learner are excluded
from both counts, matching the public-only admin KPI definition. Private shared
lessons remain visible and usable in the grid. Courses without public lessons
have no progress bar. Purely informational; it reads `lessonKB.status` and never
affects completion.

While the status filter shows every status, the lessons the learner has started
and not completed lead the whole list under an **In progress** heading
(`aria-label="Lessons in progress"`), in hierarchy order among themselves, so a
long first course (Getting Started included) can't push a returning learner's
lesson onto page 2 (`orderForCatalog()` in `client/src/lib/lessonOrder.js`;
`isInProgress()` in `lessonListOrder.js`). A status filter keeps plain
hierarchy order and grouping. After the in-progress group, each page groups by
course and unit in hierarchy order (`groupForDisplay()`); lessons without a
unit come last, under **Other lessons** whenever the list has structure.

A learner who hasn't started any lesson gets one suggestion instead: the first
lesson in the list shows **Start here** (`startHereLessonId()`), and its open
action's accessible name ends with "Start here." It follows the filters, so a
course filter moves it to that course's first lesson. It never marks an admin's
own `custom-*` lesson and doesn't appear in a list of one. Catalog order has no
authored sequence: course name, then lesson name, both with numeric collation,
so an admin who wants a particular first lesson numbers the names ("1. …"). The
mark leaves once any lesson has a status. It uses the verified progress snapshot
that orders the list; unknown progress never qualifies a learner for the mark.

`useLessonListProgress()` publishes a catalog and its progress together.
`lessonCatalogLoaded` distinguishes a successful catalog response from a failed
initial attempt. Until a catalog succeeds, its initial empty array cannot become
a retained snapshot or produce an empty-state announcement during retry.
`sync.loadAll()` returns true only after a complete, current response populates
the cache, and `AppContext` publishes that result with the catalog as
`lessonProgressHydrated`. Only this successful bulk read proves that an absent
cache record means not started. No confirming per-lesson requests are needed
after a successful bulk sync. The first render uses the cache immediately;
previous component statuses cannot override a newer catalog's snapshot.

If bulk sync fails and some progress is unknown, `loadLessonStatuses()` reads
the catalog's progress records before the first cards appear. A missing record
must be confirmed by a successful response with `data: null`; HTTP failures,
network errors and malformed responses do not become "not started." An initial
load shows **Loading lessons…**, then a retryable progress error if needed.
A foreground refresh retains the last verified catalog, status filters, paging
and keyboard focus while fallback reads are pending or failed. The existing
**Try again** action retries the catalog and progress together.

Fallback requests are aborted on unmount or when a newer catalog arrives, and
their results never write the shared sync cache. Completion-event reads have the
same lifetime guard; completion updates received during a fallback take precedence
over that fallback's older status. Sign-out resets the app catalog and its
hydration flag before another account signs in. These are read-path changes;
lesson completion and persistence writes are unchanged.

The **View outline** dialog ends with the lesson's next step (**Start
lesson**, **Continue lesson**, or **Open lesson**) and closes before navigating,
so its background scroll lock is released before the lesson page renders.

**Previous** and **Next** move focus to the page's `h1` (`goToPage()`), which
scrolls the new page's top into view. Left on the button, focus would sit below
cards the learner hasn't read, and on the last page, where Next is disabled, it
fell to the document and the next Tab reached the footer. Both buttons are
`focusableWhenDisabled`, and steps count from the page shown, which the stored
page can outrun when the list shrinks. Filter changes reset the page without
moving focus. Lesson titles, descriptions, course names and the outline's author
text use `dir="auto"`, since admins can write lessons in a right-to-left
language; the card's metadata isolates its course name in a `<bdi>`.

Both learner lesson endpoints return normalized visibility in `status`, using
the same `normalizeStatus()` helper as dashboard/activity stats: legacy
`published` and status-less lessons with markdown become `public`, and legacy
drafts with markdown become `private`. `loadLessons()` preserves this field
alongside course metadata. Only the normalized `public` status contributes to
progress; unknown visibility and incomplete status-less records do not.

`loadLessons()` merges system lessons (`/v1/lessons`) with user lessons from
sync-data. To preview a lesson as a learner sees it (the live coach experience),
admins share the lesson with themselves and view it in the classroom — the
editor preview only renders the lesson markdown.

### Lesson editor

Editing is conversation-based via the Lesson Creator agent (no raw markdown
editor). The editor is deep-linked at `/plato/lessons/:lessonId/edit` (mirrors
the `users/:userId` pattern) so it survives reload and browser-back.
`/plato/lessons/new` mints a fresh `admin-<ms>` draft id and `replace`-redirects
to that edit URL — the draft record is created lazily by the editor's first
auto-save. Only a confirmed 404 for a fresh draft (within five minutes) or an
unsaved recovery copy opens create mode. Other load failures offer retry in
place, without starting an agent or writing a draft. `AdminLessons` keys
`LessonEditor` on the lesson and load attempt so switching lessons remounts cleanly.

Authoring stays on one page. The conversation and preview sit side by side when
the editor container is at least 52rem wide; course and readiness sit above both
columns. Narrower containers show keyboard-operated **Refine / Preview** tabs,
including when enlarged text reduces the available space. Both panels remain
mounted so switching tabs preserves the composer and in-flight requests. Arrow
keys, Home and End select tabs; **View preview** opens and focuses the review.
When widening hides a focused mobile tab, readiness summary or View preview
control, focus moves to its visible content after the layout updates. Narrowing
keeps focused readiness guidance expanded. Ordinary blur and focus outside the
editor do not restore an abandoned control.
Both save choices follow the preview in reading order at every width, with
full-width buttons on narrow screens. The mobile preview uses the page's
scrolling flow. **Start over** stays with the conversation and keeps its
confirmation dialog. Unknown final-save recovery opens the Preview tab.

Existing preview content has one Refresh preview control in its header, including
when stale. Authors can refresh before scrolling through the old content; empty
previews keep Generate preview after their explanation. Final save/update choices
remain after the preview. Refresh errors describe the initiating control and
come into view while Preview is visible and focus remains on that control or
has not changed since activation. Recording the activated control separately
also handles browsers that leave focus elsewhere when a button is tapped.
Focus stays unchanged; background failures preserve Refine's focus and scroll.

Readiness describes how fully the conversation has defined the lesson. Its
native disclosure explains the exemplar, objectives and scope rubric and the
existing 3/10 creation minimum. Mobile shows the score in a disclosure that
expands to the bar, explanation and rubric. The score and its color do not
replace review or preview validation; the underlying thresholds are unchanged.

The lesson directory uses compact rows below the medium breakpoint and the
existing table at wider sizes. Both share filtering, pagination, visibility
controls and edit/delete handlers. Mobile rows expose named actions and optional
metrics. Search stays visible; a native **Filters** disclosure contains the
course and visibility choices, indicates active filters and offers clearing.

`lessonSaveQueue` serializes conversation, course, visibility and final markdown writes.
Each write carries the last acknowledged `expectedVersion` and a stable
`operationId`. Authoring reads are consistent on DynamoDB; both database
adapters enforce strict compare-and-set, including first creation and deletion.
A retry of an already committed operation acknowledges the existing version.
Competing changes return 409 rather than overwriting another session. Legacy
draft writes also cannot rename or overwrite a finalized lesson.
Non-authoring edits must clear `authoringOperationId`: the course-deletion
cascade does this so neither a retry nor tab recovery can mistake its newer
version for the original authoring save and restore a deleted course assignment.

Before requests, a recovery copy stores the conversation, pending operations,
reply state and preview in account/lesson-scoped **sessionStorage**. It survives
navigation and reload in that tab, not closing the tab. Failed saves provide
**Retry saving**, without another AI call; interrupted replies provide **Retry
reply**, reusing the submitted user turn. Back waits for pending saves, unload
warns while writes are pending, and storage failure is visible. Departed editors
cannot overwrite a newer recovery copy or navigate after their requests finish.
Conflicts preserve local work until the admin explicitly chooses to discard it
and load the saved lesson. A confirmed 400 rejecting final markdown permits
**Revise lesson**; a rejected visibility-only request can also be corrected.
Unknown write outcomes retain the same operation and chosen visibility for
retry. The editor's confirmed status and acknowledged version advance together
after a visibility-only save, so later content saves do not conflict with it.

**Markdown preview pane** (`client/src/pages/admin/MarkdownPreviewPane.jsx`):
chat left, rendered markdown right, wrapping according to available space and
text size. Headers and action groups wrap at narrow widths. The preview is
**manually refreshed** via a "Generate preview" / "Refresh preview" button that
re-runs the relevant extractor agent — it does NOT auto-update per message and
runs no AI call on editor open. On open the pane shows the already-saved markdown
(edit) or a quiet empty-state (new). Once the conversation advances past the last
refresh, a **Needs refresh** badge and notice explain that the conversation has
changed. The saved or previous content stays visible during extraction and
after a failure. Conversation and markdown revision IDs preserve that
distinction across sessions. A late extraction remains stale if the author has
continued the conversation. Refresh completion does not move focus away from
the conversation or another panel.
**Generate preview / Refresh preview** generates and validates a preview;
**Save privately / Save & make public / Update Lesson** saves that exact
markdown, after pending autosaves finish. Refresh is a separate action; final
save controls stay disabled while the preview is missing, stale or refreshing.
Conversation-save status, currently saved content, and a current but unapplied
preview have separate labels. Failed finalization retains the preview and visibility
choice for persistence-only retry, including after a same-tab reload. Restart clears it and invalidates outstanding
extractions. Preview markdown is kept in the tab's recovery copy, but is not
published as lesson content until the save button is used.
`buildConversationText` (`client/src/lib/lessonCreationEngine.js`) is the shared
builder for the extractor input. The same pane (copy parametrized via props) backs both the lesson editor
(`extractLessonMarkdown`) and the **knowledge base editor**
(`AdminCustomizer` + `AdminKBSetup`, `extractKBMarkdown`). The knowledge base
editor saves only a current reviewed preview, verbatim, and never invokes
extraction while saving. Conversation and direct text editing share a document
draft. Text changes require **Review text changes**; conversation changes require
a separately generated/refreshed preview. Extraction starts from the current
text draft so manual corrections carry into guided work. The assistant
estimates readiness on a visible 0–10 scale, with a 3/10 generation minimum;
direct text review and saving do not depend on that estimate. Failed generation
retains the previous document, and failed or unconfirmed saves keep the reviewed
bytes available for persistence-only retry. Document edits remain in the mounted
editor until saved or explicitly abandoned; the navigation/reload guard protects
them, while the conversation auto-saves as a server draft. Conversation turns
after the last save carry `unpublished: true` until the knowledge base is saved
(`client/src/lib/knowledgeBaseDraft.js`).

### Coach directive

A lesson can carry **author-supplied runtime instructions for the coach** that
are neither exemplar nor objective — e.g. "reference the learner's portfolio
project throughout (don't ask what it is)," "if the learner picks tool X, share
this discount code + URL with these checkout caveats," or "assume the learner
already finished the intro lesson." These flow end-to-end through one optional
`## Coach Directive` markdown section:

1. **Extract** — `lesson-extractor` emits `## Coach Directive` **verbatim**
   (codes, URLs, caveats intact) only when the conversation contained such
   instructions; otherwise it omits the heading.
2. **Parse** — `parseLessonPrompt` (`client/js/lessonOwner.js`) reads the
   section into `lesson.coachDirective` (buffered like the exemplar so multi-line
   directives survive; absent ⇒ no key).
3. **Serve** — `buildContext` (`client/src/lib/lessonEngine.js`) surfaces it as
   `context.coachDirective` in **both** active and completed states.
4. **Obey** — `coach.md` treats it as a high-priority instruction followed every
   exchange. It refines *how* the coach runs the lesson; it never overrides the
   exemplar, assessment, or completion semantics (the coach still owns
   `progress`). The Lesson Creator (`lesson-creator.md`) is aware of directives
   and confirms them back to the admin rather than silently dropping them.

Historically this was a gap: the extractor's output format had no slot for
coach-facing instructions, so anything an admin typed beyond exemplar/objectives
(the Creator would echo it conversationally) was summarized away and never
reached the coach. Adding the field at all four layers closed the loop.

**Extraction contract — keep these in lockstep.** What an admin discusses in the
Lesson Creator conversation only persists if the Lesson Extractor has a field
for it. The set of persisted fields (name, description, exemplar, 2-4
objectives, optional coach directive) is the contract, and it's enforced by
prose in **five** places that must change together when a field is added or
removed: `lesson-extractor.md` (output format), `parseLessonPrompt`
(`client/js/lessonOwner.js`), `buildContext` (`client/src/lib/lessonEngine.js`),
`coach.md` (so the coach reads it), and — critically — `lesson-creator.md`'s
"What the lesson actually saves" section, so the Creator agent never promises an
admin something the extractor will silently drop. Adding a persisted lesson
field without updating the Creator's contract reintroduces exactly the
scrubbed-directive bug.

### Course progress (cross-lesson memory)

When a lesson belongs to a course, the coach gets a **tiny, distilled,
per-learner note of what that learner has demonstrated in the course's *other*
lessons**, so it can connect threads ("building on the prompt you wrote earlier
in the course…"). This is the learner-profile pattern scoped to a course — same
proven, bounded plumbing as `profileSummary`, not a new mechanism.

- **Store** — one `courseProgress:<courseId>` per learner (sync-data, key
  allowlisted in `server/src/routes/sync.js`):
  `{ courseId, summary, completedLessonIds[], updatedAt }`.
- **Regenerate** — on completion, the `if (achieved)` block in
  `lessonEngine.js` calls `updateCourseProgressOnCompletionInBackground`
  (`client/src/lib/courseProgressQueue.js`, a sequential queue mirroring
  `profileQueue.js`) **only when the lesson has a course**. The new
  `course-progress-update` agent (`client/prompts/course-progress-update.md`,
  `orchestrator.updateCourseProgress`) receives the *prior* summary + the *one*
  just-completed lesson's KB (+ the course's lesson list from
  `getLessonsInCourse`) and returns an updated summary with a **hard ~600-char
  cap**. This **incremental distillation** — never concatenating all sibling KBs
  — is what keeps both the agent's input and the injected note small.
- **Inject** — `buildContext` takes an optional 5th `courseProgress` arg and, when
  present, attaches it as `context.course.progress`. `startLesson`/`sendMessage`
  fetch it via `loadCourseProgressSummary` when the lesson opens (within a session
  the value only changes via *other* lessons' completions, so fetch-on-open is
  enough). `coach.md` documents `course: { name, progress? }` as informational —
  it never touches the exemplar or completion (`applyCoachResponseToKB` stays the
  single owner of `progress`).

**Out-of-order completion just works**: complete B → `courseProgress:<id>`
regenerates → resume A → A's coach reads the now-current note including B. No
coupling between the lessons themselves.

*Known limitation (v1):* summaries build **forward** from completions after this
shipped; pre-existing completions are not backfilled.

### Getting Started, the bundled orientation course (#443)

plato ships one course, **Getting Started with plato**, so every classroom
can teach the platform itself. It's a Course holding one Unit ("How plato
works") with three lessons, in order. Each lesson's exemplar proves the
learner can use part of plato, not a subject:

| Lesson (fixed id, file in `client/prompts/lessons/`) | The learner shows they can |
|---|---|
| **Welcome to plato** (`getting-started`, `getting-started.md`) | say what plato and the coach are; find the exemplar and objectives and which are met (the lesson overview); say how a lesson is completed and what happens after |
| **Sharing your work** (`getting-started-sharing`, `getting-started-sharing.md`) | send, and pick the send key (Settings → Chat); share a screenshot or image; attach a link and say what the coach does with it |
| **What plato does behind the scenes** (`getting-started-behind`, `getting-started-behind.md`) | read and correct the learner profile (Settings → Learner Profile → Add Feedback); use "Behind this response"; say what carries between lessons (unit progress) |

Each lesson's `## Coach Directive` lists the real control names so the
coach doesn't invent UI. The files travel with the prompts (the deploy's
`cp -r client/prompts` copies the `lessons/` folder), and
`seedDefaultContent` calls `ensureBundledLessons()`
(`server/src/lib/bundled-lessons.js`) on every cold start. In the fork it runs
**after** the data migrations, because startup awaits them first (see
[Data migrations](#data-migrations)).

**The course** (`BUNDLED_COURSE`): `_system:program:prog-getting-started`
and `_system:course:unit-getting-started` (unit `lessonIds` in lesson order),
both marked `bundled: { id }`, installed once (`_system:bundled:course:getting-started`).
After that it's the admin's: rename it, reorder it, or delete it, and it's
never recreated. A record an admin already has under the same id is left
alone. Lessons installed before the course existed (playground's one-lesson
release) join the unit if they aren't in one. m004 ignores bundled courses
when deciding whether an admin already made courses, so the order of
migrations and bundled installation doesn't change the result: counting it
would leave every existing unit outside the default course.

**Each lesson:**

| Situation | What happens |
|---|---|
| First time on an install, classroom has no lessons | created **public**, in the Getting Started unit |
| First time on an existing classroom | created **private**; Admin → Lessons shows one notice for the course with **Publish all / Review lessons / Dismiss** |
| Added later to an install whose first Getting Started lesson is public | created public, so the course isn't left half-published |
| Admin deleted it | never recreated (`_system:bundled:<id>` marker remembers the install) |
| New version, copy unedited | updated in place; status, unit, and sharing kept; learner progress (`lessonKB:<id>`) untouched |
| New version, copy edited | never overwritten; Admin → Lessons shows "has an update" with **View update / Apply update / Dismiss** |
| An admin's own lesson already uses the id | left alone (no `bundled` marker) |

The record carries `bundled: { id, version, dismissed?, publishNoticeDismissed? }`.
`version` is the hash of the canonical markdown the copy last synced to, and
the copy counts as edited when its markdown no longer hashes to it. The admin
lesson PUT keeps the marker, so editing makes a copy "edited" instead of
detaching it. Routes: `GET /v1/admin/bundled-lessons` (content.read) and
`POST /v1/admin/bundled-lessons/:id { action: 'apply' | 'dismiss' |
'dismiss-publish' }` (content.write; apply is audit-logged
`bundled_lesson_updated`). Publish all uses the normal lesson PUT.

Learners see it first: its lesson reads include `startHere: true`, so the
course sorts above every other course; "Continue to Next Lesson" walks its
three lessons and stops at the end of the course. A start-here lesson an
admin moved out of every course still shows first, under **Start here**.

**Keep it current:** a PR that changes learner-facing behavior updates the
lesson that teaches it (see CLAUDE.md). Unedited copies everywhere pick up
the change on the next deploy.

### The lesson overview (#438)

One read-only dialog per lesson (`client/src/components/chat/LessonOverview.jsx`),
merging what were two dialogs upstream ("Lesson Overview" and "Your work"). It
opens from the lesson header's **"Progress (N of M Objectives)"** button
(accessible name "Progress (N of M Objectives): lesson overview") and from
**Your progress** in the lessons page's outline dialog for started lessons
(`/lessons/:id?view=overview`; `?view=work` still works). In order:
- **Objectives:** the checklist (met / not yet, with screen-reader state).
- **What finished work looks like:** the exemplar, once.
- **Where you are** and the coach's notes, when the lesson KB has them.
  Nothing is generated for the dialog.
- **Shared work** (`<details>`, started lessons): images and links from the
  messages' `metadata.imageKeys` / `metadata.links` (and a legacy single
  `imageDataUrl`). Images load only when the section opens, bound to the
  lesson's owner; a failed image keeps its key and says it failed.
- **Additional context** (`<details>`): sanitized plugin enrichments, with
  safe http(s) links only.

The footer links **How assessment works**. The body is one focusable scroll
region (axe scrollable-region-focusable). It works the same on completed
lessons and in View as User, since it only reads.

**The checklist is canonical evidence, not a coach-reported index list.**
Upstream let the coach add `"objectivesMet": [1, 3]` and merged it one way
into `lessonKB.objectivesMet`. In the fork, each authored objective has a
canonical id, and the server's assessment records `lessonKB.evidence` entries
(`{ objectiveId, status, observation, sourceIds }`) against confirmed learner
sources. The overview and completion share one predicate, `evidenceIsMet` in
`server/src/shared/lessonAssessment.js` (the client's `lessonWork.js` imports
it). An objective shows as met only when its evidence is valid and cites
confirmed, retained sources: readable link text, images still available.
Active corrections, invalid sources or a change to the lesson's criteria can
uncheck it, and legacy indices can't check anything. A completed lesson stays
frozen as completed. The exemplar is a separate completion requirement.

### Rewriting lessons in bulk (#261)

Editing in plato is conversation-based, which is too slow for an editorial
pass over many lessons. Instead:
1. **Export** (read-only): `server/scripts/export-lessons.js <dir>` writes each
   lesson to its own file and a `manifest.json` with each lesson's id,
   filename, hash and objective count (`server/src/lib/lesson-rewrite.js`).
   Filenames are bounded names derived from SHA-256, written with exclusive
   creation, so a stored lesson id never becomes a path.
2. **Edit and review** the files in a pull request.
3. **Apply**: `server/scripts/apply-lessons.js <dir>` is a dry run unless
   `--apply`. It validates manifest filenames (older manifests are accepted
   only for safe ids), requires every real path to stay inside `<dir>`, and
   refuses symlinks. It refuses any lesson changed in plato since the export
   (`conflict`), any edit that fails the lesson checks
   (`server/src/lib/lesson-markdown.js`, shared with the admin lesson PUT and
   using the fork's fence- and container-aware parser), and any edit that
   changes the number of objectives. Each write is version-checked and logs a
   `lesson_rewrite_applied` audit entry with the before and after hashes.
   Status, unit, sharing and learner progress stay.

Only the first line after the title is the lesson's description (what
`parseLessonPrompt` reads), so a rewrite puts "why this matters / how it
follows the last lesson" there. Coaching notes, such as terms to define at
first use, go in the optional `## Coach Directive`. No new lesson fields are
needed.

### How assessment works (#257, #414)

`/how-assessment-works` (`client/src/pages/HowAssessmentWorks.jsx`) is a
public page, linked from the lesson overview's footer and the Getting Started
lessons. It describes what plato actually does: each lesson's exemplar and 2–4
objectives; the AI coach assessing progress after every reply with the
provider an administrator selected (Amazon Bedrock or Cloudflare Workers AI);
completion only on trusted evidence for every objective and the exemplar, with
no message limit; feedback-only after completion; no AI-writing detectors; and
the read-only, logged staff view. Policy only people can set is shown as "To be
decided by the program team" notes: when learners may use AI tools for the work
they submit, whether people review completed lessons and how a learner appeals,
and what completing a course certifies.

The coach prompt backs this up (#414): when a response could have come from
anyone, the coach asks for a personal example or the learner's own reasoning
before recording evidence, without accusing anyone of using AI. Upstream
measured this on Bedrock with Qwen3-VL; the fork's prompt keeps the behavior
but wasn't re-measured.

## Pacing & completion philosophy

Microlearning constraints live in `client/src/lib/constants.js`:
`MAX_EXCHANGES=11`, `MIN_OBJECTIVES=2`, `MAX_OBJECTIVES=4`,
`MINS_PER_EXCHANGE=1.8`. Server mirrors them in
`server/src/lib/lesson-limits.js`. Prompts reference these as literal numbers
(update both if changed).

Lessons target 11 exchanges (~20 min). **There is no hard cutoff** — lessons
always run until the coach awards progress 10. The coach gets escalating
`pacingDirective` nudges in the context JSON (at 8+, 11+, 15+, 20+) but these
are suggestions, never orders. `client/src/lib/lessonEngine.js` must **never**
auto-complete a lesson based on exchange count; only `parsed.progress >= 10`
triggers completion. Philosophy: "move people, not force people" — the coach can
always introduce new scaffolding if the learner needs it. `extendedLessons`
(completions at 22+ exchanges) is informational only — it signals lesson-design
mismatch, not a metric to drive to zero.

### Post-completion feedback mode

Once `lessonKB.status === 'completed'`, the thread is feedback-only.

- `activitiesCompleted` freezes (it's the learning-exchange counter, not a
  total-turn counter — post-completion chatter doesn't count and would corrupt
  the `extendedLessons` KPI if it did).
- `pacingDirective` is suppressed and `postCompletionDirective` replaces it,
  telling the coach never to coach, assess, or award progress for a *different*
  lesson inside the same thread.
- **`progress` freezes too.** The directive above is prose inside a 167-line
  prompt, and compliance is model-dependent: evaluating open-weight Bedrock
  models for per-agent routing, Kimi K2.5 emitted `[PROGRESS: 10]` on every
  post-completion turn (when asked to start a *different* lesson in the thread)
  where Haiku 4.5 correctly emitted no progress tag at all. `achieved` was
  already safe via `!wasCompleted`, but the assignment to `next.progress` was
  not, so a completed lesson's score could be rewritten by any turn of feedback
  chatter. Completion semantics must not depend on a model choosing to obey an
  instruction — the freeze is now in code.
- `achieved` is one-shot — only true on the transition turn — so completion side
  effects (completion cue, completion profile update) don't re-fire on subsequent
  feedback messages.
- KB updates (`insights`, `learnerPosition`) are **not** frozen — capturing
  feedback is the entire point of the post-completion thread.

Scores are also range-clamped to 0–10 via `clampProgress`, which returns `null`
(meaning "no score reported") for absent or unparseable values rather than
coercing them. `Number(null)` is `0` and `Number('ten')` is `NaN`, so a naive
coercion would silently reset a lesson's progress to zero when the coach omits
or malforms the tag — both caught by tests during implementation.

The pure helper `applyCoachResponseToKB` in `lessonEngine.js` is the **single
owner** of this invariant.

## Denormalization policy

plato's source of truth for learner activity is the `sync-data` table
(`lessonKB:*`, `messages:*`, etc.). When a read path requires aggregating across
many of those records — counts, "last X" timestamps, percentages — the right
move is to denormalize a derived field onto a record that's already cheap to
fetch (typically the user record), maintained by hooks on the sync write path.
The Admin → Users `lessonsCompleted` + `lastActiveAt` fields (#136) are the
canonical example. Do this **responsibly**:

- **Single writer.** Exactly one code path mutates each denormalized field —
  `server/src/routes/sync.js`'s `applyActivityEffects` for activity counters. No
  other route writes these fields directly. This is the only way to keep "two
  places" from drifting.
- **Transition detection for status counters.** The coach writes a `lessonKB`
  multiple times after completion (post-completion feedback turns keep updating
  it). Counters that fire on status flips must read the prior record and only
  increment on the first transition (non-completed → completed). Repeat writes
  with the same status MUST NOT double-count. `lessonsCompleted` has a dedicated
  test for this; new counters must too.
- **Published-only stats.** Every dashboard/per-user KPI counts **only published
  (public) lessons** — drafts, privates (even when shared to a learner via
  `sharedWith`), and user-created custom lessons are excluded from both the
  numerator and the denominator. The rule lives in
  `server/src/lib/lesson-visibility.js` (`normalizeStatus`, `publicLessonIds`,
  `isPublicLessonRecord`); a completion counts iff its lesson id maps to a public
  `_system:lesson:*` record. Custom lessons (stored under the learner's own
  `lessons:custom-*` sync-data, never in `_system`) fall out for free. The
  `applyActivityEffects` writer looks up the lesson record before incrementing.
- **Best-effort writes, never blocking.** The primary sync write succeeds first.
  The counter update is wrapped in try/catch and logged but never thrown. If it
  fails, the user's lesson data is still correct — only the counter is stale, and
  lazy-backfill heals it on next admin read.
- **Lazy backfill instead of migrations.** When the read endpoint encounters a
  record with an undefined counter (legacy user), it computes the value once and
  persists it back. After that, reads are O(1). No deploy-time migration step.
- **Source of truth is still the underlying data.** Counters are an index, not
  authoritative. On drift, the underlying sync-data wins; a manual rebuild script
  can re-derive counters from scratch.
- **Anti-goals.** Don't denormalize fields that change on every learner message
  (write amplification — message-rate is plato's hot path). Don't make the
  primary write fail if the denormalized write fails. Don't add a second write
  path for the same field. Don't denormalize values that depend on cross-user
  state (e.g. a user's "rank in the classroom") — compute those per-request from
  cheap classroom-wide lists.

### Per-user activity stats (#136)

Admins see a learner's lesson activity on the Admin → Users edit-user view,
deep-linked at `/plato/users/:userId` so refresh and browser-back preserve the
selection. The edit-user state is derived from the URL via `useParams`;
`openEditUser` navigates rather than setting state directly. A bad userId
silently redirects back to `/plato/users`.

`UserStatsPanel` (`client/src/pages/admin/UserStatsPanel.jsx`) fetches
`GET /v1/admin/users/:userId/stats` and renders three summary tiles (a
CompletionRing for completed/available with color thresholds at 35%/90%, last
active, and median estimated active time with the 90th percentile beneath) and
a list of completed lessons. Computed on demand — no precomputation.

- The stats are all-time. The route accepts `?days=` and echoes it as
  `windowDays`, but nothing is filtered by it, so the panel names no window.
- UI uses "completed" rather than "mastered" because the underlying field is
  `lessonKB.status === 'completed'` — calling it mastery would imply a quality
  claim we don't measure.
- Duration is exchange-based (`activitiesCompleted × MINS_PER_EXCHANGE`) for
  consistency with `/v1/admin/stats/lessons` — wall-clock minutes inflate from
  multi-session lessons — so the UI labels it an estimate ("est. active time",
  "~N min"), matching the dashboard.

The Admin → Users table opt-in `?include=stats` adds `lessonsCompleted`,
`lessonsAvailable`, and `lastActiveAt` to each row; the Completed column renders
a compact CompletionRing colored by progress.

- `lessonsCompleted` (published-only) is **recomputed per request** from the
  learner's sync-data against the live public-lesson set, and the denormalized
  counter is healed (overwritten) when it drifts. The `applyActivityEffects`
  hook keeps the stored counter close in the meantime, but it can't be trusted
  on its own for visibility — a lesson can go public→private *after* a learner
  completes it, and legacy/pre-filter counters may be inflated. Recomputing on
  read is the deliberate trade (chosen over a one-time migration): it loosens
  the strict O(1)-per-user goal for a small per-user read, which self-corrects
  prod's existing counters. To keep that cheap at hundreds of users, the read
  uses `db.getSyncDataByPrefixForAllUsers('lessonKB:')` — one bulk prefix
  read for the whole classroom (a single query on Postgres/SQLite; a
  per-user prefix fan-out bounded to 4 in flight on DynamoDB) that returns
  only the `lessonKB:*` records, never the large
  `screenshot:*`/`messages:*` payloads. `getAllSyncData` (full-partition,
  unprojected) must NOT be used in per-user loops over the whole classroom
  for this reason. The heal/backfill writes this endpoint performs run
  through `mapWithConcurrency` with a bound of 4.
- `lastActiveAt` is **not** updated on `messages:*` writes (write amplification —
  see anti-goals); instead it's updated on `/v1/auth/login` and `/v1/auth/refresh`,
  giving a natural ~15-min heartbeat (access-token TTL). It stays a true
  denormalized read (lazily backfilled, not recomputed).
- All activity writes are best-effort (try/catch, swallowed). The lessonKB
  pre-read (used to detect the transition) and the `_system:lesson:*` visibility
  lookup are wrapped in try/catch — a failure just defaults to no increment, and
  the next stats read heals it; the lesson write never fails.
- `lessonsAvailable` is the count of **public** lessons (`publicLessonIds(...)`),
  computed per-request from the small classroom-wide lesson list — the same
  denominator for every learner.
- Columns are sortable (click header to cycle asc/desc with aria-sort + a polite
  live region); nullish values always sort last regardless of direction so
  invites cluster predictably. Modals/dropdowns that don't need stats call the
  base endpoint to skip the lessons-available computation.
- Both Users and Lessons tables standardize on `<Card className="p-0 overflow-hidden">`
  containers with keyboard-accessible scroll regions (`role="region"`, `tabIndex={0}`,
  `focus-visible:ring-inset`), semantic row headers, sticky column boundary separation,
  and 20-item pagination.

`CompletionRing` (`client/src/pages/admin/CompletionRing.jsx`) is an SVG donut
showing completed / available lessons, color-coded (red <35%, yellow 35–89%,
green ≥90%).

### Admin dashboard KPIs

Admin dashboard at `/plato` (lazy-loaded, role-gated) has two KPI sections:

- **Learner Engagement** — `Started lessons %` (target ≥90%) and
  `Completed 50%+ of lessons %` (target >50%). Denominator is non-admin users;
  "started" = ≥1 `lessonKB:*` record for a **public** lesson (any status);
  "completed 50%+" = `lessonsCompleted / lessonsAvailable > 0.5` (strict — exactly
  50% does not count), where both sides are published-only. Each widget renders
  green on target, red below.
- **Lesson Pacing** — on-target rate, over-target count, extended-lesson count.

Both are powered by `GET /v1/admin/stats/lessons`, which is **stale-while-
revalidate cached** in `_system:stats:lessons` sync-data (see
`server/src/lib/lesson-stats-cache.js`). Fresh window: 10 min. Stale window
(10 min–24 h): on Lambda, the cached payload is served and an async Lambda
self-invoke kicks off a refresh (`InvocationType: 'Event'`, see the wrapped
handler in `server/src/index.js`); everywhere else (Cloud Run, local dev),
the request starts or joins a single-flight recompute and awaits it for up
to 2 s — serving the fresh result when it lands, otherwise the stale cache,
because post-response work isn't reliable under Cloud Run CPU throttling.
Expired (>24 h) or missing: recompute synchronously. The recompute reads
every user's `lessonKB:*` records in one bulk prefix read
(`getSyncDataByPrefixForAllUsers`, skipping the large `screenshot:*`
payloads) and fetches a `messages:<lessonId>` transcript lazily, only for a
completed public lesson whose KB has no `startedAt`/`completedAt` (the
legacy duration fallback), so it should never be on the hot path of an admin
page load. `lambda:InvokeFunction` scoped to `${StackName}-*` is granted to
`PlatoApiFunction` in `template.yaml`. The Lambda SDK is imported lazily,
only when a self-invoke is actually sent.

## Custom user fields (#364)

Admins define extra profile fields (Admin → Users → **User Fields**) that every
user fills in — e.g. organization, role, website, phone. Built for the waitlist
(#363), whose registration form collects the same fields, and so admins can
search/filter users by them instead of keeping side spreadsheets. It's core,
not a plugin: it touches signup, the classroom gate, `/settings`, and the
Users list, none of which have plugin slots, and #363 depends on it.

**Storage.**
- Definitions: ordered array at `_system:settings.userFields`, alongside
  `userGroups`. Shape: `{ id: 'fld_…', label, type, required, options? }`.
  Types: `text`, `textarea`, `dropdown` (with `options`), `link` (http/https
  only), `phone` (7–15 digits).
- Values: on the **user record** as `customFields: { [fieldId]: string }` —
  not sync-data, so the Users list can search/filter every user without N
  extra reads. SQLite stores it as a JSON `TEXT` column, (de)serialized at the
  db boundary (`rowToUser`); DynamoDB stores a native map.
- `server/src/lib/user-fields.js` is the single validator
  (`validateFieldDefinition`, `mergeFieldValues`, `missingRequiredFields`,
  `visibleFieldValues`). Values are keyed by stable id, so relabeling a field
  never orphans answers. A field's **type can be changed** (`PUT
  /v1/admin/user-fields/:id` with `type`), keeping its id and answers. If
  the new type — or a dropdown losing options — would leave stored answers
  (users + wait-list/invite profiles) that fail the new rules, the server
  replies `409 { invalidCount }` and the dialog confirms before resending with
  `confirmInvalid: true`. Those answers are kept as-is; every later save
  through any route re-validates, so they get fixed the next time they're
  edited. (Delete + re-add would erase every answer and mint a new id,
  breaking integrations that map to it.)
  Deleting a field erases its values from every user, and from wait-list
  entries and invites carrying a profile (same cascade as deleting
  a user group). Values for ids with no current definition are never returned.

Settings field and profile-feedback drafts use `settingsDrafts.js` with an
encoded account key and an owner-validated payload. Only fields returned in the
current enabled definitions are restored or submitted; unchanged server values
are not automatically saved as drafts. Settings remounts on account changes,
ignores obsolete field-load responses, and binds saves to the original account.
Cancellation retains feedback for that account. A completed save clears only the
same unchanged draft, preserving newer writing entered in another visit. The
old global `plato_settings_fields_draft` and `plato_profile_feedback_draft` keys
have no trustworthy owner and are discarded rather than assigned to a user.
Passwords are never part of these drafts. Feedback remains retained if the manual note cannot be confirmed saved.

Manual note additions/removals and all model profile updates share one owner-
and auth-session-bound queue. The queued operation reads the current profile,
uses stable `{text, at}` note identity (including retries), saves the learner's
verbatim note first, and then optionally rewrites soft profile fields. Model
output cannot alter `learnerNotes`. Notes are capped at ten of 500 characters.
A failed durable note write rejects to Settings while the queue continues. A
failed optional rewrite reports that the note was saved, clears only the exact
submitted draft, and never appends a duplicate on retry. Any rejection after
the durable save (the account or session changing during the optional
rewrite) carries `noteSaved: true`, and Settings drops that owner's draft
instead of keeping it to submit again. The note's `at` is also kept with the
owner's draft (`settingsDrafts` kind `noteAt`) until the text changes, so a
page that loaded the draft before the earlier submission finished resubmits
the same identity and finds the note already saved. A completion clears `noteAt` only when it still equals that submission’s captured time, preserving the identity of a newer note submitted from another Settings mount. Removal resolves the
selected identity after earlier queued operations, so cap shifts cannot remove
a different note. Optimistic conflicts remain explicit; no latest-version
rewrite bypasses server CAS. Owner-bound profile/summary reads fail explicitly
on network failure and cannot populate a subsequent auth session's cache.

The learner overview projects canonical objective IDs and valid evidence with
the same confirmed-source predicate as server completion. Active corrections,
criteria review and invalid evidence can remove a check; historical completed
lessons stay frozen. Activity is generated on the server before receipt signing;
client image hydration uses separate render copies. It reports generated
assessment/repair and accepted sourced profile observations, never an inferred
profile update from generic insights or an optional post-save model invocation.
The single composer keeps submitted input, retained signed replies and newer
editable drafts in separate journals. Send-key preferences apply to learner and
authoring chats; authoring editors retain their shared reveal hook.

**API.**

| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /v1/user-fields` | public | Definitions only (for the signup form) |
| `GET /v1/me/fields` | user | `{ userFields, values, missing }` |
| `PATCH /v1/me` `{ customFields }` | user | Partial merge; result must have every required field → else 400 |
| `GET/POST /v1/admin/user-fields` | admin | List / add (`{ userFields }` response) |
| `PUT /v1/admin/user-fields/:id` | admin | Edit label / required / options / type (`409 { invalidCount }` unless `confirmInvalid`) |
| `PUT /v1/admin/user-fields/order` | admin | Reorder (`{ ids }`, must be a permutation) |
| `DELETE /v1/admin/user-fields/:id` | admin | Remove + erase values |
| `PATCH /v1/admin/users/:id` `{ customFields }` | admin | Edit values; same required rule as `/v1/me` |

`GET /v1/admin/users[/:id]` and `GET /v1/me` include `customFields`;
`GET /v1/me/export` includes them with labels.

**Required fields & the gate.** `ProfileCompletionGate` wraps the classroom
routes (not `/plato/*`) and fetches `GET /v1/me/fields` on every classroom load
— the cached auth user in localStorage can't know an admin just made a field
required. If anything required is missing, the learner sees "Update your
profile" with just those fields and can't reach lessons until they're saved. A
dropdown value that's no longer one of the options counts as missing, so
learners re-pick after an admin edits the list. Deliberate choices:
- **Fails open** — if the status request errors, the classroom renders; a
  profile prompt must never lock learners out of lessons.
- **Client-side gate only** — the API doesn't refuse lesson calls for
  incomplete profiles. It's a data-collection prompt, not an access control.
- **Signup doesn't enforce required server-side** (the form does client-side):
  a stale cached signup form must not hard-fail account creation; the gate
  catches anything missing on first visit.
- **Admin edits enforce required fields too** (Edit User form + server): a
  save with `customFields` is refused until every required field is filled.
  Consequence: after adding a required field, an admin must fill it in to
  save any Edit User change for a user who hasn't answered yet. (Edits that
  omit `customFields` are unaffected.) The gate is skipped during "View as
  User".
- Required fields show a visible "(required)" label marker (aria-hidden;
  `aria-required` carries it for screen readers).

**Admin → Users.** Search matches custom field values too. A field filter
(field + Has a value / Empty / a specific dropdown option) narrows the list
and adds a column with that field's values. **Download CSV** (#382) exports
the list as shown (current filter, search, and sort) with one column per
custom field (`client/src/lib/csv.js`). Cells that start with `= + - @` or a
tab/CR get a leading `'` so spreadsheets treat them as text: names and
answers arrive from the public wait-list form, so a formula there would be
attacker-controlled (CSV injection). Dates are ISO; the file has a UTF-8 BOM
and CRLF line endings so Excel opens it cleanly.

## Admin tables: filters, columns, User ID (#362, #385, #386)

**Filters (Admin → Users).** A Filters menu (`client/src/pages/admin/FiltersMenu.jsx`,
logic in `client/src/lib/userFilters.js`) replaced the single-choice
All / Active / Staff / Invited / Wait List buttons and the one custom-field
filter.
- It has one group of checkbox items per facet: Status (Signed up, Invited,
  Wait list), Role, Group (plus No group), and every custom field (its
  dropdown options plus Empty, or Has a value / Empty). Each option shows its
  count.
- Filters combine as **OR within a facet, AND across facets**. Each facet has
  Select all and Clear.
- Facets that don't apply drop an item: a role filter leaves out invites and
  wait-list entries, and invites have no field answers.
- Active filters show as removable chips with a "Clear all" button, and a
  polite status line says "N of M people".
- Search also matches the User ID.

**Columns (Users and Lessons).** A Columns dialog (`ColumnsDialog.jsx`,
logic in `client/src/lib/tableColumns.js`) shows and hides columns and moves
them with Move up / Move down buttons. Focus stays on the moved row, and each
change is announced.
- The layout is saved per browser in localStorage
  (`plato:columns:users:v1`, `plato:columns:lessons:v1`) and reconciled with
  the current columns: new ones appear in their default place, and removed
  ones drop.
- The name/open column and the actions column are fixed.
- Every custom field is a Users column, hidden until chosen. This replaced the
  old filter-driven extra column.
- Lessons adds a hidden Lesson ID column.
- Column resizing isn't built.

**User ID (#386).** The immutable account id (`usr_…`) is a Users column
(sortable and searchable) and the last CSV column, as a stable key for
research and reporting. It's shown to staff only (everyone with `users.read`: admins, educators, testers, including the CSV download); learners never see it.

## User groups (#434)

Group names live in `_system:settings.userGroups`. Membership is the name on
each user (`userGroup`), on wait-list entries and invites (`profile.userGroup`),
and on messages sent to a group (`audience.group`). Password signup and an
external sign-in (`completeExternalAuth`) initially choose a listed group.
When a supplied choice was invalid from the outset, the invitation's listed
group can still supply that initial choice. After the account write,
reconciliation only clears disappeared groups; it never assigns a fallback.
`server/src/lib/groups.js` owns them:
- Names are 1–80 characters and **unique ignoring case**. The list is stored
  sorted A–Z, with "None" and "Other" last; `GET /v1/groups` sorts older lists
  on read.
- **Rename** (`PUT /v1/admin/groups { oldName, name }`) writes the group list
  first, version-checked. Then it moves every membership: users, wait-list
  entries, pending invites, and group messages, so the bell keeps showing them
  to the group. It returns `moved: { users, invites, messages, failed }` and
  writes a `group_renamed` audit entry. If some membership writes fail, the
  dialog offers **Finish moving people from X to Y**, which sends the same
  rename again; with the new name listed and the old one gone, the server
  only moves the remaining members.
- **Delete** (`DELETE /v1/admin/groups/:name`) removes the name from the
  list first, then clears it from users and invites, and returns the same
  `moved` counts. Messages already sent keep their audience, so anyone still
  carrying the name keeps seeing them. If some membership writes fail, the
  dialog says how many people were left in the group and offers **Finish
  removing people from X**, which deletes again: with the name gone from the
  list but still carried, the server only clears the remaining memberships. A
  name nobody lists or carries is 404 (the dialog treats that as finished).

Group assignments reconcile against a strongly read account and settings after
writing. Password and external signup, account-invite acceptance, wait-list
application, and admin edits all use `settleGroupAssignment`; cleanup moves use
profile comparisons and settle their own writes too. A vanished group is cleared
with a profile CAS, retrying a lost comparison at most three times. Re-reading the
current account preserves a concurrent valid rename or another assignment. The
cleanup scans users, invites and system data with `consistentRead: true` after
the settings write; SQL adapters already read committed rows and ignore this
option. Admin user listings also request strong reads so group filters reflect
the saved membership. The raw settings PUT rejects `userGroups`; edit the list
through `/v1/admin/groups`.

Names have no rename history. If cleanup finishes before an admission's late
write, the stale group is cleared, without assigning an invitation fallback.
Admission logs `admission_group_dropped` with only the stale group name. If the
post-write check fails, `admission_group_settle_failed` contains no account or
exception data; hooks, invite consumption and session issuance continue. This
best-effort failure does not reject or delete a valid account, and requires
operational follow-up if cleanup also missed its optional membership.

The User Groups dialog (`client/src/pages/admin/GroupsDialog.jsx`) has inline
rename (Enter saves, Escape cancels), member counts, and a delete
confirmation. Errors show inside the dialog. Its parent refreshes quietly, so
the page spinner doesn't unmount it.

## Roles & permissions (#435)

Four roles. `server/src/lib/permissions.js` is the single source of who may do what.

| Role | Can |
|---|---|
| **admin** | everything |
| **educator** | lessons, courses, and units (read/write); view users and progress; invite learners; invite from the wait list. **Not:** Customizer (theme, knowledge base), prompts, settings writes, plugins, custom fields, groups, user edits/deletion, roles, logs, View as User |
| **learner** | the classroom only. Stored as `user` before #435; `normalizeRole()` maps legacy and unknown values to `learner` |
| **tester** | every `*.read` permission, so they see all classroom and admin pages, plus View as User; **no writes** to admin routes. They can still take lessons, since their own `/v1/sync` and `/v1/me` writes aren't admin routes |

**Enforcement:** `/v1/admin/*` runs `authenticate`, then `authorize`
(`server/src/middleware/authorize.js`).
- `authenticate` reloads the user's role from the DB on every request, with
  a strongly consistent read, so a role change (or a deletion) applies from
  the next request. An eventually consistent DynamoDB read could still return
  the old role.
- `authorize` looks the request up in `ROUTE_PERMISSIONS`. **Any route not in
  the table is admin-only**, so a new route is safe by default.
- `tests/lib/permissions.test.js` fails if a registered admin route is unmapped
  or a table row is stale. `tests/routes/admin-authorization.test.js` drives
  the real admin app as each role.
- A refusal returns `403 { code: 'forbidden', permission }`.
- **A read can still hold a credential.** An email invite's token registers
  that address with any password, and the shareable link's token signs anyone
  up. So `GET /v1/admin/invites` and `GET /v1/admin/invites/link` include
  `inviteToken` only for a role with `invites.write`. Everyone else, testers
  included, gets the same rows with a stable non-secret `id` (a hash prefix of
  the token) for telling them apart. Wait-list tokens stay visible: a
  `waitlist` row can't sign up, and inviting one mints a fresh token.
- Plugin admin routes still use the SDK's `requireAdmin` (admin only).
- View as User reads (`?asUserId=`, in `sync.js` and `content.js`) need
  `impersonation.use` (admins and testers).

**Data and API.**
- The role endpoint (`PUT /v1/admin/users/:id/role`, admin only) accepts the
  four roles, with legacy `user` read as learner. It refuses an admin's own
  role, and refuses demoting the last admin. Every change writes an audit
  entry `role_changed { from, to }`.
- New signups are stored as `learner`. Migration `m003_role_learner` renames
  stored `user` to `learner` conditionally, leaving `updatedAt` alone.
- Every API response sends the normalized role. Stats count only
  `role === 'learner'` as learners.
- The plugin hook payloads (`userCreated` / `userDeleted`) carry the
  normalized role (plugin API 1.4.0).

**Client.**
- `client/src/lib/permissions.js` mirrors the map, and a test compares it with
  the server's.
- `can(user, permission)` drives:
  - the `/plato` route gate (`admin.access`) and per-page gates
    (`RequirePermission`: Customizer and KB setup need `kb.read`, Plugins
    needs `plugins.read`)
  - the admin nav
  - the classroom admin bar
  - which controls render
- Rule: a control shows if the role can use it, **or the user is a tester**.
  Testers explore every screen, and `adminApi` refuses their writes up front
  with "Testers can look around but can't save changes". Educators don't see
  controls they can't use; Edit User is read-only for them.
- AdminLayout shows testers a read-only notice.
- `AuthContext` re-reads `/v1/me` on load (`refreshCurrentUser`), so a role
  change applies on the next page load, not just the next login. The refresh
  is bound to the auth session that started it (see
  [Launch data contracts](#launch-data-contracts-2026-11-06)).

## First and last names (#402)

Users have `firstName` and `lastName`. `name` stays on the record, always
derived as `firstName lastName`, for plugins, the audit log, emails, and
Beta-RC-232 rollback. `server/src/lib/names.js` is the single reader and
writer:
- `readNameInput(body, { current, required })` reads a request. `firstName` /
  `lastName` win; a lone `name` (older clients, the public wait-list API) is
  split. A part the body leaves out keeps its current value. A first name is
  required; a last name is optional (people with one name exist). Each part is
  at most 100 characters.
- `nameFields(record)` is what every response sends: `name`, `firstName`,
  `lastName`, `nameSource`. A record without parts (written before #402, or
  not yet reached by the migration) is split on read.
- **`nameSource`** is `'user'` when a person or admin entered the parts, and
  `'auto'` when they were inferred. The UI hints that an `'auto'` split may
  need a correction. Nothing is silently discarded: the inference splits at the
  first whitespace and everything after it becomes the last name.

Routes that take a name: setup, signup, `PATCH /v1/me`,
`PATCH /v1/admin/users/:id`, and the wait list (join and admin edit; profiles
store the same fields). `GET /v1/auth/invite/:token` returns the parts so
signup can fill them in.

**Migration:** `m005_name_split` writes the inferred parts with
`setUserNameSplitIf` (conditional on `name` unchanged and no parts yet;
`updatedAt` untouched). Empty names are left alone. The dry run reports how
many names had 3+ parts. Wait-list entries aren't migrated; they're split on
read and replaced when the person signs up.

**`preferences.name` is retired.** Settings edits the name on the account
(`PATCH /v1/me`), and the sync route no longer copies `preferences.name` to
the user record, so an old value left in preferences can't undo a corrected
split. The coach's `learnerName` is the account's `firstName` (it used to be
`preferences.name`, which stayed blank until the learner saved Settings).

**Client:** `client/src/components/NameFields.jsx` renders First name / Last
name (optional) with `given-name` / `family-name` autocomplete, and the
"Split automatically…" hint (tied to both inputs by `aria-describedby`) when
`nameSource` is `'auto'`. It's used on signup, setup, the wait list, Settings,
Edit User, and Edit Wait List Entry. The Users list sorts by last name, and
the CSV has First Name and Last Name columns.

**Forms start from split parts.** The split itself lives in
`server/src/shared/names.js` (`splitName`, re-exported by `lib/names.js`), so
the client splits exactly like the server. `formNameParts(source)` gives a
form its starting first and last name from a user record, a saved draft, or a
prefill, splitting a lone `name`. Settings, signup, setup, and the wait list
all use it, so an account cached before #402, an old draft, or a Google
prefill (`{ email, name }`) never starts with the whole name as the first name.
Saving that would store it as the person's own entry (`nameSource: 'user'`)
with no last name. Settings also follows the account's name as `/v1/me`
refreshes it, until the person edits the fields, so the stored parts (perhaps
corrected elsewhere) replace what the cache implied.

## Notifications (#388, #389, #400)

Everything plato emails on its own (automations, invitations) or on an
admin's behalf (messages) goes through `server/src/lib/notifications.js`.
Only the password-reset email stays in `email.js`.

- **Automations** live in `_system:automations` = `{ waitlistConfirmation,
  waitlistRemoved, inactivityNudge, weeklyDigest }`. Every one is **off** until
  an admin turns it on, including on an upgraded install.
- **Invitations are always on** (`ALWAYS_ON`): `invite` (the signup link, from
  Users → Invite, a bulk invite, a resend, or the wait list) and
  `account-invite` (#486, for someone who already has an account; links to the
  classroom). Admin → Notifications → Automations lists them as "Always on",
  with no switch, and their copy is editable like any template (variables
  `firstName`, `classroomName`, `inviterName`, `link`; `firstName` falls back
  to "there" and `inviterName` to "The <classroom> team"). They're sent with
  `sendTemplated(..., { allowlist: false })`: like the hand-built emails they
  replaced, they **ignore `EMAIL_ALLOWLIST`**, because an admin typed the
  address. `SKIP_EMAIL` logs the link instead, and `sendInviteEmail` still
  returns `{ sent | skipped, signupUrl }`.
- **Removed from the wait list** (`waitlistRemoved`, template
  `waitlist-removed`): when on, `DELETE /v1/admin/waitlist/:token` emails the
  person once (the entry is gone afterwards, so a second DELETE is a 404). Not
  sent when an entry is consumed by an invite. A failure logs
  `waitlist_removed_email_failed` and never fails the removal. One-time mail,
  no unsubscribe link; the allowlist applies.
- **Templates** come with a default copy in code (`TEMPLATES`); an admin's
  version is stored in `_system:emailTemplate:<id>` (`{ subject, body }`) and
  can be reset back to the default.
  - A body is plain text: paragraphs separated by blank lines, `{{variables}}`
    from that template's list, and a line holding only `{{link}}` becomes a
    button.
  - Saving refuses unknown variables, a multi-line subject, or anything over
    200 characters (subject) or 5000 (body).
  - Values are HTML-escaped in the HTML part.
- **Sending** is multipart text + HTML, as raw MIME through SES
  (`SendRawEmail`), so we can add `List-Unsubscribe` and one-click
  `List-Unsubscribe-Post` (RFC 8058). Header values are forced onto one line.
  - `SKIP_EMAIL=true` logs instead of sending.
  - `EMAIL_ALLOWLIST` (the `EmailAllowlist` stack parameter) limits recipients.
    When it's empty: anyone on prod, no one on other stages.
- **Unsubscribe** uses tokens that are HMAC-signed per user and kind (`nudge`,
  `digest`, `messages`; the key is derived from `JWT_SECRET`).
  - `GET /v1/unsubscribe?token=` shows a confirm button, so link scanners can't
    unsubscribe anyone. `POST` (the button, or a mail client's one-click
    request) records the opt-out.
  - Opt-outs and per-user bookkeeping live in the server-only `notify:state`
    sync record (`optOut`, bounded `read`, `emailPending`, `emailed`, `nudges`, `lastNudgeAt`, `lastDigestAt`), which learners can't write through `/v1/sync` and which a progress reset keeps. Learners manage them through
    `GET/PUT /v1/me/notifications`.
- **Wait list confirmation (#388):** sent by `POST /v1/waitlist` only when
  *that request* created the entry. The create-only insert means a retry or a
  duplicate join (which finds the entry) never sends again. A failure logs
  `waitlist_confirmation_failed` and never fails the join. Not sent when the
  email already has an account or a pending invite. It's one-time mail,
  so it carries no unsubscribe link.
- **Messages (#389):** Admin → Notifications → Compose sends a one-off
  message to everyone, chosen roles, a group, or specific people, in the
  classroom and/or by email (`server/src/lib/messages.js`).
  - The record is `_system:message:<id>`.
  - "Everyone" (`{ type: 'all', allRoles: true }`) is every user of any role;
    "By role" (`{ type: 'role', roles }`) is learners, educators, admins,
    and/or testers; a group (`allRoles: true`) is its members of any role.
    These broadcasts reach only people who had joined when it was sent.
    Specific people can be anyone.
  - **Older messages keep their meaning.** Before Blake's review on #451,
    "everyone" and groups meant learners only, and those records have no
    `allRoles`. Because the bell is worked out at read time, treating them as
    every role would suddenly show old learner announcements to staff, so a
    message without `allRoles` still reaches learners only (History labels it
    "All learners" / "Group: X (learners)"). No migration: stored records
    aren't changed.
  - In-app delivery is worked out when the learner reads (`GET /v1/me/messages`),
    so nothing is written per recipient. Read state is `notify:state.read`
    (`POST /v1/me/messages/read`), restricted to valid IDs the caller can see and capped to their newest 50 visible messages on each write. `important` messages also open as a pop-up.
  - Email goes out in the `send-message` background job, five at a time,
    honoring the `messages` opt-out with an unsubscribe link. It records
    `counts` (emailed, opted out, not allowlisted, failed), and a re-run of a
    finished job sends nothing.
  - **Delivery state (fork).** A message is `sending`, `sent`, `failed` or `closed`. An
    attempt takes a durable execution lease on the message first, claims each
    recipient in `notify:state.emailPending[messageId]`, and records
    `emailed[messageId]` only after the transport confirms. A known failure
    releases that attempt's own claim so a retry tries the person again; an
    uncertain outcome keeps its claim (at most once, never twice). Failed
    delivery returns 503 with the message, and
    `POST /v1/admin/notifications/messages/:id/retry` retries only open messages. Stop retrying or a 30-day retry-window expiry makes the message permanently `closed`; closing prunes its pending claims and bounds finished receipts to 49 per recipient. See
    [Launch data contracts](#launch-data-contracts-2026-11-06).
  - Compose shows the audience size first (`POST …/preview`) and asks for
    confirmation.
  - Each send writes a `message_sent` audit entry.
- **Learner-job isolation.** Inactivity reminders and weekly digests log and continue when a single learner’s read/write fails. Other learners still run. Existing opt-outs, daily/repeat nudge guards, digest timing guards, known-failure release and uncertain-claim retention remain in force.
- **Job events skip first-request setup.** The API handler routes a job event
  straight to `runJob`, before the middleware that seeds content, runs
  migrations, and boots plugins. Jobs must only need the database, which is
  true of all of today's jobs.
- **Background jobs** (`server/src/lib/jobs.js`): `dispatchJob(name, payload)`
  asynchronously invokes the **API function** on Lambda, whose handler routes
  `{ __platoInternal: 'platoJob' }` events to `runJob`. On Cloud Run and
  locally the job runs in process and the HTTP request awaits it, because
  Cloud Run doesn't guarantee CPU after a response.
  - The stream function, which serves all CloudFront traffic, can't take
    non-HTTP events. So it finds the API function in `JOBS_FUNCTION`. The API
    function's timeout is 300 s, for jobs; HTTP stays capped at 29 s by API
    Gateway.
  - The dashboard's async stats refresh used to invoke the stream function
    itself and never ran: prod logged 51 invokes and 0 completions in 14 days,
    and the API function had no log group at all. It now uses the same target.
- **Scheduled learner emails (#400)** live in `server/src/lib/learner-emails.js`
  and run as background jobs. Each does nothing while its automation is off.
  - **When they run:** no EventBridge rule. Creating one needs `events:*` on
    the deploy role, which the role in `docs/DEPLOY.md` doesn't have, and
    playground's deploy failed on exactly that. Instead, at most every 10
    minutes per container, a request checks `_system:jobs:schedule`
    (`server/src/lib/schedule.js`). A job that's due and on is claimed with a
    version-checked write (one container wins) and dispatched. An absent
    schedule record is created create-only, so two cold containers can't
    both claim the first run. The reminder
    is daily from 15:00 UTC, and the digest Mondays from 15:00 UTC. A day
    with no traffic sends nothing.
  - `inactivity-nudge` (daily, 15:00 UTC): a learner whose started lesson has
    gone 7 days untouched (its `lessonKB` record's `updatedAt`) gets one
    reminder, for the most recently active such lesson. The same lesson isn't
    nudged again for 14 days, and a learner gets at most one a day.
  - `weekly-digest` (Mondays, 15:00 UTC): lessons completed this week,
    lessons in progress, and lessons **published** this week (`publishedAt`,
    set by the admin lesson PUT the first time a lesson goes public). Skipped
    when there's nothing to say, and at most once every 6 days.
  - Both cover learners only and only lessons the learner can see, honor
    `optOut.nudge` / `optOut.digest`, and write their bookkeeping
    (`nudges`, `lastNudgeAt`, `lastDigestAt` in `notify:state`) before
    sending, so a retried run never emails twice.
  - Run one by hand with `aws lambda invoke --function-name <PlatoApiFunction>
    --invocation-type Event --payload
    '{"__platoInternal":"platoJob","job":"inactivity-nudge"}'`.
- **Admin routes** (`server/src/routes/admin-notifications.js`) need
  `notifications.read` (admins, testers) or `notifications.write` (admins):
  - `GET /v1/admin/notifications`
  - `PUT …/automations`
  - `PUT` and `DELETE …/templates/:id`
  - `POST …/templates/:id/test`, which sends the saved or unsaved draft to the
    signed-in admin with sample values
  - `POST …/preview`, `GET …/messages`, and `POST …/messages`
- **Learner UI:** a **bell** in the classroom header (`client/src/components/NotificationsBell.jsx`;
  hidden in View as User) lists messages, newest first, with an unread
  count in its accessible name. Opening it marks what it shows as read.
  An unread `important` message opens once as a dialog ("Got it" marks it
  read). It re-checks when the tab comes back into view, with no polling. The bell
  and the account menu are **non-modal** menus (the fork's popover-based
  `dropdown-menu.jsx`), because a modal one `aria-hidden`s the whole page
  while open (axe `aria-hidden-focus`).
  Settings → **Email** has checkboxes for reminders, the weekly digest, and
  classroom messages, saved on change.
- **Admin UI:** Admin → **Notifications** (`client/src/pages/admin/AdminNotifications.jsx`)
  has three tabs. Compose: audience radios, a searchable people picker, the
  channels, the subject and message, the audience count, and a confirm dialog.
  Automations: one card per email, headed by its name (`h2`), with its on/off
  toggle and its copy behind **Edit email**: save, a test send to yourself,
  and reset to default. History: sent messages with their delivery status and
  counts, and Retry for a failed message; table cells wrap so Status stays in
  view, and below 48 rem it's a list, as Users is. Testers can see everything
  and send nothing.
  - **Unsaved work survives tabs.** Template edits are drafts held by the page
    (Compose stays mounted), so switching tabs keeps them and an email with
    unsaved changes reopens. A Compose draft, unsaved email edits, or a save or
    send in flight make leaving the page ask first (`useBlocker`, `beforeunload`).
  - **Feedback sits beside its action** (a save, a test send, a toggle, a send
    that leaves Compose open); the page notice is for sends that open History,
    retries, and Refresh. Actions keep focus while they work. When one removes
    its own control, focus moves to what remains: Use the default → **Send a
    test to me**; a retry or Stop retrying that settles a message → its new
    status; a send that opens History → the History tab.
  - **Loading fails safe.** If the settings can't load, the page keeps its
    heading and offers **Try again** (the heading takes focus once it loads). If
    History can't load or refresh, only History says so, keeps its last list,
    and offers its own **Try again**.

## Admin "View as User"

Admins can audit a learner's classroom (lesson list, conversation history,
lesson KB) without asking for screenshots. Triggered from a "View as user"
button in the purple admin bar in the classroom (`AppShell`); a yellow status
strip with an "Exit" button surfaces underneath while impersonation is active.

- Read-only `?asUserId=<id>` query param threaded onto GET `/v1/sync*` and GET
  `/v1/lessons*` from `client/js/auth.js`'s `authenticatedFetch`; admin-gated
  server-side.
- **Writes never carry the param** — server returns 403 on PUT/DELETE with
  `?asUserId=` (defense-in-depth), and `client/src/lib/lessonEngine.js`'s
  `startLesson`/`sendMessage` throw at the top to belt-and-suspenders the
  disabled `ComposeBar`.
- Impersonation state lives in `sessionStorage('plato_impersonation')` (per-tab)
  and `AuthContext`. `startImpersonation` / `stopImpersonation` clear the storage
  cache *and* hard-reload to `/lessons` — clearing the cache alone wasn't enough
  because `AppContext` (lesson list, per-lesson progress badges) holds component
  state that wouldn't otherwise re-fetch. For an audit feature, "no stale data"
  beats a faster transition.
- Audit-logged at session granularity (`admin_view_as_user_started` / `_ended`)
  — per-read entries would spam the log. POST `/v1/admin/impersonation/start`
  `{ targetUserId }` writes the start entry and returns the target profile for
  the banner; POST `/v1/admin/impersonation/end` is best-effort (no-op if the
  admin closes the tab — the start entry is the source of truth).


### Coach assessment and signed turns (2026-10-25)

`server/src/shared/` is imported by both the SPA and server, and ships within the
existing SAM CodeUri. It owns terminal metadata parsing, exact authored-objective
identity, bounded evidence/source retention, response-type transitions, and
context assembly. Lesson markdown parsing and initialization validation are also
shared. The server reads prompts from the admin prompt store with a bundled
fallback; the bundled coach contract constrains an older or customized teaching
prompt. Program knowledge, profile, accessible catalog entries, attachments and
plugin enrichment are reference data, not protocol instructions.

Only a valid terminal integer PROGRESS plus KB_UPDATE (and optional PROFILE_UPDATE)
can update assessment. Opening stays at zero. Only substantive work or explicit
correction changes evidence/progress; questions, uncertainty, feedback, pause and
distress preserve it. Ten requires all authored objectives plus the exemplar to
be met with known confirmed sources. Completed assessments remain frozen.
Observations are limited to ten 300-character strings; sources to sixteen,
text excerpts to 6,000 characters, and each evidence entry to two source IDs.
All one-to-four authored objectives remain required, including duplicate text
with occurrence IDs. Pacing changes the next task, not the rubric.

Images have a content digest and a truthful visibility flag. At most four images
are supplied per coach request. An omitted image cannot support newly asserted
mastery; unchanged prior met evidence can survive without resending its pixels.
Links retain their original URL and bounded excerpt. Explicit source confirmation
is grounded in a new learner submission and does not alone demonstrate quality.
Screenshot keys cannot be overwritten through ordinary sync. The narrowly
validated legacy embedded-image migration remains supported.

Receipts use HMAC-SHA256 with a domain-separated key derived from the stable
JWT_SECRET, and bind the complete generated turn, owner, lesson, IDs, original
snapshot/reset generation, messages and assessment. A default development secret
cannot sign receipts in production. Receipts have no short expiry, so restart or
an ordinary delay does not strand retained work. Secret rotation invalidates
outstanding receipts; preserve the old deployment/key until pending work is saved
or export the retained text before rotation. No alternate-key rotation service is
implemented here. Invalid supplied receipts never downgrade to legacy recovery.
Generic single/batch sync writes cannot create or replace assessment/transcripts.

Unsigned retained pre-upgrade replies can save their exact transcript, explicitly
marked legacy-unverified, while preserving only previously saved assessment.
Their assistant text is retained as bounded, explicitly unverified conversation reference data; it cannot become learner evidence or completion authority. Active
legacy assessment is reconciled to authored criteria without carrying unverified
evidence forward; historical completed lessons remain complete. A changed rubric
invalidates active evidence. If criteria change between generation and save, the
reply is retained and assessment is flagged for review, without completion or
profile/course mastery effects. Reset fencing and exact replay still apply.

Profile observations are optional, bounded, explicitly sourced, and absent for
completed-thread feedback. There is no general-insight fallback. Profile agents
may return changed:false; empty trait arrays and null preference values clear
obsolete information. Completion and course-summary agents receive demonstrated
objective text, excluding raw sources and incidental disclosures. Optional model
updates run only after the acknowledged assessment confirms new completion.

`coach_assessment` telemetry records only validity, response class, completion and
fixed issue codes. `scripts/evaluate-coach.js` includes assessment and conversation-continuity offline
fixtures. Explicit live mode requires a call budget, records the selected provider
and model plus prompt/fixture hashes, and never writes synthetic lesson progress.
It evaluates the bundled prompt in isolation; server assembly is covered by route
regressions. Neither offline fixtures nor passing protocol checks establish live
coaching quality. See `docs/reviews/coach-remediation-2026-10-25.md` for the finding
map, checks and remaining qualification boundaries.

### Live-qualified coach metadata recovery

Live evaluation of the configured Workers AI model found useful replies missing
assessment tags. `coach-assessment.js` preserves the streamed wording and recovers
known opening/completed state without inference; an active malformed reply gets
at most one metadata-only model call. Criterion/source checks precede every model
summary, reference confirmation or completion mutation. Failed recovery preserves
the prior assessment. Save/replay never re-runs recovery inference, and repair
has its own content-free telemetry role.

Model context separates authored `assessmentRequirements` from generated
`evidenceGuidance`; guidance cannot create new mandatory criteria. See
`docs/reviews/coach-live-evaluation-2026-10-25.md` for live results, exact prompt
identities, the latency/call tradeoff, earlier failures and preservation evidence.


### Resumed coaching conversation continuity (2026-11-05)

`server/src/shared/coachConversation.js` builds provider history and source-backed
`lessonKB.conversationState`. Legacy assistant messages are quoted as JSON
`unverifiedCoachMessage` in a user-role reference message, with old terminal
control metadata removed. They remain available to explain what the learner is
answering, but never enter learner `sources` or assessment evidence. Recent history
is limited to 40 usable messages and 6,000 characters per message.

Conversation state separately retains the original assignment, explicit
learner directions, and the latest coach prompt. Each anchor carries its saved
message ID, exact bounded text, role and provenance; the server rehydrates anchors
from saved messages rather than accepting generated summaries. These anchors
survive history-window limits and assessment-criteria reconciliation, including a
criteria edit between generation and save. Earlier additive directions are not
discarded when later directions arrive: the existing whole-record save limit
bounds storage and rejects an oversized save instead of forgetting active work.
Duplicate message IDs cannot select one ambiguous occurrence as an anchor;
`sourceAmbiguity` tells the coach to clarify any affected task detail. Optional
KB_UPDATE `taskChangeSourceId` can retain only the current nonempty learner text;
attachments and coach-generated URLs cannot replace the assignment. The prompt
requires an explicit learner selection/change, and interprets the retained exact
text rather than treating an arbitrary link as permission to switch.

Version 3 migrates pre-existing transcripts (including version 1 continuity
records) into chronological `legacyLearnerContext` and bounds version 2 migrations.
It retains the saved learner
statements without guessing which ones are task changes; the prompt resolves
explicit selections from their actual words and asks for clarification if needed.
This migration happens once, and later observations are not added to that
historical collection. It is conversation context only and never repopulates
assessment sources or evidence. The serialized collection is limited to 48 KiB
of UTF-8, retaining whole recent anchors in chronological order. The existing
whole-record size checks still apply to the transcript and KB.

If this limit omits history, or retained task text or links are incomplete,
`legacyContextTruncated` survives reloads. For an
active lesson, the server generates a fixed clarification without calling either
the coach or metadata-repair model. It preserves assessment and observations and
asks for a complete task restatement beginning with `Continue with:`. The normal
signed-turn save, stream and recovery paths carry this clarification. A unique
saved `confirmationPromptId` must identify that exact preceding prompt before a
complete current learner reply can clear the flag. Empty, oversized, incomplete
link-dependent or unrelated replies do not clear it.

The same clarification also covers incomplete original assignments and selected
learner directions, including directions selected after an earlier complete
restatement. A prior confirmed task never hides a newer incomplete direction.

The restatement becomes a source-backed `confirmedTask`, rehydrated from the
unique saved learner message and its links. It replaces earlier task directions
and legacy context; future explicit directions remain additive. The original
assignment and transcript remain in storage, while model context hides the old
assignment and history begins at the restatement. Missing or ambiguous saved
confirmation sources require clarification again. This avoids relying on a model
to honor an omission warning while still seeing the obsolete opening. Completed
lessons continue in feedback mode with bounded context and unchanged completion.
The model evaluator refuses unresolved overflow fixtures; the route tests cover
this deterministic path instead.

Learner anchors and recent history also preserve up to four HTTP(S) link URLs and
bounded titles from saved `metadata.links`, so a direction such as "Audit this
site instead" survives source-list eviction. Page excerpts are not imported as
conversation instructions or evidence. Invalid/excessive links are marked
`linksIncomplete`; ambiguous references require clarification. A link without
explicit task-selection wording does not become a retained learner direction.

The continuity evaluator declares allowed target URLs per fixture, rejects
unapproved URLs (including Markdown destinations and bare domains), grades
explicitly forbidden diagnostic claims in the resulting `insights` and
`learnerPosition`, and requires task-change markers to be absent unless the case
expects one. These are conservative checks for the tested failure classes, not a
general semantic proof; agent editorial review is still recorded separately.

`POST /v1/admin/users/:userId/lessons/:lessonId/continuity-repair` is an admin-only
operational repair. It accepts the complete current `base` from the lesson-turn
GET, `assignmentMessageId`, the latest `learnerMessageId`, and a bounded
`misleadingInsights` list of exact existing notes to remove. The operation refuses
impersonation mode, stale snapshots, missing/empty or duplicate source identities,
and completed lessons.
It uses `commitLessonTurn` to preserve the entire transcript and all assessment
fields while restoring the chosen assignment, retaining the actual learner
observation without a guessed diagnosis, and marking the earlier coach switch for
acknowledgement. The audit write follows the atomic repair. The response returns
the committed snapshot with `X-Plato-Audit-Status: recorded` when logging succeeds.
If the audit write fails, it still returns HTTP 200 with that snapshot and
`X-Plato-Audit-Status: failed`, and emits `lesson_continuity_audit_failed` with
`committed: true` and no transcript, account or exception details. This is a
best-effort audit write; a failed audit entry is not durably queued for retry.
Back up the exact snapshot before an operational repair; a failed/stale request
must be investigated against a new read, not retried with guessed versions.

Recovery returns only a result whose base is still current or whose exact messages
and KB are already saved. A repaired KB makes an old generated result unavailable;
replaying an already saved receipt acknowledges the current repaired state, while
an unsaved stale reply conflicts. Neither repair nor replay calls a model.
