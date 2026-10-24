/**
 * Where to go after signing in: back to the page that sent the learner to
 * sign-in (RequireAuth records it in the redirect's state, e.g. when a session
 * expires mid-lesson), or the lesson list. Only an in-app path qualifies, so
 * sign-in can never be sent off-site, and the auth pages would only loop.
 */
const AUTH_PAGES = /^\/(?:login|signup|waitlist|forgot-password|reset-password)(?:[/?#]|$)/;

export function returnPath(from) {
  const inApp = typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/\\');
  return inApp && !AUTH_PAGES.test(from) ? from : '/lessons';
}
