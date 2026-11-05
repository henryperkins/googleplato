# Coach Conversation Continuity Implementation Plan

**Goal:** Resume older coaching conversations with the same assignment and safely repair the reported target drift.
**Architecture:** Add a small pure conversation-context module, store source-backed task anchors beside assessment state, retain legacy history as untrusted reference data, and expose an optimistic, admin-only continuity repair using the existing atomic lesson commit boundary.
**Tech Stack:** Node.js 20+, JavaScript ES modules, Hono, node:test, existing SQLite/PostgreSQL/DynamoDB adapters.
**Spec:** docs/superpowers/specs/2026-11-05-coach-conversation-continuity.md

## Global Constraints
- No new dependency or database schema; Node.js 20+, ES modules, single quotes, two spaces, semicolons.
- Preserve score/evidence/completed state, authentication, receipts, optimistic concurrency and inference-free save/replay.
- Work only in the isolated branch; preserve the primary checkout.
- Release requires passing checks and an approving review; production repair requires a verified recovery copy and unchanged expected state.

## Review Focus
- Legacy assistant text containing control tags or invented evidence must remain context only.
- Long histories and assessment-criteria edits must preserve task anchors.
- A learner link without an explicit task-change request must not silently select another target.
- Concurrent replies, completed lessons and stale recovery receipts must not undo a repair.
- Ambiguous or missing source messages must fail closed or prompt clarification without fabricated learner work.

### Task 1: Retain conversation context and source-backed task state
**Files:** create server/src/shared/coachConversation.js and server/tests/lib/coach-conversation.test.js; modify server/src/lib/lesson-coaching.js, server/src/shared/coachContext.js, server/src/shared/coachProtocol.js, client/prompts/coach.md, server/src/lib/coach-assessment.js, server/tests/routes/coach.test.js.
**Interfaces:** buildCoachHistory(messages) returns bounded provider messages; reconcileConversationState(previous,messages) returns versioned assignment and learnerDirections anchors; applyConversationTurn(state,messages,taskChangeSourceId) retains current reply and an optional exact learner direction. Context includes `conversationState`; optional KB_UPDATE `taskChangeSourceId` refers only to the current learner text source.
- [x] Write route regression: the legacy Berkshire opening is present as unverified context when the current learner says `It looks like css is ignored`; no progress or objective evidence is awarded from the opening.
- [x] Run focused tests; Expected: regression fails because opening is missing.
- [x] Add pure state/history tests for bounds, mixed history, old control tags, history truncation, rubric reset, valid/invalid task-change sources and retained exact learner directions.
- [x] Implement context/state preservation and optional task-change reference; update prompt for continuity, self-correction, diagnostic uncertainty and truthful target selection.
- [x] Run focused tests; Expected: all pass, including old false-completion protection adapted to context/evidence separation.
- [x] Commit the context behavior with its tests.

### Task 2: Repair one affected conversation without replay regression
**Files:** create server/src/lib/coach-continuity-repair.js and server/tests/routes/coach-continuity-repair.test.js; modify server/src/routes/admin.js and server/src/lib/lesson-coaching.js; add recovery regressions in server/tests/routes/coach.test.js.
**Interfaces:** repairCoachContinuity(userId,lessonId,input) consumes exact base snapshot, assignmentMessageId, learnerMessageId, misleadingInsights; returns the atomically saved state. Admin POST /v1/admin/users/:userId/lessons/:lessonId/continuity-repair calls it and audit-logs the action. recoverCoachTurn returns only a pending or exactly saved current result.
- [x] Write failing tests for admin authorization, exact-state CAS, preserved transcript/progress/evidence, named insight removal, actual learner observation, missing IDs/completed state rejection and stale recovery.
- [x] Run focused tests; Expected: repair route missing and stale recovery returned.
- [x] Implement bounded repair and current-state recovery checks using commitLessonTurn; no model calls or new transcript messages.
- [x] Run tests, including old receipt replay after repair and in-flight conflict; Expected: corrected state survives and stale writes fail or acknowledge current state.
- [x] Commit repair behavior with tests.

### Task 3: Qualify, review, release and repair the reported thread
**Files:** scripts/evaluate-coach.js, scripts/coach-fixtures.js, client/tests/coach-evaluation.test.js, docs/ARCHITECTURE.md, docs/reviews/coach-conversation-continuity-2026-11-05.md.
**Interfaces:** evaluator uses the same conversation history/state assembly and records continuity assertions plus separate editorial review; live requests use the existing authenticated API and an explicit call budget.
- [x] Add evaluation regressions for legacy resume, already-drifted conversation correction, long history and explicit target change; prove expected failures against mismatching replies.
- [x] Run full client/server tests, lint, client build and offline evaluation. Expected: passing checks, accurately report any unrelated warnings/skips.
- [x] Run a small synthetic live evaluation with at most 8 initial/recovery calls; inspect replies for continuity, clarifying questions and absence of invented CSS diagnosis. Expected: no state changes to real lessons.
- [x] Update architecture/review evidence, open a Draft PR, and obtain a fresh whole-branch review using the executing-plans review instructions. Fix material findings with regressions.
- [ ] Publish reviewed branch, satisfy repository review/check gates, merge and observe the existing Cloud Build release. Expected: serving commit matches the merge and deployment checks pass.
- [ ] Back up the exact affected lesson snapshot, perform the admin continuity repair with source IDs, verify unchanged transcript/assessment and neutral notes; verify reload/recovery. Review future-start lesson guidance without altering the ongoing assignment.
- [ ] Verify primary checkout preservation and report exact tests, review, release and repair evidence.
