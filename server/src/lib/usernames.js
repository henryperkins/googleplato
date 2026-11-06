import { randomBytes } from 'node:crypto';

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,28}[a-zA-Z0-9]$/;

export function validateUsername(username) {
  if (!username || typeof username !== 'string') return 'Username is required';
  if (username.length < 3 || username.length > 30) return 'Username must be 3-30 characters';
  if (!USERNAME_RE.test(username)) return 'Username must be alphanumeric with hyphens or underscores, and cannot start/end with them';
  if (username.includes('@')) return 'Username cannot contain @';
  return null;
}

export function generateUsername() {
  return 'user-' + randomBytes(3).toString('hex');
}
