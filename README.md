# Login reflow and link-fetch focus evidence

Review artifacts for source commit `ebab465a9a1bf00d67faf0f892f739e5dcd3f804` on
`fix/local-login-link-reconciliation-20261105`. The screenshots contain synthetic
local fixture data. This branch contains no application changes or private
recovery material.

## Source identity

- Base: `6377a9d2182f4915709fb2fbf72da85c14c5ffa0`
- Source commit: `ebab465a9a1bf00d67faf0f892f739e5dcd3f804`
- Files: `PRODUCT.md`, `client/src/pages/Login.jsx`,
  `client/src/components/chat/ComposeBar.jsx`, and
  `client/tests/browser/learner-recovery.test.js`
- Diff: 147 insertions and 13 deletions
- SHA-256 of the full-index binary Git diff from the base:
  `9195b8b7357c88d41a155f5c297b5adecfe56ef3a7fc51c5926c2dca0dfb44bd`

The source diff was qualified before its commit on 2026-11-05. Byte-for-byte
identity with that tested patch was checked again before publication. Publication
reused those complete runs and did not repeat unchanged suites. A separate
read-only code review found no actionable Critical, Important, or Minor issue.
That technical review does not replace independent GitHub approval.

## Recorded local checks

| Check | Result |
| --- | --- |
| Client unit suite | 763 passed, no failures or skips |
| Server unit suite | 927 passed, no failures, three PostgreSQL-dependent skips |
| Client lint | No errors; 19 existing warnings in unchanged files |
| Server lint | No errors or warnings |
| Production client build | Passed; existing chunk-size advisory also occurs on the base |
| Chromium 149.0.7827.55 learner suite | 30/30 passed |
| WebKit 26.5 learner suite | 30/30 passed |
| Impeccable detector | No findings in the two changed UI files |
| Diff, baseline reconstruction, and protected-worktree preservation | Passed |

Environment: Node 24.21.0, npm 11.19.0, and Playwright 1.61.1.
Chromium ran at 2026-11-05 15:50:27–15:51:27 UTC; WebKit ran at
15:50:27–15:51:35 UTC.

The enlarged-text and pending-link-focus regressions failed against the baseline
build for the intended reasons. The deliberate-focus-movement control already
passed on the baseline. All three new cases passed in both candidate suites.
Existing retry deduplication, failed-draft unload protection, account isolation,
pagination, and learner recovery coverage remained in place.

Login measurements covered 24 states per browser: clean and invalid forms, both
themes, widths of 320/390/430/844/1440 CSS px, and root text at 100% or 200% for the
selected viewport scenarios. The link flow used a 390 × 844 CSS px viewport. The
fixtures used mobile/touch contexts, including at wider widths.

Each browser run recorded 55 DOM snapshots with meaningful content, no framework
error overlays, and no unhandled page exceptions. Console messages were accounted
for: expected missing retained-coach lookups, injected request/network failures,
the existing fixture's missing optional client-events endpoint, and WebKit's
existing unsupported interactive-widget viewport directive. Console output was
not empty.

## Screenshot provenance

[login-before-after.png](login-before-after.png) combines two Chromium screenshots:
the baseline failure and passing candidate at 320 CSS px and 200% root text.
Shared branding above the card is cropped out; full viewport width is retained.
Labels were added during composition. Document heights differ because text wraps.

[link-focus-detail.png](link-focus-detail.png) crops the candidate's Chromium URL
validation failure screenshot to the composer. It shows retained input focus,
the invalid-URL message, and correction/cancellation controls. Pending focus was
also checked through assertions while the request was held.

## Limits

Browser fixtures used isolated temporary SQLite databases and deterministic AI
and link responses. They did not make live provider calls. The three server skips
cover PostgreSQL persistence/concurrent writers, PostgreSQL branding transactions,
and the production entrypoint's save-event integration, because no
`POSTGRES_TEST_URL` was supplied.

These results do not qualify physical devices, native keyboards, screen readers,
live OAuth, live AI, Cloud SQL, production, or browser telemetry delivery. Hosted
CI is separate from these local results; consult the PR for its current status.

Private recovery archives, original dirty work, and local Impeccable configuration
remain outside this evidence branch.

