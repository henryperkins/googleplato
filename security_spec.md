# Retired Firestore data access

Plato learner data is stored by the server API. Firebase Authentication remains
for Google sign-in and sign-out; it grants no Firestore data access.

The active policy in `firestore.rules` denies all mobile/web client reads and
writes on every document path in the named Plato database. There are no owner,
verified-email, bootstrap-admin or admin-marker exceptions. Former user profiles,
private account details, sync records, admin markers, collection-group queries
and live listeners are all denied. Future collection paths are denied too.

`firebase.json` targets only
`ai-studio-plato-196eecf7-5744-4762-b19b-47cbd67015e6` in project `idk-4e9b9`.
The unrelated `event-manager` database and Firebase Auth remain outside this
rules deployment. A `(default)` database is not created or targeted.

Executable regressions live in `client/tests/firestore-rules.test.js`, replacing
the former static `firestore.rules.test.ts` fixture list. They run against the
actual Firebase rules emulator using synthetic anonymous, owner and former
admin contexts. They verify denied get/list/create/update/delete operations,
collection-group access and subscriptions. The removed mirror schema is
historical data shape, not an active write contract; Git history preserves it.

Run with a local emulator:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run test:firestore
```

Privileged server/IAM requests bypass Firestore security rules. A successful
read-only inventory does not establish client access. Keep operational tokens
outside the repository and never use production data for rules tests.

The [retirement runbook](docs/FIRESTORE_RETIREMENT.md) records the consistent
empty-source recheck, local validation, publication boundary and rollback rules.
