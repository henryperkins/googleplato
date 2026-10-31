# Lesson authoring workspace — review handoff

Authors can refine a lesson beside its preview on desktop, or switch between
Refine and Preview on mobile. The editor distinguishes a confirmed conversation
save from current preview content and a finalized lesson. A stale public preview
keeps its saved content visible, exposes Refresh preview as a separate action,
and disables Update lesson until a current preview is ready.

Both responsive panels remain mounted. Composer drafts, pending AI requests and
save recovery survive tab switches. Final saving uses the exact reviewed markdown
through the existing versioned save queue; retries preserve the operation and
visibility choice without invoking AI again.

## Independent technical review

A separate read-only code reviewer inspected the implementation against base
`6373b1068648051f0cad8e753549b66771facedd`, including save/recovery behavior,
responsive focus, shared markdown previews, and hidden-chat scrolling.

The review found one Important/P2 issue: widening the editor could hide and blur
a focused mobile control before ResizeObserver read `document.activeElement`.
Focus then fell to the page body. The earlier resize test focused controls that
remained visible and did not catch this case.

The correction retains the last focused control when CSS hides it and moves focus
to visible content after the responsive state commits. Ordinary blur clears the
remembered control. Focused readiness guidance stays expanded when narrowing.

The new browser regression reproduced the failure before the correction and
passed afterward in Chromium and WebKit. It covers both tabs, the readiness
summary, View preview, and readiness guidance when narrowing. The reviewer also
independently verified that widening preserves focus outside the editor and does
not restore a deliberately abandoned control. Nested readiness disclosures still
work; the probes emitted no page errors.

Final review disposition: **the P2 is resolved; no remaining Critical, Important
or Minor findings identified in the reviewed scope.** The reviewer also ran 74
focused queue, extraction, scrolling-decision and knowledge-base tests with no
failures. This is technical review evidence, not a submitted GitHub approval.

After the owner approved release, the PR was marked ready for the additional
automated reviews. CodeRabbit found a minor wording mismatch in the stale private
preview hint; it now says Refresh when content exists and Generate when it does
not. A separate speaker-label concern was checked against the accessibility tree
and learner call sites: the visible authoring label remains accessible, and
learner messages retain their existing hidden speaker prefix. That thread was
resolved with the verification evidence.

Sourcery subsequently identified a valid hidden-to-visible scroll regression:
returning to a long Refine conversation could reuse its old pinned position and
scroll the selected tab out of view. The new regression reproduced a 1,217px
jump. The correction recomputes visibility and the current pin state before any
mutation, resize or scheduled frame can follow the revealed log. It preserves
explicit following for a new submitted message. The independent reviewer passed
the regression in Chromium and WebKit, both with and without a pending assistant
reply completing after return, plus all 39 scrolling-decision unit tests.

## Validation

Fresh checks after the focus correction:

| Check | Result |
| --- | --- |
| `npm test` | 708 client tests passed; 889 server tests passed; 3 optional PostgreSQL-dependent tests skipped. |
| `npm run lint` | Passed; no errors, 19 client warnings. |
| `npm run build:client` | Passed; bundle-size advisory remains. |
| Chromium authoring/publishing browser suite | 26 passed, 0 failed. |
| WebKit authoring/publishing browser suite | 26 passed, 0 failed. |
| Learner recovery browser suite after the shared scroll correction | 19 passed, 0 failed. |
| Responsive focus regression | Failed on the earlier implementation, then passed in Chromium and WebKit after correction. |
| `git diff --check` | Passed. |

The existing admin responsive browser suite passed all 24 tests during the
implementation and is rerun by the Cloud Build release gate. The subsequent
shared scrolling correction also passed the full learner browser suite and both
authoring browser suites.

All browser records are synthetic fixtures backed by disposable local services.
The browser suite also saves and reads the reviewed lesson and public visibility
through the real local API and SQLite. It covers public/private transitions,
lost responses, version conflicts, exact-preview saves, readiness thresholds,
long mobile previews, enlarged text, background extraction and hidden replies.
Optional PostgreSQL integration and Firestore emulator suites were not enabled.

## Portable screenshots

| View | Evidence |
| --- | --- |
| Desktop create and review | [Light](screenshots/create-desktop-light.png) |
| Desktop public lesson needs refresh | [Light](screenshots/edit-stale-desktop-light.png) |
| Mobile Refine | [Light](screenshots/refine-mobile-light.png) |
| Mobile Preview and save choices | [Light](screenshots/review-mobile-light.png), [WebKit dark](screenshots/review-mobile-dark.png) |
| Mobile public lesson needs refresh | [WebKit dark](screenshots/edit-stale-mobile-dark.png) |
| Narrow failed refresh | [Dark](screenshots/refresh-failed-narrow-dark.png) |
| Enlarged text | [Review](screenshots/review-enlarged-text.png) |
| Intermediate visual comparisons | [Desktop width](screenshots/before-desktop-width.png), [mobile spacing](screenshots/before-mobile-spacing.png) |

The [design QA report](../../../design-qa.md) records the source concepts,
comparison history, intentional product constraints and final visual result.
The [architecture documentation](../../ARCHITECTURE.md#lesson-editor) describes
the resulting authoring behavior.

## Remaining review and release work

- Obtain the repository's required approving PR review and passing checks before
  merging.
- Perform a short physical-phone check of keyboard-open tab switching, unfinished
  composer preservation, and reaching both save choices after a long preview.
- Physical-device and spoken-screen-reader behavior, live AI/provider access and
  production Cloud SQL behavior remain unqualified by the local evidence.

This handoff began with a feature-branch Draft PR. The owner approved completing
review, merging and releasing through Cloud Build on 2026-10-31. Local checks and
review corrections are recorded here; final build and serving identity are
recorded on PR #34 and in the operator’s release evidence directory. The owner’s
approval is recorded in the Codex conversation, rather than a submitted GitHub
approval review.
