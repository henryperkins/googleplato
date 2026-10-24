/**
 * The lesson composer and its save notice: keyboard focus rings the whole
 * message box, the send button stays hidden until there's something to send,
 * and the save notice confirms only a reply the learner actually wrote.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { savedTurnMessage } from '../js/turnPersistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '..');
// Normalize line endings: Windows checkouts use CRLF.
const read = (rel) => fs.readFileSync(path.join(CLIENT_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

describe('save notice', () => {
  it("confirms the learner's reply and stays quiet for the coach's opening turn", () => {
    const reply = [{ role: 'user', content: 'Here is my draft.' }, { role: 'assistant', content: 'Good start.' }];
    assert.equal(savedTurnMessage({ messages: reply }), 'Your reply is saved.');
    assert.equal(savedTurnMessage({ messages: [{ role: 'assistant', content: 'Welcome!' }] }), '');
    assert.equal(savedTurnMessage({}), '');
    // An empty notice renders nothing, not an empty status line.
    assert.match(read('src/pages/LessonChat.jsx'), /\{persistence\?\.message && \(/);
  });

  it("lines up with the coach's text, like the other status lines", () => {
    assert.match(read('src/components/chat/AssistantMessage.jsx'), /coach-copy min-w-0 max-w-\[85%\] px-1 /);
    assert.match(read('src/components/chat/ThinkingSpinner.jsx'), /gap-2 px-1 py-2/);
    assert.equal(read('src/pages/LessonChat.jsx').match(/className="space-y-2 px-1 py-2"/g)?.length, 2, 'save notice and error');
  });
});

describe('message box', () => {
  it('rings the whole box when its text field has keyboard focus', () => {
    const compose = read('src/components/chat/ComposeBar.jsx');
    assert.match(compose, /className=\{`compose-box /);
    assert.match(compose, /className="compose-input /);
    const css = read('src/index.css');
    assert.match(css, /\.compose-input:focus-visible \{\s*outline: none;\s*\}/);
    assert.match(css, /\.compose-box:has\(\.compose-input:focus-visible\) \{\s*outline: 3px solid var\(--ring\);/);
  });

  it('keeps the send button hidden until there is something to send', () => {
    // The button primitive dims disabled buttons to half opacity, which would
    // show an empty composer's send button as a faint patch.
    assert.match(read('src/components/chat/ComposeBar.jsx'), /hasContent \? 'opacity-100' : 'opacity-0 disabled:opacity-0 pointer-events-none'/);
  });
});
