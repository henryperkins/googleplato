# Google Sign-In plugin

Optional Google authentication through Firebase Authentication. Password accounts, invitations, roles, plato sessions, and other plugins remain host-owned.

## Behavior

- While enabled, Login, Setup, and Signup discover Google through `GET /v1/auth/providers` and lazy-load this plugin's client module.
- The browser completes a Firebase Google popup, then sends only the Firebase ID token and onboarding fields to `POST /v1/plugins/google-auth/exchange`.
- The plugin verifies the token's signature, issuer, audience, subject, Google provider claim, and verified email. It then calls the host's `completeExternalAuth` service.
- Core performs account lookup/creation, invitation checks, role assignment, classroom setup, `userCreated` hooks (including Slack), and plato access/refresh-token issuance.
- Firebase's temporary browser session is signed out after every completed exchange attempt, including rejected admissions and failures. Ordinary plato sessions do not need Firebase afterward.
- While disabled, discovery omits Google, the exchange route returns 404, and the client module is not imported. Disabling does not revoke already-issued plato sessions.

There is no core `/v1/auth/firebase` alias.

## Configuration

The manifest contains the existing Firebase web defaults. Admins can replace them on **plato → Plugins → Google Sign-In**. `apiKey`, `authDomain`, `projectId`, `appId`, and `messagingSenderId` are public Firebase web configuration, not server credentials; only the manifest's `publicSettings` allowlist is returned by discovery. `projectId` is also the required ID-token issuer and audience on the server.

In the Firebase console:

1. Enable **Authentication → Sign-in method → Google**.
2. Add every deployment hostname to **Authentication → Settings → Authorized domains**.
3. Use the same Firebase web app and project in all plugin settings.

Do not put a service-account key, OAuth client secret, or other credential in these settings. The plugin needs only the public web configuration.

## Tests

```bash
node --test plugins/google-auth/server/*.test.js
node scripts/validate-plugins.js
```

The server suite covers admission, setup, existing accounts, token validation, public configuration, and disabled-route/module isolation. Client coverage lives with the client auth suite and the invitation browser suite.
