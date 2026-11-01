# Invitation-only Google sign-in verification

Google sign-in no longer creates an account for any verified Google address. A
new account needs an invite link or a pending email invite, as password signup
does. The operator's `ADMIN_EMAIL` is the only exception and the only address
made an admin. Without an invitation, `POST /v1/auth/firebase` answers
`403 invite_required` and creates or consumes nothing.

The sign-in page then replaces its form with an invitation-only page, modelled
on the restricted-community page the owner supplied as a reference:

- It names the address used and offers **Back to sign in**, which returns focus
  to the Sign in heading. The page heading takes focus when it appears.
- When the wait list is open, **Join the wait list** opens the form prefilled
  with Google's email and name.
- A wait-listed address is told it is on the list. The entry is kept for an
  admin to invite; before this change, Google sign-in consumed it and created
  the account.
- An expired emailed invitation asks for a new one. This is best effort: the
  DynamoDB backend may already have removed an expired invite.
- Otherwise, it points to the program admin.

The hard-coded admin address is removed from the Google route, the Lambda
cold-start promotion and the local SQLite bootstrap.

## Validation

| Check | Result |
| --- | --- |
| Server suite | 896 passed; 3 PostgreSQL-dependent tests skipped locally (no `POSTGRES_TEST_URL`). |
| Client suite | 711 passed. |
| Invitation-only browser suite | 5 passed in Chromium. |
| Existing browser suites | Learner recovery 27, customizer 26, admin responsive 24 and publishing 35 passed in Chromium. |
| Lint | Passed; 19 existing client warnings. |
| Client build | Passed; existing bundle-size advisory. |

The new server admission tests and client auth-module tests for the
no-invitation cases failed against the preceding code and pass now.

The browser suite substitutes Google only: the lazily loaded Firebase chunk and
the server's reply to the verified token, which a local server can't verify.
Route tests cover the server path with a stubbed token verifier. Real Google
sign-in, the production deployment, physical phones and spoken screen readers
remain unverified.

## Screenshots

| Wait list open | On the wait list | Wait list closed |
| --- | --- | --- |
| [390px light](screenshots/join-wait-list-390-light.png) | [390px light](screenshots/on-wait-list-390-light.png) | [1280px dark](screenshots/wait-list-closed-1280-dark.png) |
