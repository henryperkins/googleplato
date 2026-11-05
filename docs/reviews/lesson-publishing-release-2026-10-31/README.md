# Lesson publishing release candidate — 2026-10-31

The user authorized committing the lesson work, merging it into `main`, pushing `main`, and deploying. This supersedes the delivery limits recorded in the earlier local-only design and verification notes.

## Resulting behavior

Authors generate and review a preview, then save it privately by default or explicitly make it public. The exact reviewed content and visibility are saved together through the existing versioned authoring queue. Existing recipients survive visibility changes; unconfirmed saves retain the same preview, visibility choice and operation identity for persistence-only retry.

The editor and lesson list expose visibility and sharing directly. Mobile finishing actions follow the preview, mobile rows retain full lesson titles and named actions, readiness has a definition and rubric, and all six admin destinations retain visible labels. Layout, typography, action wording, sharing counts and authoring guidance are consistent across the flow.

## Fresh local release checks

| Check | Result |
| --- | --- |
| `npm test` | 708 client tests passed; 889 server tests passed, with 3 optional PostgreSQL-dependent tests skipped locally; no failures. |
| `npm run lint` | Passed; no errors, 19 existing client warnings. |
| `npm run build:client` | Passed; existing bundle-size advisory remains. |
| `npm --prefix client run test:browser:publishing` | 18 passed in Chromium. |
| `npm --prefix client run test:browser:admin` | 24 passed in Chromium. |
| `git diff --check` | Passed. |

Earlier bounded WebKit, enlarged-text, interaction and independent-review evidence is recorded in the [publishing](../lesson-publishing-2026-10-31/README.md), [mobile](../lesson-mobile-refinement-2026-10-31/README.md), [layout/type](../lesson-layout-typeset-2026-10-31/README.md) and [polish](../lesson-polish-2026-10-31/README.md) notes. Those files describe their verification snapshots, including their then-uncommitted state.

## Portable rendered evidence

All records in these screenshots are synthetic local fixtures.

- [Desktop lesson editor](screenshots/editor-desktop-light.png).
- [Mobile review and save choices](screenshots/review-mobile-dark.png).
- [Mobile lesson list](screenshots/lessons-mobile-light.png).
- [Mobile visibility dialog with keyboard focus](screenshots/visibility-mobile-dark.png).

## Deployment and verification

The verified `plato-main` Cloud Build trigger deploys pushes to `main` to the existing `plato-shaped` Cloud Run service in `idk-4e9b9`, `us-east1`. Its gate runs lint, the full test suite with disposable PostgreSQL 17, a client build and the admin browser suite before building and deploying the image. The pipeline updates the app container while retaining the existing ingress sidecar and durable-storage configuration.

Release completion requires Cloud Build success, a ready Cloud Run revision serving 100% of traffic, matching public serving commit/revision headers, and matching built asset hashes. Git publication alone does not establish deployment. Release logs, recovery bundle and final production verification are retained in the operator's local release evidence directory.

No schema, provider, dependency, authentication, Cloud SQL or infrastructure change is included. Physical-device and spoken-screen-reader qualification remain outside the recorded browser evidence.
