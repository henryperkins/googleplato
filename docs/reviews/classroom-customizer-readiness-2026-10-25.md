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
| `POSTGRES_TEST_URL=... npm test` | Client 536/536; server 791/791; zero skips |
| Customizer Chromium | 19/19 |
| Customizer WebKit | 19/19 |
| Customizer Firefox | 19/19 |
| `npm run lint` | Zero errors; 20 existing warnings |
| `npm run build:client` | Passed |
| Plugin tests / manifests | 6/6 tests; all three manifests valid |
| `git diff --check` | Passed |
| Independent final agent review | Pending |

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

## Recovery UI

[Desktop recovery notice](classroom-customizer-readiness-2026-10-25/blocked-logo-desktop.png)
and [phone viewport recovery notice](classroom-customizer-readiness-2026-10-25/blocked-logo-phone.png)
show the original preserved without rendering it. These are browser viewport
captures, not physical-device or assistive-technology evidence.
