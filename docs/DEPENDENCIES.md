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
