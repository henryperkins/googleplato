/**
 * Root-level bridge for the server plugin SDK.
 *
 * Plugins in `/plugins/<id>/server/*.js` import `../../../src/lib/plugins/sdk.js`
 * (which in AWS SAM points to the Lambda root `src/lib/plugins/sdk.js`, and in
 * the repository layout resolves to `<repo>/src/lib/plugins/sdk.js`).
 * Re-exporting from `server/src/lib/plugins/sdk.js` ensures both local dev,
 * server tests, and Lambda builds resolve the exact same singleton instances.
 */

export * from '../../../server/src/lib/plugins/sdk.js';
