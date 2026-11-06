# Upstream handoff: Google auth plugin

This is a contribution checklist for later upstream work, not evidence that the upstream integration branch is merged or release-qualified. The implementation lives on local `main` at fork base `257680d`. `feat/upstream-launch-integration` (`af7d982`) is only a reconciliation reference.

No upstream issue or PR is created by this document.

## Contribution shape

Contribute the host contract and `plugins/google-auth/` together:

1. Add the `publicAuthProvider` slot, `auth.provider` capability, `extensionPoints.authProvider` schema/type declarations, and public `GET /v1/auth/providers` discovery.
2. Add provider-neutral `completeExternalAuth(identity, options)`. Keep account lookup/creation, invitations, role assignment, classroom setup, `userCreated`, and plato access/refresh-token issuance in core. The Google plugin should only verify Firebase identity and call this service.
3. Move Firebase browser initialization, the Google icon/error mapping, popup exchange, and temporary-session cleanup into the plugin. Remove core `/v1/auth/firebase`; this fork needs no backward-compatible alias or user migration.
4. Lazy-load plugin client modules only while enabled. A disabled provider must be absent from discovery and UI, return 404 from its exchange route, and cause no Firebase initialization or provider network activity.
5. Include the host fixes this plugin depends on: strict field-scoped activation/settings writes, consistent-read reconciliation before dispatch, fail-closed activation reads, recursive `writeOnly` redaction, manifest-declared `userDeleted`, and disabled uninstall tombstones.
6. Include atomic `updateUserMeta` and the teacher-comments conflict retries if those host fixes have not landed separately. The Google plugin does not depend on teacher-comments behavior, but it does depend on the activation fixes above.

Update all contract surfaces together: `PLUGIN_API_VERSION`, the JSON schema, SDK types, capability labels, extension inventory, and plugin documentation. The local host is `1.4.0`; if upstream has already used that number for another contract, assign the next appropriate minor and update `google-auth/plugin.json` and `teacher-comments/plugin.json` rather than reusing a divergent version.

## Reconcile with the upstream launch branch

The integration branch changes several auth-adjacent contracts. Preserve them when replacing its core Firebase path; do not paste this fork's older account code over the newer branch.

### Split names

- Upstream uses `firstName`, `lastName`, and `nameSource`, with `readNameInput` / `nameFields`.
- Thread those fields through external setup/signup options, user creation, and session response serialization. Use the upstream name validation and source rules for both password and external accounts.
- Preserve Google's display name only as input to that shared name pipeline. Do not restore a single `name`-only external-auth response.

### Roles

- Use upstream `normalizeRole` and its canonical `learner` role for newly invited external accounts, session responses, JWT signing, and `userCreated` payloads.
- Preserve the existing rule that an invited person never becomes an admin and that only the configured operator/first setup receives the admin role.

### Existing-account invitations (`forUserId`)

- External signup must reject an invite whose `forUserId` is set, both when a token is supplied and when looking up a pending invite by email.
- Those invites belong to the signed-in classroom acceptance flow, not public signup. Keep the upstream invite-preview and acceptance behavior unchanged.
- Preserve invite expiry, email matching, atomic link-usage limits, wait-list profiles, and Slack linkage.

### Session-generation and account-switch guards

- Keep upstream's `captureAuthSession`, `isAuthSessionCurrent`, `refreshCurrentUser`, expected-credential storage writes, and late-response protections intact.
- Replace only `loginWithGoogle` with generic `adoptAuthSession(session, provider)`. Adoption must advance the same session generation before storing the core-issued tokens. When wiring the provider exchange, capture the starting generation and verify it before adoption as well, so a late external response cannot overwrite a newer login.
- Do not reintroduce Firebase IndexedDB probing or provider SDK loading into ordinary logout. Firebase cleanup belongs to the plugin exchange attempt.

### Slack auto-invite

- External account creation must await the same `userCreated` emission as password account creation, after the user is persisted and with the canonical role.
- Preserve upstream Slack auto-invite's fresh-settings read, email matching, per-user result recording, idempotent channel behavior, and non-fatal error handling.
- Activation reconciliation must not bypass enabled Slack hooks or accidentally run disabled ones. Test both Google and password account creation with Slack enabled and disabled.

### Startup and release reconciliation

- The integration branch's current startup runs `initializeLaunch()` before `seedDefaultContent()`, while its migration test expected the opposite order. Resolve that upstream-specific ordering/test mismatch deliberately; this plugin handoff does not change it.
- Treat `af7d982` as unqualified. Its final recorded e2e run was 115/117 before the last fixes were rerun. A successful Google plugin test does not qualify the larger branch.

## Tests to contribute

- Firebase token validation: bad/missing/oversized tokens, wrong provider, missing subject, unverified email, and configured project issuer/audience.
- Existing account, invited account, invite link, operator, first setup, wait-list, expired invitation, role, split-name, and `forUserId` cases.
- Public discovery allowlist and no-secret exposure; no providers while disabled.
- Disabled route/server-module isolation and disabled client-module/no-Firebase-import coverage.
- Session adoption, refresh rotation, logout, late-response/account-switch races, and Firebase cleanup after success, rejection, and failure.
- Password auth and invitation regression suites, Slack auto-invite, all other plugin tests, manifest validation, lint, client build, and browser invitation/setup/signup coverage.
- On the integrated branch, rerun the complete upstream e2e suite and the fork's full server/client/browser suites; do not rely on the earlier 115/117 record.

## Explicit boundaries

- Leave Firestore deny-all rules and the retired Firestore data path unchanged.
- Leave Cloud SQL's `google-auth-library` dependency unchanged; it is unrelated to browser Google sign-in.
- Leave Cloudflare OAuth unchanged; it is a separate authentication surface.
- Do not merge, push, deploy, or open a PR until the maintainer approves that stage.
