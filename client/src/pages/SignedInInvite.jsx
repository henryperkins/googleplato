import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import usePublicBranding from '../hooks/usePublicBranding.js';
import PublicFooter from '../components/PublicFooter.jsx';
import ClassroomLogo from '../components/ClassroomLogo.jsx';
import { Button } from '@/components/ui/button';
import {
  Card, CardHeader, CardTitle, CardDescription, CardFooter,
} from '@/components/ui/card';

/**
 * An invite link (/signup?token=…) opened while signed in. Says who's signed
 * in instead of quietly showing that account's classroom: sign out and
 * continue to the signup form, or go back to the lessons.
 */
export default function SignedInInvite() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const branding = usePublicBranding('Invite');
  const who = user?.email || user?.username || 'another account';

  async function signOutAndContinue() {
    const here = `${window.location.pathname}${window.location.search}`;
    await logout();
    navigate(here, { replace: true });
  }

  if (!branding) return null;

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-start py-12 p-4 bg-header text-header-foreground">
      <ClassroomLogo src={branding.logo} alt={branding.classroomName || 'plato'} className="mb-6 h-12 w-auto" fallback={<span className="mb-6 text-xl font-semibold">{branding.classroomName || 'plato'}</span>} />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle as="h1" className="text-2xl">This invite is for a new account</CardTitle>
          <CardDescription>
            You&rsquo;re signed in as <strong>{who}</strong>. To use this invite, sign out first.
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-wrap gap-2">
          <Button onClick={signOutAndContinue}>Sign out and continue</Button>
          <Button variant="outline" onClick={() => navigate('/lessons')}>Go to my lessons</Button>
        </CardFooter>
      </Card>
      <PublicFooter />
    </main>
  );
}
