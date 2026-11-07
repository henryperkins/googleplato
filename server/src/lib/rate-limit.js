/**
 * Best-effort request limits for public endpoints (wait list, sign-in,
 * password reset, signup), as upstream's (#517/#520). Counts live in the
 * instance's memory, so each instance (a Lambda container, a Cloud Run
 * instance) counts on its own: a burst spread across many instances can get
 * past a limit. They stop one source hammering one instance; an edge rate rule
 * is the exact control.
 */
import { isIP } from 'node:net';

// Addresses only infrastructure inside the platform has: loopback, private,
// link-local (Cloud Run's proxy is 169.254.169.126), carrier-grade NAT, ULA.
function isInternal(address) {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(ip) === 6) return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  return true; // not an address at all
}

/**
 * The caller's IP for a limiter. The edge (CloudFront, Google Front End)
 * *appends* the viewer's address to any X-Forwarded-For the sender wrote, so
 * only entries from the right are trustworthy; the leftmost is whatever the
 * sender chose. Hops behind the edge may append their own address after it:
 * the Lambda's source address (dropped when it matches), or an internal proxy
 * such as the nginx ingress in front of the Cloud Run app (dropped as
 * internal). Returns '' when no public address is left. Limiters never count
 * an empty key, so an unexpected proxy chain turns the limits off instead of
 * putting every user in one shared bucket.
 */
export function clientIp(c) {
  const rc = c.env?.requestContext || c.env?.event?.requestContext;
  const source = rc?.http?.sourceIp || rc?.identity?.sourceIp || '';
  const hops = (c.req.header('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  while (hops.length > 1 && hops[hops.length - 1] === source) hops.pop();
  while (hops.length && isInternal(hops[hops.length - 1])) hops.pop();
  const ip = hops[hops.length - 1] || source;
  return ip && !isInternal(ip) ? ip : '';
}

const limiters = new Set();

/**
 * A sliding-window limiter: `hit(key)` records one attempt and returns true
 * when the key is over `limit` within `windowMs`. An empty key is never
 * limited. Memory is bounded (cleared past `maxKeys`).
 */
export function createLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  const seen = new Map(); // key -> [timestamps]
  const limiter = {
    hit(key, now = Date.now()) {
      if (!key) return false;
      const times = (seen.get(key) || []).filter((t) => now - t < windowMs);
      times.push(now);
      seen.set(key, times);
      if (seen.size > maxKeys) seen.clear();
      return times.length > limit;
    },
    reset() { seen.clear(); },
  };
  limiters.add(limiter);
  return limiter;
}

/** Tests: clear every limiter. */
export function _resetAllLimits() {
  for (const l of limiters) l.reset();
}

/** Read a JSON body; null when it isn't valid JSON (the caller answers 400). */
export async function readJson(c) {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}
