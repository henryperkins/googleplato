# Customizer implementation — November 5, 2026

Knowledge updates could previously generate and publish unseen replacement content when the preview was stale. This change requires a current reviewed preview, adds direct text editing alongside conversation, clarifies state/help text, and improves mobile branding and review layouts.

## Result

- Knowledge saving persists only the current reviewed Markdown. Missing, stale, or unreviewed text cannot be saved, and saving never invokes extraction.
- Conversation and Edit text share a document draft. **Review text changes** places the exact text in the preview. Conversation requests receive manual corrections, and extraction uses the current text as its starting point.
- Direct entry through **Edit text** / **Write text** does not start inference and does not require a readiness score.
- Failed generation retains the existing document and text. Failed HTTP requests and unconfirmed acknowledgements retain reviewed bytes for persistence-only retry. The existing barrier still waits for pending conversation draft writes.
- Readiness has a visible numeric score, a persistent definition, and an explicit 3/10 generation minimum. Saving follows review in reading order. The viewer confirms an acknowledged save and explains its classroom use.
- Appearance places identity first, keeps the desktop light/dark comparison, and offers one selected theme preview below 40 rem. Local touch controls grow, and compact save/status areas stay above phone navigation. Short viewports let actions scroll normally.
- The sections are named Appearance and Program knowledge. Editing modes use associated accessible tab panels; preview samples remain inert.

Document edits remain in the mounted editor until saved or explicitly abandoned. Navigation/reload guards protect them. Conversation drafts retain their existing server auto-save behavior; this pass does not add durable recovery for unsaved direct-text documents.

## Verification

Publication qualification runs in an isolated worktree based on `origin/main` at `6377a9d2182f4915709fb2fbf72da85c14c5ffa0`. The table records this scoped candidate, rather than results from the original mixed checkout.

| Check | Result |
| --- | --- |
| Client unit suite | 764 passed, zero failed |
| Server suite | 927 passed, zero failed, 3 environment-dependent skips |
| Customizer browser suite | 31 passed, zero failed |
| Client and server lint | Exit 0; client has 17 warnings, zero errors; server clean |
| Production client build | Passed; existing large-chunk advisory remains |
| Impeccable final source scan | Zero deterministic findings across four changed JSX components |
| Render checks | 11 configurations; zero document-width overflow, uncaught page errors, or inference requests |
| Whitespace check | `git diff --check` passed |

Browser regressions use authenticated real local SQLite writes and controlled model-response fixtures. They cover raw Unicode/Markdown preservation, explicit text review, stale-save prevention, failed/malformed acknowledgement retry, manual corrections reaching both AI boundaries, independent resource failures, pending draft ordering, metadata refresh races, logo safeguards, keyboard/focus behavior, and existing branding contracts.

An independent fresh-context code review found one Important issue: effect replay in development StrictMode could strand initial opening in Starting. A real Vite development-client regression reproduced it before the fix. Startup is now scheduled only by the surviving effect, with cleanup cancelling the probe; the test covers opening failure, retry, direct-text fallback, and absence of abandoned inference requests. No other substantive findings were reported.

Render checks cover 1440 px desktop, 820 px intermediate, 390 px and 320 px phone viewports, a 740 × 390 short viewport, both themes, and 200% text sizing with long unbroken content. Text enlargement is not browser-zoom or physical-device qualification. Physical keyboards/onscreen keyboards, screen readers, cross-browser behavior, browser chrome/safe areas, production Cloud SQL, and live model output remain unqualified. Validation makes no real AI or email calls and does not qualify a deployment.

## Preservation and evidence

The publication branch was assembled with a scoped temporary index and applied to the current remote main in an isolated worktree. Only Customizer source, tests, documentation, and selected screenshots are included. Unrelated local learner/chat changes and Impeccable workspace artifacts are excluded. Upstream documentation updates are retained.

The original checkout remains on its original main commit. Its HEAD, index, status, and 666 pre-publication file hashes are checked separately; recovery snapshots are retained outside the repository.

The pass updates `DESIGN.md` and the relevant architecture prose. The plan is in [2026-11-05-customizer-implementation.md](../superpowers/plans/2026-11-05-customizer-implementation.md).

Screenshots from the isolated candidate:

- [Desktop Knowledge editor](assets/customizer-implementation-2026-11-05/knowledge-text-desktop-light-reviewed.png)
- [Mobile Knowledge review](assets/customizer-implementation-2026-11-05/knowledge-text-mobile-dark-reviewed.png)
- [Mobile Appearance](assets/customizer-implementation-2026-11-05/appearance-mobile-dark.png)

## Update against main (November 5, 2026)

`main` was merged at `831b7cc`, which includes #42's sign-in reflow and link-field
focus fixes and #38's invitation-only Google sign-in. There were no conflicts;
`docs/ARCHITECTURE.md` keeps both the invitation sections and this branch's edits.

A narrow-layout pass at 320, 390 and 430 px, with default, 150% and 200% text,
found two problems from this branch. Both appear only with enlarged text:

- The renamed section tabs overflowed a centered tab row whose phone styles turn
  off scrolling, so both labels were clipped and the start of the row could not
  be reached. This happened from 150% text at 320 px and at 200% text at every
  width. The editing-mode tabs clipped at 320 px with 200% text.
- The pinned action bars, whose buttons stack at these sizes, covered 30–90% of
  the scrolling area. On Appearance at 320 px with 200% text, Save sat below the
  visible page.

Container queries in rem follow the page's text size, unlike media queries. When
the Customizer is narrower than 16 rem, which on phones happens only with enlarged
text, the tabs now wrap onto full-width rows and the action bars scroll with the
page. Default text is unchanged: the bars stay pinned and cover 13–17% of the
scrolling area. A browser case covers this and failed before the change.

The shorthand-hex Save test presses by raw coordinates at 1440 × 1000. This
branch's preview heading moved Save's center just below that viewport, so the
press missed. The test now scrolls Save into view first. The suite's timeout now
allows its WebKit run, which takes about 80 seconds.

Unsaved direct-text documents still have no durable recovery, as noted above.

### Validation at the update

Every check ran from a `git archive` export in `node:24-bookworm-slim` with a
disposable PostgreSQL 17, starting with `deploy/cloudrun/cloudbuild.yaml`'s test
step verbatim.

| Check | Result |
| --- | --- |
| Lint | 0 errors; 17 warnings in other client files. |
| Client suite | 766 passed. |
| Server suite | 955 passed, including the PostgreSQL suites; none skipped. |
| Admin responsive (deploy gate) | 24 passed in Chromium. |
| Customizer suite | 32 passed in Chromium and 32 in WebKit. |
| Learner recovery and invitation-only suites | 31 and 6 passed, in Chromium and in WebKit. |
| Lessons list and publishing suites | 14 and 35 passed in Chromium. |

| 320 px, 200% text: before | After |
| --- | --- |
| [Section tabs clipped; action bar covering the page](assets/customizer-implementation-2026-11-05/appearance-320-text200-before.png) | [Tabs on full-width rows; actions scroll with the page](assets/customizer-implementation-2026-11-05/appearance-320-text200-after.png) |
