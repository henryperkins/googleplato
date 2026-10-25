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

Tracked in [the implementation plan](../superpowers/plans/2026-10-25-customizer-readiness.md).
