import { contrastRatio, hexToOklchParts, normalizeHex } from './branding.js';

const hexOf = channels => '#' + channels.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const distance = (a, b) => Math.hypot(a.l - b.l,
  a.c * Math.cos(a.h * Math.PI / 180) - b.c * Math.cos(b.h * Math.PI / 180),
  a.c * Math.sin(a.h * Math.PI / 180) - b.c * Math.sin(b.h * Math.PI / 180));

/** Dominant, distinct logo colors. Ignore transparent edges and tiny image noise. */
export function paletteFromPixels({ data }) {
  const buckets = new Map();
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const weight = data[i + 3] / 255;
    if (weight < 0.5) continue;
    const rgb = [data[i], data[i + 1], data[i + 2]];
    const key = rgb.map(v => v >> 4).join(',');
    const bucket = buckets.get(key) || { weight: 0, sum: [0, 0, 0] };
    bucket.weight += weight;
    rgb.forEach((v, channel) => { bucket.sum[channel] += v * weight; });
    buckets.set(key, bucket);
    total += weight;
  }
  const candidates = [...buckets.values()].map(({ weight, sum }) => {
    const hex = hexOf(sum.map(v => v / weight));
    return { hex, weight, ...hexToOklchParts(hex) };
  }).sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
  const clusters = [];
  for (const color of candidates) {
    const similar = clusters.find(candidate => distance(candidate, color) < 0.07);
    if (similar) similar.weight += color.weight;
    else clusters.push({ ...color });
  }
  // A white background or black wordmark must not drown out the actual brand.
  // Keep neutrals available, and keep monochrome logos genuinely monochrome.
  return clusters.filter(color => color.weight >= total * 0.01)
    .sort((a, b) => Number(b.c >= 0.035) - Number(a.c >= 0.035)
      || b.weight * (1 + b.c) - a.weight * (1 + a.c) || a.hex.localeCompare(b.hex))
    .slice(0, 5).map(color => color.hex);
}

/** Favor a visible light header, then a distinct second logo hue as the accent. */
export function suggestLogoTheme(colors) {
  const palette = colors.map(normalizeHex).filter(Boolean);
  if (!palette.length) return null;
  const primary = palette.find(hex => contrastRatio(hex, '#ffffff') >= 3) || palette[0];
  const lead = hexToOklchParts(primary);
  const accent = palette.filter(hex => hex !== primary).find(hex => {
    const color = hexToOklchParts(hex);
    return lead.c >= 0.035 && color.c >= 0.035 && hueGap(lead.h, color.h) >= 30 && distance(lead, color) >= 0.1;
  }) || primary;
  return { primary, accent, matchPrimary: primary === accent };
}

/** A neutral backing keeps transparent marks visible even on their own brand color. */
export function logoMatteFromPixels(pixels) {
  let transparent = false;
  for (let i = 3; i < pixels.data.length; i += 4) {
    if (pixels.data[i] < 250) { transparent = true; break; }
  }
  if (!transparent) return null; // An opaque logo already supplies its background.
  const colors = paletteFromPixels(pixels);
  if (!colors.length) return null;
  // The middle neutral is useful for marks containing both black and white.
  // Maximize the weakest color, not the average that could hide part of a mark.
  return ['#f5f5f4', '#242424', '#767676'].map(hex => ({
    hex, contrast: Math.min(...colors.map(color => contrastRatio(color, hex))),
  })).sort((a, b) => b.contrast - a.contrast)[0].hex;
}

export function sampleLogoImage(img) {
  const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Logo colors could not be read. Choose colors manually.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Sample only the prepared upload or a same-origin saved asset, in image mode. */
export async function readLogoPalette(src, { signal } = {}) {
  if (!/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/i.test(src)
    && !(new URL(src, window.location.href).origin === window.location.origin
      && new URL(src, window.location.href).pathname.startsWith('/v1/branding/logo/'))) {
    throw new Error('Choose a logo file to find its colors.');
  }
  const img = new Image();
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      img.onload = null;
      img.onerror = null;
      if (error) { img.src = ''; reject(error); } else resolve();
    };
    const abort = () => finish(new DOMException('Logo analysis cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('The logo took too long to load. Try again.')), 8000);
    img.onload = () => finish();
    img.onerror = () => finish(new Error('Logo colors could not be read. Choose colors manually or try another image.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else img.src = src;
  });
  if (signal?.aborted) throw new DOMException('Logo analysis cancelled', 'AbortError');
  return paletteFromPixels(sampleLogoImage(img));
}
