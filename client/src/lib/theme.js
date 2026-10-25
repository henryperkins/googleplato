/**
 * Light/dark theme. The `.dark` class on <html> switches every semantic token
 * in index.css to its dark value. The choice is remembered per browser, and an
 * inline script in index.html applies it before first paint so a dark page
 * never flashes light while the app loads. Without a saved choice, follow the device.
 */

/** Keep in sync with the inline script in client/index.html. */
export const THEME_STORAGE_KEY = 'plato_theme';

let temporaryChoice = null;
function savedChoice() {
  if (temporaryChoice) return temporaryChoice;
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch {
    return temporaryChoice;
  }
}

/** A saved choice takes precedence over the device's current preference. */
export function storedTheme() {
  return savedChoice() || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
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
    temporaryChoice = null;
  } catch { temporaryChoice = theme; /* Keep the choice for this page session. */ }
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
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  temporaryChoice = null;
  applyTheme(storedTheme());
  notify();
}

let devicePreference;
function onDeviceChange() {
  if (savedChoice()) return;
  applyTheme(storedTheme());
  notify();
}

/** Call `listener` whenever the theme changes, here or in another tab. Returns an unsubscribe function. */
export function subscribeTheme(listener) {
  if (listeners.size === 0) {
    window.addEventListener('storage', onStorage);
    devicePreference = window.matchMedia?.('(prefers-color-scheme: dark)');
    devicePreference?.addEventListener('change', onDeviceChange);
    // The device may have changed while no theme control was mounted.
    if (currentTheme() !== storedTheme()) applyTheme(storedTheme());
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('storage', onStorage);
      devicePreference?.removeEventListener('change', onDeviceChange);
    }
  };
}
