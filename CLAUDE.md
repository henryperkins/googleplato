# CLAUDE.md

Project-level instructions for Claude Code sessions working on plato.

## Project overview

plato is an Open Source, AI-powered [microlearning](https://philosophers.group/platos-microlearning/) platform. Learners work through focused lessons in a continuous conversation with an AI coach, designed for completion in ~20 minutes.

- `client/` — React 19 + Vite SPA
- `server/` — Node.js + Hono, deployed as Google Cloud Run (`server/start.js` + Cloud SQL PostgreSQL) or AWS Lambda (SAM + DynamoDB)
- Brand: "plato" (always lowercase)

## Architecture

Quick map of the system. **Deep dives, incident history, and the *why* behind these invariants live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — read the relevant section before changing one of these subsystems.

- Login required, all data server-side. JWT access (15 min) + refresh (30 day) tokens in localStorage (`plato_auth`); login accepts email or username. Unique editable `username` per user.
- Cloud Run runs the HTTP/SSE container (`server/start.js`) backed by Cloud SQL for PostgreSQL (`users`, `invites`, `refresh_tokens`, `sync_data`, `audit_log`) over Direct VPC egress (`@google-cloud/cloud-sql-connector` with Private IP and service identity auth). AWS deployments run 2 Lambda functions (API Gateway buffered CRUD + Function URL streaming SSE for AI chat) and 5 DynamoDB tables (`users`, `invites`, `refresh-tokens`, `sync-data`, `audit-log`).
- Content is `_system` sync-data (`prompt:*`, `lesson:*`, `knowledgeBase`, `settings`). Prompts are bundled in `client/prompts/*.md` and upserted on every server startup — admins can't edit prompts directly. User-created lessons live under the user's sync-data (`lessons:custom-*`).
- **9 AI agents** (prompts in `client/prompts/`, each with an HTML header documenting reads/callers/purpose): coach, lesson-creator, lesson-owner, lesson-extractor, knowledge-base-editor, knowledge-base-extractor, learner-profile-owner, learner-profile-update, course-progress-update. Program KB + Lesson Catalog are appended to system prompts at runtime (`client/js/orchestrator.js`).
- **Learner language (#240)** — every agent writes in the learner's browser language via `withLanguage()` (`client/js/language.js`); English adds nothing to prompts. The directive lists every parsed literal (tags, JSON keys, lesson headings, `- Can `) as keep-in-English — add any new parsed literal there too. → [details](docs/ARCHITECTURE.md#learner-language-240)
- **One model for all 9 agents** — admins select **Amazon Bedrock** (`qwen.qwen3-vl-235b-a22b`, Apache-2.0) or **Cloudflare Workers AI** (`@cf/deepseek-ai/deepseek-v4.1-flash-1017` with maximum reasoning, or Mistral Small 3.1 24B, connected via Cloudflare OAuth or API token) at `/plato/ai`. `LLM` in `server/src/lib/ai-provider.js` (mirrored in `client/js/api.js` and injected into plugins as `ctx.LLM`) is a compatibility hint; all 9 agents and plugin AI calls route through `server/src/lib/ai-provider.js` with no per-agent routing and no automatic provider fallback. On Bedrock, non-Anthropic models require the **Converse API**: legacy `InvokeModel` doesn't reject them, it returns HTTP 200 with an OpenAI-shaped body, so callers silently read `undefined`. `server/src/lib/converse.js` translates between plato's internal Anthropic wire format and Converse, and `server/src/lib/workers-ai.js` translates Chat Completions/SSE for Workers AI. For UIC Bedrock deployments, a replacement model must clear **four** bars: on Bedrock us-east-2, accepts images (learners paste screenshots), reliably emits plato's literal tags, and carries an **OSI-approved license**. That last one is a constraint, not a preference — plato is AGPL-3.0, so *open weight isn't enough*: Llama 4 and Gemma ship under non-OSI community licenses and are ineligible despite passing every functional check (Llama 4 Maverick measured faster and cheaper, and is the fallback only at the cost of that bar). **Prompt caching is Claude-only on Bedrock — don't add it.** → [details](docs/ARCHITECTURE.md#ai-provider--model-choice), [why this model](docs/MODEL_SELECTION.md), [Cloudflare OAuth](docs/CLOUDFLARE_OAUTH.md)
- **Conversation & image persistence** — chat history is one append-only `messages:<lessonId>` record; progress is a separate `lessonKB:<lessonId>`. **Images are never inlined in `messages:`** — each is its own compressed `screenshot:*` record, referenced by `metadata.imageKeys` (DynamoDB's 400 KB item cap; inlining base64 silently lost conversations, #191/#193). The `LessonChat` resume effect keys on stable values, never the `lesson` object identity. → [details](docs/ARCHITECTURE.md#image--conversation-persistence-191-193)
- **Link attachments** — a learner can attach a web page to a coach message. It's fetched + read **server-side** (`POST /v1/links/fetch`); the page text is injected into the coach call on that turn only (image parity), and only `{ url, title }` is persisted in `metadata.links`. SSRF defense (`server/src/lib/url-guard.js`) is load-bearing — the server fetches user URLs from inside AWS. → [details](docs/ARCHITECTURE.md#link-attachments)
- **Lessons** — three statuses: `public`, `private` (visible to `sharedWith`), `draft` (admin-only, no markdown yet; true draft iff `status==='draft'` AND markdown empty). New lessons start as `draft`; "Create Lesson" flips `draft`→`private`. Editing is conversation-based (no raw markdown editor), deep-linked at `/plato/lessons/:lessonId/edit`, with a manually-refreshed markdown preview pane. An optional `## Coach Directive` section carries author-supplied runtime instructions for the coach (e.g. "reference the learner's project", "share this code") — extracted verbatim, parsed into `lesson.coachDirective`, and surfaced via `buildContext`; it never overrides completion semantics. Optional `course` taxonomy (`_system:course:<id>`) for grouping; delete cascades `course:null`. A per-learner `courseProgress:<courseId>` record carries a tiny distilled note of what the learner demonstrated in a course's *other* lessons — regenerated on completion by the `course-progress-update` agent (incremental, ~600-char cap) and injected into the coach context as `course.progress`; informational only, never overrides completion. → [details](docs/ARCHITECTURE.md#course-progress-cross-lesson-memory)
- **Pacing & completion** — limits in `client/src/lib/constants.js` (MAX_EXCHANGES=11, MIN/MAX_OBJECTIVES=2/4, MINS_PER_EXCHANGE=1.8), mirrored in `server/src/lib/lesson-limits.js`; prompts use the literal numbers. **No hard cutoff** — lessons run until the coach awards `progress >= 10`. Never auto-complete on exchange count. `extendedLessons` is informational only. Post-completion the thread is feedback-only — `progress` and `activitiesCompleted` both freeze in code (not just via prompt instruction, which is model-dependent), while KB updates keep flowing; scores are clamped 0–10. `applyCoachResponseToKB` (`lessonEngine.js`) is the single owner of completion semantics. → [details](docs/ARCHITECTURE.md#pacing--completion-philosophy)
- **Denormalization** — derived activity fields (`lessonsCompleted`, `lastActiveAt`) are denormalized onto the user record with a **single writer** (`applyActivityEffects` in `server/src/routes/sync.js`), transition-detected (no double-count), best-effort. Underlying sync-data stays the source of truth. **All dashboard/per-user KPIs count only published (public) lessons** — drafts, privates (even when shared), and custom lessons are excluded from numerator *and* denominator (`server/src/lib/lesson-visibility.js`); a completion counts iff its lesson id maps to a public `_system:lesson:*`. The `?include=stats` user-list recomputes `lessonsCompleted` per request and heals the counter (visibility can't be derived from the stored count alone). Per-user stats (#136) and Admin dashboard KPIs build on this. → [details](docs/ARCHITECTURE.md#denormalization-policy)
- **Custom user fields (#364)** — admin-defined profile fields (text, textarea, dropdown, link, phone; optional or required). Definitions in `_system:settings.userFields`; values on the **user record** as `customFields` keyed by stable field id (so the Users list can search/filter without extra reads). `server/src/lib/user-fields.js` is the single validator. Required fields are collected by `ProfileCompletionGate` around the classroom routes — status fetched fresh each load, **fails open**, client-side only, not enforced at signup. → [details](docs/ARCHITECTURE.md#custom-user-fields-364)
- **Wait list (#363)** — public `/waitlist` form and `POST /v1/waitlist` (open list, or a Bearer API key for outside forms). Entries are `invites` rows with `status: 'waitlist'`, no ttl, and a `profile`; config is `_system:waitlist`, not settings. Admin invites from Users → Wait List; signup fills in the entry's answers. → [details](docs/ARCHITECTURE.md#wait-list-363)
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
cd client && npm install && cd ../server && npm install
cd server && cp .env.example .env   # AWS creds with Bedrock access (see README)
node dev-sqlite.js
```

Client hot reload: `cd client && npm run dev` (port 5173, proxies API to :3000).

## Testing

```bash
cd server && npm test
```

AI route tests mock `ai-provider.js` (not `bedrock.js`), and use the real `converse.js` translation so a translation regression surfaces there too. Run `npm test` before deploying.

## Deploy

Cloud Run + Cloud SQL deployment, runtime configuration, Direct VPC connectivity, and backup/recovery procedures are in **[`docs/CLOUD_RUN_STORAGE.md`](docs/CLOUD_RUN_STORAGE.md)**. AWS SAM procedure, SSM parameters, environments (prod / playground), CloudFront, and DynamoDB backups are in **[`docs/DEPLOY.md`](docs/DEPLOY.md)**. Automation (Cloud Build CI gate, deploy dispatch, agentic workflows, branch protection, versioning) is in **[`docs/AUTOMATION.md`](docs/AUTOMATION.md)**.

- **Cloud Run (`plato-shaped`, `idk-4e9b9` / `us-east1`):** pushes to `main` trigger the `plato-main` Cloud Build webhook (`deploy/cloudrun/cloudbuild.yaml`), which runs `npm ci && npm run lint && npm test` (including the PostgreSQL suite against a disposable `postgres:17-bookworm` container) before building `Dockerfile` and updating `app-container` (preserving the `nginx-container` sidecar, Direct VPC egress, Cloud SQL `plato-durable` connection, and Secret Manager bindings). Re-run `deploy/cloudrun/configure.sh` after editing `deploy/cloudrun/cloudbuild.yaml`. Never use AI Studio's Deploy button on `plato-shaped`.
- **AWS (`plato` / `plato-playground` stacks):** prod auto-deploys on push to `main`; playground on push to `playground` — both via `repository_dispatch` to the private fork. Merges to `main` auto-deploy to prod with live users.
- CloudFront → Lambda Function URL: the Origin Request Policy **must** be `AllViewerExceptHostHeader` (Function URLs reject mismatched Host headers).
- The SAM build does not bundle the client — the `cp` steps for `client-dist` (SPA) and `client-content` (prompt seed files) are required; see `docs/DEPLOY.md`.

## Conventions

- **Accessibility is required**: every interactive element must be keyboard-operable and have an accessible name (aria-label, aria-pressed, role, etc.). Chat log uses `role="log"` `aria-live="off"`; new-message announcements go through a separate auto-clearing `role="status"` region; a streaming `AssistantMessage` is `aria-hidden` AND drops its `data-chat-message`/`tabIndex` so focus and Alt+Arrow nav can't land on an aria-hidden node; persisted messages carry sr-only speaker prefixes + `data-chat-message` for Alt+Arrow nav (`useChatKeyboardNav`). The inline `ComposeBar` (when pinned) is `inert`, not `aria-hidden`, so a focused control inside it is blurred rather than hidden-with-focus. `ComposeBar` sends on Cmd/Ctrl+Enter; plain Enter inserts a newline. `ComposeBar` takes `busy` (holds sending while a reply streams; the textarea stays editable and focused) separately from `disabled` (read-only View as User). Never disable the control that has focus during async work: forms make fields `readOnly` and keep the submit button focusable (`focusableWhenDisabled`), and a confirmation that replaces a form takes focus. Learner bubbles keep line breaks (`whitespace-pre-wrap`). Field borders use `--input`, which must hold 3:1 (WCAG 1.4.11) and is never a fill (fields stay transparent); decorative dividers use `--border`.
- **Always commit and push after changes.**
- **PR workflow for collaborative iteration**: open PRs as **Draft** (`gh pr create --draft`) while iterating interactively; mark Ready (`gh pr ready <n>`) only when the user says it's ready. If a Ready PR gets more iteration, convert it back (`gh pr ready <n> --undo`). Every push to a Ready PR triggers the full CI suite (Bedrock auto-review, CodeQL, lint ×2) — micro-commits there are noise and waste budget. Does NOT apply to plato-pilot PRs (opened Ready by design) or one-line bugfixes already approved up front.
- **Docs & tests**: update both alongside every code change (open-source project).
- Admin pages (`/plato/*`) are never themed with classroom branding. Auth pages use `usePublicBranding`; classroom pages use `BrandingProvider`. Admin nav order: Home, Lessons, Users, Customizer, AI Settings, Plugins (courses live inside Admin → Lessons).
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
- `server/src/lib/email.js` — SES email templates (invite, reset) and `SKIP_EMAIL` handling
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
