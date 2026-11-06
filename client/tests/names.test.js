// First and last names in forms (#402). Records and drafts from before the
// split carry only `name`; forms must split it the way the server does.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formNameParts, splitName } from '../../server/src/shared/names.js';
import { splitName as serverSplit, nameFields } from '../../server/src/lib/names.js';

describe('formNameParts', () => {
  it('splits a lone full name at the first whitespace, like the server', () => {
    assert.deepEqual(formNameParts({ name: 'Mary Ann Evans' }), { firstName: 'Mary', lastName: 'Ann Evans' });
    assert.deepEqual(formNameParts({ name: '  José   María García  ' }), { firstName: 'José', lastName: 'María García' });
    assert.deepEqual(formNameParts({ name: 'Cher' }), { firstName: 'Cher', lastName: '' });
    for (const legacy of [{ name: 'Mary Ann Evans' }, { name: 'Cher' }, { name: '' }]) {
      const { firstName, lastName } = nameFields(legacy);
      assert.deepEqual(formNameParts(legacy), { firstName, lastName }, 'matches what /v1/me reports for the same record');
    }
  });

  it('keeps parts a record or draft already has', () => {
    assert.deepEqual(formNameParts({ firstName: 'Mary Ann', lastName: 'Evans', name: 'Mary Ann Evans' }), { firstName: 'Mary Ann', lastName: 'Evans' });
    assert.deepEqual(formNameParts({ firstName: 'Mary' }), { firstName: 'Mary', lastName: '' });
  });

  it('falls back to the full name when the first name is blank, and to empty fields', () => {
    assert.deepEqual(formNameParts({ firstName: '  ', name: 'Ada Lovelace' }), { firstName: 'Ada', lastName: 'Lovelace' });
    for (const empty of [null, undefined, {}, { name: '   ' }]) assert.deepEqual(formNameParts(empty), { firstName: '', lastName: '' });
  });

  it('is the one split the server uses', () => {
    assert.equal(serverSplit, splitName);
  });
});

describe('forms never start with a whole name as the first name', () => {
  const read = (file) => readFileSync(new URL(`../src/pages/${file}`, import.meta.url), 'utf8');
  for (const file of ['Settings.jsx', 'Signup.jsx', 'Setup.jsx', 'Waitlist.jsx']) {
    it(file, () => {
      const source = read(file);
      assert.match(source, /formNameParts\(/);
      assert.equal(/firstName[^;\n]*\|\|\s*(?:user\?|savedDraft|prefill|d)\.name\b/.test(source), false, 'no `firstName || x.name` fallback');
    });
  }
});
