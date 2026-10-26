import { createHash } from 'node:crypto';
import { boundedSvg } from './svgSafety.js';
import db from './db.js';

// The encoded value is bounded, not just the decoded image: DynamoDB stores
// base64 as text. Keep these limits aligned with client/src/lib/logoUpload.js.
export const MAX_LOGO_DATA_URL_CHARS = 128 * 1024;
export const MAX_CLASSROOM_NAME = 100;
// New uploads also bound the decoded area, which every visitor pays for.
const MAX_LOGO_PIXELS = 1024 * 1024;
// Earlier versions stored larger images. Keep their originals; the shared SVG
// rendering policy decides whether they can be displayed safely.
const LEGACY_LOGO_DATA_URL_CHARS = 8 * 1024 * 1024;
const LOGO_OWNER = '_branding';
const HASH = /^[a-f0-9]{64}$/;

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
 * larger size and compatible editor markup of earlier versions. Both paths
 * enforce the same SVG rendering budget; blocked originals remain stored.
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
    try { valid = boundedSvg(bytes, { legacy }); } catch { return null; }
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

export async function publicBranding(settings) {
  const hash = currentLogoHash(settings);
  const logo = hash ? await readLogo(hash, settings) : null;
  return { theme: publicTheme(settings.theme), classroomName: classroomName(settings), logoUrl: logo ? `/v1/branding/logo/${hash}` : null };
}

/** Read original data for authenticated recovery, without approving it for rendering. */
export async function readLogoOriginal(settings) {
  if (HASH.test(settings.logoHash || '')) {
    const item = await db.getSyncData(LOGO_OWNER, `logo:${settings.logoHash}`, { consistentRead: true });
    if (typeof item?.data?.dataUrl === 'string') return { dataUrl: item.data.dataUrl, legacy: item.data.legacy === true };
  }
  return typeof settings.logoBase64 === 'string' ? { dataUrl: settings.logoBase64, legacy: true } : null;
}

export async function readLogo(hash, legacySettings) {
  if (!HASH.test(hash || '')) return null;
  // A newly acknowledged settings pointer must be readable immediately on DynamoDB.
  const item = await db.getSyncData(LOGO_OWNER, `logo:${hash}`, { consistentRead: true });
  // Apply today's rendering budget to stored assets too. Original bytes stay
  // available to authenticated recovery even when display validation fails.
  // `legacy` marks a logo from an earlier version, inline or migrated.
  const stored = legacyLogo({ logoBase64: item?.data?.dataUrl });
  const logo = stored ? { ...stored, legacy: item.data.legacy === true } : { ...legacyLogo(legacySettings), legacy: true };
  return logo.hash === hash ? logo : null;
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
