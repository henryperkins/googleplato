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

## Validation

Fresh checks after the focus correction:

| Check | Result |
| --- | --- |
| `npm test` | 708 client tests passed; 889 server tests passed; 3 optional PostgreSQL-dependent tests skipped. |
| `npm run lint` | Passed; no errors, 19 client warnings. |
| `npm run build:client` | Passed; bundle-size advisory remains. |
| Chromium authoring/publishing browser suite | 25 passed, 0 failed. |
| WebKit authoring/publishing browser suite | 25 passed, 0 failed. |
| Responsive focus regression | Failed on the earlier implementation, then passed in Chromium and WebKit after correction. |
| `git diff --check` | Passed. |

The existing admin responsive browser suite passed all 24 tests during the
implementation. That valid evidence is retained: the review correction changes
only lesson-editor focus and its browser regression, and does not affect the
other admin pages exercised by that suite.

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

This handoff accompanies a feature-branch Draft PR. It records local qualification
and technical review; production publication requires the separate merge and
release steps.
