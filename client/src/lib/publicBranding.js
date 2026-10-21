/**
 * One shared request for the classroom's public branding (`/v1/branding`).
 *
 * App starts it at boot, alongside the setup check, so auth pages and the
 * classroom shell usually render with their colors already known: no blank
 * screen while each page fetches, and no frame of default purple before the
 * classroom color applies. A failed request isn't cached, so the next page
 * tries again.
 */

let cached = null;
let pending = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(cached);
}

export function cachedPublicBranding() {
  return cached;
}

export function subscribePublicBranding(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolves to the branding record, or `{}` when it can't be loaded. */
export function loadPublicBranding() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = fetch('/v1/branding')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => {
        pending = null;
        if (data) {
          cached = data;
          notify();
        }
        return data || {};
      });
  }
  return pending;
}

/** Forget the cached branding after an admin saves new settings. */
export function invalidatePublicBranding() {
  cached = null;
  pending = null;
  notify();
}
