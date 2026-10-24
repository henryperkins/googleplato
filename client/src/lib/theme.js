/**
 * Light/dark theme. The `.dark` class on <html> switches every semantic token
 * in index.css to its dark value. The choice is remembered per browser, and an
 * inline script in index.html applies it before first paint so a dark page
 * never flashes light while the app loads. Light is the default.
 */

/** Keep in sync with the inline script in client/index.html. */
export const THEME_STORAGE_KEY = 'plato_theme';

/** The saved theme, or 'light' when none is saved or storage is unavailable. */
export function storedTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The theme the page is showing. */
export function currentTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Show a theme without saving it, e.g. one another tab just saved. Elements
 * with color transitions would fade a beat behind the rest (dark text briefly
 * on a dark card), so transitions stay off until a frame has rendered the new
 * colors; removing the pause then changes no color, so nothing animates.
 */
export function applyTheme(theme) {
  const pause = document.createElement('style');
  pause.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(pause);
  document.documentElement.classList.toggle('dark', theme === 'dark');
  requestAnimationFrame(() => requestAnimationFrame(() => pause.remove()));
}

/** Show and remember a theme. The page still switches when storage is unavailable. */
export function saveTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch { /* Storage can be unavailable (private browsing, quota). */ }
  notify();
}

// Every theme control (the header button, the account-menu item, the sign-in
// page's) reads one store, so they agree, and one storage listener follows a
// choice made in another tab.
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event) {
  if (event.key !== THEME_STORAGE_KEY) return;
  applyTheme(storedTheme());
  notify();
}

/** Call `listener` whenever the theme changes, here or in another tab. Returns an unsubscribe function. */
export function subscribeTheme(listener) {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}
