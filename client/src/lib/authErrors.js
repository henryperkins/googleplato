/** Messages for core password sign-in, signup, and setup requests. */

// fetch() and dynamic import() reject with a TypeError when the network is down.
export const OFFLINE_MESSAGE = "We couldn't reach plato. Check your internet connection, then try again.";

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
