/**
 * Sign-in failure delays: the fork's fix for upstream's account lockout (#517).
 *
 * Upstream locks an account for 15 minutes after 5 wrong passwords and checks
 * the lock before the password. That lets a learner who mistypes lose 15
 * minutes, lets anyone who knows a username lock its owner out from anywhere,
 * and its read-then-write counter misses guesses sent in parallel. Here:
 *
 * - **Delays grow instead of a flat lock.** After FREE_FAILURES wrong
 *   passwords, the next attempt waits FIRST_DELAY_MS, doubling with each
 *   further failure up to MAX_DELAY_MS. A correct password clears the count;
 *   so does an hour without failures.
 * - **The requester is delayed, not the account.** A browser that has signed
 *   in to the account before carries a device token, and its failures count
 *   for that device alone: nobody else's guesses can delay it. Every other
 *   attempt counts per account *and* client address, so a stranger elsewhere
 *   can't delay a learner. If untrusted failures on one account pass
 *   ACCOUNT_CEILING within the hour (guessing spread across many addresses),
 *   every untrusted attempt on it is delayed too; device-token holders still
 *   sign in normally.
 * - **No lost counts.** Counts live in this instance's memory and are read and
 *   written with no await in between, so parallel guesses each count. Each
 *   instance counts on its own (production runs at most 3), like the other
 *   request limits (lib/rate-limit.js).
 * - Unknown names are counted the same way, by the name typed.
 *
 * Nothing here is stored in the database, so it needs no migration and works
 * the same on Postgres, DynamoDB and SQLite.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { JWT_SECRET } from '../config.js';

export const FREE_FAILURES = 5;
export const FIRST_DELAY_MS = 30_000;
export const MAX_DELAY_MS = 15 * 60_000;
export const FORGET_AFTER_MS = 60 * 60_000;
export const ACCOUNT_CEILING = 50;
export const DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60_000;
const MAX_KEYS = 10_000;

const requesters = new Map(); // requester key -> { count, lastAt, retryAt }
const accounts = new Map(); // account key -> { count, lastAt }: untrusted failures from every address

/** How long the next attempt waits after `count` consecutive failures. */
export function delayAfter(count) {
  if (count < FREE_FAILURES) return 0;
  return Math.min(FIRST_DELAY_MS * 2 ** (count - FREE_FAILURES), MAX_DELAY_MS);
}

function live(map, key, now) {
  const entry = map.get(key);
  if (entry && now - entry.lastAt > FORGET_AFTER_MS) {
    map.delete(key);
    return null;
  }
  return entry || null;
}

function remember(map, key, entry) {
  map.delete(key); // re-insert so Map order stays oldest-first
  map.set(key, entry);
  for (const oldest of map.keys()) {
    if (map.size <= MAX_KEYS) break;
    map.delete(oldest);
  }
}

/**
 * Who an attempt counts against. `accountKey` is the user id, or `unknown:` and
 * the name typed; `deviceId` comes from a verified device token.
 */
export function requesterFor({ accountKey, deviceId = null, ip = '' }) {
  return deviceId
    ? { key: `device:${deviceId}`, accountKey, trusted: true }
    : { key: `account:${accountKey}|ip:${ip}`, accountKey, trusted: false };
}

/** Milliseconds this requester must still wait before trying (0 = go ahead). */
export function waitFor(requester, now = Date.now()) {
  let until = live(requesters, requester.key, now)?.retryAt || 0;
  if (!requester.trusted) {
    const account = live(accounts, requester.accountKey, now);
    if (account && account.count >= ACCOUNT_CEILING) {
      until = Math.max(until, account.lastAt + delayAfter(FREE_FAILURES + account.count - ACCOUNT_CEILING));
    }
  }
  return Math.max(0, until - now);
}

/**
 * Start a sign-in attempt. If this requester must wait, returns `{ wait }`
 * and the password must not be checked. Otherwise the attempt is counted as
 * a failure *before* the password is checked, in the same synchronous step as
 * the wait check, so a burst of parallel guesses can't all be checked before
 * any of them counts. `next` is how long the following attempt waits if this
 * one turns out wrong. Call `attemptSucceeded` when the password is right.
 */
export function beginAttempt(requester, now = Date.now()) {
  const wait = waitFor(requester, now);
  if (wait > 0) return { wait, next: wait };
  const entry = live(requesters, requester.key, now) || { count: 0 };
  entry.count += 1;
  entry.lastAt = now;
  entry.retryAt = now + delayAfter(entry.count);
  remember(requesters, requester.key, entry);
  if (!requester.trusted) {
    const account = live(accounts, requester.accountKey, now) || { count: 0 };
    account.count += 1;
    account.lastAt = now;
    remember(accounts, requester.accountKey, account);
  }
  return { wait: 0, next: waitFor(requester, now) };
}

/** The password was right: this requester starts over, and the attempt isn't a failure. */
export function attemptSucceeded(requester) {
  requesters.delete(requester.key);
  const account = requester.trusted ? null : accounts.get(requester.accountKey);
  if (account) account.count = Math.max(0, account.count - 1);
}

/** Tests: forget every count. */
export function _resetSignInGuard() {
  requesters.clear();
  accounts.clear();
}

// Device tokens: `<deviceId>.<issued seconds>.<mac>`. The MAC binds the user
// id, so the token names no account and works only for the one it was issued
// for. It grants nothing on its own: it only keeps this device's failures
// apart from everyone else's.
const deviceKey = () => createHash('sha256').update(`plato-device-token\n${JWT_SECRET}`).digest();
const mac = (userId, deviceId, issued) => createHmac('sha256', deviceKey()).update(`${userId}.${deviceId}.${issued}`).digest();

export function issueDeviceToken(userId, { deviceId = randomBytes(16).toString('hex'), now = Date.now() } = {}) {
  const issued = Math.floor(now / 1000);
  return `${deviceId}.${issued}.${mac(userId, deviceId, issued).toString('base64url')}`;
}

/** The device id if `token` is a live device token for `userId`, else null. */
export function verifyDeviceToken(token, userId, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 200 || !userId) return null;
  const [deviceId, issued, given] = token.split('.');
  if (!/^[0-9a-f]{32}$/.test(deviceId || '') || !/^\d{1,12}$/.test(issued || '') || !given) return null;
  if (now - Number(issued) * 1000 > DEVICE_TOKEN_TTL_MS) return null;
  const expected = mac(userId, deviceId, issued);
  const actual = Buffer.from(given, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? deviceId : null;
}
