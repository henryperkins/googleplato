import { DOMParser } from 'linkedom';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ELEMENTS = new Set('svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask pattern use title desc'.split(' '));
const PAINTED = new Set('path rect circle ellipse line polyline polygon text tspan'.split(' '));
const GRADIENTS = new Set(['linearGradient', 'radialGradient']);
const STYLE_PROPERTIES = new Set(`fill fill-opacity fill-rule stroke stroke-opacity stroke-width stroke-linecap stroke-linejoin
  stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color font-family font-size font-style font-weight font-stretch
  font-variant text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing paint-order shape-rendering
  text-rendering clip-path clip-rule mask display visibility stop-color stop-opacity vector-effect enable-background
  isolation mix-blend-mode transform transform-origin`.split(/\s+/));
const MAX_ELEMENTS = 10000;
const MAX_DEPTH = 128;
const MAX_RENDER_CHARS = 128 * 1024;
const LOCAL_URL = /url\(\s*['"]?#([\w.-]+)['"]?\s*\)/gi;
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
  // Escaped function names and non-local URLs are outside the supported subset.
  return !/[\\@]/.test(clean) && !/\b(?:var|attr|env)\s*\(/i.test(clean)
    && !/url\s*\(/i.test(clean.replace(LOCAL_URL, ''));
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
  const paints = new Map();
  const sizes = new Map();
  const stylesheets = [];
  const cssDocument = new DOMParser().parseFromString('<html></html>', 'text/html');
  let renderChars = 0;
  let ruleCount = 0;
  const rules = text => {
    if (!safeValue(text)) throw new Error('Unsupported SVG CSS');
    const style = cssDocument.createElement('style');
    style.textContent = text;
    const parsed = style.sheet.cssRules;
    ruleCount += parsed.length;
    if (ruleCount > 256 || parsed.some(rule => rule.type !== 1)) throw new Error('Unsupported SVG CSS rule');
    return parsed;
  };
  const declaration = (element, name, value) => {
    if (!STYLE_PROPERTIES.has(name) || !safeValue(value)) throw new Error('Unsupported SVG style');
    sizes.set(element, sizes.get(element) + name.length + value.length);
    if (name === 'fill' || name === 'stroke') {
      const values = paints.get(element)[name] ||= [];
      values.push(value);
    } else references.get(element).push(...urls(value));
  };
  const declarations = (element, style) => {
    for (let i = 0; i < style.length; i++) declaration(element, style[i].toLowerCase(), style.getPropertyValue(style[i]));
  };
  const supportedDeclarations = style => {
    for (let i = 0; i < style.length; i++) {
      if (!STYLE_PROPERTIES.has(style[i].toLowerCase()) || !safeValue(style.getPropertyValue(style[i]))) return false;
    }
    return true;
  };
  for (const element of elements) {
    let depth = 0;
    for (let parent = element; parent; parent = parent.parentElement) if (++depth > MAX_DEPTH) return false;
    const kind = kinds.get(element);
    if ((!kind && !legacy) || (kind && !ELEMENTS.has(kind) && !(legacy && ['metadata', 'style'].includes(kind)))) return false;
    references.set(element, []);
    paints.set(element, {});
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
      if (name === 'fill' || name === 'stroke') declaration(element, name, value);
      else if (name === 'style') {
        const parsed = rules(`.validation{${value}}`);
        if (parsed.length !== 1) return false;
        declarations(element, parsed[0].style);
      } else references.get(element).push(...urls(value));
      sizes.set(element, sizes.get(element) + name.length + value.length);
    }
    if (kind === 'style') stylesheets.push(element.textContent);
    if (['text', 'tspan', 'style'].includes(kind)) sizes.set(element, sizes.get(element) + element.textContent.length);
    renderChars += sizes.get(element);
    if (renderChars > MAX_RENDER_CHARS) return false;
  }
  for (const text of stylesheets) {
    for (const rule of rules(text)) {
      if (!supportedDeclarations(rule.style)) return false;
      // Conditional/pseudo selectors and namespace rules need a full browser
      // cascade. Keep the original for download instead of guessing at them.
      if (rule.selectorText.length > 256 || /[:|\\]/.test(rule.selectorText)) return false;
      const matches = [...root.querySelectorAll(rule.selectorText)];
      if (root.matches(rule.selectorText)) matches.unshift(root);
      for (const element of matches) declarations(element, rule.style);
    }
  }
  const inherited = new Map();
  const resolvedPaint = (element, parent = {}) => Object.fromEntries(['fill', 'stroke'].map(name => {
    const own = paints.get(element)[name];
    return [name, own ? new Set(own.flatMap(value => /\b(?:inherit|unset|revert(?:-layer)?)\b/i.test(value)
      ? [...(parent[name] || [])] : urls(value))) : parent[name] || new Set()];
  }));
  const ordinaryPaint = new Map();
  for (const element of elements) {
    const parent = ordinaryPaint.get(element.parentElement) || {};
    inherited.set(element, parent);
    ordinaryPaint.set(element, resolvedPaint(element, parent));
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
    const paint = resolvedPaint(element, parent);
    const targets = [...references.get(element)];
    if (PAINTED.has(kinds.get(element))) targets.push(...paint.fill, ...paint.stroke);
    for (const id of targets) {
      const target = byId.get(id);
      if (!target || GRADIENTS.has(kinds.get(target))) continue;
      if (!visit(target, kinds.get(element) === 'use' ? paint : inherited.get(target), depth + 1)) return false;
    }
    for (const child of element.children) if (!visit(child, paint, depth + 1)) return false;
    open.delete(element);
    return true;
  };
  return visit(root, {});
}
