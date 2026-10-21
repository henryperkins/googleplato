# Firestore learner-data retirement

The server API owns accounts, lesson transcripts, progress, profiles and image
records for both Google and password sign-ins. Firebase Authentication remains
responsible for the Google popup and sign-out; the server verifies its ID token
and issues the same Plato session used by password accounts. Password reset
stays on the server API.

## Current implementation and evidence

The empty-source recheck completed October 20, 2026, at 11:46:33 p.m. CDT
(`2026-10-21T04:46:33.320290Z`). The inspected resource is:

```text
projects/idk-4e9b9/databases/ai-studio-plato-196eecf7-5744-4762-b19b-47cbd67015e6
```

At one common read time, root collection discovery exhausted pagination with no
collections. Collection-group queries for `users`, `private`, `syncData` and
`admins` returned no documents. Direct `users` and `admins` listings, including
missing-parent paths, were empty. Queries projected document names and did not
collect learner payloads. See the [machine-readable recheck](reviews/firestore-retirement-empty-recheck-2026-10-20.json).
No importer, database reset or learner-data migration is needed for that snapshot.

The production prerequisite is already established: `b43a1cc` is live at
`https://plato-shaped.ai.studio` on Cloud Run with Cloud SQL PostgreSQL, durable
atomic lesson saves, strict conditional writes, stale-client fencing and
persistence-only recovery. A replacement-instance exercise retained messages,
lesson state and screenshots; retries added no model calls or duplicate turns.

This change removes Firestore profile initialization at Google login and all
mirror writes/deletes/atomic-commit copies from `storage.js`. The obsolete
`firebaseClient.js`, mirror schema and static payload-fixture list are removed.
Server-only cache hydration stays in `sync.js`. The Firebase dependency stays
because Firebase Auth still needs it; it must not load a Firestore data path.

`firestore.rules` now denies every client read and write, including former
owner/admin grants, collection-group queries and live subscriptions. The
deployment configuration names only the Plato database. It does not target
`event-manager`, create a `(default)` database, disable the shared project's
Firestore API, or modify Firebase Auth.

**Publication boundary:** this is the implementation and local-validation slice.
The checked-in rules and client changes must still be published in the cutover.
This implementation task does not publish Firestore rules or deploy Cloud Run.

## Local validation

Install the root lockfile with Node 24 and `npm ci`. Use a local Firestore
emulator and a disposable PostgreSQL 17 instance, then run:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
POSTGRES_TEST_URL=postgres://postgres@127.0.0.1:55432/postgres \
npm test
npm run lint
npm run build:client
```

The Firestore emulator must be running before those commands. The SDK's
`@firebase/rules-unit-testing` harness loads the actual `firestore.rules` file
into an isolated `demo-plato-retirement-*` project and seeds only synthetic
records through its rules-disabled test context. It accepts a loopback emulator
host only and never uses production credentials. A compatible Java runtime is
needed when starting the official emulator. See
[Firebase's rules-testing guide](https://firebase.google.com/docs/firestore/security/test-rules-emulator).

Run just the rules regression with:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run test:firestore
```

Without `FIRESTORE_EMULATOR_HOST`, the rules suite is explicitly skipped, like the
PostgreSQL suite without `POSTGRES_TEST_URL`. A run with either integration suite
skipped does not qualify a cutover. GitHub-hosted Actions are permanently
unavailable for this repository; use local validation and independent review.

Client regressions exercise the actual auth/storage/sync modules against
controlled Firebase and HTTP boundaries. They verify Google token exchange,
server-only saves/deletes/atomic acknowledgements, retained failed replies,
reset/reload authority and parity with password accounts. Existing account
switch, impersonation, screenshot, stale-client and save-retry tests remain.
Google sign-out waits for SDK restoration and actual cleanup while local Plato
logout stays immediate; another Google popup stays gated until cleanup settles.
Both sign-in providers exercise persistence-only recovery without another model
call. Rules tests prove former owner and admin access fails, not merely that the
rules source contains a deny statement.

## Cutover and rollback

1. Immediately before publication, repeat the read-only named-database inventory
   at a common read time. If any record or missing-parent path appears, retain
   it and stop the empty-source cutover. Reconcile content lineage, timestamps,
   attachment references and reset/deletion evidence; independent version
   counters do not authorize overwriting the server.
2. Confirm the serving API and rollback artifact keep protocol `1`, shared epoch
   `1`, strict writes and canonical server hydration. Do not derive the epoch
   from the Cloud Run revision. Preserve pending-turn journals and account-scoped
   drafts; an in-flight generation or failed recovery readback blocks reload.
3. Publish the deny-all rules to the exact named database above. Confirm its
   released source matches this file and recheck emptiness after closing the
   client-write window. IAM clients bypass security rules: inventory/admin access
   must not be mistaken for a successful mobile/web-client access test.
4. Deploy the qualified client/server artifact while preserving Cloud SQL and
   existing configuration. Check Google and password login, reset/admin edits,
   reload/account switch, image recovery and persistence-only retry. New bundles
   must contain no Firestore SDK chunk and issue no Firestore data requests.

Rollback keeps the server-only ownership and deny-all rules. Use a qualified
compatible artifact and the same Cloud SQL database and epoch; never restore a
Firestore backfill, subscription or write path. Do not restore a whole database
over newer learner work. No Firestore document deletion is required by the empty
snapshot, and no permission to delete another database is implied.
