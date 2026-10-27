# Coach assessment implementation plan

**Closeout 2026-10-27:** This is the historical implementation plan. The coach, Customizer, and learner-recovery work was integrated through merge `e1ebc66`.

**Evidence archive:** Historical raw captures, logs, and run records are retained privately in archive `googleplato-untracked-curation-20261027T055535Z` (`evidence-1730.tar.gz`). Paths beginning `output/` or `.mobile-ux/` below identify archive members.

> Execution: native implementation with test-driven development and a fresh independent final review. User explicitly authorized every finding in the consolidated review; no further design approval is required. No commit, push, or deployment is included.

**Goal:** Resolve every confirmed prompt/code finding while preserving existing uncommitted work and persistence-only recovery.

**Architecture:** Shared pure assessment helpers define parsing, canonical objectives, bounded evidence/context, and progress transitions. Server-owned coaching assembles canonical lesson context and issues a signed generated-turn receipt; the client retains that exact generated turn and retries only persistence. Prompt updates and a fixed offline/live evaluation runner use the same contract.

**Tech stack:** Existing JavaScript ES modules, React/Vite, Hono, node:test, SQLite/PostgreSQL/DynamoDB adapters; no new runtime dependencies.

**Spec:** `docs/reviews/coach-prompt-consolidated-review-2026-10-25.md` plus the user's instruction to implement all findings comprehensively and preserve uncommitted work.

## Constraints and decisions

- Verified recovery: `/home/ubuntu/.codex/recovery/googleplato-coach-20261026T003413Z`, 1,472 files plus staged/unstaged patches. Work continues on `fix/coach-assessment-contract` in the existing checkout so its recovery changes are tested together; no stash/reset or unrelated edits.
- Keep generated replies separate from drafts; stable turn IDs, account ownership, optimistic base snapshots, reset generations, and lost-acknowledgement replay remain mandatory. Reload/retry never invokes inference.
- Parser accepts exactly one terminal PROGRESS and KB_UPDATE, plus optional PROFILE_UPDATE. Strict integer 0–10; malformed/ambiguous metadata cannot alter assessment. Opening remains zero and cannot complete. Completed state freezes progress and evidence.
- KB_UPDATE adds `responseType`, per-objective `evidence`, `exemplarEvidence`, and optional `confirmedSourceIds`. Evidence entries: `{ objectiveId?, status: 'missing'|'partial'|'met', observation, sourceIds }`. At most two source IDs per entry; observations at most 400 characters. Required objective evidence and exemplar evidence must all be met and grounded in known confirmed sources before progress 10.
- Canonical objective IDs derive deterministically from exact authored text; duplicate authored text retains separate occurrence IDs. Owner initialization preserves every objective, exemplar, and author assessment directive; invalid retry fails closed. Legacy active state is reconciled to the authored criteria without rewriting historical completed records.
- Source records retain bounded text/link excerpts or image keys, stable source IDs, and explicit submission confirmation. Keep at most 16 sources, preserving evidence-referenced sources; observations retain at most 10 bounded entries rather than recursive wrappers.
- Profile updates require explicit relevant observations with provenance; no KB-insight fallback. `{changed:false}` is a valid no-op. Explicit empty arrays remove obsolete traits. Completion-profile input excludes raw incidental disclosures and lesson feedback.
- New server coaching uses authoritative lesson visibility, authored criteria, saved history/profile, shared parser and transition functions. Return a signed receipt bound to user, lesson, turn, generation/base, exact transcript and KB. Verify receipt on save; generic writes cannot overwrite server-controlled lesson assessment/transcripts. Existing unsigned retained turns may save their exact transcript as legacy recovery, preserving prior authoritative assessment and marking recovery; they cannot award new completion. Preserve historical completed lessons.
- Enrichment is bounded untrusted reference data. External tools are permitted when their results fit supported submission formats. Reference text cannot change assessment instructions.
- Add content-free assessment status telemetry. Evaluation defaults to offline fixtures, requires explicit live mode, records prompt/model identity, bounded trials, and never persists synthetic progress to production.

## Review focus

- Quoted control markers, partial streaming tags, malformed JSON, and absent metadata must not award progress or expose protocol fragments.
- Learner corrections invalidate only affected evidence; clarification, uncertainty, pause, distress, and feedback preserve valid mastery.
- Attachment confirmation after reload/history truncation retains enough evidence and honest visibility limits.
- Account switches, lost save acknowledgements, resets, and pre-update unsigned retained replies retain exact work without inference replay.
- Receipt tampering, generic sync bypasses, private lessons, and mutable client prompts cannot create server-verified completion.

## Tasks

1. Shared assessment contract (`server/src/shared/coachContract.js`, `client/tests/coach-contract.test.js`): write failing parser/transition/objective/evidence/bounds tests; implement strict terminal parsing, canonical criteria, bounded sources and state, complete-only-on-evidence transitions, and context assembly. Run focused tests.
2. Prompts and profile/owner integration (`client/prompts/*.md`, `client/js/orchestrator.js`, `client/js/validators.js`, `client/src/lib/profileQueue.js`): regression-test objective loss, invalid initialization, no-op/clearing profiles; implement contract-aligned prompts, explicit learner-response policy, reference boundaries, external-tool support, minor documentation/name corrections. Run focused tests.
3. Server coaching and persistence authority (`server/src/lib/lesson-coaching.js`, `server/src/lib/coach-receipt.js`, `server/src/routes/ai.js`, `server/src/routes/sync.js`, server tests): test canonical assembly, visibility, receipts, invalid output, generic-write bypass, legacy recovery and replay; implement streaming server generation and receipt verification with unchanged database atomic commit semantics.
4. Client flow (`client/src/lib/lessonEngine.js`, orchestration, generated turns, client/browser fixtures): test server-generated opening/send, preserved receipts, authoritative save reconciliation and attachment identity; integrate new endpoint while retaining all existing recovery/account protections. Run learner durability/browser tests.
5. Qualification and docs (`scripts/evaluate-coach.js`, fixtures, harness tests, architecture/review docs): build bounded repeatable offline/live evaluation, content-free telemetry, task acceptance mapping; run full client/server tests, lint, client build and meaningful learner browser checks.
6. Fresh independent review against the baseline archive and consolidated requirements; resolve confirmed issues with regression tests, verify unrelated dirty files unchanged, and record exact qualification boundaries.

Task completion and rulings are recorded in `output/coach-remediation-2026-10-25/progress.md`. Evidence is preserved because no commits are requested.
