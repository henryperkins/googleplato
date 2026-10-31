# Lesson Mobile Refinement Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in the current session. Steps use checkbox syntax for tracking.

**Goal:** Complete the four approved critique improvements while preserving the existing publishing and recovery behavior.

**Architecture:** Keep one editor state and one save-action group after the preview. Reuse the parent lesson-list state for a mobile row presentation and shared visibility control. Use native details/summary for filters, metrics and readiness help, and the existing dropdown for lesson actions. Responsive navigation retains its routes and named links.

**Tech Stack:** React, Vite, existing CSS/container queries, native HTML disclosures, current UI primitives, node:test and Playwright.

**Spec:** [Approved design](../specs/2026-10-31-lesson-mobile-refinement-design.md)

## Global Constraints

- Preserve private default, exact-preview save, shares, operation IDs and version conflicts.
- Preserve readiness thresholds and server validation; readiness is not publication approval.
- No dependencies, database changes, model calls, commits, pushes or deployment.
- Preserve previous uncommitted work using the verified recovery snapshot.

## Review Focus

- Long mobile previews use normal page flow and expose both save choices together after review.
- Two-row navigation remains labelled, keyboard reachable and unclipped at 320px and 200% text.
- Mobile filters retain active selections and the same pagination/data as the desktop list.
- Long titles and empty/error states keep visibility and named actions usable without horizontal discovery.
- Existing save rejection, lost acknowledgement, reload and private/public transitions continue to pass.

### Task 1: Review-adjacent actions and readiness guidance

**Files:** `client/src/pages/admin/LessonEditor.jsx`, `MarkdownPreviewPane.jsx`, `client/src/index.css`; regressions in `client/tests/browser/lesson-publishing.test.js`.

**Interfaces:** Existing handlers/queue remain unchanged. A single `role="group"` named `Save lesson` follows the preview. Readiness help describes the existing value and 3/10 gate.

- [x] Add and run failing browser regressions for short/long review finishing, readiness help and unchanged readiness gating.
- [x] Move the save group after the preview, isolate Start over with the conversation and add concise readiness guidance.
- [x] Verify the new regressions and existing publication/recovery scenarios.

### Task 2: Mobile lesson management

**Files:** `AdminLessons.jsx`, new `MobileLessonRow.jsx`, existing dropdown primitives; browser regressions in `lesson-publishing.test.js`.

**Interfaces:** Mobile rows consume the same lesson/page/stat data and existing edit/delete/share callbacks. A shared visibility button supplies identical access actions in both list presentations. Filters remain parent controlled.

- [x] Add and observe failing tests for a readable mobile row, named actions, metrics and filter disclosure.
- [x] Implement rows and disclosures while retaining the desktop table and shared dialog ownership.
- [x] Verify keyboard actions, empty results, long titles and desktop rendering.

### Task 3: Navigation, polish and qualification

**Files:** `AdminLayout.jsx`, `client/src/index.css`, `client/tests/browser/admin-responsive.test.js`, `DESIGN.md`, `docs/ARCHITECTURE.md`, review evidence.

**Interfaces:** Existing six labelled routes and route-focus behavior remain stable; only their narrow visual arrangement changes.

- [x] Update and run failing navigation regressions for visible labels/two rows at narrow widths and enlarged text.
- [x] Implement the labelled layout, document the four changes and inspect representative rendered states.
- [x] Run `npm test`, `npm run lint`, `npm run build:client`, publishing browser tests and the existing responsive admin suite. Record optional skips separately.
- [x] Obtain the required final independent code review, resolve material findings with regression coverage, verify protected files, and close the exact critique snapshot after all four priorities are covered.

Evidence: [local verification](../../reviews/lesson-mobile-refinement-2026-10-31/README.md).
