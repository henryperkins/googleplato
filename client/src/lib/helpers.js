/** XSS-safe text escaping. */
export function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

/**
 * Protocols safe to drop into an href. Coach/markdown output is untrusted, so
 * a `javascript:`, `data:`, or `vbscript:` URL would become a clickable XSS
 * vector (`esc()` neutralizes HTML chars but not the URL scheme). We allowlist
 * http(s) and mailto and reject everything else. Leading whitespace is trimmed
 * first so `[x]( javascript:…)` can't sneak past the anchor.
 */
export function isSafeUrl(url) {
  return /^(https?:\/\/|mailto:)/i.test(String(url).trim());
}

// Code is set aside as numbered placeholders while the other rules run, then
// restored, so nothing inside it is reformatted. U+FDD0 is a Unicode
// noncharacter, reserved for internal use like this; it is removed from the
// input so a placeholder can't be forged.
const STASH = '\uFDD0';
const MD_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
const BOLD = /\*\*(.+?)\*\*/g;
const ITALIC = /\*(.+?)\*/g;
// A run of backticks closed by the next run of the same length on the same
// line. The leading group stops a run from starting partway through another
// (a lookbehind would do the same, but older Safari can't parse one).
const INLINE_CODE = /(^|[^`])(`+)(?!`)(.*?[^`\n])\2(?!`)/g;

function keep(stash, html) {
  stash.push(html);
  return `${STASH}${stash.length - 1}${STASH}`;
}

function unstash(html, stash) {
  return html.replace(/\uFDD0(\d+)\uFDD0/g, (_, i) => stash[i]);
}

// Code never lands in an attribute (see renderLinks and linkify), but its
// quotes are encoded anyway so that a slip could not break out of one.
const codeText = (code) => code.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// As in CommonMark, a span padded with a space at both ends loses one space
// from each, so code that starts or ends with a backtick can be written.
function replaceInlineCode(text, render) {
  return text.replace(INLINE_CODE, (_, before, ticks, code) => (
    before + render(code.startsWith(' ') && code.endsWith(' ') && code.trim() ? code.slice(1, -1) : code)
  ));
}

// A line of three or more backticks, optionally indented and followed by a
// language, opens a code block that the next line of at least as many
// backticks closes. An unclosed fence runs to the end of the text, as in
// CommonMark, so a reply that is still streaming shows its code as code.
function stashFences(escaped, stash) {
  const lines = escaped.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^([ \t]*)(`{3,})([^`]*)$/);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    const [, indent, fence, info] = open;
    const closes = (line) => line.trim().length >= fence.length && /^`+$/.test(line.trim());
    const body = [];
    // A block indented under a list item drops the fence's own indentation.
    for (i++; i < lines.length && !closes(lines[i]); i++) {
      body.push(lines[i].slice(Math.min(indent.length, lines[i].length - lines[i].trimStart().length)));
    }
    // The language becomes a class name, so only plain identifiers qualify.
    const lang = info.trim().split(/\s/)[0];
    const langClass = /^[\w+-]+$/.test(lang) ? ` class="language-${lang}"` : '';
    // Wide code scrolls inside its own box, so it needs a keyboard stop and a
    // name, like a table's scroller.
    out.push(keep(stash, `<pre tabindex="0" role="region" aria-label="Code"><code${langClass}>${codeText(body.join('\n').trimEnd())}</code></pre>`));
  }
  return out.join('\n');
}

// Escaped text with LF line endings, no placeholder characters, and its code
// set aside in `stash`.
function prepare(text, stash, { fences }) {
  // Every line-based rule (lists, tables, <br>) splits on \n. A stray \r from
  // CRLF or CR-only text would split one list into several and keep tables
  // from rendering, so normalize line endings first.
  let escaped = esc(text).replace(/\r\n?/g, '\n').replaceAll(STASH, '');
  if (fences) escaped = stashFences(escaped, stash);
  return replaceInlineCode(escaped, (code) => keep(stash, `<code>${codeText(code)}</code>`));
}

// Markdown links [text](url). Unsafe-protocol URLs, and URLs that would carry
// a code placeholder into the href, are left as the literal markdown text
// rather than rendered as anchors.
function renderLinks(escaped) {
  return escaped.replace(MD_LINK, (match, label, url) => {
    const href = url.trim();
    if (!isSafeUrl(href) || href.includes(STASH)) return match;
    // esc() already neutralized & < > across the whole string, but NOT quotes
    // (textContent→innerHTML leaves " and ' intact). Without encoding them, a
    // URL like `https://x" onclick="…` breaks out of href="…" and injects
    // attributes — so percent-encode the quote characters in the href.
    const safeHref = href.replace(/"/g, '%22').replace(/'/g, '%27');
    return `<a href="${safeHref}" target="_blank" rel="noopener">${label}</a>`;
  });
}

/**
 * Lightweight markdown to HTML. Handles bold, italic, inline and fenced code,
 * headings, lists, blockquotes, tables, links, and line breaks.
 */
export function renderMd(text) {
  const stash = [];
  let escaped = prepare(text, stash, { fences: true });
  // Links must come before heading/bold/italic replacements so nested
  // formatting inside link text is handled correctly.
  escaped = renderLinks(escaped);
  // Real headings, so screen-reader heading navigation works inside long
  // replies. The page's h1 is the lesson or page title, so the reply's top
  // heading level becomes h2 and each deeper level it uses steps down one, to
  // h4 at most: "## Plan" then "#### Step" reads h2, h3, never skipping a
  // level. .coach-copy sizes them at or above the surrounding text.
  const headingLine = /^(#{1,6}) (.+)$/gm;
  const headingLevels = [...new Set([...escaped.matchAll(headingLine)].map((m) => m[1].length))].sort((a, b) => a - b);
  escaped = escaped.replace(headingLine, (_, hashes, title) => {
    const tag = `h${Math.min(headingLevels.indexOf(hashes.length) + 2, 4)}`;
    return `<${tag}>${title}</${tag}>`;
  });
  // Convert each raw list block once so ordered lists cannot re-wrap the
  // <li> elements already generated for an unordered list.
  const renderList = (block, tag, marker) => {
    const items = block.trimEnd().split('\n').map(line => `<li>${line.replace(marker, '')}</li>`).join('');
    // A numbered list split by a code block or paragraph keeps counting from
    // the number its first item was written with.
    const start = tag === 'ol' ? parseInt(block, 10) : 1;
    return `<${tag}${start !== 1 ? ` start="${start}"` : ''}>${items}</${tag}>${block.endsWith('\n') ? '\n' : ''}`;
  };
  escaped = escaped.replace(/(?:^[-*] .+(?:\n|$))+/gm, block => renderList(block, 'ul', /^[-*] /));
  escaped = escaped.replace(/(?:^\d+[.)][ \t]+.+(?:\n|$))+/gm, block => renderList(block, 'ol', /^\d+[.)][ \t]+/));
  escaped = escaped.replace(BOLD, '<strong>$1</strong>');
  escaped = escaped.replace(ITALIC, '<em>$1</em>');
  escaped = linkify(escaped);
  // Consecutive "> " lines (">" alone for a blank line) form one quote. Each
  // line already has its inline formatting; joining them with <br> keeps the
  // line-based table rule below out of the quote.
  escaped = escaped.replace(/(?:^[ \t]*&gt;(?:[ \t].*)?(?:\n|$))+/gm, (block) => {
    const lines = block.replace(/\n$/, '').split('\n').map((line) => line.replace(/^[ \t]*&gt;[ \t]?/, ''));
    return `<blockquote>${lines.join('<br>')}</blockquote>${block.endsWith('\n') ? '\n' : ''}`;
  });
  // Convert markdown tables to HTML tables
  escaped = escaped.replace(/((?:^\|.+\|$\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return block;
    // Skip separator row (|---|---|)
    const isSeparator = (r) => /^\|[\s-:|]+\|$/.test(r);
    const parseRow = (r) => r.split('|').slice(1, -1).map(c => c.trim());
    const headerCells = parseRow(rows[0]);
    const dataRows = rows.slice(isSeparator(rows[1]) ? 2 : 1);
    // The wrapper scrolls a wide table on its own; the learner shell can't
    // clip horizontal overflow (see docs/ARCHITECTURE.md, chat auto-scroll).
    let html = '<div class="md-table-scroll" tabindex="0" role="region" aria-label="Table"><table class="border-collapse text-sm w-full"><thead><tr>';
    for (const cell of headerCells) html += `<th scope="col" class="border border-border px-3 py-1.5 text-left font-medium bg-muted/50">${cell}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of dataRows) {
      if (isSeparator(row)) continue;
      const cells = parseRow(row);
      html += '<tr>';
      for (const cell of cells) html += `<td class="border border-border px-3 py-1.5">${cell}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  });
  escaped = escaped.replace(/\n/g, '<br>');
  // Code goes back in before the cleanup so a code block counts as a block;
  // its own newlines stay real newlines inside <pre>.
  escaped = unstash(escaped, stash);
  // Drop <br> runs next to block-level elements: their margins already
  // separate them, and a leftover <br> adds an empty line.
  escaped = escaped.replace(/(?:<br>)+(<\/?(?:[uo]l|table|thead|tbody|tr|h[234]|div|pre|blockquote)\b[^>]*>)/g, '$1');
  escaped = escaped.replace(/(<\/?(?:[uo]l|table|thead|tbody|tr|h[234]|div|pre|blockquote)\b[^>]*>)(?:<br>)+/g, '$1');
  return escaped;
}

/**
 * Inline markdown only (bold, italic, inline code, and safe links) for text
 * shown inside an existing element, such as a dialog description or a list
 * item. It never emits block elements; line breaks become <br>.
 */
export function renderInlineMd(text) {
  const stash = [];
  let html = renderLinks(prepare(text, stash, { fences: false }));
  html = html.replace(BOLD, '<strong>$1</strong>').replace(ITALIC, '<em>$1</em>');
  return unstash(linkify(html).replace(/\n/g, '<br>'), stash);
}

/**
 * Plain text for a line-clamped preview: emphasis markers and code backticks
 * removed, [label](url) reduced to its label, and paragraphs joined by spaces.
 * Returns text for React to escape, not HTML.
 */
export function stripInlineMd(text) {
  const stash = [];
  let plain = String(text ?? '').replace(/\r\n?/g, '\n').replaceAll(STASH, '');
  plain = replaceInlineCode(plain, (code) => keep(stash, code));
  plain = plain.replace(MD_LINK, '$1').replace(BOLD, '$1').replace(ITALIC, '$1');
  return unstash(plain, stash).replace(/\s+/g, ' ').trim();
}

/** Detect and linkify bare URLs in escaped HTML. */
export function linkify(escaped) {
  // Skip URLs already inside an <a>…</a> — markdown links ([text](url)) are
  // rendered to anchors earlier in renderMd, and re-matching the URL inside
  // their href would nest anchors and corrupt the markup. Split on existing
  // anchors (capturing group keeps them) and only linkify the segments
  // between them. A code placeholder ends a URL, so code restored later can
  // never land inside an href.
  return escaped
    .split(/(<a\b[^>]*>.*?<\/a>)/gs)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(
      /https?:\/\/[^\s<>"'\uFDD0]+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
    )))
    .join('');
}
