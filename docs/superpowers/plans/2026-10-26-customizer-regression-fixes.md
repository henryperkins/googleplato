# Customizer Regression Fixes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks in this session. Preserve the dirty checkout and do not commit or publish.

**Goal:** Fix the three issues reproduced in the 2026-10-26 review.

**Architecture:** A shared barrier tracks draft requests already in flight so publication waits for them to settle. The lesson parser recognizes section headings only outside fenced code. The Customizer displays acknowledged content and navigates once, then refreshes metadata in the background with the existing resource cancellation mechanism.

**Tech Stack:** React, Vite, JavaScript ES modules, node:test, Playwright, SQLite API.

**Spec:** The user's instruction to fix the three identified issues and the reproductions in `/tmp/googleplato-regression-review/evidence/`.

## Global Constraints

- Preserve existing unrelated tracked and untracked work; compare with the recovery manifest.
- Keep the reviewed Markdown verbatim and the existing authentication/storage contracts.
- Use deterministic AI fixtures and temporary databases for browser checks.
- Do not commit, push, merge, deploy, or call live models.

## Review Focus

- Several outstanding draft writes, including a rejected one: publication waits for every settled result.
- A draft started while waiting: include it before publishing.
- Backtick and tilde fences, longer fences, and unclosed fences: inner headings remain content.
- A slow post-save refresh: show acknowledged content and allow navigation without a late redirect.
- A failed background refresh: retain the acknowledged content; reopening an editor cancels stale resource results.

## Tasks

### 1. Make lesson section parsing respect fences

- [x] Add regressions to `server/tests/lib/lesson-markdown.test.js` for the exact Description collision and supported fence variants; observe failure.
- [x] Update `server/src/shared/lessonMarkdown.js` to track fence marker/length and preserve fenced bodies.
- [x] Run parser and learner-outline tests; require zero failures.

### 2. Make Knowledge Base publication follow pending drafts

- [x] Add the delayed-autosave browser regression and observe the current premature publication.
- [x] Add a tested `createKnowledgeBaseWriteBarrier()` to `client/src/lib/knowledgeBaseDraft.js`; track already-started writes and wait for all pending results, including writes added during a wait.
- [x] Use one shared barrier in `KnowledgeBaseEditor.jsx` to track draft PUTs and wait before the publication PUT. A draft failure must not prevent a complete explicit save.
- [x] Verify saved Markdown, published flags, clean reopening, and the navigation guard while waiting.

### 3. Decouple acknowledged saves from refresh/navigation

- [x] Add a held post-save GET regression and observe the existing delayed navigation.
- [x] Extend `useResource` in `AdminCustomizer.jsx` with background refresh of acknowledged data and fallback on failure. Navigate synchronously after acknowledged publication; a GET completion never navigates.
- [x] Check held and failed refreshes in the browser, including staying on Styles after release.

## Completion

- [x] Run focused client/server regressions, both browser engines for the affected flows, lint, and a fresh client build.
- [x] Obtain a fresh independent review of this task's diff.
- [x] Update the remediation report with exact verification scope and limitations; verify unrelated files against the starting manifest.

## Execution Decisions

- Work in place with a verified recovery snapshot because the required remediation is already uncommitted alongside unrelated work; an isolated checkout would omit that source state.
- Implement these already-authorized fixes directly; no additional design approval or release action is required.

Final result: all three fixes complete; 653 client and 771 server tests passed (2 PostgreSQL-dependent skips), 17 Customizer browser tests passed in each engine, lint/build/diff checks passed, independent review findings resolved.
