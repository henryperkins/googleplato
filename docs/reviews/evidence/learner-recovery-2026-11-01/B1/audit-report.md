**Ceiling: proxy — Chromium 149.0.7827.55 and Playwright WebKit 26.5 desktop emulation.**
The learner can browse, submit, recover supported failures, and reopen acknowledged work against the isolated SQLite fixture. The completion condition is not fully met: a full browser store silently loses newer draft revisions (F-01, P1), and normal server pending/saved states are visually indistinct (F-02, P2).
Audit only: no application fixes, commits, pushes, deployment, or production writes. Six phone checks remain not run and NOT READY.

**Run and setup.**

- Run: 20261101T122442Z-5654d6c2; 2026-11-01 UTC; /home/ubuntu/googleplato.
- Loaded Mobile Web UX Runner **2.0.7**, schema 2, October 20 r2 contract. It was found in the installed created-by-me-remote cache and loaded by explicit path because it was absent from the advertised skill list. Normal host auto-discovery is unverified.
- Loaded Impeccable **4.8.0** from the advertised installed cache path. Other candidates were user 4.8.0 and curated 4.3.1; no install/upgrade/duplicate removal. The technical audit procedure ran, including the bundled detector. The corrected detector scan returned [] / exit 0. Its initial list filename was mistyped and failed; both outputs remain.
- The context launcher was invoked once with the mistyped target Lesson.jsx, and its large combined output was truncated without a durable stdout receipt. PRODUCT.md and DESIGN.md were read directly; no successful surface-specific context load or clean-host compatibility test is claimed. [Full setup receipt](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/setup-receipt.json).
- **B1 is a frozen dirty snapshot**, based on HEAD 8fbdac6824beed29b4050bead4b6c00e99102f43 with the recorded ComposeBar.jsx, Login.jsx and learner-recovery.test.js edits. The checkout was changing concurrently. [Frozen diff](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/frozen-working.patch), [source hashes](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/frozen-source.json), and [build hashes](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/build-hashes.json) identify the actual audited build. Later shared-checkout changes are a different build.
- Runtime: Node 24.21.0, Playwright 1.61.1, Linux headless desktop. Each browser actually loaded the fixture and captured evidence. No OS simulator, physical mobile controller, tester-supplied result, mobile screen reader or field-data source ran. Playwright WebKit is not Safari.
- Fixture: real password sign-in, authorization, coach/save/read routes and on-disk SQLite; synthetic learner A/B and 14 communication lessons. Deterministic AI and link responses, closed waitlist and disabled email replace external services. Synthetic Firebase config was added only to the audit copy to make its build self-contained. Browser harness permits only its local origin plus data/blob URLs. Google sign-in, live inference and extraction, email, Cloud Run and Cloud SQL behavior remain untested.
- Case-specific substitutions are recorded per check: held requests pass through to the real fixture on release; 503 failures replace responses; lost-ack tests let SQLite commit before aborting the client response; selective Storage.setItem failure is separate from the successful native-quota reproduction. Actual browser offline mode is a scenario, not a fake offline response.

**Coverage and evidence.**

All seven modules were reviewed for this learner journey. These are dispositions for checked scenarios, not declarations that an entire area is correct on real phones. Authoring and administration were excluded. The existing learner suite also executed three profile/settings cases per engine because selecting the parent suite included them; those logs are retained without expanding this audit into a settings review.

| Master area | Disposition | Environments used | Highest level | Limits and next check |
|---|---|---|---|---|
| 1. Reach and placement | No defect found in checked scope | Source + Chromium/WebKit desktop emulation | Proxy | Primary controls visible in exercised layout; physical reach not established; remaining: C-D02, C-D03, C-D04, C-D05, C-D06 |
| 2. Viewport and safe areas | No defect found in checked scope | Source + Chromium/WebKit desktop emulation | Proxy | No document overflow; real keyboard/chrome/insets unrun; remaining: C-D02, C-D03, C-D04, C-D05 |
| 3. Touch targets | No defect found in checked scope | Source + Chromium/WebKit desktop emulation | Proxy | Phone Send was 44x44 at default text; direct hit checks passed. No blanket target-size conformance claim; remaining: C-D02, C-D03 |
| 4. Forms and keyboard | Defects found (F-01) | Source + Chromium/WebKit desktop emulation | Proxy | Draft storage failure confirmed; software keyboard/IME/autofill untested; remaining: C-D01, C-D02, C-D03, C-D04, C-D05, C-D06 |
| 5. Gestures and scrolling | No defect found in checked scope | Source + Chromium/WebKit desktop emulation | Proxy | Source and simple synthesized touch paths only; no native gesture certification; remaining: C-D02, C-D03, Beyond budget: iOS edge-swipe, pull-to-refresh and long-thread rubber-banding with focused IME |
| 6. Overlays, navigation and dense data | No defect found in checked scope | Source + Chromium/WebKit desktop emulation | Proxy | Outline/menu open/close and keyboard dismissal preserve draft; desktop Escape is not Android Back. Dense tables not applicable to this learner scope; remaining: C-D02, C-D03, C-D04, C-D05, C-D06 |
| 7. Content priority | No defect found in checked scope | Source + Chromium/WebKit desktop emulation | Proxy | Lesson selection, title, progress, coach and composer checked; larger OS text remains; remaining: C-D03, C-D05, C-D06 |
| 8. Performance | No defect found in checked scope | Source + one Chromium lab sample | Proxy | No attributed product performance defect assigned; lab concern retained: LCP 5.140s and CLS 0.7965 in one throttled local sample; remaining: R-02 attribution investigation, Beyond budget: measured real-device performance, Open question: field metrics |
| 9. Errors and recovery | Defects found (F-01, F-02) | Source + Chromium/WebKit desktop emulation | Proxy | Failure/retry and durable save controls passed; two confirmed feedback/preservation defects; remaining: C-D01, C-D02, C-D05, C-D06 |
| 10. Accessibility on mobile | No defect found in checked scope | Source + Chromium/WebKit desktop emulation | Proxy | Labels/roles, hardware keyboard and CSS text scaling checked; no VoiceOver/TalkBack or WCAG conformance claim; remaining: C-D05, C-D06 |

**Viewport matrix:** 320×740, 360×800, 390×844, 430×932 and 844×390 short landscape; each in light and dark. Additional 200% root-text-size proxy checks at 320×740, 390×844 and 844×390, plus 1280×900 controls. Eighteen rendered configurations per engine, 36 total. List, long composer and outline showed no page-level horizontal overflow. Send was 44×44 CSS px at default phone sizes and current hit targets were verified. Short-landscape header/composer became static and remained reachable. CSS root enlargement is not OS larger text or actual pinch zoom.

Observed positives:

- Existing learner suite: **22/22 pass in Chromium and 22/22 in WebKit**. [Chromium results](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/chromium/chromium-checks.json); [WebKit results](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/webkit/webkit-checks.json).
- New lifecycle probe: local-recovery acknowledgement, held coach request, held save request, backend GET, route return, same-tab reload, and fresh browser context. One response/coach pair persisted; saved lesson progress was 4 and activitiesCompleted 2. A fresh context reopened the saved response; the same-tab newer draft remained after route/reload. This proves the local SQLite boundary, not provider assessment quality or Cloud SQL.
- Offline submission retained the response, then explicit retry after reconnect produced one stored response. Lost-ack suite cases committed before client failure and retried idempotently without another inference. Save failure and reassessment notices stayed visible; Retry saving displayed its own success confirmation.
- Text-only, image-only, link-only and combined attachment paths survived failure/reload/lost acknowledgement. A separate draft matrix kept common text fixed and varied image alone, link alone and both; all restored. Move to draft, confirmed discard/cancel and account A/B isolation passed.
- Direct touchscreen synthesis opened the visible outline/menu controls; keyboard Enter/Escape paths completed and the draft remained. These are desktop proxy interactions. Android system Back, Safari scroll locking and the software keyboard were not exercised.

The runner saved-versus-draft comparison matrix is marked not applicable with an explicit source reason: this flow keeps submitted input, newer draft and generated turn separate and reconciles by turn/message identity; it has no field-difference merge UI. No comparison UI was invented. Optional-field retention coverage above remains recorded.

**Findings — both open, no fixes applied.**

**F-01 · P1 · A full browser store silently rolls a draft back on reload**

Evidence class: **Observed**. Status: **open**. Confidence: high for the observed desktop engines and stated conditions; target frequency unknown.

Learner effect: A learner can lose unsent revisions on reload while believing ordinary draft recovery still works. This is conditional draft loss, not evidence that acknowledged server saves are lost.

Where: B1 frozen source: client/src/hooks/useLessonDraft.js:15; client/src/lib/lessonDrafts.js:30; LessonChat.jsx:183.

Reproduction:

1. Open /lessons/practice-9 as synthetic learner a.
2. Type Earlier retained draft and confirm its sessionStorage record.
3. Fill only this disposable origin sessionStorage until native QuotaExceededError (or inject only draft writes as the separate mechanism test).
4. Replace text with the longer Latest response sample; observe no alert or draft-retention warning.
5. Reload the same tab; the earlier draft returns. Control: ordinary storage retained later draft through route and reload.

Expected: If retention fails, clearly say the latest draft is only in memory and keep recovery/copy options available; never silently imply normal retention.

Actual: Both engines accepted the new text with no alert or retention-status warning. On reload, Earlier retained draft returned and the newer writing disappeared.

Cause: lessonDrafts.write updates memory, returns false for quota/write failure, and useLessonDraft ignores that return. beforeunload only guards loading/pendingSave, not an unretained draft.

Affected scope: B1, authenticated synthetic learner, 390×844 portrait, Chromium 149.0.7827.55 and Playwright WebKit 26.5 on Linux desktop. The source condition may also affect phones, but no phone execution is claimed.

Smallest proposed fix: Return retention status from useLessonDraft, retain the current in-memory text and attachments, and show a persistent inline warning with Copy and Retry retaining actions. Clear the warning only after a verified write. Do not delete drafts or move data between accounts. A navigation/unload guard would require separate device-dependent proposal and testing.

Next check: After a separately authorized change, repeat native quota exhaustion and recovery; free filler storage, retry retention, reload and compare exact text/images/links. Keep account-isolation controls.

Evidence: [native Chromium quota result](evidence/chromium-followup/real-quota.json), [native WebKit quota result](evidence/webkit-followup/real-quota.json), [no-warning screenshot](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/chromium-followup/real-quota-no-warning.png), [older draft after reload](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/chromium-followup/real-quota-reloaded.png). No storage API was replaced in these native-quota checks; synthetic filler filled the disposable origin only. The independent injected-failure checks and normal-storage controls are retained in the ledger.

Exact source: [useLessonDraft.js:16](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/source/client/src/hooks/useLessonDraft.js:16) and [lessonDrafts.js:30](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/source/client/src/lib/lessonDrafts.js:30). Conditional draft loss warrants P1; this is not a finding of broad loss of acknowledged server work. Device follow-up: C-D01.

**F-02 · P2 · Normal server saving and confirmed save have no distinct learner-facing status**

Evidence class: **Observed**. Status: **open**. Confidence: high for the observed desktop engines and stated conditions; target frequency unknown.

Learner effect: The learner cannot tell whether work is still awaiting server persistence or can be safely reopened elsewhere. Persistence itself worked in the fixture; the missing state distinction fails the requested completion condition.

Where: B1 frozen source: client/src/pages/LessonChat.jsx:319,345; client/src/lib/lessonEngine.js:303; client/src/components/chat/ComposeBar.jsx:270.

Reproduction:

1. Open /lessons/practice-14 and send Response with a delayed server save.
2. Pause its POST /v1/sync/lesson-turn/practice-14 after coach generation; keep real GET and SQLite active.
3. Wait for the local recovery animation to finish and the coach reply to display.
4. Type a next draft; Send remains disabled without a Saving explanation. Ctrl/Cmd+Enter produces the reply-wait wording.
5. Release POST; verify reply via API GET and a fresh browser context. No explicit normal server-saved status appears.

Expected: Differentiate local recovery, server saving and acknowledged saved state; a disabled Send action should explain the current operation.

Actual: Your reply is saved in this tab appears briefly. During a held save POST the coach text is already shown, Send is disabled and no Saving status is shown. On success the normal server message is cleared. The keyboard send shortcut says Wait for the reply to finish, then send even though the visible reply is complete.

Cause: runSubmission remains in qa while the engine awaits saveGeneratedTurn. pendingSave becomes meaningful only after engine return, and normal saved persistence.message is deliberately replaced with an empty string. Composer busyNotice starts empty.

Affected scope: B1, authenticated synthetic learner, 390×844 portrait, Chromium 149.0.7827.55 and Playwright WebKit 26.5 on Linux desktop. The source condition may also affect phones, but no phone execution is claimed.

Smallest proposed fix: Expose the engine save phase to the lesson UI; use one compact live status beside the composer for Kept in this tab, Saving progress, and Saved. Set Saved only after validated acknowledgment; retain existing failed-save text and persistence-only retry. No viewport or gesture changes needed.

Next check: Hold a real fixture save POST after coach completion, assert Saving, release and assert Saved only after validated acknowledgment; repeat 503, lost acknowledgment and retry while checking one stored turn and no second inference.

Evidence: [Chromium pending/saved comparison](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/chromium-followup2/pending-vs-saved.json), [WebKit pending/saved comparison](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/webkit-followup2/pending-vs-saved.json), [pending server save screenshot](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/webkit-journey/server-save-pending.png), [saved response in fresh context](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/chromium-journey/saved-new-context.png). The save POST was held and later passed through unchanged; actual backend GETs distinguished uncommitted and committed data. Both UI states lacked a save label.

Exact source: [LessonChat.jsx:345](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/source/client/src/pages/LessonChat.jsx:345), [lessonEngine.js:303](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/source/client/src/lib/lessonEngine.js:303), [ComposeBar.jsx:270](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/source/client/src/components/chat/ComposeBar.jsx:270). The local wording is explicitly “in this tab”; the defect is missing server-state distinction, not a false server acknowledgement or demonstrated lost save. The source intentionally suppresses normal server success, so this proposal reconciles that choice with the requested completion condition. Device follow-ups: C-D01/C-D02/C-D05/C-D06.

**Observed submission and save states.**

| State | Current learner feedback | Observed recovery / persistence |
|---|---|---|
| Editing unsent draft | Editable composer; no ordinary retention state | Same-tab draft normally restores; silent retention failure is F-01 |
| Submitted, local recovery retained | “Your reply is saved in this tab.” briefly | Exact submission staged before clearing composer |
| Waiting for coach | Thinking status after local notice; next draft remains editable | Late success can be rejoined; reload does not auto-repeat inference |
| Coach completed, save POST pending | Coach text visible; Send disabled; no Saving text | Generated turn retained; F-02 |
| Ordinary acknowledged save | No explicit server Saved status; Send enabled for next content | API GET + fresh context found saved response and progress; F-02 |
| Coach request fails/offline | Error plus Unsent response; Retry response / Move to draft / Discard response | Earlier response and newer draft separated; retry stores once |
| Save fails or outcome unknown | Retained/unconfirmed text + Retry saving and Copy reply | Idempotent persistence retry; no new AI generation |
| Save retry succeeds | Brief “Your reply is saved.” | Confirmed backend data; notice fades |

**Field audit.**

| Field | Accepted input | type / inputmode | autocomplete | enterkeyhint | autocapitalize / spellcheck |
|---|---|---|---|---|---|
| Composer | Unicode multiline text; empty with image/link | textarea / not set | not set | enter (multiline; Ctrl/Cmd+Enter sends) | browser defaults |
| Link URL | HTTP(S), including hostname normalized to https | url / url | not set | done | none / false; autocorrect off |
| Course and Status | Enumerated lesson filters | native select | not set | not set | not applicable |
| Image attachment | Up to four image files; 5 MB individual input cap | file, accept image/*, multiple | not applicable | not applicable | not applicable |

Phone-width composer/link text computed to at least 16 px. This is a source/rendered check; focus zoom, IME and keyboard character availability remain device checks. Existing status regions and alert semantics were inspected. Missing status copy here is a task-feedback defect; no automatic WCAG 4.1.3 failure is claimed solely because new status text could be added. [W3C status-message guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

Target geometry was assessed against the 24 CSS px minimum and its spacing/inline/equivalent/user-agent/essential exceptions; the 44 px primary controls are an ergonomic observation, not a blanket conformance result. No size defect was assigned by preference alone. [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

**Recommendations — separate from defects.**

1. **R-01: explain unsent-draft lifetime.** The fresh-context control correctly reopened server work without the previous tab’s unsent draft. A compact “Draft kept in this tab” message would make the current boundary clear. Cross-session draft sync is a separate product decision. Session storage is scoped to a page session and normally survives reload; closing the tab ends it. [MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage).
2. **R-02: attribute the lab loading/shift concern before changing performance code.** One 390×844 Chromium sample with 4× CPU throttling, 100 ms simulated network latency, 1.5 Mbps down and 0.75 Mbps up recorded LCP **5.140 s** and max-session-window CLS **0.7965**, with the dominant shift before the first lesson click. Long tasks were 94 and 65 ms; the scripted click event duration was 64 ms. These are measurements for that local lab run, not INP, TBT, mobile p75 or production speed. Shift-source attribution and production-equivalent compression/delivery are missing. Capture those next; no speculative optimization defect or fix is assigned. [Raw lab data](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/chromium-followup/lab-perf.json).

**Impeccable technical assessment.** The implementation uses coherent existing controls, typography and theme tokens. The scoped source detector passed; the manual journey audit found the two integrity/feedback problems above. Provisional checklist scores: accessibility 2/4 (semantics/keyboard tested; actual AT absent), performance 2/4 (one lab concern; no field evidence), theming 3/4 (both themes rendered; no full contrast survey), responsive design 3/4 (matrix passed; mobile platform gaps), integrity 2/4 (two reproduced state defects): **12/20**. This is a bounded technical checklist score, not mobile readiness or WCAG conformance. Repair routes, if separately authorized: Impeccable harden for F-01; harden/clarify for F-02; optimize only after R-02 attribution; polish after functional rechecks.

**Changes and cleanup.** No application source was edited by this audit. Only files under this run’s output directory were written: report, ledger, harnesses, source copy, synthetic Firebase config, build and evidence. The frozen source hashes remained unchanged. Owned browsers and local fixtures stopped and temporary SQLite databases were removed. Concurrent Login/test/design/documentation changes in the shared checkout are recorded in [cleanup/state receipt](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/cleanup.json); they were not rolled back or included retroactively in B1. No physical-device-dependent changes were applied.

**Remaining device checks.** Budget 6; used as six reserved entries; **0 executed, 6 remaining, all NOT READY**. No test URL reachable from a phone or exact device software configuration was available. [Full six-entry script with prerequisites, stop conditions, separate state outcomes and build/setup confirmations](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/device-checks.md).

| ID | One proposed configuration | Main unanswered behavior |
|---|---|---|
| C-D01 | iPhone 15, Safari Bottom; versions unprovided | Draft failure/recovery, background return, distinction of save states |
| C-D02 | Pixel 8, Chrome Android, gesture navigation; versions unprovided | Keyboard/landscape, Android Back, offline retry |
| C-D03 | iPhone 15, Safari Bottom; versions unprovided | Toolbar, safe areas, reach, keyboard and pinch zoom |
| C-D04 | iPhone 15, Safari Top; versions unprovided | Top toolbar geometry and short landscape |
| C-D05 | iPhone 15, Safari Compact + VoiceOver; versions unprovided | Compact layout, larger text, reading/status/focus journey |
| C-D06 | Pixel 8, Chrome Android + TalkBack; versions unprovided | Larger text, reading/status/focus journey and Back |

**Open questions and completion limits.**

- The support policy, actual phone availability and exact OS/browser versions are unknown. Those facts are needed to turn the proposed device configurations into executable checks.
- A phone-reachable preview of exact B1, safe synthetic credentials and explicitly documented backend/provider wiring are required before those checks can run. Desktop route stubs must not be assumed to exist on the phone.
- A real/test-provider journey and PostgreSQL integration environment are needed to extend beyond the local SQLite/deterministic-coach boundary. A fresh mastery-completion transition was not qualified; the completed-lesson UI used a seeded completed lesson.
- The desired lifetime of an unsent draft beyond its current tab is a product decision. This audit does not silently extend that promise.
- R-02 needs attributed traces and production-equivalent test serving; real-user performance and real-device speed remain unknown.

Next useful deep dives are modules 2–3 on actual keyboards/chrome, 5–6 on native Back and gestures, and module 7 for tab discard plus real dependency persistence. These are tied to the preserved device checks rather than a repeat of this desktop audit.

**Ledger result.** [Machine-readable ledger](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/run.json) and [validation result](/home/ubuntu/googleplato/output/playwright/mobile-ux-audit-2026-11-01/20261101T122442Z-5654d6c2/evidence/ledger-check.json). Runner check returned **exit 3, zero schema errors**: assessment/coverage complete, proxy ceiling, verification incomplete/failed because reproduced defects and six unrun device checks remain. This means the audit deliverable is complete within available environments; the learner completion condition and mobile target verification are not established. Original failed observations and partial harness attempts remain; no later pass erases them.
