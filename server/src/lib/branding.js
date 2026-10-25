import { createHash } from 'node:crypto';
import { DOMParser } from 'linkedom';
import db from './db.js';

// The encoded value is bounded, not just the decoded image: DynamoDB stores
// base64 as text. Keep these limits aligned with client/src/lib/logoUpload.js.
export const MAX_LOGO_DATA_URL_CHARS = 128 * 1024;
export const MAX_CLASSROOM_NAME = 100;
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
  // Control characters must not reach HTML/mail headers from legacy records.
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_CLASSROOM_NAME) : '';
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
  return true;
}

const boundedDimensions = (width, height) => width > 0 && height > 0 && width <= 4096 && height <= 4096;

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 218 || marker === 217 || offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      return length >= 8 && boundedDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return false;
}

function webpDimensions(bytes) {
  const type = bytes.toString('ascii', 12, 16);
  if (type === 'VP8X' && bytes.length >= 30) return boundedDimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
  if (type === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
    return boundedDimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) {
    const dimensions = bytes.readUInt32LE(21);
    return boundedDimensions((dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1);
  }
  return false;
}

/** Only bounded, base64-encoded images; never an arbitrary browser-fetchable URL. */
export function parseLogo(value) {
  if (typeof value !== 'string' || value.length > MAX_LOGO_DATA_URL_CHARS) return null;
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const [, mime, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) return null;
  let valid = false;
  if (mime === 'image/png' && bytes.length >= 45) {
    valid = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.toString('ascii', 12, 16) === 'IHDR'
      && boundedDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
      && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND';
  } else if (mime === 'image/jpeg') {
    valid = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217 && jpegDimensions(bytes);
  } else if (mime === 'image/webp') {
    valid = bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8 && webpDimensions(bytes);
  } else if (mime === 'image/svg+xml') {
    try { valid = staticSvg(bytes); } catch { return null; }
  }
  if (!valid) return null;
  return { dataUrl: value, mime, bytes, hash: createHash('sha256').update(mime).update(bytes).digest('hex') };
}

export function publicBranding(settings) {
  const hash = HASH.test(settings.logoHash || '') ? settings.logoHash : parseLogo(settings.logoBase64)?.hash;
  return { theme: publicTheme(settings.theme), classroomName: classroomName(settings), logoUrl: hash ? `/v1/branding/logo/${hash}` : null };
}

export async function readLogo(hash, legacySettings) {
  if (!HASH.test(hash || '')) return null;
  // A newly acknowledged settings pointer must be readable immediately on DynamoDB.
  const item = await db.getSyncData(LOGO_OWNER, `logo:${hash}`, { consistentRead: true });
  const logo = parseLogo(item?.data?.dataUrl) || parseLogo(legacySettings?.logoBase64);
  return logo?.hash === hash ? logo : null;
}

export async function storeLogo(logo) {
  const key = `logo:${logo.hash}`;
  if (await db.getSyncData(LOGO_OWNER, key)) return;
  try {
    await db.putSyncData(LOGO_OWNER, key, { dataUrl: logo.dataUrl }, 0);
  } catch (error) {
    // Two identical uploads share one immutable asset. Other failures must
    // leave the settings pointer unchanged and reach the caller.
    if (error.name !== 'ConditionalCheckFailedException') throw error;
  }
}

/** Same WCAG foreground selection as client branding, including the black fallback. */
export function brandForeground(hex) {
  const color = normalizeThemeColor(hex) || '#470d99';
  const luminance = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const bg = luminance(color);
  const dark = luminance('#1a1a1a');
  const whiteRatio = 1.05 / (bg + 0.05);
  const darkRatio = (Math.max(bg, dark) + 0.05) / (Math.min(bg, dark) + 0.05);
  if (whiteRatio >= 4.5 && whiteRatio >= darkRatio) return '#ffffff';
  return darkRatio >= 4.5 ? '#1a1a1a' : '#000000';
}
