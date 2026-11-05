**B5 device handoff: six checks, all NOT READY.**

Build B5 is the isolated publication candidate. Confirm the committed source and [source manifest](source-manifest.json), [asset manifest](asset-manifest.json), and actual phone-reachable URL before running. No URL or physical device is provisioned. Build substitutions: synthetic Firebase config. Setup and phone-specific additions: unknown until reported. Local Playwright intercepts do not run on a phone.

**C-B5-D01 — Draft retention, interruption and quota recovery**

iPhone 15 (proposed, availability unconfirmed); Safari, Bottom tab layout; exact iOS/Safari version not supplied. Replaces C-B4-D01.

Prerequisites:

- Provision B5 assets matching publication/asset-manifest.json behind a phone-reachable test URL; confirm source identity with publication/source-manifest.json and committed source.
- Seed disposable learner accounts and lessons using the retained fixture; deliver credentials separately.
- Record exact hardware/OS/browser, toolbar and accessibility settings; confirm actual test-backend/provider wiring.
- Provision same-build delay/failure/quota setup only for steps that need it; otherwise mark those portions not run.

Steps:

1. Sign in to B5 test classroom as a disposable learner; open Give constructive feedback. Type a unique draft, attach one synthetic image and link, navigate away/back, then reload.
2. Send once; record local-recovery, waiting, save failure/retry and confirmed-save feedback separately. Test operator must provide a same-build save-delay/failure control before running those states.
3. In a second disposable tab/account, retain Earlier retained draft; use Safari Web Inspector to exhaust only this test origin sessionStorage, then enter the longer sample. Confirm the persistent retention warning. Keep the tab open; remove only audit-quota, activate Retry keeping draft, then reload and compare exact text/images/link.
4. Background the browser, return to the same tab and note whether the document actually reloaded. If no reload/discard occurred, mark that portion not run. Reopen an acknowledged response in a fresh tab.

| State | Expected | Result / evidence |
|---|---|---|
| 1 | Ordinary draft text/image/link preserved through route and reload. | Not run; ______ |
| 2 | Local recovery, server pending, failed and saved states distinguishable; retries preserve one response. | Not run; ______ |
| 3 | Storage failure explicitly warned; current writing remains available to copy/retry; no silent rollback. | Not run; ______ |
| 4 | Saved server response reopens; genuine tab-discard retention separately recorded. | Not run; ______ |

Stop conditions:

- Stop if build/source identity differs; record not run and request a new check ID.
- Stop if any origin, account or backend is production or fixture identity cannot be confirmed.
- Stop a missing setup/state rather than recording a pass; do not use real personal content.

Actual device / OS / browser / CSS viewport / orientation / text scale / keyboard state: ______

Build confirmation and evidence: ______

Setup confirmation, substitutions and evidence: ______

Result / notes / screenshots: ______

**C-B5-D02 — Composer, Android Back and recovery**

Pixel 8 (proposed, availability unconfirmed); Chrome Android with gesture navigation; exact Android/Chrome versions not supplied. Replaces C-B4-D02.

Prerequisites:

- Provision B5 assets matching publication/asset-manifest.json behind a phone-reachable test URL; confirm source identity with publication/source-manifest.json and committed source.
- Seed disposable learner accounts and lessons using the retained fixture; deliver credentials separately.
- Record exact hardware/OS/browser, toolbar and accessibility settings; confirm actual test-backend/provider wiring.
- Provision same-build delay/failure/quota setup only for steps that need it; otherwise mark those portions not run.

Steps:

1. Open B5 test lesson in portrait; focus composer with keyboard open, type multiline text, add a link and reach Send. Rotate to short landscape and repeat.
2. Expand and collapse browser toolbar/gesture-bar area; record overlap and visible Send in each state.
3. Open outline; use Android system Back once, reopen then close with X. Repeat with account menu. Record route, draft and focus each time.
4. Go offline using airplane mode after lesson loads; send synthetic text, then reconnect and Retry response. Reload/reopen; verify one saved response. Have the test operator read the fixture record.

| State | Expected | Result / evidence |
|---|---|---|
| 1 | Composer, link field and primary action remain reachable in portrait and landscape. | Not run; ______ |
| 2 | Toolbar/gesture-area movement does not cover actions. | Not run; ______ |
| 3 | Back closes eligible topmost overlay without losing lesson/draft; app navigation remains usable. | Not run; ______ |
| 4 | Offline error preserves input; explicit retry stores once; saved work reopens. | Not run; ______ |

Stop conditions:

- Stop if build/source identity differs; record not run and request a new check ID.
- Stop if any origin, account or backend is production or fixture identity cannot be confirmed.
- Stop a missing setup/state rather than recording a pass; do not use real personal content.

Actual device / OS / browser / CSS viewport / orientation / text scale / keyboard state: ______

Build confirmation and evidence: ______

Setup confirmation, substitutions and evidence: ______

Result / notes / screenshots: ______

**C-B5-D03 — Keyboard, safe areas and reach**

iPhone 15 (proposed, availability unconfirmed); Safari, Bottom tab layout; exact iOS/Safari version not supplied. Replaces C-B4-D03.

Prerequisites:

- Provision B5 assets matching publication/asset-manifest.json behind a phone-reachable test URL; confirm source identity with publication/source-manifest.json and committed source.
- Seed disposable learner accounts and lessons using the retained fixture; deliver credentials separately.
- Record exact hardware/OS/browser, toolbar and accessibility settings; confirm actual test-backend/provider wiring.
- Provision same-build delay/failure/quota setup only for steps that need it; otherwise mark those portions not run.

Steps:

1. Open B5 lesson in portrait with long coach content; expand then collapse Safari toolbar.
2. Focus composer and link field; type multiline response, add/remove a synthetic attachment; record keyboard open/closed and Send reach.
3. Rotate to short landscape; scroll coach text and composer; repeat with browser toolbar expanded/collapsed.
4. Pinch to 200 percent and restore; open outline, scroll to bottom, close and record scroll/focus. Try one-thumb and two-thumb grip, reporting missed taps separately.

| State | Expected | Result / evidence |
|---|---|---|
| 1 | No action hidden by toolbar, notch or home indicator. | Not run; ______ |
| 2 | Native keyboard permits accepted text/URL characters; focus and actions stay usable. | Not run; ______ |
| 3 | Landscape permits reading and submission without scroll traps. | Not run; ______ |
| 4 | Zoom and overlay dismissal preserve draft and reading access; grip results are observations, not inferred. | Not run; ______ |

Stop conditions:

- Stop if build/source identity differs; record not run and request a new check ID.
- Stop if any origin, account or backend is production or fixture identity cannot be confirmed.
- Stop a missing setup/state rather than recording a pass; do not use real personal content.

Actual device / OS / browser / CSS viewport / orientation / text scale / keyboard state: ______

Build confirmation and evidence: ______

Setup confirmation, substitutions and evidence: ______

Result / notes / screenshots: ______

**C-B5-D04 — Top toolbar geometry**

iPhone 15 (proposed, availability unconfirmed); Safari, Top tab layout; exact iOS/Safari version not supplied. Replaces C-B4-D04.

Prerequisites:

- Provision B5 assets matching publication/asset-manifest.json behind a phone-reachable test URL; confirm source identity with publication/source-manifest.json and committed source.
- Seed disposable learner accounts and lessons using the retained fixture; deliver credentials separately.
- Record exact hardware/OS/browser, toolbar and accessibility settings; confirm actual test-backend/provider wiring.
- Provision same-build delay/failure/quota setup only for steps that need it; otherwise mark those portions not run.

Steps:

1. Select Safari Top layout and confirm B5 URL/build.
2. In portrait expand/collapse toolbar, focus composer and attach-link field, submit one synthetic response.
3. Rotate to landscape with keyboard open, inspect title/outline/composer/Send and home/notch edges. Close keyboard and return portrait.

| State | Expected | Result / evidence |
|---|---|---|
| 1 | Title/navigation/composer remain available in both toolbar states. | Not run; ______ |
| 2 | Keyboard and short landscape retain primary-action access. | Not run; ______ |
| 3 | Response and next draft remain intact through rotation/return. | Not run; ______ |

Stop conditions:

- Stop if build/source identity differs; record not run and request a new check ID.
- Stop if any origin, account or backend is production or fixture identity cannot be confirmed.
- Stop a missing setup/state rather than recording a pass; do not use real personal content.

Actual device / OS / browser / CSS viewport / orientation / text scale / keyboard state: ______

Build confirmation and evidence: ______

Setup confirmation, substitutions and evidence: ______

Result / notes / screenshots: ______

**C-B5-D05 — Compact layout, VoiceOver and larger text**

iPhone 15 (proposed, availability unconfirmed); Safari, Compact tab layout with VoiceOver; exact iOS/Safari version not supplied. Replaces C-B4-D05.

Prerequisites:

- Provision B5 assets matching publication/asset-manifest.json behind a phone-reachable test URL; confirm source identity with publication/source-manifest.json and committed source.
- Seed disposable learner accounts and lessons using the retained fixture; deliver credentials separately.
- Record exact hardware/OS/browser, toolbar and accessibility settings; confirm actual test-backend/provider wiring.
- Provision same-build delay/failure/quota setup only for steps that need it; otherwise mark those portions not run.

Steps:

1. Select Compact layout; enable VoiceOver; record OS text-size setting and test default then enlarged text.
2. Browse lessons, open via named action, read coach message and type a response using native dictation/IME if available.
3. Submit and listen to local-recovery, pending, success and induced-failure announcements; record each separately. Test-operator delay/failure controls must be ready first.
4. Open/close outline with VoiceOver and navigate back to lesson list; return and read retained work. Repeat short landscape.

| State | Expected | Result / evidence |
|---|---|---|
| 1 | Named actions and reading order usable; enlarged text does not remove content/actions. | Not run; ______ |
| 2 | Status changes understandable without rereading the whole log. | Not run; ______ |
| 3 | Focus returns usefully; draft and saved response retained. | Not run; ______ |

Stop conditions:

- Stop if build/source identity differs; record not run and request a new check ID.
- Stop if any origin, account or backend is production or fixture identity cannot be confirmed.
- Stop a missing setup/state rather than recording a pass; do not use real personal content.

Actual device / OS / browser / CSS viewport / orientation / text scale / keyboard state: ______

Build confirmation and evidence: ______

Setup confirmation, substitutions and evidence: ______

Result / notes / screenshots: ______

**C-B5-D06 — TalkBack, larger text and status feedback**

Pixel 8 (proposed, availability unconfirmed); Chrome Android with TalkBack and gesture navigation; exact Android/Chrome versions not supplied. Replaces C-B4-D06.

Prerequisites:

- Provision B5 assets matching publication/asset-manifest.json behind a phone-reachable test URL; confirm source identity with publication/source-manifest.json and committed source.
- Seed disposable learner accounts and lessons using the retained fixture; deliver credentials separately.
- Record exact hardware/OS/browser, toolbar and accessibility settings; confirm actual test-backend/provider wiring.
- Provision same-build delay/failure/quota setup only for steps that need it; otherwise mark those portions not run.

Steps:

1. Enable TalkBack, record browser/OS text and display scaling; open B5 classroom.
2. Choose lesson and read coach message; use composer and attach-link error/correction; repeat with 200 percent browser text/zoom setting and landscape.
3. Submit with operator-provided pending/failure states; report every announced status and recovery action separately.
4. Close outline with Android Back, navigate away/back, then reopen an acknowledged response from a fresh tab.

| State | Expected | Result / evidence |
|---|---|---|
| 1 | Accessible names/order and error corrections permit task completion. | Not run; ______ |
| 2 | Status feedback distinguishes retained/pending/saved/failed without focus theft. | Not run; ______ |
| 3 | Text enlargement, Back and return preserve access and work. | Not run; ______ |

Stop conditions:

- Stop if build/source identity differs; record not run and request a new check ID.
- Stop if any origin, account or backend is production or fixture identity cannot be confirmed.
- Stop a missing setup/state rather than recording a pass; do not use real personal content.

Actual device / OS / browser / CSS viewport / orientation / text scale / keyboard state: ______

Build confirmation and evidence: ______

Setup confirmation, substitutions and evidence: ______

Result / notes / screenshots: ______
