**The learner can now tell whether work is an unsent tab draft, waiting for the coach, being saved, confirmed saved, or not confirmed saved in the local test journey.** F-01 and F-02 are implemented. A storage failure gives a persistent warning and recovery controls; successful retry restores the exact text, image and link after reload. A held server save has explicit pending feedback, and acknowledgment produces a saved state. The existing retry path still saves the original generated turn without another coach call.

**Evidence ceiling: proxy.** Chromium 149.0.7827.55 and Playwright WebKit 26.5 ran on Linux through Playwright 1.61.1. WebKit is not iOS Safari. There are no physical-device, mobile screen-reader, OS-simulator, or production results. Both findings remain **Implemented**, not **Verified**. Six device checks remain **NOT READY**. The Runner ledger is valid with no schema errors; its verification result remains failed/incomplete because original failures are retained and qualifying target checks have not run.

This continues the user-authorized change from audit only to **audit and fix**, with the same learner journey and six-check budget. Device-dependent fixes remain **propose only**. Authoring and administration were excluded.

**Environment and reproducible build.**

- Mobile Web UX Runner **2.0.7** loaded from the explicitly requested SKILL.md (loaded locally: `/home/ubuntu/.codex/plugins/cache/created-by-me-remote/mobile-web-ux-runner/2.0.7/skills/mobile-web-ux-runner/SKILL.md`).
- Impeccable **4.8.0** loaded from the advertised installed SKILL.md (loaded locally: `/home/ubuntu/.codex/plugins/cache/impeccable/impeccable/4.8.0/skills/impeccable/SKILL.md`). The audit procedure and detector were used in the original audit; harden, clarify and craft-floor were read for this fix pass. No second context invocation or tool installation occurred. The original mistyped context target and truncated output are documented in the retained receipt; no clean context receipt is claimed.
- Node **24.21.0**. Actual browser capabilities are evidenced by completed local journeys, not package presence. WebKit mobile emulation cannot execute Playwright mouse.wheel; the extra wheel-then-tap probe is explicitly unrun there.
- **B4** is the final immutable application snapshot at HEAD **8fbdac6824beed29b4050bead4b6c00e99102f43** plus the recorded working edits. [Source manifest](layout-source-manifest.json); [built asset hashes](layout-build-hashes.json). B1 is the original audit, B2 and B3 are retained intermediate candidates. No commit, push or deployment was performed.
- [Setup receipt](setup-receipt.json); [original audit](../B1/audit-report.md); [before snapshot](snapshot.json); [only this run’s source changes](owned-changes.patch.gz).

**Substituted services and untested behavior.**

| Boundary | What actually ran | What remains untested |
|---|---|---|
| Persistence | Disposable on-disk SQLite with real Hono routes, authenticated ownership, transaction commits and subsequent reads | Cloud Run networking, Cloud SQL/PostgreSQL behavior under deployment, concurrency, failover and production policy |
| Accounts and lessons | Synthetic users a/b, generated temporary credentials, seeded communication lessons | Real learner records, curriculum realism and production enrollment |
| AI | Deterministic fixture coach result through the real coach route and turn envelope | Live inference, streaming variability, provider outages/rate limits, quality and billing |
| Link fetching | Synthetic example.test reference through the composer | Real remote extraction, redirects and fetch safeguards |
| Auth and network | Real password sign-in/JWT locally; synthetic Firebase build config; external browser requests blocked; no email delivery | Google OAuth/Firebase, email recovery, remote services and assets |
| Save faults | Held requests continue to the real fixture; 503 is intercepted; lost acknowledgment commits SQLite before aborting the response | Real fault frequency and network timing |
| Draft faults | Native sessionStorage quota exhaustion; separate silent-write/readback failure | OS tab eviction, browser storage eviction and private-browsing policies on phones |
| Copy | Stubbed clipboard success records exact text; stubbed failure exercises fallback | Real OS clipboard, browser permission prompts and phone selection ergonomics |

Each build/setup/case boundary is also recorded in [run.json](run.json). A successful fixture response is not described as production persistence.

**Coverage table.** All seven Runner modules were reviewed; the ten master areas retain their separate dispositions. Earlier B1 evidence remains identified by build. Four B4 states (retained draft, failed retention, saving, saved) were measured in 18 configurations per engine: 320×740, 360×800, 390×844, 430×932, 844×390, 200% root-font variants at 320/390/844, and a 1280×900 desktop control, each in light/dark. CSS root-font scaling is a proxy for enlarged text; it is not OS font scaling or browser zoom.

| Master area | Disposition and evidence | Remaining limit / next check |
|---|---|---|
| Reach and placement | B4: 72 measurements per engine; enabled controls reachable after scrolling | Physical reach/keyboard; C-B4-D02/D03 |
| Viewport and safe areas | B4: zero horizontal overflow; new feedback stays in normal flow | Real chrome, insets and keyboard; D02–D05 |
| Touch targets | Geometry and hit tests; Chromium fresh hit-tested retry tap passes after explicit scroll | Real finger targets; WebKit wheel probe unavailable; D02/D03 |
| Forms and keyboard | F-01 implemented; native quota, failed retry, exact rich-draft reload and hardware-keyboard recovery pass | Software keyboard, IME, autofill; D01–D06 |
| Gestures and scrolling | B1 navigation controls retained; B4 extra Chromium direct retry path passes | Native gesture behavior unestablished; D02/D03; additional gesture cases beyond budget |
| Overlays, navigation and dense data | Outline/Escape across B4 matrix; reopened pending save reports Saving then Saved; one inference | Android Back and Safari toolbar variants; D02–D06. Dense tables excluded from learner scope |
| Content priority | Lesson/coach/action hierarchy retained; separate unsent and server-progress feedback | Actual enlarged OS text; D03/D05/D06 |
| Performance | B1 lab concern retained as R-02; no B4 performance claim | Attributed load trace and production-equivalent delivery; field/mobile performance beyond current checks |
| Errors and recovery | F-01/F-02 implemented; native quota, readback, 503, lost acknowledgment, retry and later return pass | Native storage/discard and real service failures; D01/D02/D05/D06 |
| Mobile accessibility | Named actions/live statuses, exact-text fallback, retry result focus, 200% CSS-root-font proxy | VoiceOver/TalkBack, spoken order and software-keyboard access; D05/D06 |

**F-01 — P1: browser storage failure silently lost the newest draft. Implemented; physical verification pending.**

Effect on the learner: under full or blocked tab storage, newer unsent writing could disappear on reload while an earlier retained version returned without warning. This did not establish loss of acknowledged server work.

Original reproduction (B1, both engines at 390×844): open a synthetic lesson; type “Earlier retained draft” and confirm its storage record; exhaust only the disposable origin’s sessionStorage until native QuotaExceededError; enter a longer new response; reload. Expected: explicit retention-failure feedback and a way to keep/copy/retry the current work. Actual: no warning; the older draft returned.

Exact source cause: [B1 useLessonDraft.js](../B1/source/client/src/hooks/useLessonDraft.js) ignored lessonDrafts.write’s false result, although the draft store retained the newest value in memory. [original native-quota evidence](../B1/evidence/chromium-followup/real-quota.json) and [WebKit counterpart](../B1/evidence/webkit-followup/real-quota.json) remain intact.

Smallest repair applied: [lessonDrafts.js](../../../../../client/src/lib/lessonDrafts.js#L7) publishes account/lesson-scoped readback status; [useLessonDraft.js](../../../../../client/src/hooks/useLessonDraft.js#L7) subscribes to it. [LessonChat.jsx](../../../../../client/src/pages/LessonChat.jsx#L725) shows “Draft not kept for reload. Keep this tab open.”, Retry keeping draft and Copy draft text. A failed retry keeps the warning. A successful verified write clears it. Copy failure gives a selection fallback; the button explicitly copies text, not attachments. New controls are normal-flow content rather than additions to the sticky composer. No new unload guard was added.

B4 evidence: [Chromium exact quota recovery](evidence/chromium-layout/chromium-draft-quota.json), [WebKit exact quota recovery](evidence/webkit-layout/webkit-draft-quota.json), [warning screenshot](evidence/chromium-layout/chromium-draft-quota-warning.png), [reopened work](evidence/chromium-layout/chromium-draft-quota-recovered.png). Navigation retained the newer in-memory draft during failure. After freeing only the filler and retrying, text (including spaces/Unicode), image and link objects matched after reload. A separate silent-write test confirms readback is required, unavailable copying has a fallback, and a retained clear does not resurrect old text.

Limit and next check: if a learner ignores the warning and reloads/closes before retention succeeds, memory-only work can still be lost. This fix makes that boundary visible and recoverable; it does not create cross-session server draft sync. C-B4-D01 exercises quota, retry/reload and genuine tab discard on a provisioned phone.

**F-02 — P2: a submitted reply lacked clear server-pending and saved feedback. Implemented; physical verification pending.**

Effect on the learner: after the short “saved in this tab” acknowledgment disappeared, a visible coach reply and disabled Send did not explain whether the server had saved the work. Early keyboard submission said to wait for the reply even when saving was the remaining operation.

Original reproduction (B1): submit a response; allow the coach result through; hold the real lesson-turn POST; wait for the 1.6-second local-recovery notice to disappear; draft the next message and press Control+Enter; then release the POST. Expected: local retention, server saving, and confirmed save are distinct. Actual: no explicit Saving state or normal saved confirmation; early-send feedback described waiting for the reply. [original evidence](../B1/evidence/chromium-followup2/results.json) remains.

Smallest repair applied: [lessonEngine.js](../../../../../client/src/lib/lessonEngine.js#L100) publishes the saving phase through the existing submission store before persistence. [LessonChat.jsx](../../../../../client/src/pages/LessonChat.jsx#L122) distinguishes Waiting for the coach, Saving progress, Progress saved and Progress not confirmed saved. [ComposeBar.jsx](../../../../../client/src/components/chat/ComposeBar.jsx#L33) accepts phase-appropriate busy wording. Reopening an active save observes its pending state. Normal/retry transient notices retain their existing animation; status text is excluded from the transcript and coach request. Commit IDs, the persistence API and inference behavior are unchanged.

B4 evidence: [pending screenshot](evidence/chromium-layout/chromium-practice-7-pending-progress.png), [saved/reopened screenshot](evidence/chromium-layout/chromium-practice-7-saved-progress.png), [normal save counts](evidence/chromium-layout/chromium-practice-7-save-counts.json), [lost-acknowledgment counts](evidence/chromium-layout/chromium-practice-8-save-counts.json), [WebKit counts](evidence/webkit-layout/webkit-practice-8-save-counts.json). A held save is absent from the backend before release. Lost acknowledgment leaves one committed response while the UI remains unconfirmed; retry reconciles it with **one coach call, two save calls and one stored response**. The next draft remains intact. [pending-save navigation evidence](evidence/webkit-direct/reopen-save.json) confirms reopening joins the same request.

Next check: D01/D02 and D05/D06 should verify native interruption/retry and spoken state transitions on the exact B4 test deployment, with explicitly provisioned delay/failure controls.

**Validation and retained contrary evidence.**

- Final B4 learner suite: **26/26 Chromium, 26/26 WebKit**. [Chromium log](chromium-layout.log.gz); [WebKit log](webkit-layout.log.gz). Includes existing account isolation, attachments, interruption, late responses, retry, reset/discard and navigation coverage. Three existing profile/settings cases ran with the parent suite; this does not expand the audit into settings.
- Client unit tests: **709 passed**, zero failures. [Unit log](final-client-tests.log.gz).
- Final layout: **72 state measurements per engine**, zero document overflow and zero unreachable enabled controls in the recorded measurement procedure. [Chromium geometry](evidence/chromium-matrix2/geometry-summary.json); [WebKit geometry](evidence/webkit-matrix2/geometry-summary.json).
- Build and git diff --check passed. ESLint: **0 errors, 19 existing warnings**. The build retains a large-chunk advisory. [Build log](layout-build.log.gz); [Lint log](layout-client-lint.log.gz). Server source was not changed; the full server unit suite was not rerun. Real local persistence paths were exercised by browser tests.
- All four new browser cases failed against B1 before passing on candidates. [Red baseline](red-baseline.log.gz). These failures are preserved.
- B3’s first matrix falsely treated disabled Send as a hit-test failure; the corrected harness records disabled controls and waits for Send to become available after saving. B3 WebKit exposed an oversized new sticky panel at 320px/200% text. The panel moved to normal flow in B4. Original measurements and timeouts remain; no automation-induced scroll/focus defect is asserted.
- An intermediate B4 direct-input probe tapped a point covered by the composer after resetting scroll; it is nonqualifying evidence, not an app defect. The corrected Chromium probe verifies the current hit target before tapping and passes. Playwright mobile WebKit rejects wheel input, so that extra probe is **not run** there. Native touch scrolling remains a device check.
- [Run ledger](run.json) retains 57 check records, original scopes, failures, replacements, substitutions and intermediate builds. [Runner validation](ledger-check.json) returns exit 3: valid but incomplete. This is not a claim that current local regressions are failing.

**Recommendations, separate from defects.**

- **R-01: explain draft lifetime.** The supporting copy “Unsent draft kept in this tab” is now implemented with F-01. Cross-tab/device draft synchronization is still a separate product choice.
- **R-02: attribute the load-performance concern before changes.** The original single throttled Chromium sample recorded LCP 5.140 s and max-session-window CLS 0.7965. Source attribution and production-equivalent asset delivery were not established. It remains an investigation recommendation; this run did not prescribe or apply a performance fix.

**Remaining device checks: 6 of 6, all NOT READY.** The fixed build is retained locally; no phone-reachable URL or tested device was provisioned. Existing C-D01–C-D06 remain in history; changed build B4 has linked replacement IDs. Exact OS/browser versions must be recorded when available. These hardware names are proposals, not supplied devices.

| Active ID | Proposed configuration | What remains to check |
|---|---|---|
| C-B4-D01 | iPhone 15 (proposed, availability unconfirmed); Safari, Bottom tab layout; exact iOS/Safari version not supplied | Draft retention, interruption and quota recovery |
| C-B4-D02 | Pixel 8 (proposed, availability unconfirmed); Chrome Android with gesture navigation; exact Android/Chrome versions not supplied | Composer, Android Back and recovery |
| C-B4-D03 | iPhone 15 (proposed, availability unconfirmed); Safari, Bottom tab layout; exact iOS/Safari version not supplied | Keyboard, safe areas and reach |
| C-B4-D04 | iPhone 15 (proposed, availability unconfirmed); Safari, Top tab layout; exact iOS/Safari version not supplied | Top toolbar geometry |
| C-B4-D05 | iPhone 15 (proposed, availability unconfirmed); Safari, Compact tab layout with VoiceOver; exact iOS/Safari version not supplied | Compact layout, VoiceOver and larger text |
| C-B4-D06 | Pixel 8 (proposed, availability unconfirmed); Chrome Android with TalkBack and gesture navigation; exact Android/Chrome versions not supplied | TalkBack, larger text and status feedback |

[Complete device script](device-checks.md) includes build/source identity, safe fixtures, separate build/setup confirmations, substitutions, state-specific steps and expected outcomes, stop conditions and blank result/evidence fields. Local Playwright interceptions do not automatically exist on a phone. No device-dependent fix was applied and no device check was charged as executed.

Beyond budget: iOS edge-swipe/pull-to-refresh/long-thread rubber-banding with focused IME; measured real-device performance. Field metrics are an open data need, not a phone-script entry.

**Preservation, cleanup and open items.**

The owned application files match B4 hashes. Existing Login.jsx, .impeccable/design.json and the unrelated review document match the before snapshot; existing ComposeBar link-focus and browser-test additions were preserved. PRODUCT.md changed independently during the run and was left intact. [Cleanup and preservation receipt](cleanup.json) records zero remaining run-owned Node/fixture processes. Only temporary test databases were removed; evidence and frozen builds remain. No existing service was stopped.

To complete target verification, the remaining inputs are a phone-reachable deployment of the hashed B4 build, disposable accounts/lessons, exact supported devices/OS/browser versions, and documented operator controls for delayed/failed saves and storage pressure. Real clipboard behavior, VoiceOver/TalkBack, browser chrome, native keyboards/IME/autofill, safe areas and tab-discard behavior remain open. Review and publication are separate actions; this run leaves the edits uncommitted.
