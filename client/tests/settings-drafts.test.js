import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsDraftStore, enabledSettingsValues } from '../src/lib/settingsDrafts.js';

function disk() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('fields and feedback survive A/B/A switches and reload without crossing accounts', () => {
  const storage = disk();
  const page = createSettingsDraftStore({ storage: () => storage });
  const fields = { goal: 'Practice 日本語 🌱', phone: '+1 (555) 010-1234', team: 'Learning' };
  page.write('a:person', 'fields', fields);
  page.write('a:person', 'feedback', 'A private draft\nwith a second line');
  page.write('b', 'feedback', 'B draft');
  const next = createSettingsDraftStore({ storage: () => storage });
  assert.deepEqual(next.read('b', 'fields'), {});
  assert.equal(next.read('b', 'feedback'), 'B draft');
  assert.deepEqual(next.read('a:person', 'fields'), fields);
  assert.equal(next.read('a:person', 'feedback'), 'A private draft\nwith a second line');
  assert.deepEqual(next.read('a', 'person:fields'), '');
});

test('legacy drafts are discarded without assigning them to the signed-in user', () => {
  const storage = disk();
  storage.setItem('plato_settings_fields_draft', '{"goal":"Someone else"}');
  storage.setItem('plato_profile_feedback_draft', 'Someone else');
  const store = createSettingsDraftStore({ storage: () => storage });
  assert.deepEqual(store.read('a', 'fields'), {});
  assert.equal(store.read('a', 'feedback'), '');
  assert.equal(storage.getItem('plato_settings_fields_draft'), null);
  assert.equal(storage.getItem('plato_profile_feedback_draft'), null);
});

test('corrupt, wrong-owner and wrong-kind records are ignored', () => {
  const storage = disk();
  for (const value of ['bad json', JSON.stringify({ userId: 'b', kind: 'fields', value: { goal: 'Private' } }), JSON.stringify({ userId: 'a', kind: 'feedback', value: 'wrong type' })]) {
    storage.setItem('plato_settings_draft_v1:a:fields', value);
    assert.deepEqual(createSettingsDraftStore({ storage: () => storage }).read('a', 'fields'), {});
  }
});

test('only current enabled fields restore and save, including empty optional values', () => {
  const fields = [{ id: 'goal' }, { id: 'phone' }, { id: 'removed', enabled: false }, { id: 'disabled', disabled: true }];
  assert.deepEqual(enabledSettingsValues({ goal: 'Exact text', phone: '', removed: 'Private', disabled: 'Hidden', obsolete: 'Old', unexpected: 1 }, fields), { goal: 'Exact text', phone: '' });
});

test('a late save clears only its own unchanged draft and preserves newer writing', () => {
  const storage = disk();
  const store = createSettingsDraftStore({ storage: () => storage });
  store.write('a', 'feedback', 'Original');
  store.write('a', 'feedback', 'Newer');
  assert.equal(store.clear('a', 'feedback', 'Original'), false);
  assert.equal(store.read('a', 'feedback'), 'Newer');
  store.write('a', 'fields', { goal: 'Newer' });
  assert.equal(store.clear('a', 'fields', { goal: 'Original' }), false);
  assert.deepEqual(store.read('a', 'fields'), { goal: 'Newer' });
  assert.equal(store.clear('a', 'fields', { goal: 'Newer' }), true);
  assert.deepEqual(createSettingsDraftStore({ storage: () => storage }).read('a', 'fields'), {});
});

test('unavailable storage retains drafts in memory without exposing them to another user', () => {
  const store = createSettingsDraftStore({ storage: () => { throw new Error('Blocked'); } });
  store.write('a', 'feedback', 'Retained');
  assert.equal(store.read('a', 'feedback'), 'Retained');
  assert.equal(store.read('b', 'feedback'), '');
});
