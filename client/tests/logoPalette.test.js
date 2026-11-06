import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logoMatteFromPixels, paletteFromPixels, suggestLogoTheme } from '../src/lib/logoPalette.js';
import { contrastRatio } from '../src/lib/branding.js';

const pixels = (...samples) => ({ data: Uint8ClampedArray.from(samples.flatMap(([hex, count, alpha = 255]) => {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return Array.from({ length: count }, () => [...rgb, alpha]).flat();
})) });

describe('logo palette selection', () => {
  it('finds brand hues instead of the white background, black wordmark or transparent padding', () => {
    const colors = paletteFromPixels(pixels(['#ffffff', 2000], ['#101010', 600], ['#137e8e', 200], ['#f5b800', 80], ['#ff00ff', 5000, 0]));
    assert.deepEqual(colors, ['#137e8e', '#f5b800', '#ffffff', '#101010']);
    assert.deepEqual(suggestLogoTheme(colors), { primary: '#137e8e', accent: '#f5b800', matchPrimary: false });
  });

  it('keeps monochrome, all-white and all-black logos neutral without inventing an accent', () => {
    for (const hex of ['#000000', '#ffffff', '#888888']) {
      const colors = paletteFromPixels(pixels([hex, 100]));
      assert.deepEqual(colors, [hex]);
      assert.deepEqual(suggestLogoTheme(colors), { primary: hex, accent: hex, matchPrimary: true });
    }
    assert.equal(suggestLogoTheme(paletteFromPixels(pixels(['#222222', 300], ['#eeeeee', 200]))).matchPrimary, true);
  });

  it('favors a visible primary over a dominant bright background, keeping both source hues', () => {
    assert.deepEqual(suggestLogoTheme(['#f5b800', '#137e8e', '#ffffff']), {
      primary: '#137e8e', accent: '#f5b800', matchPrimary: false,
    });
    assert.deepEqual(suggestLogoTheme(['#ffffff', '#222222']), {
      primary: '#222222', accent: '#222222', matchPrimary: true,
    });
  });

  it('retains pale, dark and saturated brand hues across different color families', () => {
    for (const hex of ['#bae6fd', '#fef08a', '#082f49', '#4a044e', '#ff0000', '#00ff00', '#0000ff']) {
      assert.equal(paletteFromPixels(pixels(['#ffffff', 2000], [hex, 150]))[0], hex);
    }
  });

  it('merges similar edge colors, filters tiny noise, and caps a busy image at five swatches', () => {
    const colors = paletteFromPixels(pixels(['#137e8e', 200], ['#148091', 30], ['#ff0000', 1]));
    assert.deepEqual(colors, ['#137e8e']);
    const busy = paletteFromPixels(pixels(...['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff', '#000000'].map(hex => [hex, 100])));
    assert.equal(busy.length, 5);
    assert.equal(new Set(busy).size, 5);
  });

  it('weights partial transparency and ignores invisible or mostly transparent pixels', () => {
    assert.deepEqual(paletteFromPixels(pixels(['#ff0000', 100, 100])), []);
    assert.equal(paletteFromPixels(pixels(['#137e8e', 80], ['#f5b800', 100, 128]))[0], '#137e8e');
    assert.deepEqual(paletteFromPixels({ data: [] }), []);
    assert.equal(suggestLogoTheme([]), null);
    assert.equal(suggestLogoTheme(['invalid']), null);
  });

  it('matches the primary for a single hue and does not mistake a different shade for an accent', () => {
    assert.equal(suggestLogoTheme(['#137e8e', '#bae6fd', '#ffffff']).matchPrimary, true);
    assert.deepEqual(suggestLogoTheme(['#123']), { primary: '#112233', accent: '#112233', matchPrimary: true });
  });

  it('protects transparent light, dark and mixed marks without recoloring opaque logos', () => {
    for (const colors of [['#ffffff'], ['#000000'], ['#137e8e'], ['#000000', '#ffffff']]) {
      const sample = pixels(['#ffffff', 300, 0], ...colors.map(hex => [hex, 100]));
      const matte = logoMatteFromPixels(sample);
      for (const color of colors) assert.ok(contrastRatio(color, matte) >= 3, `${color} on ${matte}`);
    }
    assert.equal(logoMatteFromPixels(pixels(['#ff0000', 100])), null);
    assert.equal(logoMatteFromPixels(pixels(['#000000', 100, 0])), null);
  });
});
