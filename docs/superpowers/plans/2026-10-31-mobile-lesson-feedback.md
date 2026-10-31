# Mobile Lesson Feedback Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution. Steps use checkbox syntax for tracking.

**Goal:** Resolve all three confirmed mobile findings while preserving publishing and chat behavior.

**Architecture:** Reuse the preview header's refresh control, keep final actions after review, reveal errors while the activation context remains current, and give the shared scrolling hook an authoring-only initial-pin option.

**Tech Stack:** React, existing CSS and UI primitives, node:test and installed Playwright Chromium/WebKit.

**Spec:** [Approved scope](../specs/2026-10-31-mobile-lesson-feedback-design.md).

## Global Constraints

- Preserve exact-preview saves, readiness, visibility, versioned operations and recovery.
- Preserve learner and shared knowledge-base behavior.
- No dependencies, backend changes, model calls or production writes.
- The owner authorized committing, pushing and then merging the feature branch into main after validation; the existing automatic release follows main.
- Keep the primary checkout and other worktrees intact.

## Review Focus

- Short phones and long previews must expose the refresh failure without losing keyboard focus.
- Background failures must not move focus or scroll in Refine.
- Existing empty-preview generation and pending final-save recovery must remain clear and unique.
- New author messages must still resume following after entry pinning is disabled.
- Tab return, responsive focus transfer and learner-chat pinning must remain unchanged.

### Task 1: Refresh access and visible failure feedback

**Files:** `client/src/pages/admin/LessonEditor.jsx`, `MarkdownPreviewPane.jsx`, `client/tests/browser/lesson-publishing.test.js`.

**Interfaces:** Header `onRefresh` is available with existing content; empty previews retain Generate preview. Error descriptions and conditional scrolling retain the initiator's focus and respect panel visibility.

- [x] Add regressions for long stale preview refresh access, long-content failed refresh visibility/focus at 320/390px, and a failed background refresh.
- [x] Run those regressions against the baseline build and verify failures match the findings.
- [x] Implement the smallest UI changes and rerun the targeted regressions.
- [x] Run the full publishing suite in Chromium and WebKit.

### Task 2: Authoring entry position and shared scrolling qualification

**Files:** `client/src/components/chat/ChatArea.jsx`, `client/src/hooks/useStickToBottom.js`, `LessonEditor.jsx`, browser tests and `docs/ARCHITECTURE.md`.

**Interfaces:** `ChatArea` and `useStickToBottom` accept `scrollOnMount` with a default of true. Lesson authoring passes false. New user turns retain explicit following.

- [x] Add an entry regression for title/status/tab visibility at 320/390/430px and a submission-following assertion; update the return-tab setup to scroll explicitly.
- [x] Observe the entry regression fail, implement the option, then verify it passes.
- [x] Update architecture documentation and run client/server suites, lint, build, publishing in both engines, learner and admin browser suites.
- [x] Review the rendered mobile states and run the scoped design detector.
- [x] Obtain independent review, resolve material findings with regression evidence, and verify the primary checkout is unchanged.
