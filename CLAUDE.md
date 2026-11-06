# CLAUDE.md

Project-level instructions for Claude Code sessions working on plato.

## Project overview

plato is an Open Source, AI-powered [microlearning](https://philosophers.group/platos-microlearning/) platform. Learners work through focused lessons in a continuous conversation with an AI coach, designed for completion in ~20 minutes.

- `client/` — React 19 + Vite SPA
- `server/` — Node.js + Hono, deployed as Google Cloud Run (`server/start.js` + Cloud SQL PostgreSQL) or AWS Lambda (SAM + DynamoDB)
- Brand: "plato" (always lowercase)
- This fork has no actual users. Upstream plato.courses is separate. Feature branches and draft PRs do not authorize merging or deployment; pushes to `main` trigger the fork's Cloud Run deployment.

## Architecture

Quick map of the system. **Deep dives, incident history, and the *why* behind these invariants live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — read the relevant section before changing one of these subsystems.

- Login required, all data server-side. JWT access (15 min) + refresh (30 day) tokens in localStorage (`plato_auth`); login accepts email or username. Unique editable `username` per user.
- Cloud Run runs the HTTP/SSE container (`server/start.js`) backed by Cloud SQL for PostgreSQL (`users`, `invites`, `refresh_tokens`, `sync_data`, `audit_log`) over Direct VPC egress (`@google-cloud/cloud-sql-connector` with Private IP and service identity auth). AWS deployments run 2 Lambda functions (API Gateway buffered CRUD + Function URL streaming SSE for AI chat) and 5 DynamoDB tables (`users`, `invites`, `refresh-tokens`, `sync-data`, `audit-log`).
- Content is `_system` sync-data (`prompt:*`, `lesson:*`, `knowledgeBase`, `settings`). Prompts are bundled in `client/prompts/*.md` and upserted on every server startup — admins can't edit prompts directly. User-created lessons live under the user's sync-data (`lessons:custom-*`).
- **Launch features** — four normalized roles (admin, educator, learner, tester), split first/last names, Course–Unit–Lesson structure, existing-account invitation acceptance, notifications and learner-owned profile notes. Hierarchy storage keeps `program:*` for Courses and `course:*` for Units; `/v1/admin/courses` remains a Unit API alias. Role permissions do not widen the plugin SDK's admin-only routes. See [launch data contracts](docs/ARCHITECTURE.md#launch-data-contracts-2026-11-06).
- **9 AI agents** (prompts in `client/prompts/`, each with an HTML header documenting reads/callers/purpose): coach, lesson-creator, lesson-owner, lesson-extractor, knowledge-base-editor, knowledge-base-extractor, learner-profile-owner, learner-profile-update, course-progress-update. Program KB + Lesson Catalog are appended to system prompts at runtime (`client/js/orchestrator.js`).
- **Learner language (#240)** — every agent writes in the learner's browser language via `withLanguage()` (`client/js/language.js`); English adds nothing to prompts. The directive lists every parsed literal (tags, JSON keys, lesson headings, `- Can `) as keep-in-English — add any new parsed literal there too. → [details](docs/ARCHITECTURE.md#learner-language-240)
- **One model for all 9 agents** — admins select **Amazon Bedrock** (`qwen.qwen3-vl-235b-a22b`, Apache-2.0) or **Cloudflare Workers AI** (`@cf/deepseek-ai/deepseek-v4.1-flash-1017` with maximum reasoning, or Mistral Small 3.1 24B, connected via Cloudflare OAuth or API token) at `/plato/ai`. `LLM` in `server/src/lib/ai-provider.js` (mirrored in `client/js/api.js` and injected into plugins as `ctx.LLM`) is a compatibility hint; all 9 agents and plugin AI calls route through `server/src/lib/ai-provider.js` with no per-agent routing and no automatic provider fallback. On Bedrock, non-Anthropic models require the **Converse API**: legacy `InvokeModel` doesn't reject them, it returns HTTP 200 with an OpenAI-shaped body, so callers silently read `undefined`. `server/src/lib/converse.js` translates between plato's internal Anthropic wire format and Converse, and `server/src/lib/workers-ai.js` translates Chat Completions/SSE for Workers AI. For UIC Bedrock deployments, a replacement model must clear **four** bars: on Bedrock us-east-2, accepts images (learners paste screenshots), reliably emits plato's literal tags, and carries an **OSI-approved license**. That last one is a constraint, not a preference — plato is AGPL-3.0, so *open weight isn't enough*: Llama 4 and Gemma ship under non-OSI community licenses and are ineligible despite passing every functional check (Llama 4 Maverick measured faster and cheaper, and is the fallback only at the cost of that bar). **Prompt caching is Claude-only on Bedrock — don't add it.** → [details](docs/ARCHITECTURE.md#ai-provider--model-choice), [why this model](docs/MODEL_SELECTION.md), [Cloudflare OAuth](docs/CLOUDFLARE_OAUTH.md)
- **Conversation & image persistence** — chat history is one append-only `messages:<lessonId>` record; progress is a separate `lessonKB:<lessonId>`. **Images are never inlined in `messages:`** — each is its own compressed `screenshot:*` record, referenced by `metadata.imageKeys` (DynamoDB's 400 KB item cap; inlining base64 silently lost conversations, #191/#193). The `LessonChat` resume effect keys on stable values, never the `lesson` object identity. → [details](docs/ARCHITECTURE.md#image--conversation-persistence-191-193)
- **Behind this response (#411)** — each assistant reply can carry `metadata.agents` (which agents ran, what they read, what they did), shown by the `AgentActivity` disclosure on every chat. In lessons the server builds it (`server/src/shared/agentActivity.js`) **before signing**, so the receipt covers it; it reports only what happened before the save, never an optional post-save model run, and never raw model reasoning. → [details](docs/ARCHITECTURE.md#behind-this-response-411)
- **Link attachments** — a learner can attach a web page to a coach message. It's fetched + read **server-side** (`POST /v1/links/fetch`); the page text is injected into the coach call on that turn only (image parity), and only `{ url, title }` is persisted in `metadata.links`. SSRF defense (`server/src/lib/url-guard.js`) is load-bearing — the server fetches user URLs from inside AWS. → [details](docs/ARCHITECTURE.md#link-attachments)
- **Lessons** — three statuses: `public`, `private` (visible to `sharedWith`), `draft` (admin-only, no markdown yet; true draft iff `status==='draft'` AND markdown empty). New lessons start as `draft`; "Create Lesson" flips `draft`→`private`. Editing is conversation-based (no raw markdown editor), deep-linked at `/plato/lessons/:lessonId/edit`, with a manually-refreshed markdown preview pane. An optional `## Coach Directive` section carries author-supplied runtime instructions for the coach (e.g. "reference the learner's project", "share this code") — extracted verbatim, parsed into `lesson.coachDirective`, and surfaced via `buildContext`; it never overrides completion semantics. Lessons are organized **Course → Unit → Lesson** (#408). Storage keeps pre-hierarchy names: **`_system:course:<id>` is a Unit** (`lesson.course` = unit id), **`_system:program:<id>` is a Course**; order lives in `program.unitIds` / `unit.lessonIds` and only orders (stale entries fall back to name order) — see `server/src/lib/hierarchy.js` and [hierarchy details](docs/ARCHITECTURE.md#courses-units-and-lessons-408). Unit delete cascades `course:null`; course delete leaves units unassigned. Learners see lessons in that order (`client/src/lib/lessonOrder.js`); "next lesson" crosses units but never courses. A per-learner `courseProgress:<unitId>` record carries a tiny distilled note of what the learner demonstrated in a unit's *other* lessons — regenerated on completion by the `course-progress-update` agent (incremental, ~600-char cap) and injected into the coach context as `unit.progress` (the coach also gets `course.name`, the course above); informational only, never overrides completion. → [details](docs/ARCHITECTURE.md#course-progress-cross-lesson-memory)
- **Pacing & completion** — limits in `client/src/lib/constants.js` (MAX_EXCHANGES=11, MIN/MAX_OBJECTIVES=2/4, MINS_PER_EXCHANGE=1.8), mirrored in `server/src/lib/lesson-limits.js`; prompts use the literal numbers. **No hard cutoff** — lessons run until the coach awards `progress >= 10`. Never auto-complete on exchange count. `extendedLessons` is informational only. Post-completion the thread is feedback-only — `progress` and `activitiesCompleted` both freeze in code (not just via prompt instruction, which is model-dependent), while KB updates keep flowing; scores are clamped 0–10. `applyCoachResponseToKB` (`server/src/shared/lessonAssessment.js`, run by the server's coaching route; `lessonEngine.js` only re-exports it) is the single owner of completion semantics, and completion needs source-backed evidence for every objective and the exemplar. A coach reply missing its tags gets at most one server-side, metadata-only repair before signing — never guessed from its prose. The lesson overview's checklist shows that canonical evidence (`evidenceIsMet`, shared with completion). → [details](docs/ARCHITECTURE.md#pacing--completion-philosophy)
- **Denormalization** — derived activity fields (`lessonsCompleted`, `lastActiveAt`) are denormalized onto the user record with a **single writer** (`applyActivityEffects` in `server/src/routes/sync.js`), transition-detected (no double-count), best-effort. Underlying sync-data stays the source of truth. **All dashboard/per-user KPIs count only published (public) lessons** — drafts, privates (even when shared), and custom lessons are excluded from numerator *and* denominator (`server/src/lib/lesson-visibility.js`); a completion counts iff its lesson id maps to a public `_system:lesson:*`. The `?include=stats` user-list recomputes `lessonsCompleted` per request and heals the counter (visibility can't be derived from the stored count alone). Per-user stats (#136) and Admin dashboard KPIs build on this. → [details](docs/ARCHITECTURE.md#denormalization-policy)
- **Custom user fields (#364)** — admin-defined profile fields (text, textarea, dropdown, link, phone; optional or required). Definitions in `_system:settings.userFields`; values on the **user record** as `customFields` keyed by stable field id (so the Users list can search/filter without extra reads). `server/src/lib/user-fields.js` is the single validator. Required fields are collected by `ProfileCompletionGate` around the classroom routes — status fetched fresh each load, **fails open**, client-side only, not enforced at signup. → [details](docs/ARCHITECTURE.md#custom-user-fields-364)
- **Names (#402)** — users have `firstName` / `lastName` (last name optional); `name` is kept, always derived, for plugins, audit, emails, and rollback. `server/src/lib/names.js` reads every request (a lone `name` is split at the first whitespace) and shapes every response (`nameFields`). `nameSource: 'auto'` marks an inferred split the UI invites people to correct. Migration `m005_name_split`. → [details](docs/ARCHITECTURE.md#first-and-last-names-402)
- **Wait list (#363)** — public `/waitlist` form and `POST /v1/waitlist` (open list, or a Bearer API key for outside forms). Entries are `invites` rows with `status: 'waitlist'`, no ttl, and a `profile`; config is `_system:waitlist`, not settings. Admin invites from Users → Wait List; signup fills in the entry's answers. → [details](docs/ARCHITECTURE.md#wait-list-363)
- **Data migrations** — any change to existing stored data ships as an append-only entry in `server/src/lib/migrations.js`: additive/idempotent/conditional, never rewrites learner work, and rollback-compatible with the release being upgraded from (Beta-RC-232). **Startup awaits them** (`initializeLaunch`, `server/src/lib/launch.js`) before seeding or serving, in `start.js`, the Lambda handler and `dev-sqlite.js`; a failed migration or a lock still held after 20 s fails startup instead of serving partly migrated data. Gate: `server/tests/migrations/upgrade-from-rc232.test.js` (runs RC-232's own handlers on migrated data); dry-run with `server/scripts/migrate.js`. → [details](docs/ARCHITECTURE.md#data-migrations)
- **Roles (#435)** — admin, educator, learner (stored `user` before; `normalizeRole`), tester (read-only everything). `server/src/lib/permissions.js` maps roles→permissions and every `/v1/admin` route→permission; **unmapped routes are admin-only** and a test fails if a route isn't mapped. `authorize` middleware enforces; the client mirrors the map (`client/src/lib/permissions.js`, kept in sync by test) for nav/controls only. Plugin admin routes keep the SDK's `requireAdmin`. → [details](docs/ARCHITECTURE.md#roles--permissions-435)
- **Notifications (#388, #389, #400)** — automated and admin-sent email goes through `server/src/lib/notifications.js`: editable templates, multipart raw MIME with one-click unsubscribe, opt-outs in the server-only `notify:state` record (create-only on first write), and `EMAIL_ALLOWLIST`. **Every automation ships OFF**; the invitation emails are always on. A message delivery takes an execution lease, claims each recipient before sending and records `emailed` only on confirmation: a known failure is retryable (`failed` status, 503, `POST …/messages/:id/retry`), an uncertain one is never resent (at most once). Cloud Run awaits jobs in the request. With `SKIP_EMAIL=true` nothing is emailed and results say so. → [details](docs/ARCHITECTURE.md#notifications-388-389-400), [launch contracts](docs/ARCHITECTURE.md#launch-data-contracts-2026-11-06)
- **Admin "View as User"** — read-only learner-classroom audit via `?asUserId=<id>` on GET `/v1/sync*` and `/v1/lessons*`; writes never carry the param (403 server-side + client throw). Session-granularity audit log. → [details](docs/ARCHITECTURE.md#admin-view-as-user)
- **Observability** — errors flow `server/src/lib/logger.js` (snake_case `code` + Cloud Logging `severity`) → `GET /v1/admin/logs` (merges ring buffer + Cloud Logging on Cloud Run via `server/src/lib/cloud-logging.js`, or CloudWatch on Lambda via `server/src/lib/cloudwatch-logs.js`, and aggregates by `code`) → `scripts/log-watch.js` (queries Cloud Logging directly via ADC on Cloud Run) and pilot report. **Before adding any error detection or alert, read [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) and [`docs/SAVE_OBSERVABILITY.md`](docs/SAVE_OBSERVABILITY.md)** (the three-tier model + Cloud Run save observability).

## Plugins

Manifest-driven plugin system modeled on VS Code/Vite/WordPress. Plugins live in `plugins/<id>/` and are bundled into the SAM build (no runtime code uploads — Lambda's read-only FS). The admin UI at `/plato/plugins` toggles activation and configures plugins.

- Host code: `server/src/lib/plugins/` (registry, manifest, hooks, lifecycle, sdk), `client/src/lib/plugins/` (`<PluginSlot>`, loader, SettingsForm). Types in `packages/plugin-sdk/index.d.ts`. Docs in `docs/plugins/` (README, AUTHORING, AGENTS, EXTENSION_REFERENCE, CAPABILITIES, API_VERSIONING, EXAMPLES, schema, templates). Scaffolder `scripts/create-plato-plugin.js`; CI gate `scripts/validate-plugins.js`.
- **Anti-goals (plugins MUST NOT):** override completion semantics (`applyCoachResponseToKB` is the single owner), introduce hard exchange-count cutoffs, write `_system:settings.*` directly, read/write another plugin's settings, mount routes outside `/v1/plugins/<id>/`, modify files outside their own `plugins/<id>/` folder.
- **When changing the plugin contract:** bump `PLUGIN_API_VERSION` in `server/src/lib/plugins/version.js`, update `docs/plugins/plugin.schema.json` enums, `packages/plugin-sdk/index.d.ts`, and `docs/plugins/EXTENSION_REFERENCE.md`. `docs/plugins/CAPABILITIES.md` is the source of truth for documented vs. implemented.
- **Tests:** core plugin tests alongside each plugin (`plugins/<id>/server/*.test.js`); host tests at `server/tests/lib/plugins/*.test.js`.

## Development

```bash
npm ci                          # root workspace lockfile, Node 24
cp server/.env.example server/.env  # choose a configured provider (see README)
npm run build:client && npm run dev:server
```

Client hot reload: `cd client && npm run dev` (port 5173, proxies API to :3000).

## Testing

```bash
npm test                        # client + server
# POSTGRES_TEST_URL=postgres://... npm test includes PostgreSQL integration
npm run build:client && npm --prefix e2e ci && cd e2e && npx playwright test   # accessibility + e2e (see e2e/README.md)
```

Run the server suite before lint, not alongside it: the RC-232 upgrade gate
extracts a temporary tree that a concurrent lint can race.

The e2e suite runs axe on every page and dialog (no serious/critical WCAG 2.1
A/AA violations) and keyboard flows, against `dev-sqlite` with
`AI_PROVIDER=mock`, whose replies still go through the real server assessment,
signing and atomic save. `.github/workflows/a11y.yml` runs it where GitHub
Actions are available; this fork's Cloud Build gate doesn't, so run it locally
for UI changes. Add any new page or dialog to `e2e/tests/a11y.spec.js` in the
same PR. The fork's own browser suites (`client/tests/browser/*.test.js`,
`npm --prefix client run test:browser:*`) cover recovery, publishing,
customizer and responsive admin journeys.

AI route tests mock `ai-provider.js` (not `bedrock.js`), and use the real `converse.js` translation so a translation regression surfaces there too. Run `npm test` before deploying.

## Deploy

Cloud Run + Cloud SQL deployment, runtime configuration, Direct VPC connectivity, and backup/recovery procedures are in **[`docs/CLOUD_RUN_STORAGE.md`](docs/CLOUD_RUN_STORAGE.md)**. AWS SAM procedure, SSM parameters, environments (prod / playground), CloudFront, and DynamoDB backups are in **[`docs/DEPLOY.md`](docs/DEPLOY.md)**. Automation (Cloud Build CI gate, deploy dispatch, agentic workflows, branch protection, versioning) is in **[`docs/AUTOMATION.md`](docs/AUTOMATION.md)**.

- **Cloud Run (`plato-shaped`, `idk-4e9b9` / `us-east1`):** pushes to `main` trigger the `plato-main` Cloud Build webhook (`deploy/cloudrun/cloudbuild.yaml`), which runs `npm ci && npm run lint && npm test` (including the PostgreSQL suite against a disposable `postgres:17-bookworm` container) before building `Dockerfile` and updating `app-container` (preserving the `nginx-container` sidecar, Direct VPC egress, Cloud SQL `plato-durable` connection, and Secret Manager bindings). Re-run `deploy/cloudrun/configure.sh` after editing `deploy/cloudrun/cloudbuild.yaml`. Never use AI Studio's Deploy button on `plato-shaped`.
- **AWS (`plato` / `plato-playground` stacks):** prod auto-deploys on push to `main`; playground on push to `playground` — both via `repository_dispatch` to the private fork. These are supported upstream deployment options; do not infer active users or configured fork AWS deployments.
- CloudFront → Lambda Function URL: the Origin Request Policy **must** be `AllViewerExceptHostHeader` (Function URLs reject mismatched Host headers).
- The SAM build does not bundle the client — the `cp` steps for `client-dist` (SPA) and `client-content` (prompt seed files) are required; see `docs/DEPLOY.md`.

## Conventions

- **Accessibility is required**: every interactive element must be keyboard-operable, show visible focus (`e2e/tests/focus.spec.js` checks), reflow at 320 px (`e2e/tests/reflow.spec.js`), and have an accessible name (aria-label, aria-pressed, role, etc.) that contains its visible text (WCAG 2.5.3). Chat log uses `role="log"` `aria-live="off"`; new-message announcements go through a separate auto-clearing `role="status"` region; a streaming `AssistantMessage` is `aria-hidden` AND drops its `data-chat-message`/`tabIndex` so focus and Alt+Arrow nav can't land on an aria-hidden node; persisted messages carry sr-only speaker prefixes + `data-chat-message` for Alt+Arrow nav (`useChatKeyboardNav`). The inline `ComposeBar` (when pinned) is `inert`, not `aria-hidden`, so a focused control inside it is blurred rather than hidden-with-focus. `ComposeBar` sends on Cmd/Ctrl+Enter by default; the learner's `sendKey` preference can make plain Enter send (Shift+Enter = newline), and a visible hint (the textarea's description) says which. `ComposeBar` takes `busy` (holds sending; the textarea stays editable and focused) separately from `disabled` (read-only View as User). While busy, its `busyHint` must name what holds sending — a streaming reply, saving, a retained unsaved reply, an earlier response to recover — never "the reply" when none is running. Replies show as they stream in, with no typing animation → [details](docs/ARCHITECTURE.md#composing-and-showing-replies-247). Never disable the control that has focus during async work: forms make fields `readOnly` and keep the submit button focusable (`focusableWhenDisabled`), and a confirmation that replaces a form takes focus. Learner bubbles keep line breaks (`whitespace-pre-wrap`). Field borders use `--input`, which must hold 3:1 (WCAG 1.4.11) and is never a fill (fields stay transparent); decorative dividers use `--border`.
- **Always commit and push after changes.**
- **PR workflow for collaborative iteration**: open PRs as **Draft** (`gh pr create --draft`) while iterating interactively; mark Ready (`gh pr ready <n>`) only when the user says it's ready. If a Ready PR gets more iteration, convert it back (`gh pr ready <n> --undo`). Every push to a Ready PR triggers the full CI suite (Bedrock auto-review, CodeQL, lint ×2) — micro-commits there are noise and waste budget. Does NOT apply to plato-pilot PRs (opened Ready by design) or one-line bugfixes already approved up front.
- **Docs & tests**: update both alongside every code change (open-source project).
- **Getting Started stays current (#443)**: any PR that changes learner-facing behavior (controls, labels, chat behavior, completion, navigation) updates the Getting Started lesson that teaches it (`client/prompts/lessons/getting-started*.md`, three lessons in the bundled "Getting Started with plato" course) in the same PR. Use the real control names, and check the coach against the change with a real run on the configured provider. Unedited copies update themselves on deploy; edited copies get an "update available" notice → [details](docs/ARCHITECTURE.md#getting-started-the-bundled-orientation-course-443)
- **Dialogs** (`components/ui/dialog.jsx`, `alert-dialog.jsx`) cap at the viewport height and scroll (`max-h-[calc(100dvh-2rem)]`), so a long dialog never runs off-screen (#421). Don't remove that cap on a single dialog; if one needs an inner scroll area instead, override `max-h` on that dialog. AdminLayout has a skip link and `<main id="main-content">`.
- Admin pages (`/plato/*`) are never themed with classroom branding. Auth pages use `usePublicBranding`; classroom pages use `BrandingProvider`. Admin nav order: Home, Lessons, Users, Customizer, AI Settings, Notifications, Plugins (Courses & Units live inside Admin → Lessons).
- Colors come from the semantic tokens in `client/src/index.css` (documented in `DESIGN.md`), in core and plugin UIs alike; raw Tailwind palette classes (`bg-green-50`, `text-blue-700`) fail `client/tests/design-tokens-contract.test.js`. Dark mode is a per-browser choice: the classroom header's `ThemeToggle` (an account-menu item under 30rem, and a toggle on the sign-in page and in the admin shell; all share `useTheme`) toggles `.dark` on `<html>` and saves `plato_theme` (`client/src/lib/theme.js`); an inline script in `client/index.html` reapplies it before first paint, and `color-scheme` follows it. With no saved choice, the page follows the device's `prefers-color-scheme`, including later changes. A classroom's dark colors (header, fills, learner bubbles, surface tint) are derived from its primary by `buildThemeVars`, not configured ([details](docs/ARCHITECTURE.md#client-loading)).
- Footer text: "Powered by plato." (with period, with GitHub link). Emails use classroom name/colors from settings with that footer.
- API responses for user groups use `{ userGroups: [...] }` consistently (custom user fields mirror it: `{ userFields: [...] }`). User-created lesson IDs start with `custom-`. `loadLessons()` merges system lessons (`/v1/lessons`) with user sync-data lessons.
- Favicon: plato's until branding loads, then a rounded tile in the primary color with the logo, or with the classroom name's initial when there is no logo, the logo is wider than 2:1, or it fails to load.

## Key files

- `server/start.js` — Cloud Run / production HTTP entry point (`0.0.0.0:$PORT`, graceful `SIGTERM` drain)
- `server/src/lib/db-postgres.js` — Cloud SQL Connector (`@google-cloud/cloud-sql-connector`, Private IP) + `pg.Pool` initialization and startup retry
- `server/src/lib/postgres-database.js` — PostgreSQL adapter (advisory-locked per-learner transactions, JSONB tables, atomic token consumption)
- `server/src/lib/cloud-logging.js` — Cloud Run structured log reader (`entries:list` pagination + deduplication)
- `deploy/cloudrun/cloudbuild.yaml` — Cloud Build test-gated pipeline and `gcloud run services update` step
- `deploy/cloudrun/configure.sh` — Idempotent `plato-deploy` IAM setup and `plato-main` webhook trigger sync
- `server/template.yaml` — AWS SAM/CloudFormation infrastructure
- `server/src/lib/email.js` — the email wrapper, escaping, and the password-reset email (every other email is a template in `notifications.js`); `SKIP_EMAIL` handling
- `server/src/lib/notifications.js` / `messages.js` / `schedule.js` — templates and unsubscribe, message delivery leases and claims, request-driven scheduling
- `server/src/lib/launch.js` / `migrations.js` — startup migrations (awaited before serving) and the append-only migration list
- `server/src/lib/permissions.js` + `server/src/middleware/authorize.js` — role → permission map and `/v1/admin` enforcement
- `server/src/lib/hierarchy.js` / `names.js` / `groups.js` — Course → Unit → Lesson order, name parts, user groups
- `server/src/lib/ai-provider.js` — AI provider router (Bedrock / Workers AI) + the `LLM` constant
- `server/src/lib/converse.js` — Anthropic ⇄ Bedrock Converse translation (pure, unit-tested)
- `server/src/lib/workers-ai.js` — Cloudflare Workers AI Chat Completions / SSE adapter
- `server/src/lib/cloudflare-oauth.js` — Encrypted Cloudflare OAuth PKCE flow and leased token refresh
- `server/src/routes/sync.js` — sync CRUD + `applyActivityEffects` (denormalization single writer)
- `server/src/lib/lesson-limits.js` — server-side mirror of microlearning limits
- `server/src/lib/lesson-stats-cache.js` — stale-while-revalidate KPI cache
- `client/src/contexts/BrandingContext.jsx` — classroom branding for authenticated pages
- `client/src/hooks/usePublicBranding.js` — classroom branding for auth pages
- `client/src/lib/branding.js` — shared branding utilities (CSS vars, favicon gen)
- `client/src/lib/lessonEngine.js` — lesson runtime; `applyCoachResponseToKB` (completion semantics), `resumeLesson`, image hydration/migration
- `client/src/lib/lessonCreationEngine.js` — lesson creation flow; `buildConversationText`
- `client/js/lessonOwner.js` — lesson loading and markdown parsing
- `client/js/storage.js` — sync-data cache and persistence (`putSyncData`)
- `client/js/orchestrator.js` — AI agent orchestration
- `client/src/lib/imageCompression.js` — downscales pasted screenshots under the 400 KB item limit
- `client/src/lib/constants.js` — microlearning limits + shared constants
- `client/src/hooks/useChatKeyboardNav.js` — Alt+Arrow chat navigation
- `client/src/hooks/useStickToBottom.js` — chat auto-scroll (follow while at bottom; jump on send). Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#chat-auto-scroll-319-321) before touching it — three non-obvious traps live here
- `client/src/hooks/useTitleNotification.js` — document title flash for new-message notifications
- `server/src/lib/user-fields.js` — custom user field definition/value validation (#364)
- `client/src/components/ProfileCompletionGate.jsx` — blocks the classroom until required custom fields are filled
- `client/src/pages/admin/UserFieldsDialog.jsx` — Admin → Users → User Fields management
- `client/src/pages/admin/UserStatsPanel.jsx` — per-user activity widget (Admin → Users)
- `client/src/pages/admin/CompletionRing.jsx` — SVG completion donut, color-coded

## Reference docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — subsystem deep-dives + incident history
- [`docs/CLOUD_RUN_STORAGE.md`](docs/CLOUD_RUN_STORAGE.md) — Cloud Run & Cloud SQL architecture, Direct VPC networking, IAM, backups/PITR, and rollback
- [`docs/SAVE_OBSERVABILITY.md`](docs/SAVE_OBSERVABILITY.md) — Cloud Logging save telemetry, `log-watch` ADC CLI, and exit codes
- [`docs/INFERENCE_TELEMETRY.md`](docs/INFERENCE_TELEMETRY.md) — AI invocation telemetry and lesson cost reporting
- [`docs/CLOUDFLARE_OAUTH.md`](docs/CLOUDFLARE_OAUTH.md) — Cloudflare OAuth setup for Workers AI
- [`docs/FIRESTORE_RETIREMENT.md`](docs/FIRESTORE_RETIREMENT.md) — Firestore learner-data retirement and rules verification
- [`docs/AUTOMATION.md`](docs/AUTOMATION.md) — Cloud Build CI, agentic workflows, branch protection, versioning
- [`docs/MODEL_SELECTION.md`](docs/MODEL_SELECTION.md) — why Qwen3-VL: constraints, benchmarks, rejected candidates
- [`docs/WAITLIST_API.md`](docs/WAITLIST_API.md) — public wait-list API guide for outside forms/integrations
- [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) — error-reporting tiers + how to add an alert
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — Cloud Run and AWS deploy, environments, backups
- [`docs/plugins/`](docs/plugins/) — plugin authoring (human + AI guides, reference, examples)
