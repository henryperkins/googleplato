/** Firebase authentication, kept separate from the larger Firestore SDK. */
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
let pendingSignOut = null;

/** Wait for Firebase's persisted Google session before reading its user. */
export async function restoredUser() {
  await auth.authStateReady();
  return auth.currentUser;
}

export async function signInWithGooglePopup() {
  if (pendingSignOut) {
    throw new Error('Your previous Google sign-out is still finishing. Please try again in a moment.');
  }
  const result = await signInWithPopup(auth, googleProvider);
  const idToken = await result.user.getIdToken();
  return { firebaseUser: result.user, idToken };
}

export function signOutFirebase() {
  if (pendingSignOut) return pendingSignOut;
  // The SDK may still be changing persisted auth after plato has signed out.
  // Keep the gate until that actual operation settles; it cannot be cancelled
  // safely by the outer logout deadline.
  pendingSignOut = (async () => {
    try {
      if (auth.currentUser) await firebaseSignOut(auth);
    } catch { /* Non-fatal on logout. */ }
  })();
  const operation = pendingSignOut;
  void operation.then(() => { if (pendingSignOut === operation) pendingSignOut = null; });
  return operation;
}

export { onAuthStateChanged } from 'firebase/auth';
