/**
 * Messages for failed sign-in, signup, and setup requests on the auth pages.
 * Firebase errors carry an `auth/…` code and a raw message that isn't meant
 * for people; errors from plato's server carry a readable `message`.
 */

// fetch() and dynamic import() reject with a TypeError when the network is down.
export const OFFLINE_MESSAGE = "We couldn't reach plato. Check your internet connection, then try again.";

/**
 * Message for a failed Google sign-in, or '' when the person closed the
 * Google window themselves. `audience: 'admin'` (first-run setup) explains how
 * to enable Google sign-in instead of pointing to an administrator.
 */
export function googleSignInError(err, { audience = 'learner' } = {}) {
  const code = typeof err?.code === 'string' ? err.code : '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return '';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google sign-in window. Allow pop-ups for this site, then try again.';
    case 'auth/network-request-failed':
      return "We couldn't reach Google. Check your internet connection, then try again.";
    case 'auth/unauthorized-domain':
    case 'auth/operation-not-allowed':
      return audience === 'admin'
        ? "Google sign-in isn't enabled for this site yet. In the Firebase console, add this site's domain to the authorized domains in Authentication settings, or set up with a password instead."
        : "Google sign-in isn't available on this site yet. Use your email and password, or ask your administrator.";
    case 'auth/too-many-requests':
      return 'Too many sign-in attempts. Wait a few minutes, then try again.';
    default:
      break;
  }
  if (err instanceof TypeError) return OFFLINE_MESSAGE;
  if (code.startsWith('auth/') || !err?.message) {
    return "Google sign-in didn't work. Try again, or use your email and password.";
  }
  return err.message;
}

/** Message for a failed email-or-username and password sign-in. */
export function passwordSignInError(err) {
  if (err instanceof TypeError) return OFFLINE_MESSAGE;
  if (err?.status === 401) {
    return "That email or username and password don't match. Try again, or reset your password.";
  }
  return err?.message || "We couldn't sign you in. Try again.";
}

/** Message for any other failed request: offline, the server's reason, or `fallback`. */
export function requestError(err, fallback) {
  if (err instanceof TypeError) return OFFLINE_MESSAGE;
  return err?.message || fallback;
}

/**
 * One summary naming every empty required field, e.g.
 * missingFieldsMessage(['your name', 'a password']) → "Enter your name and a password."
 */
export function missingFieldsMessage(fields) {
  return `Enter ${new Intl.ListFormat('en', { type: 'conjunction' }).format(fields)}.`;
}
