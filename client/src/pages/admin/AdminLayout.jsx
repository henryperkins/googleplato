import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { House, BookOpen, Users, Palette, Sparkles, Puzzle } from 'lucide-react';

const NAV_LINKS = [
  { to: '/plato', label: 'Home', end: true, Icon: House },
  { to: '/plato/lessons', label: 'Lessons', Icon: BookOpen },
  { to: '/plato/users', label: 'Users', Icon: Users },
  { to: '/plato/customizer', label: 'Customizer', Icon: Palette },
  { to: '/plato/ai', label: 'AI Settings', Icon: Sparkles },
  { to: '/plato/plugins', label: 'Plugins', Icon: Puzzle },
];

function NavItems({ onClick }) {
  return NAV_LINKS.map(({ to, label, end }) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        `touch-target flex items-center px-3 py-2 rounded-md text-sm transition-colors whitespace-nowrap ${
          isActive
            ? 'bg-sidebar-foreground/20 font-medium'
            : 'hover:bg-sidebar-foreground/10'
        }`
      }
    >
      {label}
    </NavLink>
  ));
}

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [version, setVersion] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  useEffect(() => {
    fetch('/v1/version').then(r => r.json()).then(d => setVersion(d.version)).catch(() => {});
  }, []);

  // Close menu on route change
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = event => { if (event.matches) setMenuOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  const handleSignOut = async () => {
    setSignOutOpen(false);
    setMenuOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <>
    <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
      <div className="flex h-dvh flex-col overflow-hidden md:h-auto md:min-h-dvh md:flex-row md:overflow-visible">
        {/* Mobile: compact top bar with brand, classroom shortcut, and drawer trigger */}
        <header
          className="md:hidden shrink-0 bg-sidebar text-sidebar-foreground flex flex-wrap items-center justify-between gap-2 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
          style={{ '--ring': 'var(--sidebar-foreground)' }}
        >
          <a href="/plato" onClick={e => { e.preventDefault(); navigate('/plato'); }} className="touch-target flex items-center rounded-sm shrink-0">
            <img src="/assets/logo-white.svg" alt="plato" width="50" height="20" className="h-5 w-auto" />
          </a>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="secondary"
              size="xs"
              className="whitespace-nowrap shrink-0"
              onClick={() => navigate('/lessons')}
            >
              Classroom
            </Button>
            <DialogTrigger
              className="touch-target flex items-center justify-center rounded-sm bg-transparent border-none cursor-pointer text-primary-foreground p-1"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </DialogTrigger>
          </div>
        </header>

        {/* Mobile: native <dialog> slide-out drawer */}
        <DialogContent
          variant="drawer"
          showCloseButton={false}
          className="admin-drawer p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          style={{ '--ring': 'var(--sidebar-foreground)' }}
        >
          <DialogTitle className="sr-only">Admin menu</DialogTitle>
          {/* The visible hint below already tells sighted users about the
              bottom tabs; the description only needs to cover this drawer. */}
          <DialogDescription className="sr-only">Sign out or open the classroom.</DialogDescription>
          <div className="flex items-center justify-between px-4 py-3">
            <img src="/assets/logo-white.svg" alt="plato" width="60" height="24" className="h-6 w-auto" />
            <DialogClose
              className="touch-target flex items-center justify-center rounded-sm bg-transparent border-none cursor-pointer text-primary-foreground p-1"
              aria-label="Close menu"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </DialogClose>
          </div>

          <p className="px-4 py-3 text-sm text-sidebar-foreground/80">
            Use the tabs at the bottom of the screen to move between admin pages.
          </p>

          <div className="flex flex-col gap-2 px-4 py-3 mt-auto">
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => { setMenuOpen(false); navigate('/lessons'); }}
            >
              Visit Classroom
            </Button>
            <Separator className="bg-primary-foreground/20" />
            <span className="text-xs truncate opacity-80">{user?.email || ''}</span>
            <Button
              variant="link"
              size="sm"
              className="justify-start p-0 h-auto text-primary-foreground hover:text-primary-foreground focus-visible:ring-primary-foreground"
              onClick={() => { setMenuOpen(false); setSignOutOpen(true); }}
            >
              Sign Out
            </Button>
            {version && (
              <>
                <Separator className="bg-primary-foreground/20" />
                <a
                  href="https://github.com/1111philo/plato"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="touch-target flex items-center text-xs opacity-60 hover:opacity-100 transition-opacity"
                >
                  plato {version}
                </a>
              </>
            )}
          </div>
        </DialogContent>

        {/* Desktop: fixed sidebar */}
        <aside
          className="hidden md:flex md:w-56 md:h-screen md:fixed md:top-0 md:left-0 bg-sidebar text-sidebar-foreground md:flex-col shrink-0"
          aria-label="Admin sidebar"
          style={{ '--ring': 'var(--sidebar-foreground)' }}
        >
          <div className="px-4 py-4">
            <img src="/assets/logo-white.svg" alt="plato" width="60" height="24" className="h-6 w-auto" />
          </div>

          <nav className="flex flex-col flex-1 gap-0.5 px-2" aria-label="Admin navigation">
            <NavItems />
          </nav>

          <div className="flex flex-col gap-2 px-4 py-3 mt-auto">
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => navigate('/lessons')}
            >
              Visit Classroom
            </Button>
            <Separator className="bg-primary-foreground/20" />
            <span className="text-xs truncate opacity-80">{user?.email || ''}</span>
            <Button
              variant="link"
              size="sm"
              className="justify-start p-0 h-auto text-primary-foreground/80 hover:text-primary-foreground"
              onClick={() => setSignOutOpen(true)}
            >
              Sign Out
            </Button>
            {version && (
              <>
                <Separator className="bg-primary-foreground/20" />
                <a
                  href="https://github.com/1111philo/plato"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs opacity-60 hover:opacity-100 transition-opacity"
                >
                  plato {version}
                </a>
              </>
            )}
          </div>
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] md:ml-56 md:overflow-visible">
          <div className="min-w-0 max-w-4xl pb-4">
            <Outlet />
          </div>
        </main>

        {/* Mobile bottom tab bar exposes admin destinations without requiring the drawer. */}
        <nav
          className="admin-bottom-nav md:hidden shrink-0 flex items-center justify-around border-t bg-background pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pb-[env(safe-area-inset-bottom)]"
          aria-label="Admin primary navigation"
        >
          {NAV_LINKS.map(({ to, label, end, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) =>
                `touch-target flex flex-1 items-center justify-center border-t-2 px-1 py-2.5 transition-colors ${
                  isActive
                    ? 'border-primary text-primary-text'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={22} strokeWidth={isActive ? 2.25 : 1.9} aria-hidden="true" />
                  <span className="sr-only">{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
    </Dialog>

    <AlertDialog open={signOutOpen} onOpenChange={setSignOutOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign Out?</AlertDialogTitle>
          <AlertDialogDescription>
            You&apos;ll need to sign in again to access the admin dashboard.
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
    </>
  );
}
