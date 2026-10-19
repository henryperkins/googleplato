# Firestore Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Global Default Deny**: Any path not explicitly matched is unconditionally denied (`allow read, write: if false;`).
2. **Verified Identity**: All writes require `request.auth != null` and `request.auth.token.email_verified == true`.
3. **Master Gate & Relational Sync**:
   - Every subcollection under `/users/{userId}` (`/private/{docId}` and `/syncData/{syncId}`) requires the parent `/users/{userId}` document to exist (`exists(/databases/$(database)/documents/users/$(userId))`) and belong to `request.auth.uid` (or be accessed by a verified `isAdmin()`).
4. **PII Isolation (Split Collection)**:
   - `/users/{userId}` holds only non-PII profile fields (`uid`, `platoUserId`, `name`, `username`, `role`, `userGroup`, `createdAt`, `updatedAt`).
   - `/users/{userId}/private/{docId}` holds PII (`email`) and is strictly readable and writable only by `isOwner(userId)` or `isAdmin()`.
5. **Privilege Escalation Prevention**:
   - Non-admin users can only create a `UserProfile` with `role == 'user'`. Setting `role == 'admin'` requires `isAdmin()`.
   - During `update` on `/users/{userId}`, non-admins cannot modify `role`, `uid`, `platoUserId`, or `createdAt`.
6. **Temporal Integrity**:
   - On `create`: `incoming().createdAt == request.time && incoming().updatedAt == request.time`.
   - On `update`: `incoming().createdAt == existing().createdAt && incoming().updatedAt == request.time`.
7. **Volumetric & Key Bounds**:
   - All document IDs (`userId`, `docId`, `syncId`, `adminId`) are validated with `isValidId()` (`size() <= 128` and regex `^[a-zA-Z0-9_\-]+$`) on single-document operations (`get`, `create`, `update`, `delete`).
   - Every string field enforces strict `.size()` bounds matching `firebase-blueprint.json`.

---

## 2. The "Dirty Dozen" Payloads

1. **Shadow Field Injection on UserProfile Create**:
   `{ "uid": "u1", "platoUserId": "usr_1", "name": "Alice", "username": "alice1", "role": "user", "createdAt": "<SERVER_TIME>", "updatedAt": "<SERVER_TIME>", "isSuperAdmin": true }` -> Rejected by `hasOnly()`.
2. **Self-Assigned Admin Role on Create**:
   `{ "uid": "u1", "platoUserId": "usr_1", "name": "Alice", "username": "alice1", "role": "admin", "createdAt": "<SERVER_TIME>", "updatedAt": "<SERVER_TIME>" }` (by non-admin) -> Rejected by role gate.
3. **Unverified Email Spoof Attack**:
   Auth token with `email: "allthesecrushes@gmail.com"` and `email_verified: false` attempting admin write -> Rejected by `request.auth.token.email_verified == true`.
4. **Cross-User Identity Spoofing on Create**:
   Authenticated as `u2`, creating `/users/u1` with `uid: "u1"` -> Rejected by `isOwner(userId)` and `data.uid == request.auth.uid`.
5. **Role Escalation via Update-Gap**:
   Updating `/users/u1` with `{ "role": "admin", "updatedAt": "<SERVER_TIME>" }` as non-admin -> Rejected by `affectedKeys().hasOnly(['name', 'username', 'userGroup', 'updatedAt'])` and `incoming().role == existing().role`.
6. **Immortal Field Mutation (`createdAt` / `uid`)**:
   Updating `/users/u1` where `incoming().createdAt != existing().createdAt` -> Rejected by temporal immutability gate.
7. **Forged Client Timestamp**:
   Creating `/users/u1` with `createdAt` set to a past or future timestamp `!= request.time` -> Rejected by `incoming().createdAt == request.time`.
8. **Cross-User PII Read on `/users/u1/private/info`**:
   Authenticated as `u2` performing `get` on `/users/u1/private/info` -> Rejected by `isOwner(userId) || isAdmin()`.
9. **Orphaned Subcollection Write on `/users/u1/syncData/profile`**:
   Authenticated as `u1` creating `/users/u1/syncData/profile` when `/users/u1` does not exist -> Rejected by Master Gate `exists(/databases/$(database)/documents/users/$(userId))`.
10. **Denial-of-Wallet Oversized Sync Payload**:
    Creating `/users/u1/syncData/messages` with `payload` length > 389,120 chars -> Rejected by `data.payload.size() <= 389120`.
11. **Path Variable ID Poisoning**:
    Creating `/users/u1/syncData/invalid$id!with@spaces` -> Rejected by `isValidId(syncId)`.
12. **Unauthorized List Scraping on `/users`**:
    Authenticated as non-admin `u2` executing a collection-wide `list` query on `/users` without filtering `resource.data.uid == request.auth.uid` -> Rejected by Query Enforcer `allow list: if isSignedIn() && (resource.data.uid == request.auth.uid || isAdmin());`.
