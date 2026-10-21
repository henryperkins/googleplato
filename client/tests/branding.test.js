import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PRIMARY,
  DEFAULT_ACCENT,
  applyThemeVarsToRoot,
  buildThemeVars,
  contrastRatio,
  contrastText,
  generateFavicon,
  hexToOklch,
  luminance,
  normalizeHex,
  readableColor,
  setFavicon,
} from '../src/lib/branding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');
const readSrc = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

describe('classroom color contrast', () => {
  it('keeps brand colors while selecting readable text for midtone backgrounds', () => {
    assert.equal(contrastText('#8b1a1a'), '#ffffff');
    assert.equal(contrastText('#ffffff'), '#1a1a1a');
    assert.ok(contrastRatio(contrastText('#999999'), '#999999') >= 4.5);
  });

  it('covers the gap between white and near-black across grayscale and colored palettes', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#470d99'];
    for (let value = 0; value <= 255; value++) colors.push('#' + value.toString(16).padStart(2, '0').repeat(3));
    for (const color of colors) {
      assert.ok(contrastRatio(contrastText(color), color) >= 4.5, color);
    }
  });

  it('preserves readable accents and adjusts failing light and dark text colors', () => {
    assert.equal(readableColor('#470d99', '#f5f5f5'), '#470d99');
    for (const background of ['#f5f5f5', '#303030']) {
      for (const color of ['#ffffff', '#000000', '#999999', '#ffff00', '#8b1a1a', '#dc2626']) {
        assert.ok(contrastRatio(readableColor(color, background), background) >= 4.6, `${color} on ${background}`);
      }
    }
  });

  it('separates original surfaces from accessible link and focus roles in both themes', () => {
    const vars = buildThemeVars({ primary: '#ffffff', accent: '#999999' });
    assert.equal(vars['--classroom-header-bg'], '#ffffff');
    assert.equal(vars['--primary'], hexToOklch('#ffffff'));
    assert.notEqual(vars['--classroom-link-light'], vars['--primary']);
    assert.notEqual(vars['--classroom-link-dark'], vars['--classroom-link-light']);
    assert.equal(vars['--classroom-ring-light'], vars['--classroom-link-light']);
  });

  it('ignores malformed theme values and falls back to primary when accent is absent', () => {
    assert.deepEqual(buildThemeVars(null), {});
    assert.deepEqual(buildThemeVars({ primary: 'invalid', accent: '#xyzxyz' }), {});
    assert.equal(buildThemeVars({ primary: '#8b1a1a' })['--classroom-link-light'], hexToOklch('#8b1a1a'));
  });

  it('normalizes shorthand and non-six-digit theme colors instead of dropping them', () => {
    assert.equal(normalizeHex('#fff'), '#ffffff');
    assert.equal(normalizeHex('#FFF'), '#ffffff');
    assert.equal(normalizeHex('#f008'), '#ff0000');
    assert.equal(normalizeHex('#ff000080'), '#ff0000');
    assert.equal(normalizeHex('ff0000'), '#ff0000');
    assert.equal(normalizeHex('rgb(255, 0, 0)'), '#ff0000');
    assert.equal(normalizeHex('rgba(255, 0, 0, 0.5)'), '#ff0000');
    assert.equal(normalizeHex('  #8b1a1a  '), '#8b1a1a');
    assert.equal(normalizeHex('invalid'), null);
    assert.equal(normalizeHex('#xyzxyz'), null);
    assert.equal(normalizeHex(null), null);
    // Regression for issue 1: shorthand primary used to yield {}.
    assert.deepEqual(buildThemeVars({ primary: '#fff' }), buildThemeVars({ primary: '#ffffff' }));
    assert.equal(buildThemeVars({ primary: '#fff' })['--classroom-header-bg'], '#ffffff');
    assert.ok(contrastRatio(contrastText('#fff'), '#ffffff') >= 4.5);
    assert.equal(hexToOklch('#fff'), hexToOklch('#ffffff'));
    assert.equal(readableColor('#fff', '#ffffff'), readableColor('#ffffff', '#ffffff'));
  });

  it('exposes --ring for consumers that apply vars without .classroom-theme', () => {
    const vars = buildThemeVars({ primary: '#470d99', accent: '#dc2626' });
    assert.equal(vars['--ring'], vars['--classroom-ring-light']);
    assert.ok(vars['--ring']);
  });
});

it('derived branding text meets normal-text contrast for configurable colors', () => {
  for (let red = 0; red <= 255; red += 17) {
    for (let green = 0; green <= 255; green += 17) {
      for (let blue = 0; blue <= 255; blue += 17) {
        const background = '#' + [red, green, blue].map(c => c.toString(16).padStart(2, '0')).join('');
        const bg = luminance(background);
        const fg = luminance(contrastText(background));
        const ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
        assert.ok(ratio >= 4.5, `${background} uses ${contrastText(background)} at ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

it('default brand and very light backgrounds preserve their foregrounds', () => {
  assert.equal(DEFAULT_PRIMARY, '#470d99');
  assert.equal(DEFAULT_ACCENT, '#470d99');
  assert.equal(contrastText('#470d99'), '#ffffff');
  assert.equal(contrastText('#ffffff'), '#1a1a1a');
});

describe('root theme application, favicons, and customizer parity', () => {
  it('applies .classroom-theme and CSS vars to documentElement so portaled modals inherit them, then restores on cleanup', () => {
    const props = new Map([['--primary', 'existing-primary']]);
    const classes = new Set();
    const prevDocument = globalThis.document;
    globalThis.document = {
      documentElement: {
        classList: {
          contains: (c) => classes.has(c),
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
        },
        style: {
          getPropertyValue: (k) => props.get(k) || '',
          setProperty: (k, v) => props.set(k, v),
          removeProperty: (k) => props.delete(k),
        },
      },
    };
    try {
      const cleanup = applyThemeVarsToRoot({ primary: '#8b1a1a', accent: '#dc2626' });
      assert.equal(classes.has('classroom-theme'), true);
      assert.equal(props.get('--classroom-header-bg'), '#8b1a1a');
      assert.equal(props.get('--primary'), hexToOklch('#8b1a1a'));
      assert.ok(props.get('--ring'));

      cleanup();
      assert.equal(classes.has('classroom-theme'), false);
      assert.equal(props.get('--primary'), 'existing-primary');
      assert.equal(props.has('--classroom-header-bg'), false);
    } finally {
      globalThis.document = prevDocument;
    }
  });

  it('generates a text-initial favicon when no logo is uploaded and restores the original favicon on cleanup', async () => {
    const drawnTexts = [];
    const fills = [];
    const linkEl = { rel: 'icon', type: 'image/svg+xml', href: '/assets/favicon.svg' };
    const prevDocument = globalThis.document;
    globalThis.document = {
      createElement: (tag) => {
        if (tag === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              beginPath() {},
              moveTo() {},
              lineTo() {},
              quadraticCurveTo() {},
              closePath() {},
              fill() { fills.push(this.fillStyle); },
              fillText(text) { drawnTexts.push({ text, color: this.fillStyle }); },
            }),
            toDataURL: () => 'data:image/png;base64,FAVICON',
          };
        }
        return {};
      },
      querySelector: () => linkEl,
      head: { appendChild() {} },
    };
    try {
      const dataUrl = await generateFavicon(null, '#8b1a1a', 'AI Leaders Academy');
      assert.equal(dataUrl, 'data:image/png;base64,FAVICON');
      assert.equal(fills[0], '#8b1a1a');
      assert.deepEqual(drawnTexts[0], { text: 'A', color: '#ffffff' });

      const restore = setFavicon(dataUrl);
      assert.equal(linkEl.href, 'data:image/png;base64,FAVICON');
      assert.equal(linkEl.type, 'image/png');
      restore();
      assert.equal(linkEl.href, '/assets/favicon.svg');
      assert.equal(linkEl.type, 'image/svg+xml');
    } finally {
      globalThis.document = prevDocument;
    }
  });

  it('aligns default colors, workspace preview surface, text fallback, and favicon wiring across branding consumers', () => {
    const customizer = readSrc('pages/admin/AdminCustomizer.jsx');
    const brandingCtx = readSrc('contexts/BrandingContext.jsx');
    const publicHook = readSrc('hooks/usePublicBranding.js');

    // Default purple shared via branding.js; no hardcoded #8b1a1a fallback in client hooks/customizer
    assert.equal(/#8b1a1a/.test(customizer), false);
    assert.equal(/#8b1a1a/.test(publicHook), false);
    assert.match(customizer, /bg-workspace text-sm space-y-2/);
    assert.match(customizer, /\{classroomName \|\| 'plato'\}/);
    assert.equal(/Your Classroom/.test(customizer), false);

    // Both BrandingContext and usePublicBranding apply vars to :root and pass classroomName to generateFavicon
    assert.match(brandingCtx, /applyThemeVarsToRoot\(branding\.theme\)/);
    assert.match(brandingCtx, /generateFavicon\(branding\.logoBase64,\s*primaryColor,\s*branding\.classroomName\)/);
    assert.equal(/isAdmin/.test(brandingCtx), false);
    assert.match(publicHook, /applyThemeVarsToRoot\(branding\?\.theme\)/);
    assert.match(publicHook, /generateFavicon\(branding\.logoBase64,\s*primaryColor,\s*branding\.classroomName\)/);
  });
});
