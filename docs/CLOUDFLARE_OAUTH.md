# Connect Cloudflare for Workers AI

An administrator can connect the classroom's Cloudflare account from **Admin →
AI Settings → Cloudflare Workers AI → Connect Cloudflare**. Sign-in and consent
happen on Cloudflare. If more than one account is authorized, Plato asks which
account to use. This is one shared classroom connection, not a learner sign-in.

Connecting stores credentials immediately but does not change the saved AI
provider or model. Run **Test connection**, then **Save AI settings** to apply any
pending selections. The browser keeps those pending selections in session storage
during sign-in, scoped to the initiating administrator. If another administrator
changed the settings meanwhile, Plato loads the current settings for review.

## One-time registration

The server owner registers an OAuth client once in [Cloudflare OAuth clients](https://dash.cloudflare.com/?to=/:account/oauth-clients).
Use these settings:

| Setting | Value |
| --- | --- |
| Name | Plato |
| Grant types | `authorization_code` and `refresh_token` |
| Response type | `code` |
| Token authentication | `none` for a PKCE client, or `client_secret_post` for a confidential client |
| Required API scopes | `ai.read`, `ai.write`, `account-settings.read` |
| Refresh permission | `offline_access`, added by Cloudflare when the refresh-token grant is enabled |
| Redirect URL | Your exact `APP_URL` followed by `/v1/oauth/cloudflare/callback` |

For `https://plato-shaped.ai.studio`, the redirect URL is
`https://plato-shaped.ai.studio/v1/oauth/cloudflare/callback`.
For local development on port 3000, register
`http://localhost:3000/v1/oauth/cloudflare/callback` as another redirect.
The application uses PKCE for both client types. Clients registered with
`client_secret_basic` are not supported; choose one of the modes above.

A private client works for members of the Cloudflare account where it was
created. A public client can authorize other Cloudflare users and requires
publisher-domain verification. See [Cloudflare's registration documentation](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/).

## Server configuration

Configure these values on every API and streaming server instance:

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Canonical public origin, such as `https://plato-shaped.ai.studio`; HTTPS is required except on localhost |
| `CLOUDFLARE_OAUTH_CLIENT_ID` | Registered client ID |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Secret only when the client uses `client_secret_post`; leave empty for `none` |
| `CLOUDFLARE_OAUTH_ENCRYPTION_KEY` | One stable base64-encoded 32-byte key for encrypting stored credentials |

Generate the encryption key once:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep secrets out of source control and use the host's secret storage in production.
For local development, use the untracked `server/.env`. For Cloud Run, reference
the encryption key and optional client secret from Secret Manager. For Lambda,
the SAM parameters `CloudflareOAuthClientId`, `CloudflareOAuthClientSecret` and
`CloudflareOAuthEncryptionKey` supply both functions. Protect the parameters with
your deployment secret configuration; do not save secret values in SAM config.

Use a shared, durable database so connections and refresh leases survive instance
replacement and are visible to all instances. Local SQLite is suitable for local
development. A container's ephemeral filesystem does not provide durable storage.
Keep the same encryption key across restarts and deployments. Replacing the key
makes previously stored credentials unreadable and requires a new connection.

Restart or redeploy after configuring the OAuth client, then reload AI settings.
The **Connect Cloudflare** button becomes available once server configuration is
complete. Registering the client does not authorize an account; the administrator
still signs in and approves the Cloudflare consent screen.

## Renewal, disconnect and manual credentials

OAuth credentials take precedence over manually configured Workers AI credentials.
Access tokens are renewed shortly before expiry using the refresh token. A shared
database lease prevents concurrent requests from rotating the same refresh token.
An uncertain or failed refresh disables the connection and requires **Reconnect
Cloudflare**; Plato does not repeatedly submit an old refresh token or silently
switch to another account.

**Disconnect Cloudflare** requires confirmation and affects the entire classroom.
Plato first disables the browser connection locally, then attempts to revoke its
refresh and access tokens at Cloudflare. If revocation fails, it retains encrypted,
disabled credentials for **Retry revoking access**. You can also revoke Plato in
[Cloudflare's OAuth authorizations](https://dash.cloudflare.com/?to=/profile/access-management/authorization).
Neither a delayed authorization callback nor an in-flight refresh can restore a
disconnected connection. The selected AI provider and model stay saved.

Cleanup records are independent of the active connection. Connecting another
account does not discard a previous failed revocation, and **Retry revoking
access** preserves the newer classroom connection. Credentials returned after a
disconnect, failed account discovery, or abandoned account selection are revoked
or retained encrypted for retry. Cleanup uses its own conditional ownership and
lease so it cannot revoke credentials that are being activated or are active.
If a connection is still finishing, another Connect attempt waits; explicit
disconnect can cancel the pending activation.

After explicit disconnect, manual `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
credentials, if configured, are available again. Disconnect does not remove those
environment settings. A successful OAuth connection does not establish model or
billing access; use **Test connection** for the selected model. Normal provider
usage charges apply to tests and AI requests.

## When AI requests fail

Only conditions an administrator must fix ask for **Reconnect Cloudflare** or
server setup. The browser gets `ai_unavailable` for these:

- The connection was disabled after a failed or uncertain renewal.
- Stored credentials can't be read, for example because the encryption key changed.
- The OAuth client ID changed, or browser connection setup is incomplete.
- No browser connection or manual credentials exist.

Other credential failures don't ask anyone to reconnect a working account:

- **Temporary (`ai_overloaded`):** another request is renewing the token and
  didn't finish within 15 seconds. Non-streaming agents retry automatically.
- **Server error (`ai_error`):** the database couldn't be read, or another
  unexpected error happened.

Every failed request logs `ai_provider_error` with `stage: credentials` and a
`reason` ([fields](INFERENCE_TELEMETRY.md#failure-diagnostics)). Disabling the
connection also logs `cloudflare_oauth_reconnect_required` once, from the request
that disabled it, however many requests then fail. It records how the renewal
failed:

| Field | Meaning |
| --- | --- |
| `trigger` | `refresh-failed`, or `refresh-lease-expired` when another request took the renewal lease and never finished, so its token may have been rotated |
| `reason` | The renewal failure's reason, usually `failed` |
| `http_status` | The token endpoint's status, when it answered (`400` usually means the grant was revoked or expired) |
| `error_name`, `cause_code` | The transport failure, such as `TimeoutError`, or `TypeError` with `ECONNRESET` |

No token, authorization code or response body is logged. If learners report
that AI stopped working, check **Admin → AI Settings** and Cloud Logging for this
event first.

## Protocol and data boundaries

The flow uses Cloudflare's [documented OAuth endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
and the fixed account discovery endpoint under `api.cloudflare.com`. Requests
reject redirects and have a timeout. Upstream error bodies, authorization codes,
PKCE verifiers and access/refresh tokens are never included in settings responses
or application error messages. Callback responses disable caching and referrer
transmission, then redirect to AI settings with a fixed result code.

Only account identity, connection state and credential-presence flags reach the
settings page. Credentials are encrypted in the server database under the reserved
`_integrations` principal, outside user synchronization and `_system` settings.
User synchronization rejects reserved server principals, including administrators'
view-as-user requests. Cleanup records never enter a browser sync response.
The callback has no application bearer header, so it checks the browser binding,
one-use state, expiry and current administrator role before exchanging a code.
