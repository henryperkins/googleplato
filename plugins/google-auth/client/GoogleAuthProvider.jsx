import { useState } from 'react';
import { Button } from '@/components/ui/button';
import GoogleIcon from './GoogleIcon.jsx';
import { signInWithGooglePopup, signOutFirebase } from './firebaseAuth.js';
import { exchangeGoogleToken } from './exchange.js';
import { googleSignInError } from './errors.js';

const LABELS = {
  login: ['Continue with Google', 'Signing in with Google...'],
  setup: ['Create admin account with Google', 'Setting up with Google...'],
  signup: ['Continue with Google', 'Continuing with Google...'],
};

export default function GoogleAuthProvider({
  pluginId,
  provider,
  surface,
  options = {},
  busy = false,
  setBusy,
  beforeStart,
  onSession,
  onAdmission,
  onError,
}) {
  const [working, setWorking] = useState(false);
  const [label, busyLabel] = LABELS[surface] || LABELS.login;

  async function handleClick() {
    if (busy || working) return;
    if (beforeStart && await beforeStart() === false) return;
    setWorking(true);
    setBusy?.(true);
    onError?.('');
    try {
      const { idToken } = await signInWithGooglePopup(provider.config);
      const body = await exchangeGoogleToken(idToken, options);
      // Firebase is needed only to obtain the ID token. Do not retain its SDK
      // session after plato's ordinary access/refresh session is adopted.
      await signOutFirebase(provider.config);
      await onSession(body, pluginId);
    } catch (error) {
      if (error?.admission && onAdmission) onAdmission(error.admission);
      else onError?.(googleSignInError(error, { audience: surface === 'setup' ? 'admin' : 'learner' }), error);
    } finally {
      // Includes network failures and rejected admissions, not only non-2xx responses.
      await signOutFirebase(provider.config);
      setWorking(false);
      setBusy?.(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-10 w-full flex-wrap gap-2 whitespace-normal py-2"
      onClick={handleClick}
      disabled={busy || working}
      focusableWhenDisabled
      aria-busy={working ? 'true' : undefined}
    >
      <GoogleIcon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 max-w-full break-words">{working ? busyLabel : label}</span>
    </Button>
  );
}
