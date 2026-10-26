# Customizer PR #23 readiness follow-up

Starting point: `fb179f9`, following the completed `e2ce942` remediation.
The requested scope is to address every actionable readiness finding, including
the separately identified password-reset response leak. Preserve unrelated work,
existing branding originals, authentication boundaries, and all three databases.

## Acceptance criteria

1. Publishing a logo, saving its bytes, and deleting the obsolete asset are one
   version-checked transaction. Competing requests cannot delete the active logo,
   publish a missing asset, or leave partial changes after failure.
2. Primary-only and accent-only edits preserve independent changes made by other
   administrators. Match primary has explicit clearing semantics. Existing API
   clients that replace the complete theme remain supported.
3. Stored SVGs receive the same expansion budget as new SVG uploads. Compatible
   editor metadata and static styles remain supported. Unsafe or unsupported
   originals are retained, never rendered in the Customizer or public pages,
   and can be downloaded or explicitly replaced/removed by an administrator.
4. Newly served logo responses require revalidation, including conditional GETs.
   Removing an origin asset cannot erase bytes already downloaded or previously
   cached under the old immutable policy; document that limit.
5. Reset-email delivery and token-storage failures produce the same public status
   and body for registered and unregistered addresses. Log a bounded operational
   failure without addresses, reset tokens, links, or provider exception text.
6. Regressions fail on the starting code and pass on the finished change. Run
   the full client/server suites, real disposable PostgreSQL tests, browser
   Customizer checks, lint, build, and an independent final agent review.

The reported `storeLogo` conditional-insert race was a false positive: version
zero is unconditional without `strictVersion`. The transactional replacement
must retain successful identical uploads and handle real settings conflicts.
The favicon initial fallback remains intentional.

GitHub-hosted Actions are permanently unavailable per `CLOUD_RUN_STORAGE.md`.
Local checks and independent review qualify this branch; merging/deployment and
marking the PR Ready remain separate user decisions.

## Implementation and evidence

Implementation is tracked in [the plan](../superpowers/plans/2026-10-25-customizer-readiness.md).

| Finding | Implemented behavior | Regression evidence |
| --- | --- | --- |
| Delayed cleanup could delete a restored, active logo. | SQLite, PostgreSQL and DynamoDB publish settings/assets and delete the previous asset in one version-checked transaction. | `branding-concurrency.test.js` reproduces the original route interleaving on real SQLite; `branding-persistence.test.js` exercises real SQLite/PostgreSQL, competing creates and rollback, plus DynamoDB transaction contracts. |
| One color edit resent both stale colors. | The client sends `themePatch` with only changed color keys. `accent:null` clears the override. The server merges into current settings and keeps full `theme` replacement compatibility. | `stylesDraft.test.js`, branding route cases, and a real browser stale-form test in both directions, including Match primary. |
| Stored SVGs bypassed expansion limits. | Stored and new SVGs share structural and rendering budgets, including namespace aliases, CSS resources and inherited paints. Compatible editor styles remain supported; unsupported originals are preserved and available to the administrator as attachments. | `branding-svg.test.js`, inline/asset route cases, and a browser regression checking no preview, exact download bytes, keyboard activation, unrelated saves and explicit removal. |
| Removed logos remained usable from immutable caches. | Future 200/304 responses require revalidation; removed origin assets return 404 with no-store. Previously downloaded/cached copies cannot be revoked. | Conditional 200/304/404 route coverage in `branding-concurrency.test.js`. |
| Password reset disclosed accounts when token storage or SES failed. | Known and unknown addresses receive HTTP 200 `{ok:true}` even after lookup/storage/delivery failure. Logs contain only the fixed failure stage. | `password-reset-privacy.test.js` first reproduced 500 responses, then verified identical responses, secret-free logs, and successful token/message creation through a stubbed SES transport. |

The new regressions were run failing before implementation. The cleanup race also
had a passing `e2ce942` comparison in the preceding review; the color-patch and
stored-SVG failures were reproduced on the initial PR head. No changes were made
to the intentional initial favicon for wordmarks wider than 2:1.

## Qualification

Local checks use Node 24.21.0 and a throwaway PostgreSQL 17 container bound only
to localhost. The two SQL adapters run against actual databases. DynamoDB
coverage verifies transaction construction and error handling without an AWS table.

| Check | Result |
| --- | --- |
| `POSTGRES_TEST_URL=... npm test` | Client 537/537; server 794/794; zero skips |
| Customizer Chromium | 19/19 |
| Customizer WebKit | 19/19 |
| Customizer Firefox | 19/19 |
| `npm run lint` | Zero errors; 20 existing warnings |
| `npm run build:client` | Passed |
| Plugin tests / manifests | 6/6 tests; all three manifests valid |
| `git diff --check` | Passed |
| Independent final agent review | Addressed `9f045fc` and `566079d` review findings with regression-tested fixes below. |

The committed browser runner now selects Chromium, WebKit or Firefox with
`PLATO_TEST_BROWSER`; it does not need a modified temporary test copy. The
initial Firefox launch found its exact Playwright executable absent; installing
that browser resolves the environment prerequisite before the final run. A
minimal standalone page then isolated a Firefox automation distinction:
Playwright `page.reload()` emitted zero beforeunload dialogs, while
`location.reload()` emitted one. The navigation regression now requests an
ordinary document reload and requires the dialog; it no longer swallows a
missing-dialog timeout. This changes the test harness, not the page guard.

No live SES delivery, real DynamoDB table, physical device or screen-reader
qualification was performed. Password-reset status/body parity does not claim
constant response timing. No production settings or deployment were changed.

## Independent review and final fix pass

One fresh GPT-6 Astra reviewer examined the entire PR from `32f5748` through
`9f045fc`, including the initial follow-ups. It found two Important issues:

1. Equal colors could accidentally clear a newer accent. A primary edit equal
   to the stale accent sent `accent:null`; an accent edit equal to the stale
   primary also became a clear instead of the literal color entered. Patch
   generation now follows each field's edit and the explicit Match primary
   choice. The new unit regression and strengthened browser stale-form test
   failed first, then passed. Unchecking Match primary without changing the
   effective color remains a no-op.
2. Explicit `mask="inherit"` and `clip-path="inherit"`, plus context paints,
   bypassed the expansion budget. The validator now resolves explicit mask/clip
   inheritance at every descendant, while retaining their non-inherited
   defaults. It rejects `context-fill`/`context-stroke` until their rendering
   context is modeled. New/stored expansion fixtures failed first, then passed;
   bounded inherited masks/clips still display. Blocked originals retain their
   existing recovery controls.
3. A follow-up review at `566079d` found that `linkedom`'s CSSOM map kept only
   the last duplicate property declaration (allowing `mask:url(#next) !important; mask:url(#dummy)`
   to charge `#dummy` while browsers rendered `#next`), let `image-set("https://...")`
   slip past `url(...)` checks, and left `password_reset_request_failed` without
   a Cloud Monitoring alert policy. Further inspection of the same CSSOM/inheritance
   path also showed that duplicate properties without `!important` (`mask:url(#next); mask:123`),
   leading-parenthesis values (`opacity: (); fill: url(#next)` and `.decoy { fill: (;) } rect { ... }`),
   and invalid child `fill="123"` attributes inside `<g fill="url(#p)">` could hide
   active browser declarations from `linkedom`'s CSSOM or shadow ancestor `fill`/`stroke`
   inheritance. `svgSafety.js` now parses rules and declarations directly without
   `linkedom`'s CSSOM map, rejects `!important` and external CSS image functions
   (`image-set`, `-webkit-image-set`, `image`, `src`, `cross-fade`, `element`),
   keeps auto-inherited `fill`/`stroke` resources in the budget on painted descendants,
   and returns `false` directly from `boundedSvg` on malformed CSS. `deploy/cloudrun/monitoring.js`
   also adds the `password-reset-failure` log-match alert policy on `password_reset_request_failed`.

The fix pass was verified with focused regressions and the complete suites,
rather than claiming a second independent approval of the amended code. This
was agent review; the repository still requires an approving review for merge.

The review's explicitly unqualified areas remain recorded: equal reset-response
timing, revocation of old downloaded/cached copies, the intentional initial
favicon above 2:1, and real SES/DynamoDB/device/screen-reader behavior. A reset
timing difference could still reveal information; the implemented privacy
contract covers response status/body and operational logs. No actionable minor
findings were deferred.

## Recovery UI

[Desktop recovery notice](classroom-customizer-readiness-2026-10-25/blocked-logo-desktop.png)
and [phone viewport recovery notice](classroom-customizer-readiness-2026-10-25/blocked-logo-phone.png)
show the original preserved without rendering it. These are browser viewport
captures, not physical-device or assistive-technology evidence.
