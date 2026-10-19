import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractReadable, fetchUrlContent, _internals } from '../../src/lib/link-extractor.js';

const ARTICLE = `<html><head><title>My Great Article</title></head><body>
  <nav>home about contact</nav>
  <article>
    <h1>The Heading</h1>
    <p>This is the first substantial paragraph of the article with plenty of words so the readability algorithm treats it as the main content and does not bail out early.</p>
    <p>A second paragraph that also carries a meaningful amount of text to comfortably clear the content threshold readability applies.</p>
  </article>
  <footer>copyright junk</footer>
</body></html>`;

describe('extractReadable', () => {
  it('pulls the title and article text, dropping nav/footer chrome', () => {
    const { title, text } = extractReadable(ARTICLE);
    assert.equal(title, 'My Great Article');
    assert.ok(text.includes('first substantial paragraph'));
    assert.ok(!text.includes('home about contact'), 'nav should be dropped');
    assert.ok(!text.includes('copyright junk'), 'footer should be dropped');
  });

  it('preserves block boundaries (no word-merging across elements)', () => {
    const { text } = extractReadable(ARTICLE);
    assert.ok(!/HeadingThis/.test(text), 'heading and paragraph must not fuse');
  });

  it('falls back to a whole-body strip when Readability declines', () => {
    const { title, text } = extractReadable(
      '<html><head><title>Tiny Page</title></head><body><div>just a little text here</div></body></html>'
    );
    assert.equal(title, 'Tiny Page');
    assert.ok(text.includes('just a little text here'));
  });

  it('decodes entities and returns trimmed text', () => {
    const out = _internals.domToText('<p>Tom &amp; Jerry &lt;3</p>');
    assert.equal(out, 'Tom & Jerry <3');
  });

  it('drops scripts and never emits HTML markup (text is read from the DOM, not regex-stripped)', () => {
    // The output is plain text — read via textContent — so no tag or event
    // handler can survive as functional markup, even from malformed input.
    assert.equal(_internals.domToText('<p>safe</p><script>alert(1)</script>'), 'safe');

    const injected = _internals.domToText('<p>hi</p><img src=x onerror="alert(1)"><b>bold</b>');
    assert.ok(!/[<>]/.test(injected), 'no angle-bracket markup in the output');
    assert.ok(!/onerror/i.test(injected), 'no event-handler attribute leaks through');
    assert.ok(injected.includes('hi') && injected.includes('bold'), 'visible text is kept');
  });
});

describe('fetchUrlContent — guard rejections (no network)', () => {
  it('rejects an internal IP literal before fetching', async () => {
    await assert.rejects(fetchUrlContent('http://127.0.0.1/admin'), (e) => e.code === 'blocked_host');
    await assert.rejects(fetchUrlContent('http://169.254.169.254/latest/meta-data/'), (e) => e.code === 'blocked_host');
  });

  it('rejects a non-http scheme before fetching', async () => {
    await assert.rejects(fetchUrlContent('file:///etc/passwd'), (e) => e.code === 'bad_scheme');
  });
});
