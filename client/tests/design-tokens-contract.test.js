/**
 * Colors come from the semantic tokens in client/src/index.css (documented in
 * DESIGN.md), not raw Tailwind palette classes: a stray `bg-green-50` or
 * `text-blue-700` ignores dark mode, classroom branding, and the contrast the
 * tokens were tuned for. Plugin UIs, and the templates new plugins are
 * scaffolded from, are held to the same rule, and Tailwind must scan plugin
 * UIs or classes only a plugin uses are never generated.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const CLIENT_SRC = path.join(REPO, 'client', 'src');
const PLUGINS = path.join(REPO, 'plugins');
const PLUGIN_TEMPLATES = path.join(REPO, 'docs', 'plugins', 'templates');

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
    const css = fs.readFileSync(path.join(CLIENT_SRC, 'index.css'), 'utf8');
    for (const token of ['workspace', 'completed-background', 'completed-foreground', 'in-progress-background', 'in-progress-foreground']) {
      assert.match(css, new RegExp(`--${token}:\\s*oklch`), `--${token} value`);
      assert.match(css, new RegExp(`--color-${token}:\\s*var\\(--${token}\\)`), `--color-${token} mapping`);
    }
  });

  it('has Tailwind scan every plugin UI file, so classes only a plugin uses are generated', async () => {
    // Run Tailwind's own compiler and scanner, as the Vite plugin does. A
    // directive can parse and still match nothing ("plugins/*/client" did), so
    // check the files the scanner reads, not the directive's text.
    const { compile } = await import('@tailwindcss/node');
    const { Scanner } = await import('@tailwindcss/oxide');
    const css = fs.readFileSync(path.join(CLIENT_SRC, 'index.css'), 'utf8');
    const compiler = await compile(css, { base: CLIENT_SRC, onDependency() {} });
    const scanner = new Scanner({ sources: compiler.sources });
    scanner.scan();
    const scanned = new Set(scanner.files.map((file) => path.relative(REPO, file)));
    const pluginUi = pluginUiFiles().map((file) => path.relative(REPO, file));
    assert.ok(pluginUi.length > 0, 'expected at least one plugin UI file');
    assert.deepEqual(pluginUi.filter((file) => !scanned.has(file)), []);
  });
});
