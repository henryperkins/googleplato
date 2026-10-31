# Mobile lesson feedback verification

This follow-up resolves the three findings from the second mobile review:

- Opening the editor preserves the title, saved status and workspace tabs.
- Existing content has one Refresh preview control beside its state, including
  when stale. Final save/update choices remain after the reviewed content.
- A refresh error comes into view while Preview is visible and focus remains on
  its control or has not moved since activation. The control describes the error;
  background failures preserve Refine's focus and scroll position.

Authoring still follows a new submitted turn, stops when the reader scrolls
away, and preserves review position while chat is hidden. The new browser
coverage exposed a WebKit layout-generated scroll event with unchanged offsets;
the authoring-only filter now distinguishes that from an actual scroll. Learner
chat retains its default initial pinning and event handling.

## Validation

| Check | Result |
| --- | --- |
| Client suite | 708 passed. |
| Server suite | 889 passed; 3 optional PostgreSQL-dependent tests skipped locally. |
| Final authoring/publishing browser suite | 35 passed in Chromium; 35 passed in WebKit. |
| Learner recovery browser suite | 19 passed. |
| Admin responsive browser suite | 24 passed. |
| Lint | Passed; 19 existing client warnings. |
| Client build | Passed; existing bundle-size advisory. |
| Scoped design detector and diff checks | Passed; no detector findings. |
| Independent technical review | No remaining Critical, Important or Minor findings; reviewer independently passed 39 scrolling-decision tests. |

The original finding regressions failed against the preceding build before their
corrections. The WebKit post-submit regression also failed before the offset
correction, then passed. Additional guards cover actual scroll-away, responsive
scrollport changes, hidden replies, failed background refreshes, and tab return.

Learner and admin browser results were retained after the final correction,
which is restricted to the explicit authoring endpoint and is exercised by both
final publishing suites. All browser records are synthetic; preview generation
uses controlled replies. Exact reviewed saving is also checked through the real
local API and disposable SQLite. No paid inference or production-data writes
were used for these checks.

This is local and browser-emulation evidence. Physical-phone keyboard, browser
chrome, safe areas, spoken screen readers, live AI and authenticated production
admin saves remain unqualified. Independent technical review is not a submitted
GitHub approval; the owner requested the merge in the Codex conversation.

## Screenshots

| Editor entry | Stale preview refresh | Visible refresh failure |
| --- | --- | --- |
| [390px light](screenshots/editor-entry-390-light.png) | [320px dark](screenshots/stale-refresh-first-screen-320-dark.png) | [320px WebKit dark](screenshots/refresh-error-visible-320-dark.png) |

Pre-merge review added a refreshed scroll baseline on hidden-panel return and
separate tracking of the activated preview control and current focus. New tests
cover activation leaving the document focused and deliberate focus changes.
A native-layout hook harness uses a minimal lifecycle adapter and a controlled
unchanged-offset scroll event to verify resumed following; it is mechanism
evidence, not full React lifecycle or physical-device qualification.

GitHub review, hosted checks and the automatic main-branch release are recorded
on [PR #35](https://github.com/henryperkins/googleplato/pull/35).
