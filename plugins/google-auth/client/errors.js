const OFFLINE_MESSAGE = "We couldn't reach plato. Check your internet connection, then try again.";

export function googleSignInError(error, { audience = 'learner' } = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
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
  if (error instanceof TypeError) return OFFLINE_MESSAGE;
  if (code.startsWith('auth/') || !error?.message) {
    return "Google sign-in didn't work. Try again, or use your email and password.";
  }
  return error.message;
}
