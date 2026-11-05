# Lesson Publishing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current session. Steps use checkbox syntax for tracking.

**Goal:** Let admins publish reviewed lessons directly and find visibility controls in both the editor and lesson list.

**Architecture:** Reuse the versioned lesson save queue for final content and editor visibility updates. Reuse the sharing dialog with explicit pending/error feedback. The server's existing validated lesson write remains the publishing boundary.

**Tech Stack:** React, Base UI, Vite, JavaScript modules, node:test and existing Playwright browser fixtures.

**Spec:** [Approved design](../specs/2026-10-31-lesson-publishing-design.md)

## Global Constraints

- Private is the default; public means all learners in the classroom.
- Save the exact reviewed preview; retry the same operation without inference.
- Preserve shares, version conflicts, account-scoped recovery and existing validation.
- No new dependencies, database changes or production actions.

## Review Focus

- Lost acknowledgement plus reload retains the public choice and does not generate content again.
- Visibility-only changes advance the editor's version without losing an unsaved preview.
- A rejected publishing request can be corrected; an unknown outcome remains retryable.
- Double activation cannot enqueue a second or different publishing operation.
- Public/private controls remain usable by keyboard and at 320px in both themes.

### Task 1: Integrated publishing and reliable visibility updates

**Files:** Modify `client/src/pages/admin/LessonEditor.jsx`, `client/src/pages/admin/AdminLessons.jsx`, `client/src/components/modals/ShareLessonModal.jsx`, and `client/src/lib/lessonSaveQueue.js`. Test in `client/tests/browser/lesson-publishing.test.js` and `client/tests/lessonSaveQueue.test.js`.

**Interfaces:** Editor accepts initial visibility/shares, records pending final visibility in its recovery snapshot, and reports confirmed final status through `onSave({ status })`. Dialog awaits `onConfirm({ status, sharedWith })` and displays pending/errors. Queue continues to own all editor writes.

- [x] Add browser regressions for reviewed private/public creation, editor publishing and sharing, recovery, validation, conflicts, keyboard use and narrow layouts. Add a queue regression for discarding a confirmed rejected visibility write while preserving unknown outcomes.
- [x] Run the new tests against the old UI and observe the missing controls/rejected-write recovery failures.
- [x] Implement atomic final publishing, confirmed visibility feedback, and interactive list status using existing components.
- [x] Run the targeted queue and browser tests and inspect rendered desktop/mobile captures.

### Task 2: Documentation and final validation

**Files:** Update `docs/ARCHITECTURE.md`, add the browser command to `client/package.json`, and record validation in `docs/reviews/lesson-publishing-2026-10-31/README.md`.

**Interfaces:** Uses the final behavior and browser command from Task 1.

- [x] Document the authoring choices, list/editor visibility controls and recovery contract.
- [x] Run `npm test`, `npm run lint`, `npm run build:client`, the new publishing browser suite and existing sharing browser regression. Expected: pass, with any optional integration skips explicitly recorded.
- [x] Run the Impeccable detector on changed UI files and review the full diff, including the five Review Focus conditions.
- [x] Record local changes, validation, screenshots, and the absence of a production release in the review evidence below.

Validation and review: [local evidence](../../reviews/lesson-publishing-2026-10-31/README.md).
