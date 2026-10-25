import { DOMParser } from 'linkedom';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ELEMENTS = new Set('svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask pattern use title desc'.split(' '));
const PAINTED = new Set('path rect circle ellipse line polyline polygon text tspan'.split(' '));
const GRADIENTS = new Set(['linearGradient', 'radialGradient']);
const RESOURCE_PROPERTIES = ['fill', 'stroke', 'mask', 'clip-path'];
const AUTO_INHERITED = new Set(['fill', 'stroke']);
const STYLE_PROPERTIES = new Set(`fill fill-opacity fill-rule stroke stroke-opacity stroke-width stroke-linecap stroke-linejoin
  stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color font-family font-size font-style font-weight font-stretch
  font-variant text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing paint-order shape-rendering
  text-rendering clip-path clip-rule mask display visibility stop-color stop-opacity vector-effect enable-background
  isolation mix-blend-mode transform transform-origin`.split(/\s+/));
const MAX_ELEMENTS = 10000;
const MAX_DEPTH = 128;
const MAX_RENDER_CHARS = 128 * 1024;
const LOCAL_URL = /url\(\s*['"]?#([\w.-]+)['"]?\s*\)/gi;
const COMPOUND_SELECTOR = '(?:[a-z_*][\\w-]*(?:[.#][a-z_][\\w-]*)*|(?:[.#][a-z_][\\w-]*)+)';
const COMPLEX_SELECTOR = `${COMPOUND_SELECTOR}(?:(?:\\s+|\\s*[>+~]\\s*)${COMPOUND_SELECTOR})*`;
const SELECTOR = new RegExp(`^\\s*${COMPLEX_SELECTOR}(?:\\s*,\\s*${COMPLEX_SELECTOR})*\\s*$`, 'i');
const cleanCss = value => value.replace(/\/\*[\s\S]*?\*\//g, '');
const urls = value => [...cleanCss(value).matchAll(LOCAL_URL)].map(match => match[1]);

function svgName(element) {
  const parts = element.localName.split(':');
  const attribute = parts.length === 1 ? 'xmlns' : `xmlns:${parts[0]}`;
  for (let ancestor = element; ancestor?.nodeType === 1; ancestor = ancestor.parentElement) {
    if (ancestor.hasAttribute(attribute)) return ancestor.getAttribute(attribute) === SVG_NS ? parts.at(-1) : null;
  }
  return null;
}

function safeValue(value) {
  const clean = cleanCss(value);
  // Dynamic CSS can move references away from the node where they are counted.
  // Priority overrides, escaped function names, and non-local URLs or image
  // functions are outside the supported static subset.
  return !/[\\@<>]|\/\*|\*\/|!\s*important/i.test(clean)
    && !/(?:^|[^\w-])(?:var|attr|env|(?:-[a-z]+-)?image-set|image|src|cross-fade|element)\s*\(/i.test(clean)
    && !/url\s*\(/i.test(clean.replace(LOCAL_URL, ''));
}

function supportedStyle(name, value) {
  const clean = cleanCss(value).trim();
  const withoutUrls = clean.replace(LOCAL_URL, '');
  return Boolean(clean) && STYLE_PROPERTIES.has(name) && safeValue(value)
    && !/[;:{}]/.test(withoutUrls)
    && !/['"]/.test(withoutUrls.replace(/'[\w .-]*'|"[\w .-]*"/g, ''))
    && !/[()]/.test(withoutUrls.replace(/(?:^|(?<=[^\w-]))[a-z-]+\([#\w .,%+-]*\)/gi, ''))
    // Context paints come from a use/marker's context, not normal inheritance.
    // Keep them out of the static subset until that context is modeled.
    && !(RESOURCE_PROPERTIES.includes(name) && /\bcontext-(?:fill|stroke)\b/i.test(clean));
}

/** A bounded static rendering subset. Validation never changes the saved bytes. */
export function boundedSvg(bytes, { legacy = false } = {}) {
  const source = bytes.toString('utf8');
  if (/<!ENTITY|<\?xml-stylesheet/i.test(source) || (!legacy && /<!DOCTYPE/i.test(source))) return false;
  // Bound the parser's structure before creating a DOM. Large inert descriptions
  // from older editors remain readable, but thousands of tiny tags do not.
  let tags = 0;
  for (const _match of source.matchAll(/<[a-z]/gi)) {
    if (++tags > MAX_ELEMENTS) return false;
  }
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  let root = document.documentElement;
  if (!root || svgName(root) !== 'svg') return false;
  const kinds = new Map();
  const originalElements = [root, ...root.querySelectorAll('*')];
  for (const element of originalElements) kinds.set(element, svgName(element));
  // linkedom retains qualified tag names. Normalize SVG aliases only in this
  // validation DOM so CSS type selectors see the same elements as the browser.
  for (const element of originalElements) {
    const kind = kinds.get(element);
    if (kind && element.localName !== kind) {
      const replacement = document.createElement(kind);
      for (const { name, value } of element.attributes) replacement.setAttribute(name, value);
      while (element.firstChild) replacement.appendChild(element.firstChild);
      element.replaceWith(replacement);
      kinds.set(replacement, kind);
    }
  }
  root = document.documentElement;
  const elements = [root, ...root.querySelectorAll('*')];
  if (elements.length > MAX_ELEMENTS) return false;
  const byId = new Map();
  const references = new Map();
  const resourceValues = new Map();
  const sizes = new Map();
  const stylesheets = [];
  let renderChars = 0;
  let ruleCount = 0;
  const declaration = (element, name, value) => {
    if (!supportedStyle(name, value)) return false;
    sizes.set(element, sizes.get(element) + name.length + value.length);
    if (RESOURCE_PROPERTIES.includes(name)) {
      const values = resourceValues.get(element)[name] ||= [];
      values.push(value);
    } else references.get(element).push(...urls(value));
    return true;
  };
  // Parse declarations directly instead of reading linkedom's CSSOM map, which
  // keeps only the last duplicate property and misparses leading parentheses.
  const parseDeclarations = text => {
    const clean = cleanCss(text);
    if (!safeValue(clean) || /[{}]/.test(clean)) return null;
    const parsed = [];
    for (const raw of clean.split(';')) {
      const entry = raw.trim();
      if (!entry) continue;
      const colon = entry.indexOf(':');
      if (colon <= 0) return null;
      const name = entry.slice(0, colon).trim().toLowerCase();
      const value = entry.slice(colon + 1).trim();
      if (!supportedStyle(name, value)) return null;
      parsed.push([name, value]);
    }
    return parsed;
  };
  const declarations = (element, list) => list !== null && list.every(([name, value]) => declaration(element, name, value));
  const rules = text => {
    const clean = cleanCss(text);
    if (!safeValue(clean)) return null;
    const parsed = [];
    let rest = clean.trim();
    while (rest) {
      const open = rest.indexOf('{');
      const close = rest.indexOf('}');
      if (open <= 0 || close < open) return null;
      const selectorText = rest.slice(0, open).trim();
      const list = parseDeclarations(rest.slice(open + 1, close));
      // Conditional/pseudo selectors and namespace rules need a full browser
      // cascade. Keep the original for download instead of guessing at them.
      if (selectorText.length > 256 || !SELECTOR.test(selectorText) || !list) return null;
      parsed.push({ selectorText, declarations: list });
      rest = rest.slice(close + 1).trim();
    }
    ruleCount += parsed.length;
    return ruleCount <= 256 ? parsed : null;
  };
  for (const element of elements) {
    let depth = 0;
    for (let parent = element; parent; parent = parent.parentElement) if (++depth > MAX_DEPTH) return false;
    const kind = kinds.get(element);
    if ((!kind && !legacy) || (kind && !ELEMENTS.has(kind) && !(legacy && ['metadata', 'style'].includes(kind)))) return false;
    references.set(element, []);
    resourceValues.set(element, {});
    sizes.set(element, 0);
    const id = element.getAttribute('id');
    if (id !== null) {
      if (byId.has(id)) return false;
      byId.set(id, element);
    }
    // Foreign style/link elements can participate in the document's CSS even
    // though they are not SVG geometry. Editor/RDF metadata remains supported.
    if (!kind && /^(?:style|script|link|foreignobject|image)$/i.test(element.localName.split(':').at(-1))) return false;
    for (const { name: rawName, value } of element.attributes) {
      const name = rawName.toLowerCase();
      if (name.split(':').at(-1).startsWith('on') || name === 'xml:base') return false;
      if (!safeValue(value)) return false;
      if (name === 'filter' && value.trim() !== 'none') return false;
      if (name === 'href' || name.endsWith(':href')) {
        if (!/^#[\w.-]+$/.test(value)) return false;
        references.get(element).push(value.slice(1));
      }
      if (RESOURCE_PROPERTIES.includes(name)) {
        if (!declaration(element, name, value)) return false;
      } else if (name === 'style') {
        if (!declarations(element, parseDeclarations(value))) return false;
      } else references.get(element).push(...urls(value));
      sizes.set(element, sizes.get(element) + name.length + value.length);
    }
    if (kind === 'style') stylesheets.push(element.textContent);
    if (['text', 'tspan', 'style'].includes(kind)) sizes.set(element, sizes.get(element) + element.textContent.length);
    renderChars += sizes.get(element);
    if (renderChars > MAX_RENDER_CHARS) return false;
  }
  for (const text of stylesheets) {
    const parsed = rules(text);
    if (!parsed) return false;
    for (const rule of parsed) {
      let matches;
      try {
        matches = [...root.querySelectorAll(rule.selectorText)];
        if (root.matches(rule.selectorText)) matches.unshift(root);
      } catch {
        return false;
      }
      for (const element of matches) {
        if (!declarations(element, rule.declarations)) return false;
      }
    }
  }
  const inherited = new Map();
  const resolvedResources = (element, parent = {}) => Object.fromEntries(RESOURCE_PROPERTIES.map(name => {
    const own = resourceValues.get(element)[name] || [];
    // Browsers ignore invalid fill/stroke values and inherit the ancestor paint,
    // so auto-inherited resources remain in the budget on painted descendants.
    const inherit = AUTO_INHERITED.has(name) || own.some(value => /\b(?:inherit|unset|revert(?:-layer)?)\b/i.test(value));
    return [name, new Set([...(inherit ? parent[name] || [] : []), ...own.flatMap(urls)])];
  }));
  const ordinaryResources = new Map();
  for (const element of elements) {
    const parent = ordinaryResources.get(element.parentElement) || {};
    inherited.set(element, parent);
    ordinaryResources.set(element, resolvedResources(element, parent));
  }
  // Spend a shared budget while expanding. Unlike a per-node memoized sum,
  // this also accounts for inherited paints inside use-instance shadow trees.
  let remaining = MAX_ELEMENTS;
  const open = new Set();
  const visit = (element, parent, depth = 0) => {
    if (depth > MAX_DEPTH || open.has(element)) return false;
    remaining -= 1 + Math.floor(sizes.get(element) / 64);
    if (remaining < 0) return false;
    open.add(element);
    const resources = resolvedResources(element, parent);
    // Masks and clips do not inherit by default, but explicit `inherit` applies
    // the ancestor's resource separately to each descendant, including groups.
    const targets = [...references.get(element), ...resources.mask, ...resources['clip-path']];
    if (PAINTED.has(kinds.get(element))) targets.push(...resources.fill, ...resources.stroke);
    for (const id of targets) {
      const target = byId.get(id);
      if (!target || GRADIENTS.has(kinds.get(target))) continue;
      if (!visit(target, kinds.get(element) === 'use' ? resources : inherited.get(target), depth + 1)) return false;
    }
    for (const child of element.children) if (!visit(child, resources, depth + 1)) return false;
    open.delete(element);
    return true;
  };
  return visit(root, {});
}
