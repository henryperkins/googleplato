/**
 * Light/dark theme (client/src/lib/theme.js): the theme controls put `.dark` on
 * <html> and remember the choice, an inline script in index.html applies a
 * saved choice before first paint using the same storage key, and every
 * control reads one store that follows other tabs.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { THEME_STORAGE_KEY, applyTheme, currentTheme, saveTheme, storedTheme, subscribeTheme } from '../src/lib/theme.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '..');
// Normalize line endings: Windows checkouts use CRLF.
const read = (rel) => fs.readFileSync(path.join(CLIENT_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

function fakeRoot() {
  const classes = new Set();
  return {
    classList: {
      add: (name) => { classes.add(name); },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    },
  };
}

function fakeStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
  };
}

// Private browsing and blocked site data make storage access throw.
const unavailableStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
};

let root;
let styles;
let frames;
let storageListeners;
let deviceListeners;
let device;
beforeEach(() => {
  root = fakeRoot();
  styles = new Set();
  frames = [];
  storageListeners = new Set();
  deviceListeners = new Set();
  device = { matches: false, addEventListener: (_type, listener) => deviceListeners.add(listener), removeEventListener: (_type, listener) => deviceListeners.delete(listener) };
  globalThis.window = {
    matchMedia: () => device,
    addEventListener: (type, listener) => { if (type === 'storage') storageListeners.add(listener); },
    removeEventListener: (type, listener) => { if (type === 'storage') storageListeners.delete(listener); },
  };
  globalThis.document = {
    documentElement: root,
    head: { appendChild: (el) => { styles.add(el); } },
    createElement: () => {
      const el = { textContent: '', remove: () => { styles.delete(el); } };
      return el;
    },
  };
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); };
  globalThis.localStorage = fakeStorage();
});

const nextFrame = () => frames.splice(0).forEach((callback) => callback());
const transitionsPaused = () => [...styles].some((el) => /transition:\s*none/.test(el.textContent));
afterEach(() => {
  // A fresh page has no volatile choice left over from blocked storage.
  globalThis.localStorage = fakeStorage();
  saveTheme('light');
});

describe('theme choice', () => {
  it('uses the device when nothing usable is saved', () => {
    assert.equal(storedTheme(), 'light');
    device.matches = true;
    assert.equal(storedTheme(), 'dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    assert.equal(storedTheme(), 'dark');
    globalThis.localStorage = unavailableStorage;
    assert.equal(storedTheme(), 'dark');
  });

  it('puts .dark on <html> and remembers the choice', () => {
    saveTheme('dark');
    assert.equal(root.classList.contains('dark'), true);
    assert.equal(currentTheme(), 'dark');
    assert.equal(storedTheme(), 'dark');

    saveTheme('light');
    assert.equal(root.classList.contains('dark'), false);
    assert.equal(currentTheme(), 'light');
    assert.equal(localStorage.getItem(THEME_STORAGE_KEY), 'light');
  });

  it('still switches the page when storage is unavailable', () => {
    globalThis.localStorage = unavailableStorage;
    assert.doesNotThrow(() => saveTheme('dark'));
    assert.equal(currentTheme(), 'dark');
  });

  it('keeps a session choice when storage is readable but writes fail', () => {
    const stop = subscribeTheme(() => {});
    localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    saveTheme('dark');
    assert.equal(storedTheme(), 'dark');
    for (const listener of deviceListeners) listener();
    assert.equal(currentTheme(), 'dark');
    stop();
  });

  it('shows a theme saved elsewhere without saving it again', () => {
    applyTheme('dark');
    assert.equal(currentTheme(), 'dark');
    assert.equal(localStorage.getItem(THEME_STORAGE_KEY), null);
  });

  it('switches every color in the same frame instead of staggered fades', () => {
    saveTheme('dark');
    assert.equal(transitionsPaused(), true, 'transitions are off when the class flips');
    nextFrame();
    assert.equal(transitionsPaused(), true, 'and stay off while the next frame renders the new colors');
    nextFrame();
    assert.equal(transitionsPaused(), false, 'then come back');
  });
});

describe('first paint', () => {
  // Run index.html's inline <head> script the way the browser does: before
  // the body paints and before the app's module script loads.
  function firstPaint(storage, darkDevice = false) {
    const head = read('index.html').split('</head>')[0];
    const inline = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    assert.ok(inline, 'index.html should apply the saved theme from an inline script in <head>');
    const documentElement = fakeRoot();
    vm.runInNewContext(inline, { localStorage: storage, document: { documentElement }, window: { matchMedia: () => ({ matches: darkDevice }) } });
    return documentElement.classList.contains('dark') ? 'dark' : 'light';
  }

  it('applies the theme the toggle saved, with the same key and class', () => {
    saveTheme('dark');
    assert.equal(firstPaint(localStorage), 'dark');
    saveTheme('light');
    assert.equal(firstPaint(localStorage), 'light');
    assert.equal(firstPaint(fakeStorage()), 'light');
    assert.equal(firstPaint(unavailableStorage), 'light');
    assert.equal(firstPaint(fakeStorage(), true), 'dark');
    assert.equal(firstPaint(unavailableStorage, true), 'dark');
    assert.equal(firstPaint(localStorage, true), 'light', 'a saved light choice overrides a dark device');
  });

  it('switches native controls and scrollbars with the theme', () => {
    const css = read('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const schemes = new Map();
    // Check each selector independently; page and panel scopes may share a rule.
    for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const scheme = declarations.match(/\bcolor-scheme:\s*(light|dark)\s*;/);
      if (!scheme) continue;
      for (const selector of selectors.split(',')) schemes.set(selector.trim(), scheme[1]);
    }
    for (const [selector, scheme] of [['html', 'light'], ['.light', 'light'], ['html.dark', 'dark'], ['.dark', 'dark']]) {
      assert.equal(schemes.get(selector), scheme, `${selector} native color scheme`);
    }
  });
});

describe('theme store', () => {
  it('follows device changes until an explicit choice is saved', () => {
    const seen = [];
    const stop = subscribeTheme(() => seen.push(currentTheme()));
    assert.equal(deviceListeners.size, 1);
    device.matches = true;
    for (const listener of deviceListeners) listener();
    assert.equal(currentTheme(), 'dark');
    saveTheme('light');
    for (const listener of deviceListeners) listener();
    assert.equal(currentTheme(), 'light');
    localStorage.setItem(THEME_STORAGE_KEY, '');
    for (const listener of storageListeners) listener({ key: null });
    assert.equal(currentTheme(), 'dark');
    assert.deepEqual(seen, ['dark', 'light', 'dark']);
    stop();
    assert.equal(deviceListeners.size, 0);
  });
  it('tells every subscriber when the theme changes, until it unsubscribes', () => {
    const seen = [];
    const stopA = subscribeTheme(() => seen.push(`a:${currentTheme()}`));
    const stopB = subscribeTheme(() => seen.push(`b:${currentTheme()}`));
    saveTheme('dark');
    stopA();
    saveTheme('light');
    stopB();
    saveTheme('dark');
    assert.deepEqual(seen, ['a:dark', 'b:dark', 'b:light']);
  });

  it('follows a choice saved in another tab, with one storage listener for every control', () => {
    const seen = [];
    const stops = [subscribeTheme(() => seen.push(currentTheme())), subscribeTheme(() => {})];
    assert.equal(storageListeners.size, 1);
    // The other tab has already written the value when the event arrives here.
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    for (const listener of storageListeners) listener({ key: THEME_STORAGE_KEY });
    assert.equal(currentTheme(), 'dark');
    assert.equal(localStorage.getItem(THEME_STORAGE_KEY), 'dark');
    assert.deepEqual(seen, ['dark']);
    for (const listener of storageListeners) listener({ key: 'plato_auth' });
    assert.deepEqual(seen, ['dark'], 'other keys are ignored');
    stops.forEach((stop) => stop());
    assert.equal(storageListeners.size, 0, 'the listener goes with the last subscriber');
  });
});

describe('theme boot', () => {
  it('follows device changes on pages without a theme control', () => {
    // Waitlist, Signup and the other public pages mount no control, so the app
    // keeps one subscription for the life of the page.
    assert.match(read('src/main.jsx'), /^subscribeTheme\(\(\) => \{\}\);$/m);
  });
});

describe('theme controls', () => {
  it('sit in the classroom header as a named toggle button whose tooltip shows its name', () => {
    const shell = read('src/components/AppShell.jsx');
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    assert.match(header, /<ThemeToggle\b[^>]*\/>/);

    // A toggle button keeps one name; `aria-pressed` says whether it is on.
    const toggle = read('src/components/ThemeToggle.jsx');
    assert.match(toggle, /type="button"/);
    assert.match(toggle, /aria-pressed=\{dark\}/);
    assert.match(toggle, /aria-label="Dark mode"/);
    assert.match(toggle, /touch-target/);
    assert.match(toggle, /useTheme\(\)/);
    // The visible tooltip says what the accessible name says (WCAG 2.5.3).
    assert.match(toggle, /<Tooltip\.Popup[^>]*>\s*Dark mode\s*<\/Tooltip\.Popup>/);
    // Only the hover wash animates, so its focus ring appears at once, like the
    // other header controls' (transition-colors would fade the outline in).
    assert.match(toggle, /transition-\[background-color\]/);
    assert.equal(/transition-colors/.test(toggle), false);
  });

  it('move into the account menu where the header is too narrow for the button and the name', () => {
    const shell = read('src/components/AppShell.jsx');
    assert.match(shell, /<ThemeToggle className="header-control hidden min-\[30rem\]:flex" \/>/);
    const item = shell.match(/<DropdownMenuCheckboxItem[\s\S]*?<\/DropdownMenuCheckboxItem>/)?.[0];
    assert.ok(item, 'a Dark mode checkbox item in the account menu');
    assert.match(item, /checked=\{theme === 'dark'\}/);
    assert.match(item, /closeOnSelect=\{false\}/);
    assert.match(item, /className="min-\[30rem\]:hidden"/);
    assert.match(item, />\s*Dark mode\s*</);

    // Arrow keys reach checkbox items and skip items a breakpoint hides.
    const menu = read('src/components/ui/dropdown-menu.jsx');
    assert.match(menu, /\[role="menuitemcheckbox"\]/);
    assert.match(menu, /getClientRects\(\)\.length > 0/);
    assert.match(menu, /if \(closeOnSelect\) ctx\?\.closeMenu\(false\);/);
  });

  it('offer the choice on every public page too, ringed in the page text color', () => {
    const footer = read('src/components/PublicFooter.jsx');
    assert.match(footer, /<div className="[^"]*" style=\{\{ '--ring': 'currentColor' \}\}>[\s\S]*<ThemeToggle \/>/);
    for (const page of ['Login', 'Signup', 'Waitlist', 'ForgotPassword', 'ResetPassword', 'Privacy', 'Setup']) {
      const src = read(`src/pages/${page}.jsx`);
      assert.match(src.slice(src.lastIndexOf('</Card>')), /<PublicFooter\b[\s\S]*?\/>\s*<\/main>/, `${page} footer`);
    }
  });
});
