# Google Sign-In plugin notes

- Keep Firebase imports and configuration inside this plugin. Core must not reintroduce Firebase initialization, Google icons, provider-specific errors, or `/v1/auth/firebase`.
- `publicSettings` is a public allowlist. Never add a secret or a `writeOnly` setting to it.
- Verify identity here, but delegate admission and session issuance to `completeExternalAuth`. Do not duplicate invitation, role, account-creation, or token logic.
- Require a Google provider claim, subject, verified email, and the configured project as issuer/audience.
- Always run Firebase cleanup after popup/exchange attempts. Do not load Firebase for ordinary plato logout or authenticated storage.
- Disabled means no discovery result, no route, no client import, and no server-module evaluation. Add a regression test when changing activation or lazy loading.
- Firestore deny-all rules, Cloud SQL's `google-auth-library`, and Cloudflare OAuth are separate systems; do not couple them to this plugin.
