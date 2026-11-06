/** Firebase Authentication owned by the optional google-auth plugin. */
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

let current = null;
let appSequence = 0;
let pendingSignOut = null;

function authFor(config) {
  const key = JSON.stringify(config || {});
  if (!current || current.key !== key) {
    const app = initializeApp(config, `plato-google-auth-${++appSequence}`);
    current = { key, auth: getAuth(app) };
  }
  return current.auth;
}

export async function signInWithGooglePopup(config) {
  if (pendingSignOut) {
    throw new Error('Your previous Google sign-out is still finishing. Please try again in a moment.');
  }
  // No await before opening the popup: Safari requires it to stay in the click.
  const result = await signInWithPopup(authFor(config), googleProvider);
  const idToken = await result.user.getIdToken();
  return { idToken };
}

export function signOutFirebase(config) {
  if (pendingSignOut) return pendingSignOut;
  pendingSignOut = (async () => {
    try {
      const auth = authFor(config);
      await auth.authStateReady();
      if (auth.currentUser) await firebaseSignOut(auth);
    } catch { /* Provider cleanup is best-effort and never blocks plato. */ }
  })();
  const operation = pendingSignOut;
  void operation.then(() => { if (pendingSignOut === operation) pendingSignOut = null; });
  return operation;
}
