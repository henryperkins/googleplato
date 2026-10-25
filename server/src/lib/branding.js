import { createHash } from 'node:crypto';
import { DOMParser } from 'linkedom';
import db from './db.js';
import { logger } from './logger.js';

// The encoded value is bounded, not just the decoded image: DynamoDB stores
// base64 as text. Keep these limits aligned with client/src/lib/logoUpload.js.
export const MAX_LOGO_DATA_URL_CHARS = 128 * 1024;
export const MAX_CLASSROOM_NAME = 100;
// New uploads also bound the decoded area, which every visitor pays for.
const MAX_LOGO_PIXELS = 1024 * 1024;
// Logos saved before these limits are still shown, up to the largest data URL
// the earlier Customizer could produce (an incompressible 512 x 512 PNG).
const LEGACY_LOGO_DATA_URL_CHARS = 2 * 1024 * 1024;
// <use> repeats other content, so count rendered instances rather than elements.
const MAX_SVG_INSTANCES = 10000;
const LOGO_OWNER = '_branding';
const HASH = /^[a-f0-9]{64}$/;
const SVG_ELEMENTS = new Set('svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask pattern use title desc'.split(' '));

export function normalizeThemeColor(value) {
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value.trim())) return null;
  const hex = value.trim().slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map(ch => ch + ch).join('') : hex}`;
}

export function publicTheme(theme) {
  const result = {};
  for (const key of ['primary', 'accent']) {
    const value = theme?.[key];
    let color = normalizeThemeColor(value);
    // Read older CSS-shaped colors as safe, opaque hex values, like the
    // classroom's normalizeHex. New writes still require #rgb or #rrggbb.
    if (!color && typeof value === 'string') {
      const hex = value.trim().match(/^#?([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
      const rgb = value.trim().match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+%?)?\s*\)$/i);
      if (hex) color = normalizeThemeColor(`#${hex.slice(0, hex.length < 5 ? 3 : 6)}`);
      else if (rgb) color = '#' + rgb.slice(1, 4).map(channel => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('');
    }
    if (color) result[key] = color;
  }
  return Object.keys(result).length ? result : null;
}

export function classroomName(settings) {
  const name = typeof settings.classroomName === 'string' ? settings.classroomName : settings.logoAlt;
  if (typeof name !== 'string') return '';
  // Control characters must not reach HTML/mail headers from legacy records,
  // and a lone surrogate makes the SES SDK throw. Cut by code point.
  // eslint-disable-next-line no-control-regex
  return [...name.replace(/[\u0000-\u001f\u007f]/g, '').trim().toWellFormed()].slice(0, MAX_CLASSROOM_NAME).join('').trim();
}

/** Why a submitted classroom name can't be saved, or null. Every writer (setup, Customizer) uses this. */
export function classroomNameError(value) {
  // eslint-disable-next-line no-control-regex
  if (typeof value === 'string' && value.trim().length <= MAX_CLASSROOM_NAME && !/[\u0000-\u001f\u007f]/.test(value) && value.isWellFormed()) return null;
  return `Classroom name must be text of at most ${MAX_CLASSROOM_NAME} characters, without control characters.`;
}

/** True when <use> references expand the document to at most `limit` rendered elements. */
function boundedInstances(root, limit) {
  const byId = new Map([root, ...root.querySelectorAll('[id]')].map(element => [element.getAttribute('id'), element]));
  const counted = new Map();
  const open = new Set();
  const count = element => {
    if (counted.has(element)) return counted.get(element);
    if (open.has(element)) return Infinity; // a reference cycle
    open.add(element);
    let total = 1;
    for (const child of element.children) total += count(child);
    if (element.localName === 'use') {
      const target = byId.get((element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '').slice(1));
      if (target) total += count(target);
    }
    open.delete(element);
    counted.set(element, total);
    return total;
  };
  return count(root) <= limit;
}

function staticSvg(bytes) {
  const source = bytes.toString('utf8');
  // No entities, stylesheet PIs, executable elements or external references.
  // The endpoint also applies CSP sandboxing, including on direct navigation.
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) return false;
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (root?.localName !== 'svg' || root.getAttribute('xmlns') !== 'http://www.w3.org/2000/svg') return false;
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!SVG_ELEMENTS.has(element.localName)) return false;
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith('on') || name === 'xml:base') return false;
      if ((name === 'href' || name.endsWith(':href')) && !/^#[\w.-]+$/.test(value)) return false;
      if (/[\\@]/.test(value) || /url\s*\(/i.test(value.replace(/url\(\s*['"]?#[\w.-]+['"]?\s*\)/gi, ''))) return false;
    }
  }
  return boundedInstances(root, MAX_SVG_INSTANCES);
}

// Earlier Customizers stored SVG files unchanged, and every page already showed
// them as images. Keep showing them: they only render through <img> (no script,
// no fetches) and the logo endpoint sandboxes direct navigation. Refuse entity
// declarations, which a parser would have to expand.
const legacySvg = bytes => {
  const source = bytes.toString('utf8');
  return /<svg[\s>]/i.test(source) && !/<!ENTITY/i.test(source);
};

function pngSize(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255
    || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return null;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 255) return null;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 218 || marker === 217 || offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      return length >= 8 ? { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) } : null;
    }
    offset += length;
  }
  return null;
}

function webpSize(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP'
    || bytes.readUInt32LE(4) !== bytes.length - 8) return null;
  const type = bytes.toString('ascii', 12, 16);
  if (type === 'VP8X' && bytes.length >= 30) return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (type === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) {
    const dimensions = bytes.readUInt32LE(21);
    return { width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

const RASTER_SIZE = { 'image/png': pngSize, 'image/jpeg': jpegSize, 'image/webp': webpSize };

/**
 * Only bounded, base64-encoded images; never an arbitrary browser-fetchable URL.
 * New uploads use the strict rules. `legacy` reads what is already stored: the
 * larger size of earlier versions and any SVG they kept, so tightening these
 * rules never hides a logo that is live.
 */
export function parseLogo(value, { legacy = false } = {}) {
  if (typeof value !== 'string' || value.length > (legacy ? LEGACY_LOGO_DATA_URL_CHARS : MAX_LOGO_DATA_URL_CHARS)) return null;
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const [, mime, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) return null;
  let valid;
  if (mime === 'image/svg+xml') {
    try { valid = legacy ? legacySvg(bytes) : staticSvg(bytes); } catch { return null; }
  } else {
    const size = RASTER_SIZE[mime](bytes);
    valid = size && size.width > 0 && size.height > 0 && size.width <= 4096 && size.height <= 4096
      && (legacy || size.width * size.height <= MAX_LOGO_PIXELS);
  }
  if (!valid) return null;
  return { dataUrl: value, mime, bytes, hash: createHash('sha256').update(mime).update(bytes).digest('hex') };
}

// An inline legacy logo is read on every public branding request, and stays
// the same between saves. Parse each stored value once.
let legacyRead = { value: undefined, logo: null };

/** The logo an earlier version kept inline in settings, if it can still be shown. */
export function legacyLogo(settings) {
  const value = settings?.logoBase64;
  if (typeof value !== 'string') return null;
  if (legacyRead.value !== value) legacyRead = { value, logo: parseLogo(value, { legacy: true }) };
  return legacyRead.logo;
}

/** The hash of the logo pages should show, from its asset pointer or a legacy inline value. */
export function currentLogoHash(settings) {
  return HASH.test(settings.logoHash || '') ? settings.logoHash : legacyLogo(settings)?.hash || null;
}

export function publicBranding(settings) {
  const hash = currentLogoHash(settings);
  return { theme: publicTheme(settings.theme), classroomName: classroomName(settings), logoUrl: hash ? `/v1/branding/logo/${hash}` : null };
}

export async function readLogo(hash, legacySettings) {
  if (!HASH.test(hash || '')) return null;
  // A newly acknowledged settings pointer must be readable immediately on DynamoDB.
  const item = await db.getSyncData(LOGO_OWNER, `logo:${hash}`, { consistentRead: true });
  // Assets were checked when they were written. Read them by the stored-logo
  // rules, so a later tightening never hides a logo that is already live.
  // `legacy` marks a logo from an earlier version, inline or migrated.
  const stored = parseLogo(item?.data?.dataUrl, { legacy: true });
  const logo = stored ? { ...stored, legacy: item.data.legacy === true } : { ...legacyLogo(legacySettings), legacy: true };
  return logo.hash === hash ? logo : null;
}

/** Store a logo asset. Resolves true when this call created the row. */
export async function storeLogo(logo) {
  const key = `logo:${logo.hash}`;
  // Identical uploads share one immutable asset.
  if (await db.getSyncData(LOGO_OWNER, key, { consistentRead: true })) return false;
  await db.putSyncData(LOGO_OWNER, key, { dataUrl: logo.dataUrl, ...(logo.legacy ? { legacy: true } : {}) }, 0);
  return true;
}

/**
 * Remove a logo asset that settings no longer point to, so a replaced or
 * removed logo stops being fetchable by its URL. Best effort: a leftover row
 * costs only storage, and the save it follows has already succeeded.
 */
export async function deleteUnusedLogo(hash) {
  if (!HASH.test(hash || '')) return;
  try {
    const current = await db.getSyncData('_system', 'settings', { consistentRead: true });
    if (current?.data?.logoHash === hash) return;
    await db.deleteSyncData(LOGO_OWNER, `logo:${hash}`);
  } catch (error) {
    logger.warn('branding_logo_cleanup_failed', { reason: error.name });
  }
}

/** Same WCAG foreground selection as client branding, including the black fallback. */
export function brandForeground(hex) {
  const color = normalizeThemeColor(hex) || '#470d99';
  const bg = luminance(color);
  const dark = luminance('#1a1a1a');
  const whiteRatio = 1.05 / (bg + 0.05);
  const darkRatio = (Math.max(bg, dark) + 0.05) / (Math.min(bg, dark) + 0.05);
  if (whiteRatio >= 4.5 && whiteRatio >= darkRatio) return '#ffffff';
  return darkRatio >= 4.5 ? '#1a1a1a' : '#000000';
}

/** WCAG contrast of a brand color against white, for edges that would otherwise vanish. */
export function contrastOnWhite(hex) {
  return 1.05 / (luminance(normalizeThemeColor(hex) || '#470d99') + 0.05);
}

function luminance(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
