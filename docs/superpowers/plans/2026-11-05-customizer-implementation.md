# Customizer implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this combined implementation pass. The user explicitly authorized all five steps and preservation of unrelated work; no further design or execution approval is pending.

**Goal:** Make Knowledge changes reviewable before saving, support conversation and direct text editing, and shorten the mobile branding workflow.

**Architecture:** Keep the existing React/Vite design system and authenticated APIs. Both Knowledge editing modes share a document draft and reviewed preview; saving never calls an extractor. Keep the existing conversation-write barrier and navigation guard. Scope responsive styles to the customizer/editor rather than modifying shared chat controls.

**Tech Stack:** JavaScript ES modules, React, existing UI primitives, node:test, Playwright, temporary SQLite fixtures.

**Spec:** Reviewed-preview saving, shared conversation/direct-text editing, state clarity, mobile adaptation, and polish, documented in [the implementation report](../../reviews/customizer-implementation-2026-11-05.md).

## Global constraints

- Preserve existing unrelated tracked and untracked work; recovery archive and file hashes precede edits.
- Save only the current reviewed document, including after a failed request; never generate content during save.
- Direct text edits do not require model access or a model readiness score. Conversation generation retains its 3/10 minimum, explained persistently.
- Preserve authentication, Markdown rendering safeguards, logo processing, branding boundaries, and pending conversation-write ordering.
- Run local synthetic browser validation without live model calls or deployment. Feature-branch publication is a separate authorized stage.

## Review focus

- Switching editing modes must preserve both unsaved text and conversational changes.
- A stale or unreviewed document cannot be published; save retry uses identical reviewed bytes without inference.
- Generation failure retains the existing document and text draft.
- Direct text entry must work with no conversation, no provider, and a low readiness estimate.
- Narrow and short viewports must keep controls reachable above navigation without trapping scrolling or keyboard focus.

## Tasks

### Task 1: Enforce reviewed Knowledge saves

Files: `client/src/lib/knowledgeBaseDraft.js`, `client/tests/knowledgeBaseDraft.test.js`, `client/src/pages/admin/KnowledgeBaseEditor.jsx`.

- [x] Replace the stale/missing-preview extraction test with rejection and zero-extraction assertions; add unreviewed-text state cases. Run and observe expected failures.
- [x] Enforce a current preview in the save helper and handler. Include the text draft in dirty/current state and retain the write barrier.
- [x] Run `node --test client/tests/knowledgeBaseDraft.test.js` and require zero failures.

### Task 2: Add text editing and clear Knowledge states

Files: `KnowledgeBaseEditor.jsx`, `AdminCustomizer.jsx`, `MarkdownPreviewPane.jsx`, scoped `customizer.css`, browser regression suite.

- [x] Add browser regressions for direct editing without inference, explicit review before save, stale-preview prevention, failed-save retry, and generation failure.
- [x] Add Conversation / Edit text modes sharing the draft. Explicit text review updates the preview. Conversation extraction uses the current text as its starting point.
- [x] Define readiness and the 3/10 generation minimum; add direct entry, opening retry, saved acknowledgement, and preview-preserving errors.
- [x] Run focused unit and customizer browser regressions.

### Task 3: Adapt and polish branding

Files: `AdminStyles.jsx`, scoped `customizer.css`, `AdminCustomizer.jsx`, customizer browser suite.

- [x] Move identity before colors/previews; add a phone preview selector while preserving desktop comparison.
- [x] Keep save feedback/actions available in the narrow main scroller and enlarge local touch controls; disable sticky behavior on short viewports.
- [x] Render and check desktop, intermediate, 390 px and 320 px, both themes, keyboard focus, long content and failed requests.

### Task 4: Complete verification and documentation

Files: `DESIGN.md`, a scoped implementation review note, this plan, critique snapshot status.

- [x] Run client/server tests, client/server lint, production build and relevant browser regressions; report environment skips explicitly.
- [x] Run the Impeccable detector once over completed changed UI targets, then inspect and dismiss only justified contextual findings.
- [x] Obtain a fresh-context final code review and resolve substantive findings; verify protected file hashes and inspect the scoped diff.
- [x] Update documentation, record evidence/limits, and close only the critique snapshot addressed by this pass.

## Execution ledger

- Pre-flight: Task 1's `draftMarkdown` input is consumed by Task 2; omission defaults to the preview for existing consumers. Task 3 uses only scoped CSS and keeps shared chat files protected.
- Initial implementation recovery: 16 existing dirty/untracked paths archived and verified; baseline covers 663 files. Verified recovery records are retained outside the repository.
- Initial implementation used scoped edits in the existing checkout without modifying unrelated shared chat code. Publication uses a separate worktree on current remote main and excludes the unrelated dirty work.

- Task 1 complete: the original code failed stale/missing-preview rejection and unreviewed-text protection; the revised 18-test rules suite passed.
- Task 2 complete: direct entry, text review, mode switching, exact retry after HTTP/malformed acknowledgements, stale-preview prevention, generation failure, and mixed editing are covered by browser regressions.
- Task 3 complete: 11 rendered configurations cover desktop/intermediate/narrow/short layouts, both themes, enlarged text and long content. The save areas were made compact and flush with navigation after visual inspection.
- Final review: independent fresh-context review found a development StrictMode startup regression. A Vite-browser test reproduced the failure, then passed after startup scheduling/cleanup was fixed. No deferred substantive issues.
- Verification: client 764/764; server 927 passed/3 skipped; browser 31/31; build and both linters exit 0 (17 client warnings); final detector empty; whitespace check passed.
- Documentation scope includes only Knowledge-specific architecture edits. The isolated branch retains upstream changes and excludes unrelated local hunks; the original checkout is preserved separately.

- Publication qualification: scoped candidate on remote main `6377a9d` passed 764 client tests, 927 server tests with 3 skips, all 31 Customizer browser regressions, lint/build, and 11 synthetic rendered configurations. No unrelated local changes were imported.
