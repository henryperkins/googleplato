# Task 6 report

Implemented NOTE-1, NOTIFY-1, A11Y-1 and A11Y-2 in the isolated `fix/pr43-notifications` worktree, based on `64b45d8`.

- Settings captures `submittedAt` before `addLearnerNote` and conditionally clears only that identity. The existing expected-text clear and account checks remain.
- Compose mirrors its fingerprint from an effect. An earlier successful POST acknowledges the named message and refreshes History in place while retaining a newer draft and field focus. Success always rotates the request ID. Send remains focusable while disabled.
- The lesson editor uses one exported pure recovery cascade for its description and attempted-send status. Conflict, rejected final saves, retryable saves and rejected recovered visibility choices identify the actual available action.
- Architecture documentation covers all three contracts. TemplateEditor's discard-on-save remains the specified follow-up.

## RED evidence

Scratch Git worktree `/home/ubuntu/.codex/worktrees/pr43-notifications-red/googleplato` is detached at original PR head `6d02058`. Tests copied in; production source unchanged. Shared installed modules are symlinked; no npm ci performed. Built that worktree's own client first.

Commands from the scratch root:

```
npm --prefix client run build
PLATO_REQUIRE_RC232=1 node --test --test-name-pattern='late first mounted note' client/tests/browser/learner-recovery.test.js
PLATO_REQUIRE_RC232=1 node --test --test-name-pattern='keeps a newer draft' client/tests/browser/notification-audience.test.js
PLATO_REQUIRE_RC232=1 node --test --test-name-pattern='explains composer recovery' client/tests/browser/lesson-publishing.test.js
```

The original code clears T2's `noteAt` to null when the first mount finishes. Compose clears the newer draft and selects History (the retained-draft notice never appears). All four lesson-editor cases select the wrong description: saving instead of conflict/retry/rechoose, and retry lesson instead of revise. Logs: `/tmp/task6-notes-red-final.log`, `/tmp/task6-compose-red.log`, `/tmp/task6-publishing-red.log`. The new pure-helper import is absent on the original code; its cases are additionally covered by the behavioral browser RED results.

## GREEN evidence

Commands from this worktree root, except ESLint from `client/`:

```
node --test client/tests/lesson-editor-hints.test.js client/tests/settings-drafts.test.js
npm --prefix client run build
PLATO_REQUIRE_RC232=1 node --test client/tests/browser/notification-audience.test.js
PLATO_REQUIRE_RC232=1 node --test --test-name-pattern='explains composer recovery' client/tests/browser/lesson-publishing.test.js
PLATO_REQUIRE_RC232=1 node --test --test-name-pattern='late first mounted note|saves notes independently|a note saved just before' client/tests/browser/learner-recovery.test.js
./node_modules/.bin/eslint src/pages/Settings.jsx src/pages/admin/AdminNotifications.jsx src/pages/admin/LessonEditor.jsx src/lib/lessonEditorHints.js tests/lesson-editor-hints.test.js tests/settings-drafts.test.js tests/browser/notification-audience.test.js tests/browser/lesson-publishing.test.js tests/browser/learner-recovery.test.js
```

Results: 22 unit cases, 5 Compose browser cases, 4 publishing browser cases and 4 learner browser cases pass. Build passes. Client-local ESLint exits 0, with one existing `set-state-in-effect` warning at LessonEditor:243 and zero errors. A root-local ESLint invocation found an incompatible installed ESLint 10; rerunning with the package's ESLint 9 is the valid result. Logs are `/tmp/task6-unit-green.log`, `/tmp/task6-green-build.log`, `/tmp/task6-compose-green.log`, `/tmp/task6-publishing-green.log`, `/tmp/task6-notes-green-final.log`, `/tmp/task6-lint.log`.

## Rulings and limits

- Browser plugin is not available. Existing Playwright harnesses exercise actual App + real SQLite for learner notes and publishing; notification audience exercises the actual Notifications page/components with synthetic auth/HTTP. Promise gates control the overlapping requests; no sleeps determine interleaving.
- In the ordinary-reload learner case, the outgoing document's aborted optional rewrite can finish its own durable-note cleanup. The test proves the stored T2 remains exactly once with no extra cap eviction. A second Chromium case crashes the old renderer and restores the browser's captured auth and actual session storage into a new renderer, modelling crash/session restoration without outgoing cleanup; it then resubmits the exact retained T2 identity and proves the ten stored notes are unchanged. This is explicitly crash/session-restoration evidence, not an ordinary-reload resubmission claim. Both start with nine notes and use in-app navigation between mounts, preserving the auth generation.
- Chromium's crashed target cannot be reused by Playwright; the new renderer receives the actual captured storage snapshot. WebKit runs the ordinary-reload case only.
- The notification test checks the exact original payload, retained second subject/body, selected Compose tab, focused message field, focusable disabled Send and a new request ID for the retained draft's send.
- Publishing fixtures independently exercise visibility 409, visibility network failure, final-save 400, and recovered visibility 400. Both `aria-describedby` content and composer status are asserted after Control+Enter. The final-save case opens Preview at 320px; the viewed screenshot is `docs/reviews/assets/pr43-remediation/task6-preview-320.png`.
- Browser emulation is not physical-device or assistive-technology evidence. No full npm test/browser matrix, push, merge or deployment performed here.
