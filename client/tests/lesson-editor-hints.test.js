import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lessonEditorComposerHint } from '../src/lib/lessonEditorHints.js';

const cases = [
  ['conflict wins over saving', { busy: 'visibility', saveState: { saving: true, error: { status: 409 } }, snapshot: { visibilityPending: {} } }, 'This lesson changed elsewhere. Choose “Load saved lesson”, then send.'],
  ['rejected final save wins over busy', { busy: 'saving', saveState: { error: { status: 400 } }, snapshot: { finalizePending: true } }, 'Choose “Revise lesson” in Preview, then send.'],
  ['starting', { busy: 'starting' }, null],
  ['reply', { busy: 'reply', snapshot: { finalizePending: true } }, null],
  ['saving', { busy: 'saving' }, 'Wait for saving to finish, then send.'],
  ['visibility', { busy: 'visibility' }, 'Wait for saving to finish, then send.'],
  ['background saving', { saveState: { saving: true } }, 'Wait for saving to finish, then send.'],
  ['visibility retry', { saveState: { error: { status: 503 } }, snapshot: { visibilityPending: {} } }, 'Choose “Retry saving”, then send.'],
  ['final save retry', { saveState: { error: { status: 503 } }, snapshot: { finalizePending: true } }, 'Choose “Retry saving”, then send.'],
  ['idle final save', { snapshot: { finalizePending: true } }, 'Choose “Retry saving lesson” in Preview, then send.'],
  ['idle visibility', { snapshot: { visibilityPending: {} } }, 'Wait for saving to finish, then send.'],
  ['failed reply', { snapshot: { failedReply: true } }, 'Choose “Retry reply”, then send.'],
  ['rejected recovered visibility', { saveState: { error: { status: 400 } }, snapshot: { visibilityPending: {} } }, 'Choose a visibility again in Visibility and sharing, then send.'],
  ['idle', {}, null],
];
for (const [name, state, message] of cases) test(`lesson editor composer hint: ${name}`, () => {
  assert.deepEqual(lessonEditorComposerHint(state), message ? [message, message] : []);
});
