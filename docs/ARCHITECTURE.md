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
  `/v1/branding/logo/:hash` endpoint serves immutable, cacheable image bytes with
  an ETag, `nosniff`, and a restrictive CSP sandbox. Content-addressed assets are
  retained so cached pages can still resolve previous logo URLs; removal clears
  the current reference. Safe legacy inline logos remain readable and migrate
  on the next theme save. No schema migration is required on any database adapter.
- The theme write accepts only primary/accent hex colors, an optional trimmed
  classroom name of at most 100 characters without control characters, and a
  PNG/JPEG/WebP/static-SVG base64 image or `null`. Encoded logos are capped at
  128 KiB and raster dimensions at 4096 pixels per edge; a request-body limit
  also bounds parsing. SVG accepts only static
  geometry/text/gradient elements with local references. The Customizer accepts
  source files up to 5 MiB and rasterizes them to transparent PNG, preserving
  proportions within 1024 × 128 pixels and shrinking further to meet the cap.
  Re-upload an old oversized or unsupported SVG logo through the Customizer.

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

## Google sign-in and canonical server storage

Google sign-in uses Firebase Auth's popup. The server verifies the Firebase ID
token at `POST /v1/auth/firebase` and returns plato access and refresh tokens.
A verified email that matches an existing account signs in to it. Any other
verified Google account gets a new learner account; a pending invite or wait-list
entry for that email supplies its profile, but neither is required.

Google and password sessions use the same server storage paths. `storage.js`
only writes through the API and caches acknowledged atomic lesson commits.
`sync.js` replaces cached state with the current server response; no Firestore
backfill, subscription, profile initialization, or mirror write remains.
The retired `firebaseClient.js` module is removed. `firestore.rules` denies all
client access, including former owners/admins, and `firebase.json` targets only
the named Plato database. Keep the Firebase project and its unrelated databases.
See [Firestore retirement](FIRESTORE_RETIREMENT.md) for inventory evidence,
local rules testing, cutover order, and publication status.

- **Firebase Auth stays lazy.** Login, Signup and Setup preload `firebaseAuth.js`
  at idle (`preloadFirebase`) so the Google popup can open directly from the click.
  The production browser bundle has no Firestore SDK data path. The Firebase
  package remains necessary for Auth.
- **Provider detection is for sign-out.** `usesFirebase()` reads the provider in
  `plato_auth`; for older sessions it probes `firebaseLocalStorageDb`. This keeps
  Google cleanup and account-switch protection without loading a data mirror.
- **Password reset is plato's.** `/forgot-password` uses the server's
  `POST /v1/auth/forgot-password` endpoint. Firebase resets are not used for
  plato password accounts. Reset links are single-use, and completing a reset
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

Sign-out removes plato's local credentials and protected React state before
waiting for any remote work. Server refresh-token revocation is best effort,
uses the old token snapshot, and aborts after five seconds. In-flight refreshes
check the session generation immediately before writing replacement credentials
or notifying session expiry, so they cannot restore a logged-out account or
overwrite the next account. A delayed 401 can retry with credentials already
refreshed by another request in the same account and session generation.
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

The Customizer loads Styles and Knowledge independently, with per-tab retry.
Styles tracks edits against its last acknowledged save; discard restores that
snapshot, and reset stages the seeded defaults for an explicit Save. A data-router
navigation blocker protects links and browser history, and `beforeunload` protects
reloads/closing the page. The existing route tree remains in `App`. Knowledge
editor mode is derived from `/plato/customizer/knowledge/edit`, never local state.
An omitted accent means “Match primary”; new classrooms use that mode, while
existing explicit accents remain unchanged. Both previews use real button styles,
classroom identity, and isolated light/dark tokens. Partial hex input keeps the
last complete color until blur or Save accepts a shorthand value.

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
foreground selection as the classroom. All inserted names are HTML escaped;
the SES display name uses bounded UTF-8 MIME words, and subject/body declare UTF-8.
The current `classroomName` takes precedence over the legacy `logoAlt` field.

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
theme store follow `prefers-color-scheme`, including later device changes. An
explicit light/dark choice takes precedence, even if storage is unavailable for
the current page session. Clearing the saved choice resumes device following.

A classroom's dark colors are derived, not configured. `buildThemeVars`
(`client/src/lib/branding.js`) computes a dark header, fill, text color, and
surface tint from the saved primary and sets them as `--classroom-*-dark`
variables beside the light ones; `index.css` applies them under
`.dark .classroom-theme`. Two rules hold that cascade together. A custom
property resolves where it is declared, so the tinted surface tokens are
declared again on every `.classroom-theme` element; declared once on `.dark`,
they would keep plato's hue. And the dark `--primary` and `--ring` are
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
navigation still warns while a reply or generation is pending.
After reload, the original turn IDs, base snapshot, reply, and progress restore;
**Retry saving** only submits the original atomic commit. It neither generates
a replacement nor runs optional profile/course models. A lost acknowledgement
still reconciles through the existing idempotent commit contract.

Already-open legacy bundles cannot acquire this UI retroactively. Their existing
account-scoped generated-turn journal remains readable after manual reload, but
legacy `plato_compose_draft:<lessonId>` text has no owner identity and is left
untouched rather than assigned to whichever account signs in next. Copy that
unsent text before upgrading a legacy tab. Recovery remains limited to the same
tab/session, not browser closure or another device.

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
  directly render unchanged.
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
inline composer. On narrow screens the markdown preview follows the chat, so
scrolling that admin container to its absolute bottom would hide the composer.
The optional target changes both pinning and the "at bottom" calculation.
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
- **Confirmations that replace a form take focus** (Reset Password, Wait List),
  and a failed lesson start offers Try again in place, parking focus on the
  lesson heading while the loading view replaces the error.
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

Admins invite users via email or shareable link. Invites expire after 7 days (TTL enforced in DynamoDB/SQLite). All invite operations are audit-logged.

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
- **API:** `POST /v1/waitlist` (public) takes `{ name, email, userGroup, customFields }`. It works when the list is open, or with `Authorization: Bearer <key>` from an outside form, even when closed. Send the key from a server, not a web page. The reply is `202 { ok: true }` for any valid input, including an email that already has an account, invite, or entry, so it never reveals who is registered. `GET /v1/waitlist` returns `{ open }`.
- **Storage:** rows in the `invites` table with `status: 'waitlist'`, no `ttl` (they never expire), and a `profile` of `{ name, userGroup, customFields }`. Pending-only lookups skip them, so a wait-list token can't sign up.
- **Config:** `_system:waitlist` = `{ open, apiKeyHash }`, kept out of `_system:settings` so a stale settings save can't bring back a revoked key. The key is shown once; only its SHA-256 is stored.
- **Admin:** Users → **Wait List** filter, with Invite and Remove per row; click a row to edit the entry (`/plato/users/waitlist/:token`: name, email, group, custom fields — same validation as joining, and a new email must not belong to a user, pending invite, or other entry). Users → **Wait List** button to open or close the form and make or revoke the key. Routes: `GET /v1/admin/waitlist`, `PUT /v1/admin/waitlist/settings`, `POST`/`DELETE /v1/admin/waitlist/key`, `PUT /v1/admin/waitlist/:token` (edit; conditional on the row still being an entry, so it can't race an Invite), `POST /v1/admin/waitlist/:token/invite`, `DELETE /v1/admin/waitlist/:token`.
- **Invite:** creates a normal email invite that carries the entry's `profile`, sends the invite email, and deletes the entry. Resend keeps the profile.
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

- `public` — visible to all (legacy `published` normalizes to `public`).
- `private` — visible only to users in `sharedWith`.
- `draft` — in-progress, admin-only, no markdown yet.

A record is a **true draft** iff `status === 'draft'` AND markdown is empty;
legacy `status: 'draft'` records that *do* have markdown are treated as
`private` to preserve pre-rework semantics. Drafts surface as a `Draft` pill in
Admin → Lessons and are never exposed to learner-facing endpoints.

New lessons start as `draft` the moment the Lesson Creator conversation begins
(one `lesson:<id>` record per draft in `_system` sync-data), so admins can pause
and resume drafts or work on several in parallel. Clicking "Create Lesson"
finalizes the same record with extracted markdown and flips status
`draft` → `private` (shared only with author). Admins toggle public/private on
finalized lessons and manage shared users via the Share modal. Drafts hide the
Share icon (nothing shareable yet).

### Courses

Optional taxonomy for grouping lessons. Each course is a first-class
`_system:course:<id>` sync-data record with `{ name }`. Each lesson carries an
optional `course` field (course ID, like `userGroup` on users). Pure
organization — courses don't carry visibility/ACL; lesson visibility is
unchanged. The learner-facing `GET /v1/lessons` and `/v1/lessons/:id` inline
`course: { id, name } | null` so the coach context (`buildContext` in
`client/src/lib/lessonEngine.js`) can include `course: { name }` when assigned.
Admin manages courses via a "Courses" button on Admin → Lessons (mirrors the
User Groups pattern); the lesson editor has a course dropdown that persists
immediately on edit; the lessons table has a Course column. Course delete
cascades: any lesson whose `course` referenced the deleted course is rewritten
with `course: null`.

### Learner classroom

`/lessons` (`client/src/pages/LessonsList.jsx`): lessons render as a responsive
grid (1 col mobile / 2 col `sm:` / 3 col `lg:`) with 12 per page. A course
filter dropdown sits above the grid; it's hidden when no courses exist. When the
filter is set to a course that no longer exists, it snaps back to "All courses"
automatically. Filter and page changes are announced via an always-mounted
`role="status" aria-live="polite"` region — no visible "N lessons" subhead.

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

`lessonSaveQueue` serializes conversation, course and final markdown writes.
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
**Revise lesson**; unknown write outcomes retain the same operation for retry.

**Markdown preview pane** (`client/src/pages/admin/MarkdownPreviewPane.jsx`):
chat left, rendered markdown right, wrapping according to available space and
text size. Headers and action groups wrap at narrow widths. The preview is
**manually refreshed** via a "Generate preview" / "Refresh preview" button that
re-runs the relevant extractor agent — it does NOT auto-update per message and
runs no AI call on editor open. On open the pane shows the already-saved markdown
(edit) or a quiet empty-state (new). Once the conversation advances past the last
refresh a hint explains that the conversation has changed. Conversation and
markdown revision IDs preserve that distinction across sessions.
**Generate preview / Refresh preview** generates and validates a preview;
**Create/Update Lesson** saves that exact
markdown, after pending autosaves finish. Failed finalization retains the
preview for persistence-only retry. Restart clears it and invalidates outstanding
extractions. Preview markdown is kept in the tab's recovery copy, but is not
published as lesson content until the save button is used.
`buildConversationText` (`client/src/lib/lessonCreationEngine.js`) is the shared
builder for the extractor input. The same pane (copy parametrized via props) backs both the lesson editor
(`extractLessonMarkdown`) and the **knowledge base editor**
(`AdminCustomizer` + `AdminKBSetup`, `extractKBMarkdown`). The knowledge base
editor likewise saves a current preview verbatim and extracts only when the
preview is missing or stale. Its conversation auto-saves as a draft; turns
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
and adds a column with that field's values.

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
Their assistant assertions are excluded from future assessment history. Active
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
fixed issue codes. `scripts/evaluate-coach.js` defaults to 15 authored offline
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
