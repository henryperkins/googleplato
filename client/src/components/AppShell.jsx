import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useBranding } from '../contexts/BrandingContext.jsx';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import ViewAsUserModal from './modals/ViewAsUserModal.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { useTheme } from '../hooks/useTheme.js';

export default function AppShell({ children }) {
  const navigate = useNavigate();
  const { user, logout, sessionExpired, impersonatedUser, stopImpersonation } = useAuth();
  const branding = useBranding();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const isAdmin = user?.role === 'admin';
  const impersonating = !!impersonatedUser;

  // An expired session signs out; RequireAuth then sends the learner to
  // sign-in, which says why and brings them back to this page afterwards.
  useEffect(() => {
    if (sessionExpired) logout({ reason: 'expired' });
  }, [sessionExpired, logout]);

  const handleSignOut = async () => {
    await logout();
    navigate('/login', { replace: true });
    setSignOutOpen(false);
  };

  // start/stopImpersonation in AuthContext do a hard reload to /lessons;
  // no further navigation needed here.
  const handleStopImpersonation = () => stopImpersonation();
  const handleStartedImpersonation = () => { /* AuthContext handles navigation */ };

  const classroomLogo = branding?.logoBase64 || null;
  const classroomName = branding?.classroomName || branding?.logoAlt || 'plato';
  const accountName = user?.name || user?.username || user?.email || 'Account';
  const impersonatedLabel =
    impersonatedUser?.name || impersonatedUser?.username || impersonatedUser?.email || 'learner';

  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-primary focus:text-primary-foreground">
        Skip to main content
      </a>

      {/* Admin bar — plato branding, quick links to dashboard */}
      {isAdmin && (
        <div className="py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-xs text-white" style={{ backgroundColor: '#470d99', '--ring': '#ffffff' }}>
          {/* A landmark, so screen-reader users can find admin controls from
              the classroom; both links go to the admin dashboard. */}
          <nav aria-label="Admin" className="mx-auto max-w-5xl flex flex-wrap items-center gap-2 px-4">
            <a href="/plato" onClick={e => { e.preventDefault(); navigate('/plato'); }} className="touch-target flex items-center gap-1.5 opacity-90 hover:opacity-100 whitespace-nowrap shrink-0">
              <img src="/assets/logo-white.svg" alt="plato admin" width="48" height="12" className="h-3 w-auto" />
            </a>
            <div className="flex-1" />
            {!impersonating && (
              <button
                type="button"
                onClick={() => setViewAsOpen(true)}
                className="touch-target flex items-center gap-1 cursor-pointer border border-white/30 rounded px-2 py-0.5 text-white/90 hover:text-white hover:bg-white/10 bg-transparent text-xs transition-colors whitespace-nowrap shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/></svg>
                View as user
              </button>
            )}
            <a href="/plato" onClick={e => { e.preventDefault(); navigate('/plato'); }} className="touch-target flex items-center gap-1 cursor-pointer border border-white/30 rounded px-2 py-0.5 text-white/90 hover:text-white hover:bg-white/10 text-xs transition-colors whitespace-nowrap shrink-0 no-underline">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              Admin Dashboard
            </a>
          </nav>
        </div>
      )}

      {/* Impersonation status strip — high-visibility, admin-only. Always
          underneath the purple admin bar so it's the first thing the admin sees. */}
      {impersonating && (
        <div
          className="py-1.5 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-sm flex items-center gap-3 border-b border-warning-border bg-warning text-warning-foreground"
          role="status"
          aria-live="polite"
        >
          <div className="mx-auto max-w-5xl flex items-center w-full gap-3 px-4">
            <span className="flex-1 min-w-0 truncate">
              Viewing as <strong>{impersonatedLabel}</strong>
            </span>
            <button
              type="button"
              onClick={handleStopImpersonation}
              aria-label={`Exit viewing as ${impersonatedLabel}`}
              className="touch-target rounded border border-warning-border px-2.5 py-1 text-xs font-medium hover:bg-warning-foreground/10 cursor-pointer bg-transparent transition-colors whitespace-nowrap shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-warning-foreground"
            >
              Exit
            </button>
          </div>
        </div>
      )}

      {/* Classroom header — custom branding */}
      <header
        className={`bg-header text-header-foreground py-2 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] ${!isAdmin ? 'pt-[max(0.5rem,env(safe-area-inset-top))]' : ''}`}
        role="banner"
      >
        {/* The classroom leads and the account follows. The two columns share
            the row fairly: each takes what it needs, and only when both run
            long does each give up an equal share. header-control gives each
            header control the header's focus color without passing it to the
            account menu, which sits on the popover. The padding sits inside the
            column, as on the pages, so the classroom name lines up with them. */}
        <nav className="mx-auto max-w-5xl px-4 grid grid-cols-[minmax(0,max-content)_minmax(0,max-content)] items-center justify-between gap-2" aria-label="Main navigation">
          <a href="/lessons" onClick={e => { e.preventDefault(); navigate('/lessons'); }} className="header-control touch-target flex min-w-0 items-center rounded-sm" aria-label={`${classroomName} — Lessons`}>
            {classroomLogo ? (
              <img src={classroomLogo} alt="" width="32" height="32" fetchPriority="high" className="h-8 w-auto max-w-full object-contain" />
            ) : (
              <span className="truncate text-base font-semibold">{classroomName}</span>
            )}
          </a>
          <div className="flex min-w-0 items-center gap-1">
            {/* Under 30rem a 414-430 px phone can't fit the button and the
                learner's name, so the choice moves into the account menu. */}
            <ThemeToggle className="header-control hidden min-[30rem]:flex" />
            <DropdownMenu>
              <DropdownMenuTrigger
                className="header-control touch-target group flex min-w-0 items-center gap-1 truncate text-inherit cursor-pointer bg-transparent border-none rounded-md px-3 py-1.5 text-sm font-medium"
                aria-label={`${accountName} — Account`}
              >
                <span className="truncate underline-offset-4 group-hover:underline">{accountName}</span>
                <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuLabel>
                  {user?.email || ''}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate('/settings')}>
                  Settings
                </DropdownMenuItem>
                {/* Stays open on select, so the check shows the new state. */}
                <DropdownMenuCheckboxItem
                  checked={theme === 'dark'}
                  closeOnSelect={false}
                  onSelect={toggleTheme}
                  className="min-[30rem]:hidden"
                >
                  Dark mode
                </DropdownMenuCheckboxItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setSignOutOpen(true)}
                >
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </nav>
      </header>

      <main id="main-content" className="flex-1 min-w-0 bg-workspace pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]" tabIndex={-1}>
        {children}
      </main>

      <footer className="shrink-0 border-t px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground">
        <a href="/privacy" onClick={e => { e.preventDefault(); navigate('/privacy'); }} className="underline hover:text-foreground">Privacy</a>
        {' · '}
        Powered by <a href="https://github.com/1111philo/plato" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">plato</a>.
      </footer>

      <AlertDialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign Out?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll need to sign in again to access your lessons.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={handleSignOut}
            >
              Sign Out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ViewAsUserModal
        open={viewAsOpen}
        onOpenChange={setViewAsOpen}
        onStarted={handleStartedImpersonation}
      />
    </>
  );
}
