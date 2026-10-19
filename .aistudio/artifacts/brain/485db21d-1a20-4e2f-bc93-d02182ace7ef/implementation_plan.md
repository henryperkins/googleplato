# Fix Google Sign-In & Enable Seamless Google Onboarding

Resolve the Google Sign-In failure on the login page by enabling verified Google users without an existing account or invite to sign in immediately, automatically provisioning learner accounts, and delivering clear, human-readable error diagnostics.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following user preferences were confirmed during the clarification interview:
> - **Open Access for Verified Google Accounts**: Any user signing in with a verified Google account will be permitted to access Plato directly. If no account or invite exists yet, a new learner account will be provisioned automatically on the fly rather than rejecting them with an invite-required error.
> - **Login Flow Diagnostic Clarity**: The generic error banner above the sign-in form will be replaced with specific, user-friendly guidance for authentication errors (e.g. popup closure, domain configuration issues, network blips, or unverified emails).
> - **Data & Firestore Synchronization**: New Google sign-ins will automatically initialize their Firestore user profile and isolated PII info record (`users/{uid}/private/info`) adhering to `firebase-blueprint.json` and `firestore.rules`.

---

## 1. Overview & Core Concept

Currently, Plato's backend `/v1/auth/firebase` endpoint restricts Google sign-in to users who already have an account in Plato's SQLite/DynamoDB database, or who hold a pending invite / waitlist token. When an uninvited user clicks "Continue with Google" on `/login`, the server returns an HTTP 403 `INVITE_REQUIRED` response, which surfaces as a generic error above the sign-in form.

This change upgrades the authentication pipeline so that:
1. When a user authenticates with Google on `/login` and passes Firebase token verification, Plato checks if an account already exists.
2. If no user exists, Plato seamlessly provisions a new learner account (`role: 'user'`), auto-generates a friendly username from their Google profile/email, issues auth tokens, and logs them in immediately.
3. If they had a pending waitlist entry or invite token, it automatically marks it consumed and links their information.
4. If an unexpected error occurs during Firebase authentication (such as network disconnection or popup cancellation), the client displays contextual, actionable error messaging instead of an unhelpful generic banner.

---

## 2. User Experience & Visual Design

### Key User Flows
1. **Google Sign-In (Existing User)**:
   - Learner navigates to `/login`.
   - Clicks **Continue with Google**.
   - Selects their Google account in the Google OAuth popup.
   - Popup closes; button switches to a loading state ("Signing in with Google...").
   - Learner is instantly transitioned to `/lessons`.

2. **Google Sign-In (First-Time User)**:
   - Learner arrives at `/login` without an invite.
   - Clicks **Continue with Google**.
   - Authenticates via Google.
   - Plato automatically creates their learner profile, initializes their Firestore synchronization container, and directs them straight into the classroom (`/lessons`).
   - If administrator-configured custom profile fields exist, the `ProfileCompletionGate` gracefully presents any required custom fields on their first visit without blocking initial registration.

3. **Graceful Error Recovery**:
   - If the user closes the popup without signing in (`auth/popup-closed-by-user`), no jarring red error banner is displayed.
   - If a domain restriction or network failure occurs, a clear banner with recovery steps appears:
     ```
     ┌──────────────────────────────────────────────────────────────┐
     │ ⚠ Google sign-in could not be completed.                      │
     │ Please check your internet connection or try again.           │
     └──────────────────────────────────────────────────────────────┘
     ```

### Visual Styling & Accessibility
- **Sign-in Card**: Maintains Plato's brand palette (configured classroom primary color and crisp high-contrast cards).
- **Button Affordance**: Minimum 44px tap target on mobile viewports with visible focus ring (`focus-visible:ring-2`) and disabled state during submission to prevent double-clicks.
- **Accessible Announcements**: Error alerts retain `role="alert"` and clear typographic hierarchy.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Direct Account Creation vs. Invite Gate for Google Users**
  - *Chosen Approach*: Enable auto-provisioning for any verified Google email (`email_verified === true`) on `/v1/auth/firebase`.
  - *Why*: Aligns with user decision to "Allow any verified Google user to sign in", eliminating friction for learners joining via Google Workspace or personal Gmail.
  - *Trade-off*: Removes invite gate for Google users while preserving traditional password-based invite boundaries.

- **Decision 2: Name & Username Resolution**
  - *Chosen Approach*: Extract `name` and `email` from Google JWT claims. Derive a clean username (`usr_<slug>`), ensuring uniqueness against existing database records.
  - *Why*: Avoids prompting the learner for an extra username registration step; ensures instant onboarding into lesson chat.

- **Decision 3: Firestore Profile Sync on First Sign-In**
  - *Chosen Approach*: Run `ensureFirestoreUserProfile(user)` immediately upon successful token generation, isolating PII into `users/{uid}/private/info` per security rules.
  - *Why*: Guarantees instant real-time progress syncing across devices from turn 1.

---

## 4. Technical Architecture & Data Strategy

### System Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                          Client (Browser)                              │
│                                                                        │
│   ┌───────────────────┐               ┌────────────────────────────┐   │
│   │     Login.jsx     │ ────────────> │     firebaseClient.js      │   │
│   │ (Continue w/ Ggl) │               │   signInWithGooglePopup()  │   │
│   └─────────┬─────────┘               └─────────────┬──────────────┘   │
│             │                                       │ (Google OAuth)   │
│             │                                       ▼                  │
│             │                        ┌─────────────────────────────┐   │
│             │                        │    Google / Firebase Auth   │   │
│             │                        └──────────────┬──────────────┘   │
│             │                                       │ idToken          │
│             ▼                                       ▼                  │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                 auth.js: loginWithGoogle()                     │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
└───────────────────────────────────┼────────────────────────────────────┘
                                    │ POST /v1/auth/firebase { idToken }
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          Plato Server (API)                            │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │              verifyFirebaseIdToken(idToken)                    │   │
│   │    - Validates RS256 signature against Google JWKS             │   │
│   │    - Verifies issuer & audience match FIREBASE_PROJECT_ID      │   │
│   │    - Requires email_verified === true                          │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │                                    │
│             ┌─────────────────────┴─────────────────────┐              │
│             ▼                                           ▼              │
│   [Existing User Found?]                     [No Existing User]        │
│             │                                           │              │
│      Issue Tokens &                              Auto-create User      │
│      Log Activity                               (role: 'user')         │
│             │                                           │              │
│             └─────────────────────┬─────────────────────┘              │
│                                   ▼                                    │
│                 Return { accessToken, refreshToken, user }             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Firestore & Client Completion                       │
│                                                                        │
│   - client/js/auth.js saves tokens & user to storage.js               │
│   - ensureFirestoreUserProfile(user) seeds users/{uid} & PII record    │
│   - navigate('/lessons', { replace: true })                            │
└────────────────────────────────────────────────────────────────────────┘
```

### Components to Update
1. **`server/src/routes/auth.js` (`/v1/auth/firebase`)**:
   - Modify Case 3 (uninvited users): Instead of returning 403 `INVITE_REQUIRED` or `WAITLIST_PENDING`, create a new user record with `role: 'user'`, generate a unique username, consume any existing waitlist/invite entries if present, and issue access + refresh tokens.
2. **`client/src/pages/Login.jsx`**:
   - Enhance `handleGoogleLogin()` to distinguish between benign user dismissals (`auth/popup-closed-by-user`) and actionable failures (network issues, domain permissions), showing friendly guidance.
3. **`client/tests/auth.test.js` & `server/tests/routes/auth.test.js`**:
   - Add automated test assertions verifying that unknown Google users successfully onboard and receive tokens on `/v1/auth/firebase`.
