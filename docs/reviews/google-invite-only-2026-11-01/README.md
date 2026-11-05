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

## Update against main (2026-11-05)

`main` was merged at `1b8f0f4`, which includes #42's sign-in reflow and link-fetch
focus fixes and its product-record corrections. The only textual conflict was
`client/package.json`, where both branches added a browser-suite script; both
are kept. The sign-in page keeps #42's wrapping buttons, guidance and recovery
link alongside the invitation page.

- `PRODUCT.md`'s admission record, which #42 left describing open Google
  onboarding as a known gap, now records invitation-only Google sign-in and no
  longer names a hard-coded admin address.
- Route tests now pin behavior this change keeps: existing accounts, admins
  included, sign in through Google without an invitation lookup and keep their
  roles, and the first Google account on an empty database still becomes the
  admin without an invitation.
- A browser case holds the invitation page to the sign-in form's enlarged-text
  bar from #42: in both themes, at 320, 390 and 1440 px and with 200% text,
  every heading, paragraph and button label stays inside the card and its
  button, with no horizontal scroll. It found the heading and description
  clipped at 320 px with 200% text, because "Membership" was wider than the
  card. The heading now breaks inside a word when it must, as the address on
  the page already did.

### Validation at e2d75a8

Every check ran from a `git archive` export in `node:24-bookworm-slim` with a
disposable PostgreSQL 17, starting with `deploy/cloudrun/cloudbuild.yaml`'s test
step verbatim.

| Check | Result |
| --- | --- |
| Lint | 0 errors; 19 existing client warnings. |
| Client suite | 765 passed. |
| Server suite | 955 passed, including the PostgreSQL suites; none skipped. |
| Admin responsive (deploy gate) | 24 passed in Chromium. |
| Invitation-only suite | 6 passed in Chromium and 6 in WebKit. |
| Learner recovery (includes #42's sign-in layout cases) | 31 passed in Chromium and 31 in WebKit. |
| Lessons list, publishing, customizer | 14, 35 and 26 passed in Chromium. |

The enlarged-text case failed before the heading change. The existing-account
and first-setup tests describe unchanged behavior and pass before and after it.
Google stays substituted in the browser, as above. Real Google sign-in, Cloud
SQL, production, physical phones and spoken screen readers remain unverified.

| 320 px, 200% text: before | After |
| --- | --- |
| [Heading and description clipped](screenshots/invitation-320-text200-before.png) | [All text inside the card](screenshots/invitation-320-text200-after.png) |
