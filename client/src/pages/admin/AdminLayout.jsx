import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { BookOpen, ChevronDown, ExternalLink, House, Palette, Puzzle, Sparkles, Users } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useTheme } from '../../hooks/useTheme.js';
import { adminPageName } from '../../lib/routeTitles.js';
import ThemeToggle from '../../components/ThemeToggle.jsx';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
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
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

const NAV_LINKS = [
  { to: '/plato', label: 'Home', end: true, Icon: House },
  { to: '/plato/lessons', label: 'Lessons', Icon: BookOpen },
  { to: '/plato/users', label: 'Users', Icon: Users },
  { to: '/plato/customizer', label: 'Customizer', Icon: Palette },
  { to: '/plato/ai', label: 'AI Settings', Icon: Sparkles },
  { to: '/plato/plugins', label: 'Plugins', Icon: Puzzle },
];

const SOURCE_URL = 'https://github.com/1111philo/plato';

function NavItems() {
  return NAV_LINKS.map(({ to, label, end }) => (
    <NavLink
      key={to}
      to={to}
      end={end}
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
  const [theme, toggleTheme] = useTheme();
  const [version, setVersion] = useState(null);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const shellRef = useRef(null);
  const mainRef = useRef(null);
  const page = adminPageName(location.pathname);
  const pageRef = useRef(page);

  useEffect(() => {
    fetch('/v1/version').then(r => r.json()).then(d => setVersion(d.version)).catch(() => {});
  }, []);

  // A new admin page opens at its top with focus inside it, as a page load
  // would; ScreenReaderAnnounce names it. Moving within a page (a user's edit
  // view, the lesson editor) keeps both. A layout effect, so the old scroll
  // position never paints, and a page that places focus itself still wins.
  useLayoutEffect(() => {
    if (pageRef.current === page) return;
    pageRef.current = page;
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    const active = document.activeElement;
    const fromChrome = !active || active === document.body
      || (shellRef.current?.contains(active) && !main.contains(active));
    if (fromChrome) main.focus({ preventScroll: true });
  }, [page]);

  const handleSignOut = async () => {
    setSignOutOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  const accountName = user?.name || user?.username || user?.email || 'Account';
  // Shown before the version loads too, so the rows above it never shift.
  const versionLabel = version ? `plato ${version}` : 'plato';

  return (
    <>
    <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-primary focus:text-primary-foreground">
      Skip to main content
    </a>
    <div ref={shellRef} className="admin-shell flex h-dvh flex-col overflow-hidden lg:h-auto lg:min-h-dvh lg:flex-row lg:overflow-visible">
      {/* Phones and tablets: the brand, then the theme and account menu, as in
          the classroom header. sidebar-control gives the bar's own controls a
          light focus ring; the menu sits on the popover and keeps the page's. */}
      <header className="lg:hidden shrink-0 bg-sidebar text-sidebar-foreground flex items-center justify-between gap-2 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <a href="/plato" onClick={e => { e.preventDefault(); navigate('/plato'); }} className="sidebar-control touch-target flex items-center rounded-sm shrink-0">
          <img src="/assets/logo-white.svg" alt="plato" width="50" height="20" className="h-5 w-auto" />
        </a>
        <div className="flex min-w-0 items-center gap-1">
          {/* Under 30rem the button would crowd the name, so the choice moves into the menu. */}
          <ThemeToggle className="sidebar-control hidden min-[30rem]:flex" />
          <DropdownMenu>
            <DropdownMenuTrigger
              className="sidebar-control touch-target group flex min-w-0 items-center gap-1 truncate text-inherit cursor-pointer bg-transparent border-none rounded-md px-3 py-1.5 text-sm font-medium"
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
              <DropdownMenuItem onSelect={() => navigate('/lessons')}>
                Visit Classroom
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
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-xs text-muted-foreground"
                onSelect={() => window.open(SOURCE_URL, '_blank', 'noopener,noreferrer')}
              >
                {versionLabel}
                <ExternalLink aria-hidden="true" className="ml-auto size-3.5" />
                <span className="sr-only"> (opens in a new tab)</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Desktop: fixed sidebar, scrolling when the window is too short for it. */}
      <aside
        className="hidden lg:flex lg:w-56 lg:h-dvh lg:fixed lg:top-0 lg:left-0 lg:overflow-y-auto lg:overscroll-contain bg-sidebar text-sidebar-foreground lg:flex-col shrink-0"
        aria-label="Admin sidebar"
        style={{ '--ring': 'var(--sidebar-foreground)' }}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <img src="/assets/logo-white.svg" alt="plato" width="60" height="24" className="h-6 w-auto" />
          <ThemeToggle className="-mr-2" />
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
            className="justify-start h-auto min-h-6 border-0 px-0 text-primary-foreground/80 hover:text-primary-foreground"
            onClick={() => setSignOutOpen(true)}
          >
            Sign Out
          </Button>
          <Separator className="bg-primary-foreground/20" />
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs opacity-60 hover:opacity-100 transition-opacity"
          >
            {versionLabel}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </aside>

      <main
        ref={mainRef}
        id="main-content"
        tabIndex={-1}
        className="admin-main min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] lg:ml-56 lg:overflow-visible"
      >
        <div className="min-w-0 max-w-4xl pb-4">
          <Outlet />
        </div>
      </main>

      {/* Phones and tablets: a tab per admin page. */}
      <nav
        className="admin-bottom-nav lg:hidden shrink-0 flex items-stretch border-t bg-background pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pb-[env(safe-area-inset-bottom)]"
        aria-label="Admin navigation"
      >
        {NAV_LINKS.map(({ to, label, end, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `touch-target flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-0.5 py-2.5 min-[30rem]:py-1.5 transition-colors ${
                isActive
                  ? 'border-primary text-primary-text'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon aria-hidden="true" strokeWidth={isActive ? 2.25 : 1.9} className="size-[1.375rem]" />
                {/* Six labels fit from 30rem; narrower, the icons stand alone
                    and the label stays for screen readers. */}
                <span className={`sr-only min-[30rem]:not-sr-only min-[30rem]:text-center min-[30rem]:text-xs min-[30rem]:leading-4 ${isActive ? 'font-medium' : ''}`}>
                  {label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>

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
