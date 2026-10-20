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

/** Wait for Firebase's persisted Google session before reading its user. */
export async function restoredUser() {
  await auth.authStateReady();
  return auth.currentUser;
}

export async function signInWithGooglePopup() {
  const result = await signInWithPopup(auth, googleProvider);
  const idToken = await result.user.getIdToken();
  return { firebaseUser: result.user, idToken };
}

export async function signOutFirebase() {
  try {
    if (auth.currentUser) await firebaseSignOut(auth);
  } catch { /* Non-fatal on logout. */ }
}

export { onAuthStateChanged } from 'firebase/auth';
