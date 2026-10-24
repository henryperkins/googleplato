/**
 * Colors come from the semantic tokens in client/src/index.css (documented in
 * DESIGN.md), not raw Tailwind palette classes: a stray `bg-green-50` or
 * `text-blue-700` ignores dark mode, classroom branding, and the contrast the
 * tokens were tuned for. Plugin UIs, and the templates new plugins are
 * scaffolded from, are held to the same rule, and Tailwind must scan plugin
 * UIs or classes only a plugin uses are never generated. The tokens themselves
 * keep their contrast in both themes, for any classroom hue.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio, oklchToHex } from '../src/lib/branding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const CLIENT_SRC = path.join(REPO, 'client', 'src');
const PLUGINS = path.join(REPO, 'plugins');
const PLUGIN_TEMPLATES = path.join(REPO, 'docs', 'plugins', 'templates');
const CSS = fs.readFileSync(path.join(CLIENT_SRC, 'index.css'), 'utf8').replace(/\r\n/g, '\n');

// The body of the top-level rule whose selector list is exactly `selector`.
function rule(selector) {
  const start = CSS.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `${selector} rule`);
  return CSS.slice(start, CSS.indexOf('\n}', start));
}

// Hex for an oklch() value, with the surface tint (plato purple by default) filled in.
function hexOf(value, tint = { chroma: 0.012, hue: 285 }) {
  const resolved = value
    .replace('calc(var(--tint-chroma) / 3)', String(tint.chroma / 3))
    .replaceAll('var(--tint-chroma)', String(tint.chroma))
    .replaceAll('var(--tint-hue)', String(tint.hue));
  const [, l, c, h] = resolved.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  return oklchToHex(Number(l), Number(c), Number(h));
}
const token = (block, name, tint) => hexOf(block.match(new RegExp(`--${name}:\\s*([^;]+);`))[1], tint);

const PALETTE = /\b(?:bg|text|border|ring|fill|stroke|from|to|outline|decoration|divide|shadow|accent|caret|placeholder)-(?:stone|emerald|amber|green|blue|red|yellow|sky|slate|gray|zinc|neutral|orange|lime|teal|cyan|indigo|violet|purple|pink|rose|fuchsia)-\d{2,3}\b/;

function jsxFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : jsxFiles(full);
    return /\.(jsx|js)$/.test(entry.name) ? [full] : [];
  });
}

function pluginUiFiles() {
  return fs.readdirSync(PLUGINS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => jsxFiles(path.join(PLUGINS, d.name, 'client')));
}

describe('design tokens', () => {
  it('keeps raw palette color classes out of the client, plugin UIs, and plugin templates', () => {
    const offenders = [];
    for (const file of [...jsxFiles(CLIENT_SRC), ...pluginUiFiles(), ...jsxFiles(PLUGIN_TEMPLATES)]) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const match = line.match(PALETTE);
        if (match) offenders.push(`${path.relative(REPO, file)}:${i + 1} ${match[0]}`);
      });
    }
    assert.deepEqual(offenders, []);
  });

  it('defines the workspace and lesson-status tokens DESIGN.md names', () => {
    for (const name of ['workspace', 'completed-background', 'completed-foreground', 'in-progress-background', 'in-progress-foreground', 'header', 'header-foreground']) {
      assert.match(CSS, new RegExp(`--${name}:\\s*(oklch|var)`), `--${name} value`);
      assert.match(CSS, new RegExp(`--color-${name}:\\s*var\\(--${name}\\)`), `--color-${name} mapping`);
    }
  });

  it('gives dark mode its own status chips, and surfaces that rise with elevation', () => {
    const dark = rule('.dark');
    for (const name of ['completed-background', 'completed-foreground', 'in-progress-background', 'in-progress-foreground']) {
      assert.match(dark, new RegExp(`--${name}:\\s*oklch`), `.dark --${name}`);
    }
    // Declared on each .classroom-theme as well, so a classroom's hue reaches
    // them; a .light preview inside a dark page is left out, and keeps the
    // light values `.light` declares.
    const surfaces = rule('.dark,\n.dark .classroom-theme:not(.light *)');
    assert.match(CSS, /\n:root,\n\.light \{/);
    const lightness = (name) => Number(surfaces.match(new RegExp(`--${name}: oklch\\(([\\d.]+) var\\(--tint-chroma\\) var\\(--tint-hue\\)\\)`))[1]);
    // The page lowest; cards and chrome above it; menus above those; a
    // highlighted menu row above the menu.
    assert.ok(lightness('workspace') <= lightness('background'), 'learner page at or below the admin page');
    assert.ok(lightness('background') < lightness('card'), 'cards above the page');
    assert.ok(lightness('card') < lightness('popover'), 'menus above cards');
    assert.ok(lightness('popover') < lightness('muted'), 'muted fills above menus');
    assert.ok(lightness('muted') <= lightness('accent'), 'highlighted rows at the top');
    // The lesson header and message box are chrome, raised off the page.
    assert.match(fs.readFileSync(path.join(CLIENT_SRC, 'pages/LessonChat.jsx'), 'utf8'), /id="lesson-header" className="[^"]*\bbg-card\b/);
    assert.match(fs.readFileSync(path.join(CLIENT_SRC, 'components/chat/ComposeBar.jsx'), 'utf8'), /max-w-3xl rounded-lg border border-input bg-card\b/);
  });

  it('has Tailwind scan every plugin UI file, so classes only a plugin uses are generated', async () => {
    // Run Tailwind's own compiler and scanner, as the Vite plugin does. A
    // directive can parse and still match nothing ("plugins/*/client" did), so
    // check the files the scanner reads, not the directive's text.
    const { compile } = await import('@tailwindcss/node');
    const { Scanner } = await import('@tailwindcss/oxide');
    const compiler = await compile(CSS, { base: CLIENT_SRC, onDependency() {} });
    const scanner = new Scanner({ sources: compiler.sources });
    scanner.scan();
    const scanned = new Set(scanner.files.map((file) => path.relative(REPO, file)));
    const pluginUi = pluginUiFiles().map((file) => path.relative(REPO, file));
    assert.ok(pluginUi.length > 0, 'expected at least one plugin UI file');
    assert.deepEqual(pluginUi.filter((file) => !scanned.has(file)), []);
  });
});

describe('theme contrast', () => {
  const light = rule(':root,\n.light');
  const dark = rule('.dark');
  const surfaces = rule('.dark,\n.dark .classroom-theme:not(.light *)');
  const night = rule('.dark.classroom-theme,\n.dark .classroom-theme:not(.light *)');
  // Any classroom hue: buildThemeVars caps the surface tint at this chroma.
  const HUES = Array.from({ length: 12 }, (_, i) => i * 30);

  it('keeps the status chips readable in both themes', () => {
    for (const [theme, block] of [['light', light], ['dark', dark]]) {
      for (const chip of ['completed', 'in-progress']) {
        const ratio = contrastRatio(token(block, `${chip}-foreground`), token(block, `${chip}-background`));
        assert.ok(ratio >= 4.5, `${theme} ${chip} chip at ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('keeps dark text readable on the lightest surface, whatever hue tints it', () => {
    for (const hue of HUES) {
      const tint = { chroma: 0.012, hue };
      for (const text of ['foreground', 'muted-foreground']) {
        const ratio = contrastRatio(token(surfaces, text, tint), token(surfaces, 'accent', tint));
        assert.ok(ratio >= 4.5, `${text} on accent at hue ${hue}: ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('draws focus at 3:1 on cards and menus in both themes, in the classroom and out', () => {
    const rings = [
      ['light', token(light, 'ring'), [token(light, 'card'), token(light, 'popover')]],
      ['dark', token(dark, 'ring'), [token(surfaces, 'card'), token(surfaces, 'popover')]],
      // An unbranded classroom at night rings in its primary text color.
      ['dark classroom', hexOf(night.match(/--primary-text: var\(--classroom-primary-text-dark, (oklch\([^)]+\))\)/)[1]), [token(surfaces, 'card'), token(surfaces, 'popover')]],
    ];
    for (const [theme, ring, backgrounds] of rings) {
      for (const background of backgrounds) {
        const ratio = contrastRatio(ring, background);
        assert.ok(ratio >= 3, `${theme} ring at ${ratio.toFixed(2)}:1 on ${background}`);
      }
    }
  });

  it('holds the unbranded night header and fills to the rules dark classroom colors follow', () => {
    // lib/branding.js darkHeaderColor and darkFillColor: the header band stands
    // apart from the page (1.5:1), and fills from the card (3:1).
    const page = token(surfaces, 'workspace');
    const card = token(surfaces, 'card');
    assert.ok(contrastRatio(token(dark, 'header'), page) >= 1.5);
    assert.ok(contrastRatio(token(dark, 'header-foreground'), token(dark, 'header')) >= 4.5);
    assert.ok(contrastRatio(token(dark, 'primary'), card) >= 3);
    assert.ok(contrastRatio(token(dark, 'primary-foreground'), token(dark, 'primary')) >= 4.5);
    for (const name of ['header', 'header-foreground', 'primary', 'primary-foreground']) {
      const fallback = night.match(new RegExp(`--${name}: var\\(--classroom-${name === 'header' ? 'header-bg' : name === 'header-foreground' ? 'header-text' : name}-dark, (oklch\\([^)]+\\))\\)`))[1];
      assert.equal(hexOf(fallback), token(dark, name), `the classroom's --${name} fallback matches .dark`);
    }
  });
});
