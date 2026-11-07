# Workspace dependency maintenance

Install dependencies from the repository root with `npm ci`. The root
`package-lock.json` covers the client, server, and plugin SDK workspaces.

## Firebase Firestore gRPC override

The root `package.json` overrides `@grpc/grpc-js` to `1.14.6` only beneath
`@firebase/firestore`. Firestore 4.18.0, shipped by Firebase 13.0.0, requests
`~1.9.0` and otherwise installs the affected 1.9.16 release. Firestore 4.19.0
still requests that older series, so updating Firebase alone does not remove
the affected dependency as of 26 October 2026.

Version 1.14.6 includes the fixes for
[GHSA-m9gg-hp2v-232j](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j)
and
[GHSA-f596-whhp-79r4](https://github.com/grpc/grpc-node/security/advisories/GHSA-f596-whhp-79r4).
The override leaves Firebase Authentication and the separately patched Cloud
SQL dependency unchanged. Firebase remains required for Google sign-in; the
Firestore SDK is also used by the retired-mirror rules tests.

When changing or removing this override:

1. Regenerate the root lockfile and run a clean `npm ci`.
2. Inspect `npm ls @grpc/grpc-js --all` and `npm audit` for affected copies.
3. Run the Firebase authentication lifecycle/session tests and the Firestore
   rules suite against a disposable local emulator using
   `FIRESTORE_EMULATOR_HOST=127.0.0.1:<port> npm run test:firestore`.
4. Run the normal unit, lint, build, and browser gates. The Firebase Auth module
   must still load in the browser; emulator tests do not qualify live Google
   OAuth or production Firestore access.

Remove the override when Firestore's own dependency range selects a patched
release and the compatibility checks above pass without it.

## Launch remediation and development-only exception — 6 November 2026

`shadcn` is a development CLI and lives in the client's `devDependencies`.
The production image builds the client before pruning development packages.
The root override pins `rimraf` to `6.1.4`, selecting patched `glob` 14 and
`minimatch` 11 for the Cloud SQL connector's cleanup dependencies. The root
also pins `follow-redirects` to `1.16.2`; its former server-workspace override
did not take effect. Keep the server's `@hono/node-server` at `2.1.5` and
`google-gax` at `5.0.8`. Do not move the client's incompatible Hono-server
override to the root, and do not use `npm audit fix` for these changes.

The checked production dependency set has **zero audit findings**. Full audit
reports 13 affected development packages through the two advisories below;
that count includes dependent packages and is not 13 separate advisories.
The owner chose to retain the Firestore-rules lint tooling. This exception
expires **6 December 2026**, or earlier when compatible patched dependencies
become available. Recheck it with `npm audit`, `npm explain minimatch` and
`npm explain deepmerge`; a new production finding is outside this exception.

| Advisory | Exact affected installed path and version | Development dependency chains |
| --- | --- | --- |
| [deepmerge prototype poisoning](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) | `node_modules/deepmerge` `4.3.1` | `client → shadcn@4.22.1 → deepmerge`, and `shadcn → @shadcn/registry@0.2.0 → deepmerge` |
| [minimatch pattern amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) | `node_modules/@ts-morph/common/node_modules/minimatch` `10.2.6` | `client → shadcn@4.22.1 → ts-morph@26.0.0 → @ts-morph/common@0.27.0 → minimatch` |
| Same minimatch advisory | `node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch` `10.2.6` | `@firebase/eslint-plugin-security-rules@0.0.2 → @typescript-eslint/parser` and `@typescript-eslint/rule-tester → @typescript-eslint/utils`, each reaching `@typescript-eslint/typescript-estree@8.72.0 → minimatch` |
| Same minimatch advisory | `node_modules/eslint/node_modules/minimatch` `10.2.6` | root `eslint@10.13.0 → minimatch`, and `eslint → @eslint/config-array@0.23.5 → minimatch` |

As checked on this date, deepmerge has no patched release and these tools'
minimatch ranges do not accept patched 11.x. Treat imported CLI configuration
and glob patterns as trusted repository inputs while the exception remains.
The ESLint 9 workspace copies use minimatch 3.1.5 and are outside this advisory.
The separate [glob cancellation advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
is resolved by the rimraf override rather than accepted as an exception.
