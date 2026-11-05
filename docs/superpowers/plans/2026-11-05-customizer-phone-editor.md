# Customizer Phone Editor Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this focused task; one fresh review after validation.

**Goal:** Make knowledge editing usable on small phones and make its two authoring methods explicit.
**Architecture:** Preserve the existing state and save flow. Scope layout changes to the knowledge editor and adjust viewer labels; expose detailed help through native disclosure and focus the existing editor on return.
**Tech Stack:** React, Vite, existing Base UI primitives, CSS, node:test and Playwright.
**Spec:** `docs/superpowers/specs/2026-11-05-customizer-phone-editor-design.md`

## Global constraints
- Preserve all pre-existing dirty files and work from a verified snapshot in an isolated managed worktree.
- Keep review and save separate, preserve exact reviewed bytes and leave guards, and make no live AI/backend calls.
- Keep existing desktop layout and the assistant-first action hierarchy.
- The initial implementation excluded commits, pushes and deployments. The user subsequently authorized commit/push and synchronization of local `main`; deployment operations remain outside this task.

## Review focus
- Phone entry must show at least 160 px of the text field above navigation.
- Review-to-edit return must restore focus and retain text; subsequent edits must disable saving until reviewed.
- Native help must remain keyboard accessible and fit at enlarged text sizes.
- Clean, dirty, saving and failed-save states must keep required actions reachable.
- Both direct text and assistant paths must retain existing persistence semantics.

## Task 1: Adapt and clarify the existing editor
Files: AdminCustomizer.jsx, KnowledgeBaseEditor.jsx, customizer.css, customizer.test.js, DESIGN.md.
- [x] Add meaningful browser regressions for initial phone writing space and the review-to-edit loop; observe expected failures.
- [x] Apply the approved compact layout, help disclosure, explicit labels and focus return. Update affected browser selectors.
- [x] Run targeted regressions, then the Customizer suite, client checks, desktop/phone screenshots and Impeccable detector.
- [x] Request a fresh review of the incremental diff. Resolve substantive findings.
- [x] Apply only the tested incremental changes back to the primary checkout after verifying baseline hashes; preserve all unrelated work.

Execution decision: implement inline to keep this small, shared-component change coherent. The user's command authorizes the already-described plan; no repeated approval gate is needed.


## Execution record

- Preserved the existing dirty checkout in a hash-verified recovery archive and overlaid its tracked changes into an isolated managed worktree. The review and integration base is this snapshot, not HEAD.
- Observed the phone writing-space regressions fail at 92 px (390 x 844) and 0 px (320 x 740), then pass at 325 px and 221 px after adaptation.
- Verified 200% text wrapping, keyboard disclosure and review-to-edit focus/scroll. The original return alignment and narrow enlarged-text layout were reproduced before fixing them.
- Final review found one Important issue: the unchanged-state footer predicate excluded untouched new documents. The added empty-entry assertion failed at 120 px on the 320 px phone. Changed only the layout predicate to `!editor.dirty && !isBusy && !error`; the new and saved document regressions now pass. No other Critical, Important or Minor findings; no declined judgments.
- Final validation: 710/710 client tests, 33/33 full Chromium Customizer checks, 5/5 targeted WebKit checks, visual QA on desktop and both phones plus 200% text and short landscape. Client lint has 0 errors and 17 existing warnings in other files; build passes with its existing chunk-size warning. Impeccable markup detector returned no findings.
- Evidence: `output/playwright/customizer-adapt-clarify-2026-11-05/`. Tests used temporary local SQLite and isolated sample data with stubbed AI. Browser emulation is not physical-device, virtual-keyboard or screen-reader proof.
- Integrated the seven scoped files back into the primary checkout with a checked incremental patch. Verified every integrated file matches the tested worktree and all 24 unrelated pre-existing files retain their original hashes. No commits, pushes or deployment actions were performed.
- Subsequent authorized publication integrates the adaptation, clarification and polish onto remote main `496e09f`, preserving its newer layout fixes and browser tests. Fresh checks passed: 774 client tests, 936 server tests with 3 skips, 35 Chromium Customizer tests, 7 targeted WebKit tests, build, lint with 0 errors/17 existing warnings, and rendered desktop/tablet/phone checks. See the [publication qualification and screenshots](../../reviews/customizer-polish-2026-11-05.md#publication-qualification).
