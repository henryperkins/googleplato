# Nested-page startup and navigation announcements

Direct entry to `/plato/customizer` caused AI Studio's injected service-worker
registration to request `/plato/_service-worker.js`. The application's SPA
fallback returned HTML, which the browser rejected as a worker script. After
the signed-out redirect, a separate bug left the live region saying
`Navigated to Classroom Customizer` on the Sign in page. Both were reproduced
against production before implementation and predate the logo-derived theme
release. The October 20 durability review also records the hosting error.

The client HTML now wraps the registration API before the hosting load handler
can run, replacing only the exact `./_service-worker.js` argument with
`/_service-worker.js`. Other worker URLs and the browser's receiver, options,
registration promises and errors pass through. The host continues to provide
its current worker; the app does not carry a copy. No ingress, database or
Cloud Run configuration changes are needed. If the hosting template adopts the
root URL, this wrapper naturally passes it through.

Navigation announcements now follow the auth guards. Protected admin pages are
announced only for an authenticated admin; guest pages wait for the guest
guard; Privacy remains public. Public pages have labels matching their headings
and retain ownership of their dynamic document titles, including the
invitation-required sign-in view. An unnamed or unresolved destination clears
the prior live-region message.

## Validation

- The worker URL unit regression failed first with a nested script URL. Four
  worker tests then passed, covering root scope, unrelated registrations,
  preserved options/promises/receiver, failed registration, and no-worker support.
- Three browser regressions failed before the fix and passed afterward: native
  worker registration on fresh and warm nested entries; Sign in after a
  protected redirect without a transient inaccessible-page announcement; and
  clearing the previous announcement while a lesson title remains unresolved.
- `npm test`: 787 client tests passed; 936 server tests passed and three
  environment-dependent integration tests skipped.
- `npm --prefix client run test:browser:admin`: all 29 Chromium cases passed.
  These include the new regressions, so they run in the existing Cloud Build
  deployment gate.
- The three targeted browser regressions also passed in WebKit.
- Client build passed. Client/server lint passed with zero errors and the 17
  existing client warnings. `git diff --check` passed.

The browser harness uses an isolated SQLite database and a loopback HTTP proxy
that simulates the hosting injection. It exercises native worker registration
without external AI calls. This is browser and DOM evidence; physical
screen-reader speech and authenticated production workflows are not qualified
by these checks. Live release identity and production verification are recorded
separately after publication.
