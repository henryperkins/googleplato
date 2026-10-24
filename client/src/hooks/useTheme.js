import { useSyncExternalStore } from 'react';
import { currentTheme, saveTheme, subscribeTheme } from '../lib/theme.js';

/**
 * The page's theme ('light' or 'dark') and a function that switches it. Every
 * caller shares lib/theme.js's store, so all theme controls show the same
 * state, including after another tab changes it.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const toggleTheme = () => saveTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  return [theme, toggleTheme];
}
