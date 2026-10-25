import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STYLES, changedStyles, normalizeColor, stylesFrom } from '../src/lib/stylesDraft.js';

const saved = stylesFrom({ theme: { primary: '#2a4b8c' }, classroomName: 'Acme', logoBase64: 'data:image/png;base64,AAAA' });

describe('Customizer styles draft', () => {
  it('accepts hex with or without the hash, but not alpha forms', () => {
    assert.equal(normalizeColor('#ABC'), '#aabbcc');
    assert.equal(normalizeColor(' 8b1a1a '), '#8b1a1a');
    assert.equal(normalizeColor('fff'), '#ffffff');
    for (const value of ['#abcd', '#aabbccdd', 'rgb(1, 2, 3)', '#12', 'red', '']) assert.equal(normalizeColor(value), null, value);
  });

  it('treats an accent equal to the primary as Match primary', () => {
    assert.equal(stylesFrom({ theme: { primary: '#8b1a1a' } }).matchPrimary, true);
    assert.equal(stylesFrom({ theme: { primary: '#8b1a1a', accent: '#8B1A1A' } }).matchPrimary, true);
    const independent = stylesFrom({ theme: { primary: '#8b1a1a', accent: '#dc2626' } });
    assert.equal(independent.matchPrimary, false);
    assert.equal(independent.accent, '#dc2626');
  });

  it('finds nothing to save when the published result would not change', () => {
    assert.deepEqual(changedStyles(saved, saved), {});
    assert.deepEqual(changedStyles({ ...saved, classroomName: ' Acme  ' }, saved), {});
    assert.deepEqual(changedStyles({ ...saved, primary: '#2A4B8C' }, saved), {});
    // An accent edited and then matched again is not used.
    assert.deepEqual(changedStyles({ ...saved, accent: '#123456' }, saved), {});
    // Unmatching alone, or an explicit accent equal to the primary, still means Match primary.
    assert.deepEqual(changedStyles({ ...saved, matchPrimary: false }, saved), {});
    assert.deepEqual(changedStyles({ ...saved, matchPrimary: false, accent: '#2A4B8C' }, saved), {});
  });

  it('sends only the fields that change', () => {
    assert.deepEqual(changedStyles({ ...saved, primary: '#123' }, saved), { theme: { primary: '#112233' } });
    assert.deepEqual(changedStyles({ ...saved, matchPrimary: false, accent: '#dc2626' }, saved), { theme: { primary: '#2a4b8c', accent: '#dc2626' } });
    assert.deepEqual(changedStyles({ ...saved, classroomName: 'Beta' }, saved), { classroomName: 'Beta' });
    assert.deepEqual(changedStyles({ ...saved, logoBase64: null }, saved), { logoBase64: null });
    assert.deepEqual(changedStyles(DEFAULT_STYLES, saved), { theme: { primary: '#8b1a1a' }, classroomName: '', logoBase64: null });
  });

  it('still reports an edit that cannot be saved, so Save can explain it', () => {
    assert.deepEqual(Object.keys(changedStyles({ ...saved, primary: '#12' }, saved)), ['theme']);
  });
});
