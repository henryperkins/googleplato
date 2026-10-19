# Firebase Auth & Cloud Firestore Integration for plato

Integrate Firebase Authentication (Google Sign-In) and Cloud Firestore into **plato** so learners and admins can sign in with Google alongside existing password credentials, link or onboard via classroom invites/waitlist, and mirror their learning progress, profiles, and conversation history to Firestore with zero-trust security rules.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural choices reflect your confirmed preferences from the clarification step:

- **Confirmed Scope — Full Firebase Auth + Firestore Cloud Sync**: Both Google Sign-In via Firebase Auth and real-time Cloud Firestore persistence will be integrated into the application.
- **Confirmed Auth Mode — Hybrid Google Sign-In + Password Login**: Existing email/username and password authentication remains fully functional alongside a new "Continue with Google" option on Setup, Login, Signup, and Waitlist flows.
- **Confirmed Onboarding — Invite & Waitlist Auto-Linking**: When a user signs in with Google, if their verified Google email matches an existing account, pending email invite, active link invite token, or initial classroom setup (when 0 users exist), they are automatically linked and signed in; otherwise they are guided to join the classroom waitlist or use an invite link.

---

## 1. Overview & Core Concept

- **What It Does**: Adds Google Sign-In (`signInWithPopup`) powered by Firebase Authentication and synchronizes learner profiles, preferences, lesson progress (`lessonKB`), and conversation records to the provisioned Cloud Firestore database (`ai-studio-plato-196eecf7-5744-4762-b19b-47cbd67015e6`) in project `idk-4e9b9`.
- **Target Audience / Persona**: Classroom administrators setting up or managing a plato microlearning instance, and learners working through AI-coached lessons across devices.
- **Key Value**: Frictionless single-click Google authentication that respects plato's invite-only/waitlist classroom boundaries, paired with durable Cloud Firestore storage protected by zero-trust Attribute-Based Access Control (ABAC) security rules.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Initial Classroom Setup (`/setup`)**: When no users exist yet, the first administrator can either fill out the password form or click **Continue with Google** after entering a Classroom Name to bootstrap the admin account with their Google identity.
  2. **Sign In (`/login`)**: Users can sign in with their email/username + password or click **Continue with Google**. Verified Google accounts matching an existing user sign in immediately; users with a pending email invite for that Google address have their account provisioned automatically.
  3. **Invite Signup (`/signup?token=...`)**: Invited learners can complete signup either with a password or with **Continue with Google**, preserving any custom user field answers and group assignments attached to the invite.
  4. **Cloud Firestore Sync**: While signed in with Firebase Auth, learner preferences, profile summaries, and lesson records sync to Firestore (`users/{uid}/syncData/{dataKey}`) with real-time snapshot listeners and structured permission error reporting.
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Preserves plato's clean, accessible microlearning aesthetic and dynamic classroom branding (`--primary`, `--primary-text`, `--ring`).
  - *Color Palette & Mood*: Uses existing semantic theme tokens (`bg-background`, `text-foreground`, `border-border`, `bg-card`) and dynamic classroom header themes with WCAG AA contrast derivation.
  - *Typography & Hierarchy*: Clean sans-serif hierarchy with clear visual separation ("or" divider) between primary credential fields and the Google Sign-In button, maintaining 44px minimum touch targets on mobile and visible `:focus-visible` outlines.
  - *Component Styling & Layout*: Uses plato's existing `Card`, `Button`, `Input`, and `Label` primitives without introducing nested card elevation or decorative clutter.
- **Interactive Feedback & Motion**: Clear loading states (`Signing in with Google...`), accessible `role="alert"` error banners when an uninvited Google account attempts sign-in (with a direct link to `/waitlist` when open), and automatic startup Firestore connection validation.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Hybrid Session Bridge between Firebase Auth and plato API**
  - *Chosen Approach*: Verify the Firebase ID token (via Google's public JWKS using `jose` on the server) at `/v1/auth/firebase` to issue plato's standard JWT access/refresh tokens while simultaneously maintaining the client-side Firebase Auth session for direct Firestore operations.
  - *Why*: Every existing server route (`/v1/ai`, `/v1/admin`, `/v1/sync`, plugins) and all existing tests continue to work without breaking password-only users, while Google-authenticated users get both full backend API access and direct Firestore cloud sync.
  - *Alternatives Considered*: Replacing server JWTs entirely with Firebase ID tokens was passed over because it would break username/password login requested in Phase 1.
- **Decision 2: Split PII & Scoped Sync Subcollections in Firestore**
  - *Chosen Approach*: Store public user metadata in `/users/{uid}`, private PII (email) in `/users/{uid}/private/info`, admin bootstrap records in `/admins/{uid}`, and synced learning records in `/users/{uid}/syncData/{dataKey}`.
  - *Why*: Satisfies strict PII isolation, prevents blanket read vulnerabilities, and ensures every document write is validated against strict schema and size bounds in `firestore.rules`.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           React 19 Client SPA                           │
│                                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                 │
│  │  Setup.jsx   │   │  Login.jsx   │   │  Signup.jsx  │                 │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘                 │
│         └──────────────────┼──────────────────┘                         │
│                            ▼                                            │
│             ┌─────────────────────────────┐                             │
│             │   AuthContext & auth.js     │                             │
│             │ (Password + Google Popup)   │                             │
│             └──────┬───────────────┬──────┘                             │
│                    │               │                                    │
│      Firebase SDK  │               │  REST (/v1/auth/firebase, /v1/sync)│
│                    ▼               ▼                                    │
│        ┌──────────────────┐ ┌──────────────────┐                        │
│        │ firebaseClient   │ │   storage.js     │                        │
│        │ (Auth/Firestore) │ │ (Cache + Sync)   │                        │
│        └────────┬─────────┘ └────────┬─────────┘                        │
└─────────────────┼────────────────────┼──────────────────────────────────┘
                  │                    │
                  ▼                    ▼
┌───────────────────────────┐ ┌───────────────────────────────────────────┐
│      Cloud Firestore      │ │             Hono API Server               │
│  (Zero-Trust ABAC Rules)  │ │                                           │
│                           │ │  • POST /v1/auth/firebase (JWKS verify,   │
│  • /admins/{uid}          │ │    auto-link existing user / invite /     │
│  • /users/{uid}           │ │    initial admin setup)                   │
│  • /users/{uid}/private/* │ │  • Existing /v1/auth/*, /v1/sync/*,       │
│  • /users/{uid}/syncData/*│ │    /v1/ai/*, /v1/admin/*                  │
└───────────────────────────┘ └───────────────────────────────────────────┘
```

- **Data Model & State (`firebase-blueprint.json` & `firestore.rules`)**:
  - `UserProfile` (`/users/{userId}`): `uid`, `name`, `username`, `role` (`user` | `admin`), `userGroup`, `createdAt`, `updatedAt`.
  - `UserPrivateInfo` (`/users/{userId}/private/{docId}`): `uid`, `email`, `createdAt`, `updatedAt` (strictly isolated to owner/admin).
  - `SyncRecord` (`/users/{userId}/syncData/{dataKey}`): `uid`, `dataKey`, `payload` (serialized JSON string bounded to 380 KB), `version` (integer), `createdAt`, `updatedAt`.
  - `AdminRecord` (`/admins/{adminId}`): Read-only marker documents plus bootstrapped runtime admin check (`allthesecrushes@gmail.com` with `email_verified == true`).
- **Interactive Component & State Mapping**:
  - **Google Sign-In Handler (`loginWithGoogle`)**: Opens Firebase `signInWithPopup(auth, googleProvider)`, retrieves the Firebase ID token, calls `POST /v1/auth/firebase` (passing optional `inviteToken`, `classroomName`, `userGroup`, `customFields`), stores plato tokens, initializes the user's Firestore profile + `syncData` mirror, and navigates to `/lessons` (or `/plato` on setup).
  - **Storage & Cloud Sync (`storage.js` / `firebaseClient.js`)**: Validates connection on boot via `getDocFromServer`, mirrors `putSyncData` / `deleteSyncData` to Firestore when a Firebase user is active, and wraps all Firestore reads/writes/snapshots with `handleFirestoreError` emitting the structured `FirestoreErrorInfo` JSON payload.
  - **Security Rules Verification & Deployment**: Author `firebase-blueprint.json`, `security_spec.md`, and `firestore.rules`; lint with `@firebase/eslint-plugin-security-rules`; and deploy rules via the `DeployRules` RPC.
