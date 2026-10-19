/**
 * Security Rules Specification & Dirty Dozen Verification Suite
 * Validates that all 12 adversarial payloads in security_spec.md are rejected by firestore.rules.
 */

export interface DirtyPayloadTest {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email?: string; email_verified?: boolean } | null;
  payload?: Record<string, unknown>;
  expectedOutcome: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: DirtyPayloadTest[] = [
  {
    id: 1,
    name: 'Shadow Field Injection on UserProfile Create',
    collectionPath: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_1', email: 'alice@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      platoUserId: 'usr_1',
      name: 'Alice',
      username: 'alice1',
      role: 'user',
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
      isSuperAdmin: true,
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Self-Assigned Admin Role on Create',
    collectionPath: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_1', email: 'alice@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      platoUserId: 'usr_1',
      name: 'Alice',
      username: 'alice1',
      role: 'admin',
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Unverified Email Spoof Attack',
    collectionPath: '/users/admin_1',
    operation: 'create',
    auth: { uid: 'admin_1', email: 'allthesecrushes@gmail.com', email_verified: false },
    payload: {
      uid: 'admin_1',
      platoUserId: 'usr_admin',
      name: 'Admin',
      username: 'admin1',
      role: 'admin',
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Cross-User Identity Spoofing on Create',
    collectionPath: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_2', email: 'bob@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      platoUserId: 'usr_1',
      name: 'Alice',
      username: 'alice1',
      role: 'user',
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Role Escalation via Update-Gap',
    collectionPath: '/users/user_1',
    operation: 'update',
    auth: { uid: 'user_1', email: 'alice@example.com', email_verified: true },
    payload: {
      role: 'admin',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Immortal Field Mutation (createdAt)',
    collectionPath: '/users/user_1',
    operation: 'update',
    auth: { uid: 'user_1', email: 'alice@example.com', email_verified: true },
    payload: {
      name: 'Alice Updated',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Forged Client Timestamp on Create',
    collectionPath: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_1', email: 'alice@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      platoUserId: 'usr_1',
      name: 'Alice',
      username: 'alice1',
      role: 'user',
      createdAt: '2099-01-01T00:00:00Z',
      updatedAt: '2099-01-01T00:00:00Z',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Cross-User PII Read on /users/user_1/private/info',
    collectionPath: '/users/user_1/private/info',
    operation: 'get',
    auth: { uid: 'user_2', email: 'bob@example.com', email_verified: true },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Orphaned Subcollection Write on /users/missing_user/syncData/profile',
    collectionPath: '/users/missing_user/syncData/profile',
    operation: 'create',
    auth: { uid: 'missing_user', email: 'ghost@example.com', email_verified: true },
    payload: {
      uid: 'missing_user',
      dataKey: 'profile',
      payload: '{}',
      version: 1,
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Denial-of-Wallet Oversized Sync Payload',
    collectionPath: '/users/user_1/syncData/messages',
    operation: 'create',
    auth: { uid: 'user_1', email: 'alice@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      dataKey: 'messages',
      payload: 'x'.repeat(400_000),
      version: 1,
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Path Variable ID Poisoning',
    collectionPath: '/users/user_1/syncData/invalid$id!with@spaces',
    operation: 'create',
    auth: { uid: 'user_1', email: 'alice@example.com', email_verified: true },
    payload: {
      uid: 'user_1',
      dataKey: 'invalid$id!with@spaces',
      payload: '{}',
      version: 1,
      createdAt: 'SERVER_TIMESTAMP',
      updatedAt: 'SERVER_TIMESTAMP',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unauthorized List Scraping on /users',
    collectionPath: '/users',
    operation: 'list',
    auth: { uid: 'user_2', email: 'bob@example.com', email_verified: true },
    expectedOutcome: 'PERMISSION_DENIED',
  },
];
