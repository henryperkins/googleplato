import { useEffect, useState } from 'react';
import { Moon } from 'lucide-react';
import { THEME_STORAGE_KEY, applyTheme, currentTheme, saveTheme, storedTheme } from '../lib/theme.js';

/**
 * Header toggle between the light and dark themes (lib/theme.js). A toggle
 * button named "Dark mode": the name stays fixed while `aria-pressed` carries
 * on/off, and the moon fills in when dark mode is on. Colors come from the
 * header's text color, so it reads on any classroom header color.
 */
export default function ThemeToggle() {
  // index.html already applied the saved theme, so the page is the source of truth.
  const [theme, setTheme] = useState(currentTheme);
  const dark = theme === 'dark';

  // Follow a change made in another tab, so the pressed state stays truthful.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = storedTheme();
      applyTheme(next);
      setTheme(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    saveTheme(next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label="Dark mode"
      className="touch-target flex shrink-0 items-center justify-center rounded-md border-none bg-transparent p-2 text-inherit cursor-pointer transition-colors hover:bg-current/10"
    >
      <Moon aria-hidden="true" className="size-4" fill={dark ? 'currentColor' : 'none'} />
    </button>
  );
}
