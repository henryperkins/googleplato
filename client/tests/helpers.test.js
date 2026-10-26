/**
 * Tests for the markdown helpers (renderMd, renderInlineMd, stripInlineMd),
 * with a focus on the XSS guards: coach/markdown output is untrusted, so only
 * safe protocols may become clickable anchors (a `javascript:` URL must render
 * as literal text, never an <a href>), and code must never reach an attribute.
 *
 * helpers.esc() uses document.createElement, so we stub a minimal `document`
 * that mirrors the browser's textContent→innerHTML escaping (escapes & < >,
 * but NOT the URL scheme — which is exactly why the protocol allowlist, not
 * escaping, is the load-bearing defense).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
  createElement: () => ({
    set textContent(v) { this._t = v; },
    get innerHTML() {
      return String(this._t)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    },
  }),
};

const { isSafeUrl, renderMd, renderInlineMd, stripInlineMd } = await import('../src/lib/helpers.js');

describe('isSafeUrl', () => {
  it('allows http(s) and mailto', () => {
    assert.equal(isSafeUrl('https://example.com'), true);
    assert.equal(isSafeUrl('http://example.com/path?q=1'), true);
    assert.equal(isSafeUrl('HTTPS://EXAMPLE.COM'), true);
    assert.equal(isSafeUrl('mailto:teacher@school.edu'), true);
  });

  it('rejects dangerous and unknown protocols', () => {
    assert.equal(isSafeUrl('javascript:alert(document.cookie)'), false);
    assert.equal(isSafeUrl('JaVaScRiPt:alert(1)'), false);
    assert.equal(isSafeUrl('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isSafeUrl('vbscript:msgbox(1)'), false);
    assert.equal(isSafeUrl('file:///etc/passwd'), false);
    assert.equal(isSafeUrl('relative/path'), false);
  });

  it('rejects leading-whitespace obfuscation', () => {
    assert.equal(isSafeUrl('  javascript:alert(1)'), false);
    // and still accepts a valid URL with stray leading space
    assert.equal(isSafeUrl(' https://example.com'), true);
  });
});

describe('renderMd lists', () => {
  it('keeps unordered items directly inside a single unordered list', () => {
    assert.equal(renderMd('- First item\n- Second item'), '<ul><li>First item</li><li>Second item</li></ul>');
  });

  it('preserves emphasis in asterisk-marked items', () => {
    assert.equal(renderMd('* *First* item\n* **Second** item'), '<ul><li><em>First</em> item</li><li><strong>Second</strong> item</li></ul>');
  });

  it('groups numbered items with either supported marker', () => {
    assert.equal(renderMd('1. First item\n2) Second item'), '<ol><li>First item</li><li>Second item</li></ol>');
  });

  it('keeps adjacent ordered and unordered lists as siblings', () => {
    assert.equal(renderMd('- First\n- Second\n1. Third\n2. Fourth'), '<ul><li>First</li><li>Second</li></ul><ol><li>Third</li><li>Fourth</li></ol>');
  });

  it('keeps surrounding prose and separate lists outside list items', () => {
    // The list's own margin separates it from the next paragraph; a leftover
    // <br> would add an empty line.
    assert.equal(renderMd('Before\n- First\n\nBetween\n- Second\nAfter'), 'Before<ul><li>First</li></ul>Between<ul><li>Second</li></ul>After');
  });

  it('retains safe links and escaped HTML inside list items', () => {
    const html = renderMd('- [Reference](https://example.com)\n- <img src=x onerror=alert(1)>\n- [Unsafe](javascript:alert(1))');
    assert.match(html, /<li><a href="https:\/\/example\.com"[^>]*>Reference<\/a><\/li>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img|href="javascript:|<ul><ol>/);
  });
});

describe('renderMd blocks', () => {
  it('renders markdown headings as real headings below the page h1', () => {
    assert.equal(renderMd('# Title\n## Section\n### Detail'), '<h2>Title</h2><h3>Section</h3><h4>Detail</h4>');
  });

  it("starts a reply's top heading at h2 and never skips a level", () => {
    assert.equal(renderMd('## Section'), '<h2>Section</h2>');
    assert.equal(renderMd('## Plan\n#### Step'), '<h2>Plan</h2><h3>Step</h3>');
  });

  it('keeps headings deeper than three levels at h4', () => {
    assert.equal(renderMd('# A\n## B\n### C\n#### D'), '<h2>A</h2><h3>B</h3><h4>C</h4><h4>D</h4>');
  });

  it('leaves seven hashes and hashtags as text', () => {
    assert.equal(renderMd('####### Too deep'), '####### Too deep');
    assert.equal(renderMd('#tag'), '#tag');
  });

  it('drops line breaks around headings so only their margins separate them', () => {
    assert.equal(renderMd('Intro\n\n## Plan\n\nFirst step.'), 'Intro<h2>Plan</h2>First step.');
  });

  it('wraps tables in their own scroller', () => {
    const html = renderMd('Intro\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro');
    assert.match(html, /^Intro<div class="md-table-scroll"[^>]*><table[^>]*>.*<\/table><\/div>Outro$/);
  });

  it('keeps line breaks inside ordinary prose', () => {
    assert.equal(renderMd('Line one\nLine two\n\nNext paragraph'), 'Line one<br>Line two<br><br>Next paragraph');
  });
});

describe('renderMd line endings', () => {
  it('keeps CRLF-separated items in one list with no stray carriage returns', () => {
    assert.equal(renderMd('- First\r\n- Second'), '<ul><li>First</li><li>Second</li></ul>');
    assert.equal(renderMd('1. First\r\n2. Second'), '<ol><li>First</li><li>Second</li></ol>');
  });

  it('treats CR-only line endings like LF', () => {
    assert.equal(renderMd('Before\r- First\r- Second\rAfter'), 'Before<ul><li>First</li><li>Second</li></ul>After');
  });

  it('renders CRLF tables and line breaks exactly like LF', () => {
    const lf = 'Intro\n| Term | Meaning |\n|---|---|\n| KB | Knowledge base |\nOutro';
    const html = renderMd(lf.replace(/\n/g, '\r\n'));
    assert.equal(html, renderMd(lf));
    assert.match(html, /<td[^>]*>KB<\/td><td[^>]*>Knowledge base<\/td>/);
    assert.doesNotMatch(html, /\r/);
  });
});

describe('renderMd markdown links', () => {
  it('renders a safe markdown link as an anchor', () => {
    const html = renderMd('See [the docs](https://example.com/docs).');
    assert.match(html, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener">the docs<\/a>/);
  });

  it('does NOT render a javascript: link as an anchor', () => {
    const html = renderMd('[click here](javascript:alert(document.cookie))');
    assert.doesNotMatch(html, /<a /);
    assert.doesNotMatch(html, /href="javascript:/i);
    // The original markdown text survives (no anchor injected).
    assert.match(html, /click here/);
  });

  it('does NOT render a data: link as an anchor', () => {
    const html = renderMd('[x](data:text/html,<script>alert(1)</script>)');
    assert.doesNotMatch(html, /<a /);
  });

  it('does not double-linkify an http(s) markdown link (no nested anchors)', () => {
    const html = renderMd('See [the docs](https://example.com/docs).');
    // Exactly one anchor, and no <a> nested inside an href attribute.
    assert.equal(html.match(/<a /g).length, 1);
    assert.doesNotMatch(html, /href="<a /);
    assert.match(html, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener">the docs<\/a>/);
  });

  it('neutralizes attribute-breakout via quotes in an http(s) URL', () => {
    // Passes isSafeUrl (starts with https://) but tries to break out of the
    // href attribute to inject an onclick handler. esc() does not escape
    // quotes, so the link renderer must encode them.
    const html = renderMd('[click](https://evil.com" onclick="alert(document.cookie))');
    // No real attribute breakout: a raw quote must not close href and start
    // an event handler. The quotes are percent-encoded, so any "onclick" text
    // is inert URL content inside the href value, not an HTML attribute.
    assert.doesNotMatch(html, /"\s*onclick\s*=/i);
    assert.doesNotMatch(html, /href="https:\/\/evil\.com"/); // not closed early
    assert.match(html, /%22/); // quote was percent-encoded
  });

  it('still auto-linkifies a bare URL alongside a markdown link', () => {
    const html = renderMd('[docs](https://a.com) and bare https://b.com here');
    assert.equal(html.match(/<a /g).length, 2);
    assert.match(html, /<a href="https:\/\/a\.com"[^>]*>docs<\/a>/);
    assert.match(html, /<a href="https:\/\/b\.com"[^>]*>https:\/\/b\.com<\/a>/);
  });
});

// Fenced blocks scroll on their own, so they carry the table scroller's
// keyboard stop and name.
const PRE = '<pre tabindex="0" role="region" aria-label="Code">';

describe('renderMd code', () => {
  it('renders a fenced block as pre and code, keeping its newlines', () => {
    assert.equal(
      renderMd('```js\nconst a = 1;\nconst b = 2;\n```'),
      `${PRE}<code class="language-js">const a = 1;\nconst b = 2;</code></pre>`,
    );
  });

  it('leaves every other rule out of a fenced block', () => {
    const html = renderMd('```\n# Not a heading\n- not a list\n1. not a list\n> not a quote\n**not bold** *nor this* [x](https://a.com) https://b.com\n| a | b |\n|---|---|\n```');
    assert.equal(html, `${PRE}<code># Not a heading\n- not a list\n1. not a list\n&gt; not a quote\n**not bold** *nor this* [x](https://a.com) https://b.com\n| a | b |\n|---|---|</code></pre>`);
  });

  it('drops line breaks around a code block so only its margins separate it', () => {
    assert.equal(renderMd('Intro\n\n```\nx\n```\n\nOutro'), `Intro${PRE}<code>x</code></pre>Outro`);
    assert.equal(renderMd('Intro\n```\nx\n```\nOutro'), `Intro${PRE}<code>x</code></pre>Outro`);
    assert.equal(renderMd('## Plan\n```sh\nls\n```\n## Next'), `<h2>Plan</h2>${PRE}<code class="language-sh">ls</code></pre><h2>Next</h2>`);
  });

  it('closes a fence only with a line of at least as many backticks', () => {
    assert.equal(renderMd('````md\n```js\ninner\n```\n````'), `${PRE}<code class="language-md">\`\`\`js\ninner\n\`\`\`</code></pre>`);
  });

  it('treats an unclosed fence as code to the end, as a streaming reply shows it', () => {
    assert.equal(renderMd('Here:\n```js\nconst x = 1;\n**still code**\n'), `Here:${PRE}<code class="language-js">const x = 1;\n**still code**</code></pre>`);
  });

  it('keeps code indented under a numbered step, and the step numbers after it', () => {
    assert.equal(
      renderMd('1. Install:\n   ```bash\n   npm install\n     --save-dev\n   ```\n2. Run'),
      `<ol><li>Install:</li></ol>${PRE}<code class="language-bash">npm install\n  --save-dev</code></pre><ol start="2"><li>Run</li></ol>`,
    );
  });

  it('renders inline code and leaves its contents alone', () => {
    assert.equal(renderMd('Run `npm *test*` then `**x**` or `[x](https://a.com)`'), 'Run <code>npm *test*</code> then <code>**x**</code> or <code>[x](https://a.com)</code>');
    assert.equal(renderMd('*a `*` b*'), '<em>a <code>*</code> b</em>');
  });

  it('matches inline code runs of the same length, as CommonMark does', () => {
    assert.equal(renderMd('`` `x` ``'), '<code>`x`</code>');
    assert.equal(renderMd('`a``b`'), '<code>a``b</code>');
    assert.equal(renderMd('Text ```triple``` here'), 'Text <code>triple</code> here');
    assert.equal(renderMd('a `` b and `open'), 'a `` b and `open');
    assert.equal(renderMd('`foo\nbar`'), '`foo<br>bar`');
  });

  it('keeps inline code inside headings, list items, links, and table cells', () => {
    assert.equal(renderMd('## The `useState` hook'), '<h2>The <code>useState</code> hook</h2>');
    assert.equal(renderMd('- `a`\n- b'), '<ul><li><code>a</code></li><li>b</li></ul>');
    assert.match(renderMd('[`useState`](https://react.dev)'), /^<a href="https:\/\/react\.dev"[^>]*><code>useState<\/code><\/a>$/);
    // A pipe inside code does not split the cell.
    assert.match(renderMd('| A | B |\n|---|---|\n| `a|b` | c |'), /<td[^>]*><code>a\|b<\/code><\/td><td[^>]*>c<\/td>/);
  });

  it('escapes HTML inside code', () => {
    assert.equal(renderMd('`<img src=x onerror=alert(1)>`'), '<code>&lt;img src=x onerror=alert(1)&gt;</code>');
    const html = renderMd('```\n</code></pre><script>alert(1)</script>\n```');
    assert.equal(html, `${PRE}<code>&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>`);
  });

  it('only turns a plain identifier into a language class', () => {
    assert.equal(renderMd('```c++\nx\n```'), `${PRE}<code class="language-c++">x</code></pre>`);
    assert.equal(renderMd('```python title="x.py"\nx\n```'), `${PRE}<code class="language-python">x</code></pre>`);
    for (const info of ['js" onmouseover="alert(1)', '"><img src=x onerror=alert(1)>', 'js&quot;']) {
      const html = renderMd(`\`\`\`${info}\nx\n\`\`\``);
      assert.equal(html, `${PRE}<code>x</code></pre>`, info);
    }
  });

  it('never lets code reach an href', () => {
    // A markdown link whose URL contains code is left as text...
    const link = renderMd('[x](https://a.com/`" onmouseover="alert(1)//`)');
    assert.doesNotMatch(link, /href="[^"]*(<code|onmouseover)/);
    assert.doesNotMatch(link, /"\s*onmouseover=/);
    assert.match(link, /^\[x\]\(/);
    // ...even when the code is a fenced block on the following lines.
    const block = renderMd('[x](https://a.com/\n```\n" onmouseover="alert(1)//\n```\n)');
    assert.doesNotMatch(block, /href="[^"]*(<pre|onmouseover)/);
    // A bare URL stops where code begins.
    assert.equal(
      renderMd('https://a.com`" onmouseover="x`'),
      '<a href="https://a.com" target="_blank" rel="noopener">https://a.com</a><code>&quot; onmouseover=&quot;x</code>',
    );
  });

  it('ignores placeholder characters in the input', () => {
    assert.equal(renderMd('\uFDD00\uFDD0 and `a`'), '0 and <code>a</code>');
  });

  it('renders CRLF and CR-only code exactly like LF', () => {
    const lf = 'Intro\n```js\nconst a = 1;\nconst b = 2;\n```\nUse `x` here';
    for (const eol of ['\r\n', '\r']) {
      const html = renderMd(lf.replace(/\n/g, eol));
      assert.equal(html, renderMd(lf));
      assert.doesNotMatch(html, /\r/);
    }
    assert.match(renderMd(lf), /<code class="language-js">const a = 1;\nconst b = 2;<\/code>/);
  });
});

describe('renderMd blockquotes', () => {
  it('joins consecutive quoted lines into one quote with inline formatting', () => {
    assert.equal(renderMd('> First line\n> **Second** line with `code`'), '<blockquote>First line<br><strong>Second</strong> line with <code>code</code></blockquote>');
  });

  it('keeps a blank quoted line as a paragraph break', () => {
    assert.equal(renderMd('> One\n>\n> Two'), '<blockquote>One<br><br>Two</blockquote>');
  });

  it('drops line breaks around a quote so only its margins separate it', () => {
    assert.equal(renderMd('Before\n> Quote\nAfter'), 'Before<blockquote>Quote</blockquote>After');
    assert.equal(renderMd('Before\n\n> Quote\n\nAfter'), 'Before<blockquote>Quote</blockquote>After');
    assert.equal(renderMd('> A\n\n> B'), '<blockquote>A</blockquote><blockquote>B</blockquote>');
    assert.equal(renderMd('- item\n> quote\n1. step'), '<ul><li>item</li></ul><blockquote>quote</blockquote><ol><li>step</li></ol>');
  });

  it('applies no block rules inside a quote', () => {
    assert.equal(renderMd('> # Not a heading\n> - not a list'), '<blockquote># Not a heading<br>- not a list</blockquote>');
  });

  it('needs a space or the line end after the marker', () => {
    assert.equal(renderMd('>not a quote and a > b'), '&gt;not a quote and a &gt; b');
  });

  it('escapes HTML and refuses unsafe links inside a quote', () => {
    const html = renderMd('> <script>alert(1)</script>\n> [x](javascript:alert(1)) [y](https://e.com" onclick="alert(1))');
    assert.doesNotMatch(html, /<script|href="javascript:|"\s*onclick=/i);
    assert.match(html, /^<blockquote>&lt;script&gt;alert\(1\)&lt;\/script&gt;<br>\[x\]\(javascript:alert\(1\)\) <a href="https:\/\/e\.com%22/);
  });

  it('renders CRLF quotes exactly like LF', () => {
    assert.equal(renderMd('Intro\r\n> one\r\n> two\r\nOutro'), 'Intro<blockquote>one<br>two</blockquote>Outro');
  });
});

describe('renderInlineMd', () => {
  it('renders bold, italic, inline code, and safe links', () => {
    assert.equal(
      renderInlineMd('Use **bold**, *italic*, `code`, and [docs](https://example.com).'),
      'Use <strong>bold</strong>, <em>italic</em>, <code>code</code>, and <a href="https://example.com" target="_blank" rel="noopener">docs</a>.',
    );
  });

  it('links bare URLs, as the author preview does', () => {
    assert.equal(renderInlineMd('See https://e.com/a now'), 'See <a href="https://e.com/a" target="_blank" rel="noopener">https://e.com/a</a> now');
  });

  it('turns line breaks into <br> so paragraphs stay apart', () => {
    assert.equal(renderInlineMd('One\nline\n\nTwo'), 'One<br>line<br><br>Two');
    assert.equal(renderInlineMd('One\r\n\r\nTwo'), 'One<br><br>Two');
  });

  it('never emits block elements', () => {
    const html = renderInlineMd('# Title\n- item\n1. step\n> quote\n| a | b |\n|---|---|\n```js\nx\n```');
    assert.doesNotMatch(html, /<(h\d|ul|ol|li|blockquote|table|div|pre|p)\b/);
    assert.equal(html, '# Title<br>- item<br>1. step<br>&gt; quote<br>| a | b |<br>|---|---|<br>```js<br>x<br>```');
  });

  it('escapes HTML and keeps unsafe links as text', () => {
    const html = renderInlineMd('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](https://e.com" onclick="alert(1)) `"><b>`');
    assert.doesNotMatch(html, /<img|<b>|href="javascript:|"\s*onclick=/i);
    assert.match(html, /^&lt;img src=x onerror=alert\(1\)&gt; \[x\]\(javascript:alert\(1\)\) <a href="https:\/\/e\.com%22/);
    assert.match(html, /<code>&quot;&gt;&lt;b&gt;<\/code>$/);
  });

  it('keeps markdown inside inline code literal', () => {
    assert.equal(renderInlineMd('`**x** [y](https://e.com)`'), '<code>**x** [y](https://e.com)</code>');
  });
});

describe('stripInlineMd', () => {
  it('removes inline markers and keeps link labels', () => {
    assert.equal(
      stripInlineMd('Learn **perceptual lightness** with `OKLCH`, *calmly*, and [WCAG 2.2 contrast](https://www.w3.org/TR/WCAG22/).'),
      'Learn perceptual lightness with OKLCH, calmly, and WCAG 2.2 contrast.',
    );
  });

  it('joins paragraphs and lines with single spaces', () => {
    assert.equal(stripInlineMd('First paragraph.\n\nSecond\r\nparagraph.  '), 'First paragraph. Second paragraph.');
  });

  it('keeps inline code text exactly, markers included', () => {
    assert.equal(stripInlineMd('Use `a*b*c` and `[x](y)`'), 'Use a*b*c and [x](y)');
  });

  it('returns plain text for React to escape, leaving lone asterisks alone', () => {
    assert.equal(stripInlineMd('<b>x</b> & y, 5 * 3'), '<b>x</b> & y, 5 * 3');
  });
});
