# Learner mobile audit remediation — 2026-10-25

**Closeout 2026-10-27:** The learner-recovery and account-owned draft changes were committed as `172c60b` and integrated into `main` through merge `e1ebc66`. The measurements and test totals below apply to the recorded B-2 build. Physical iOS/Android checks remain unrun; the archived device handoff and continuation ledger preserve their prerequisites.

**Evidence archive:** Historical raw captures, logs, and run records are retained privately in archive `googleplato-untracked-curation-20261027T055535Z` (`evidence-1730.tar.gz`). Paths beginning `output/` or `.mobile-ux/` below identify archive members.

## 1. Verdict

**Verification ceiling: mechanism tests and desktop Chromium 149 / Playwright WebKit 26.6 with mobile viewport/touch emulation.** All three findings are implemented and their affected browser regressions pass. Physical iOS/Android readiness remains unverified. The largest remaining qualification gap is native interruption/recovery and keyboard/assistive-technology behavior on actual phones.

User authorization: “Address all findings comprehensively.” Mode changed from audit only to audit and fix. Baseline findings and reproduction evidence remain in the original audit (archive member `.mobile-ux/runs/20261025T131629Z-4966cb65/audit.md`). No commit, push, deployment, production write or live model call was performed by this task.

Build B-2 is the workspace based on `32f57481e629cddb833b50e1940d63d54e24da75` plus these changes. Independent admin AI work merged while remediation was in progress; it was preserved and predates the final build. **All 50 tested build artifacts match an independent rebuild of the final combined source.** See build identity (archive member `output/playwright/mobile-ux-remediation-2026-10-25/build-identity.json`), source manifest (archive member `output/playwright/mobile-ux-remediation-2026-10-25/source-manifest.json`) and artifact manifest (archive member `output/playwright/mobile-ux-remediation-2026-10-25/build-manifest.json`).

## 2. Coverage and substitutions

S-FIX-LOCAL uses the real application bundle and repository authentication, profile, sync and content routes against a temporary SQLite database. Two synthetic password accounts, 14 lessons and optional profile fields exercise the learner flow. Coach and link extraction return deterministic fixture content. Browser requests outside the local test origin are blocked. Per-case controls hold/reject coach responses, drop acknowledgements only after real SQLite commits, and throw or silently ignore selected browser-storage writes. These substitutions establish application handling and local persistence; they do not establish real provider behavior, Google sign-in, production Cloud SQL, live URL fetching or phone behavior.

The initial audit's complete ten-area coverage remains scoped to B-1. B-2 rechecks all affected journeys and useful regressions, without representing untouched areas as a fresh full audit.

| Area | Disposition | Environments / ceiling | Evidence and remaining work |
| --- | --- | --- | --- |
| Reach and placement | No defect found in checked scenarios | B-1 source/emulation; B-2 recovery control rendering, proxy | Native reach and touch: C-FIX-DEVICE-05/06 |
| Viewport and safe areas | Defects found; F-03 implemented | B-2 Chromium/WebKit, proxy | 20 layout states across engines; native chrome/keyboard/safe areas remain |
| Touch targets | No defect found in checked scenarios | B-1 direct hit testing; B-2 standard buttons, proxy | Native hit/gesture behavior: C-FIX-DEVICE-05/06 |
| Forms and keyboard | Defects found; F-02/F-03 implemented | B-2 account/draft and layout tests, proxy | Accepted phone/Unicode formats preserved; native autofill/keyboard and screen readers remain |
| Feedback and perceived speed | No new defect found | B-2 pending, failure and recovery controls, proxy | Physical interruption and perceived latency remain |
| Navigation and overlays | Defects found; F-01 implemented | B-2 route leave/return, pending response, confirm/cancel, proxy | Native Back and browser gestures: C-FIX-DEVICE-05/06 |
| Gestures and scrolling | No defect found in previously checked scenarios | B-1 source/emulation; no custom gesture changes | Native pan/zoom/edge gestures remain unqualified |
| Accessibility | Defect found; enlarged-text component of F-03 implemented | B-2 real rendered text geometry and keyboard focus, proxy | VoiceOver/TalkBack: C-FIX-DEVICE-07/08; no WCAG conformance claim |
| Performance | No new measured defect; original recommendation retained | B-1 lab metrics only | B-2 production build passes with existing chunk warning; field/native performance not rerun |
| Data entry and resilience | Defects found; F-01/F-02 implemented | B-2 tests, real SQLite fault/retry cases, mechanism/proxy | Original/new draft text, image-only, link-only and combined input retained; physical checks C-FIX-DEVICE-01–04 |

## 3. Findings and implemented fixes

### F-01 — P1 — Failed coach requests lose submitted input or overwrite newer writing

**Status: implemented; browser regressions pass; target verification pending.** Original evidence class: Observed at the proxy scope. Original reproduction and affected scopes are retained unchanged in the ledger.

Before: ComposeBar cleared input before its owner could retain it. The failure callback returned after navigation or restored the older response over a newer draft. Generated-turn recovery began only after generation succeeded.

After: `lessonSubmissions.js` retains the exact submitted text, image names/data and extracted link context by encoded account/lesson before the composer clears. A failed local write leaves the only input copy editable and refuses Send. The engine keeps generation alive independently of React and joins it on route return. The retained response is separate from the next draft, with **Retry response**, **Move to draft** only when empty, and confirmed **Discard response**. Original and newer input survive independently.

Submission IDs become stable generated-turn IDs. Reload and retry check authoritative saved IDs; a committed pair is reused rather than generated or appended again. Once output is generated, **Retry saving** uses the existing immutable save journal. A journal write is only considered durable after read-back verification. When the larger output cannot be stored, the smaller submitted input remains until a confirmed save or durable generated copy takes over. This preserves input through the blocked-journal/lost-ack/reload case. A reload never automatically invokes a model.

Owner-bound image/model requests prevent an old submission being sent under a later account. Existing server commit semantics, URL-fetch safeguards and lesson completion processing remain intact.

Acceptance exercised in both engines: failure after leaving; failure while staying with newer text/images/links; reopen before late success; reload during generation; A/B/A account changes; refusal when input retention fails; move/confirm/cancel; four text/optional attachment combinations; lost acknowledgement with exact one-pair replay; generated journal unavailable after a real commit. The image records were read back from SQLite. Newer attachments were explicitly checked not to leak into the older retried response.

Main files: [lessonSubmissions.js](../../client/src/lib/lessonSubmissions.js), [lessonEngine.js](../../client/src/lib/lessonEngine.js), [generatedTurns.js](../../client/src/lib/generatedTurns.js), [LessonChat.jsx](../../client/src/pages/LessonChat.jsx), [ComposeBar.jsx](../../client/src/components/chat/ComposeBar.jsx), [useLessonDraft.js](../../client/src/hooks/useLessonDraft.js), and the owner-bound request helpers.

Visual evidence: retained response beside newer draft (archive member `output/playwright/mobile-ux-remediation-2026-10-25/webkit-retained-and-newer-draft.png`). Physical requirements remain C-FIX-DEVICE-01/02, with separate iOS/Android regression records.

### F-02 — P1 — Settings drafts cross accounts in the same tab

**Status: implemented; browser regressions pass; target verification pending.** Original evidence class: Observed at the proxy scope.

Before: global session-storage keys restored profile fields and feedback belonging to account A into B. Pending asynchronous work could also outlive a Settings visit.

After: fields and feedback have owner-scoped keys and owner-validated payloads. Settings remounts when the account changes, ignores abandoned field loads, restores/submits only current enabled definitions, and persists user edits rather than automatically treating fetched server values as drafts. Unknown-owner legacy keys are discarded. Cancelling feedback retains it only for its owner. A completed save clears only the unchanged submitted draft, preserving newer writing from a later visit.

Profile updates, feedback-generated writes and model requests bind to their original owner. A delayed profile response body cannot replace B's credentials; a delayed profile acknowledgement cannot populate B's cache. Rejected profile/summary writes retain feedback and report an error. These are owner checks at actual request/acknowledgement boundaries, not just UI hiding.

Acceptance exercised: A/B/A fields and feedback, reload and real profile-field save, valid phone/team values, delayed feedback crossing account change, wrong-owner/corrupt/legacy draft data, hidden/removed definitions, stale save clearing, rejected writes and delayed response bodies. No A data was submitted as B. See B's Settings (archive member `output/playwright/mobile-ux-remediation-2026-10-25/webkit-account-b-settings.png`).

Main files: [settingsDrafts.js](../../client/src/lib/settingsDrafts.js), [Settings.jsx](../../client/src/pages/Settings.jsx), [auth.js](../../client/js/auth.js), [storage.js](../../client/js/storage.js), [orchestrator.js](../../client/js/orchestrator.js), and [profileQueue.js](../../client/src/lib/profileQueue.js). Physical requirements: C-FIX-DEVICE-03/04.

### F-03 — P2 — Enlarged lesson-list text clips and compresses browsing controls

**Status: implemented; browser regressions pass; target verification pending.** Original evidence class: Observed at the proxy scope.

Before: a constrained title row clipped enlarged words beside the status icon, course metadata competed with View outline, and WebKit produced horizontal scrolling at 320px with 200% root text.

After: titles wrap and take the full row when the status icon cannot fit alongside them; metadata has a full-width row before the outline action. Filter labels stack above bounded full-width native selects, with content-based height. The change preserves native controls, zoom, tokens and light/dark themes, without hiding overflow.

Acceptance exercised in Chromium and WebKit: light/dark at 320×760, 390×844, 844×390 landscape, 1440×900 and 320×760 with root text at 200%. Actual text-range geometry stays inside title bounds and the document stays within the viewport. This is a controlled enlargement proxy, not native phone accessibility text enlargement.

File: [LessonsList.jsx](../../client/src/pages/LessonsList.jsx). Screenshots: 200% narrow layout (archive member `output/playwright/mobile-ux-remediation-2026-10-25/chromium-lessons-light-320-scale2.png`), desktop dark (archive member `output/playwright/mobile-ux-remediation-2026-10-25/webkit-lessons-dark-1440-scale1.png`). Physical requirements: C-FIX-DEVICE-05/06.

## 4. Recommendations retained separately

Collect field or physical-device performance evidence before treating the earlier local lab samples as representative. The entry bundle still emits the existing Vite size warning; no new dependency was added. Native interruption, keyboard, assistive technology and browser-chrome checks remain useful because desktop emulation cannot qualify them. These recommendations are separate from the three implemented defects.

## 5. Changes, regression coverage and validation

The source changes above address all three findings. Added executable stores/ownership tests and a reproducible `node:test` + Playwright browser suite, with a local-only fixture that imports no production AI route or `.env`. Existing static assertions that required the old broken markup/call order were replaced by behavior and rendered-geometry coverage. Architecture documentation records the new journals, ownership boundaries and recovery limits.

- `npm test`: **547 client tests passed**; **729 server tests passed**, **2 skipped**, no failures. Both skipped server checks require `POSTGRES_TEST_URL`: PostgreSQL concurrency/persistence and the production HTTP launcher's save-event test. The inactive Firestore suite is separately marked skipped as before; the client runner reports zero skipped test cases.
- `npm run lint`: exit 0, zero errors, **20 existing client warnings**; server lint passes.
- Client production build: exit 0, existing large-chunk warning.
- Browser regressions: **24 groups passed, 12 per engine**. Each engine ran the initial 11-group full suite, then one additional focused in-place failure case on the identical B-2 bundle. The optional-input group contains four cases per engine, and the layout group contains ten states per engine.
- The generated-journal storage-pressure regression includes a real SQLite commit, deliberately lost acknowledgement, unavailable local generated journal, reload and stable-ID reconciliation with one inference request.
- Independent rebuild: **50/50 artifacts byte-identical**, no differences. The tested source includes the independent admin merge without taking ownership of its changes.
- Impeccable detector: no candidates. Visual inspection included narrow enlarged text, retained/current draft separation, and the desktop dark list. No design-sidecar drift repair was performed.
- `git diff --check`: clean. All test-owned browsers, API servers and temporary databases were cleaned up; no fixture server remains. No Git mutation or release action by this task.

Evidence: unit/server output (archive member `output/playwright/mobile-ux-remediation-2026-10-25/full-tests.log`), lint (archive member `output/playwright/mobile-ux-remediation-2026-10-25/lint.log`), build (archive member `output/playwright/mobile-ux-remediation-2026-10-25/build.log`), Chromium suite (archive member `output/playwright/mobile-ux-remediation-2026-10-25/chromium-browser.log`), WebKit suite (archive member `output/playwright/mobile-ux-remediation-2026-10-25/webkit-browser.log`), Chromium focused case (archive member `output/playwright/mobile-ux-remediation-2026-10-25/chromium-focused.log`), WebKit focused case (archive member `output/playwright/mobile-ux-remediation-2026-10-25/webkit-focused.log`), cleanup and preservation receipt (archive member `output/playwright/mobile-ux-remediation-2026-10-25/cleanup.json`).

Initial validation failures were resolved rather than counted as passes: the first lint found a duplicate existing/new readOnly prop; old source-pattern tests expected the former markup/call order; a new storage test shared a page-level compatibility cache with an unrelated cancellation test and was moved to its own test module. Early browser account-switch cases used full document navigation that interrupted controlled in-flight requests; app navigation replaced it. Final executed evidence above supersedes those harness attempts for the current checks; the initial browser logs remain in the evidence directory.

Reproduce with `npm run build:client`, `npm test`, `npm run lint`, then `npm --prefix client run test:browser:learner` and `PLATO_TEST_BROWSER=webkit npm --prefix client run test:browser:learner`. `PLATO_TEST_CLIENT_DIST` can select the frozen B-2 build and `PLATO_TEST_EVIDENCE` selects the artifact directory. Tests launch only their own local fixture and clean it up.

## 6. Device handoff

Ten B-2 device checks (archive member `.mobile-ux/runs/20261025-learner-remediation/device-checks.md`) replace the earlier build's plans with new IDs. All are **NOT READY** until there is a verified phone-reachable isolated preview and actual device/browser configuration. Each preserves build/setup distinctions, prerequisites, stop conditions and separate state outcomes. No physical pass is inferred from the browser suite. All fixes are ordinary application/state/layout changes; none modifies native keyboard, gesture, viewport-unit, safe-area or browser-history behavior.

The continuation ledger (archive member `.mobile-ux/runs/20261025-learner-remediation/run.json`) preserves original finding IDs, affected scopes, failed observations, prior build and the original audit-only authorization, then records the explicit fix authorization, B-2 implementation and new checks. Findings remain **implemented**, not target-Verified. Ledger validation and report both returned exit 3 with zero schema errors: valid but incomplete target verification. Original failures are retained and are not erased by a proxy pass.

## 7. Remaining qualification inputs

A phone-reachable B-2 test URL, exact iOS/Safari and Android/Chrome configurations, safe fixture accounts and controlled-failure setup are needed to execute the handoff. A disposable PostgreSQL test URL is needed for the two skipped server checks. No production RUM, live provider quality/streaming, Google authentication or Cloud SQL claim is made. These limits do not leave any of the three authorized source fixes unimplemented.
