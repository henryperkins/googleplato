# Login reflow and link-fetch focus evidence

Review artifacts for [PR #42](https://github.com/henryperkins/googleplato/pull/42),
source commit `36f38bf98e75721b2125da940a2996ce5c6c5e5b`. Screenshots contain synthetic local fixture data.
This evidence branch is separate from the four-file application change.

## Source identity

- Base: `6377a9d2182f4915709fb2fbf72da85c14c5ffa0`
- Current source: `36f38bf98e75721b2125da940a2996ce5c6c5e5b`
- Initial source: `ebab465a9a1bf00d67faf0f892f739e5dcd3f804`
- Files: `PRODUCT.md`, `client/src/pages/Login.jsx`,
  `client/src/components/chat/ComposeBar.jsx`, and
  `client/tests/browser/learner-recovery.test.js`
- Combined diff: 201 insertions and 14 deletions
- SHA-256 of the full-index binary Git diff from the base:
  `1fe65692cbd417eb0dba134caa25f0b32cb378ffa63741fc14cd46f400fc54f4`

The application and browser-test files match qualified commit
`1bcc8c0d88c61fe79d4a0f1169e83335b9e12463` byte for byte. The final commit only
clarifies that completing first-sign-in Google setup on an empty database creates
an admin regardless of email; both role-assignment branches were checked against
`server/src/routes/auth.js`. Completed runtime checks were reused for this prose
correction. A separate read-only review found no actionable issue in the preceding
runtime follow-up. Technical review does not replace formal GitHub approval.

## Review follow-up

Keyboard activation of Add dropped focus when the button became disabled during
a link fetch. A real browser regression first failed at the pending-focus
assertion on the initial source build. The button now uses its existing
`focusableWhenDisabled` option only while fetching. The test covers Tab, Space,
pending Enter/Space suppression, rejection, keyboard correction, Enter retry,
and one successful attachment with focus restored to the composer.

The login geometry check now requires labels to fit within their own buttons as
well as the card. PRODUCT.md also records the empty-database bootstrap condition,
Google onboarding's configured and legacy admin-role exceptions, and the
password-reset-before-invitation path. Authentication behavior is unchanged.

## Local qualification

| Check | Result |
| --- | --- |
| Fresh client tests | 763 passed; no failures or skips |
| Fresh client lint | No errors; 19 existing warnings in unchanged files |
| Fresh client production build | Passed; existing chunk-size advisory |
| Chromium 149.0.7827.55 learner suite | 31/31 passed |
| WebKit 26.5 learner suite | 31/31 passed |
| Impeccable detector | No findings in the two changed UI files |
| Original full server run | 927 passed; no failures; three PostgreSQL-dependent skips covered below |
| Focused PostgreSQL follow-up | 27 passed; no failures or skips |
| Original server lint | No errors or warnings |
| Diff identity and protected current-main files | Passed |

The fresh client checks ran on 2026-11-05. Chromium ran at 16:36:31–16:37:33 UTC;
WebKit ran at 16:36:31–16:37:41 UTC. Environment: Node 24.21.0, npm 11.19.0,
Playwright 1.61.1. Server code and package manifests/locks are unchanged since the
server and PostgreSQL checks, so those completed runs remain applicable.

The PostgreSQL 17.11 run exercised all three previously skipped groups:
persistence/concurrent writers, branding transactions, and save-event reports
through the production HTTP entrypoint. Its three selected files also contain
SQLite, DynamoDB, and development-entrypoint checks. The 27 passes are a focused
follow-up; do not add them to 927 as if the cases were disjoint. The digest-pinned,
loopback-only, disposable database used synthetic fixtures. Its temporary schemas
and task-owned container were removed after testing.

Both browser suites include all 27 original learner cases and four added cases.
Login checks cover 24 states per engine across clean/invalid forms, light/dark
themes, widths from 320 to 1440 CSS px, and 100%/200% root text for the selected
scenarios. Both runs captured 58 DOM snapshots across 32 pages: meaningful content,
no framework error overlays, no unhandled page exceptions, and no capture errors.
Console output was accounted for: expected absent retained-coach lookups,
injected response/network failures, omitted fixture telemetry, and WebKit's
existing unsupported viewport directive. External Google script requests were
blocked by the fixture's origin rule. Console output was not empty.

## Logs and screenshots

- [Qualification details and original log hashes](review-followup-qualification.json)
- [Expected failure before the Add-button fix](button-focus-before-fix.log)
- [Chromium follow-up run](browser-chromium-followup.log)
- [WebKit follow-up run](browser-webkit-followup.log)
- [PostgreSQL test output](postgres-tests.log)
- [PostgreSQL source, image, isolation, and cleanup record](postgres-qualification.json)

The browser logs replace local filesystem roots with placeholders; their test
results and assertions are unchanged. The JSON records hashes of the original
local logs. The PostgreSQL record retains the exact initial source identity;
no server or dependency file changed in the later source commit.

[add-button-pending.png](add-button-pending.png) and
[add-button-rejected.png](add-button-rejected.png) are unedited 390 × 844 CSS px
Chromium screenshots from the fresh follow-up. Both show the focused Add button;
pending/rejected focus and disabled behavior were also checked by assertions.
Matching WebKit screenshots were inspected and are retained locally.

The earlier [login-before-after.png](login-before-after.png) and
[link-focus-detail.png](link-focus-detail.png) remain unchanged. They were captured
for the initial source commit. The login comparison crops shared branding above
the card and adds baseline/candidate labels; the link image crops the composer.
Current follow-up checks revalidated both behaviors. These older screenshots are
not represented as captures of the later source commit.

## Limits

Browser fixtures used isolated temporary SQLite databases and deterministic AI
and link responses. No live provider calls were made. Local PostgreSQL results do
not establish Cloud SQL or production behavior. Physical devices, native
keyboards, screen readers, live OAuth, live AI, and browser telemetry delivery
remain unqualified. Hosted Actions remain unavailable because of account billing;
consult the PR for current check and review status.

Original dirty work, private recovery archives, local hook configuration, and
unrelated fork/upstream work remain outside this branch and application PR.
