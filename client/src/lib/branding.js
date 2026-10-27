/** Shared branding utilities — used by BrandingContext and public auth pages. */

export const DEFAULT_PRIMARY = '#470d99';
export const DEFAULT_ACCENT = '#470d99';

/**
 * Normalize a CSS color to `#rrggbb`, or return null when it cannot be parsed.
 * Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, bare hex, and
 * `rgb()`/`rgba()` — legacy or API-set themes are not always six-digit hex,
 * and dropping them silently loses all classroom branding.
 */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const rgb = trimmed.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+%?)?\s*\)$/i);
  if (rgb) {
    return '#' + rgb.slice(1, 4).map(c => Math.min(255, Number(c)).toString(16).padStart(2, '0')).join('');
  }
  const hex = trimmed.match(/^#?([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (!hex) return null;
  const digits = hex[1].toLowerCase();
  if (digits.length === 3) return '#' + [...digits].map(c => c + c).join('');
  if (digits.length === 4) return '#' + [...digits.slice(0, 3)].map(c => c + c).join('');
  return '#' + digits.slice(0, 6);
}

function channelsOf(hex) {
  const normalized = normalizeHex(hex) || '#000000';
  return [1, 3, 5].map(index => parseInt(normalized.slice(index, index + 2), 16));
}

/** Relative luminance (0=black, 1=white). */
export function luminance(hex) {
  const [r255, g255, b255] = channelsOf(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const lin = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Keep the familiar near-black when possible; pure black closes its contrast gap. */
export function contrastText(bgHex) {
  const white = contrastRatio('#ffffff', bgHex);
  const dark = contrastRatio('#1a1a1a', bgHex);
  if (white >= 4.5 && white >= dark) return '#ffffff';
  return dark >= 4.5 ? '#1a1a1a' : '#000000';
}

/** OKLCH lightness (0–1), chroma, and hue (degrees) of a hex color. */
export function hexToOklchParts(hex) {
  const [r255, g255, b255] = channelsOf(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const lin = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const lr = lin(r), lg = lin(g), lb = lin(b);
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l = Math.cbrt(l_), m = Math.cbrt(m_), s = Math.cbrt(s_);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { l: L, c: Math.sqrt(a * a + bOk * bOk), h: (Math.atan2(bOk, a) * 180 / Math.PI + 360) % 360 };
}

/** Convert hex to oklch string. */
export function hexToOklch(hex) {
  const { l, c, h } = hexToOklchParts(hex);
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
}

function oklchToLinearRgb(l, c, h) {
  const a = c * Math.cos(h * Math.PI / 180);
  const b = c * Math.sin(h * Math.PI / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
  ];
}

const inSrgb = (rgb) => rgb.every(v => v >= -1e-6 && v <= 1 + 1e-6);

/** Hex for an OKLCH color; chroma beyond sRGB is reduced, keeping lightness and hue. */
export function oklchToHex(l, c, h) {
  let rgb = oklchToLinearRgb(l, c, h);
  if (!inSrgb(rgb)) {
    let lo = 0, hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inSrgb(oklchToLinearRgb(l, mid, h))) lo = mid; else hi = mid;
    }
    rgb = oklchToLinearRgb(l, lo, h);
  }
  const gamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, gamma(v))) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * Adjust only failing colors toward a readable endpoint, moving OKLCH lightness
 * and keeping hue and chroma, so a brand stays one color family instead of
 * washing toward gray (mixing RGB toward white turned maroon into dusty rose).
 */
export function readableColor(hex, background, minimum = 4.6) {
  const normalized = normalizeHex(hex);
  if (!normalized) return hex;
  if (contrastRatio(normalized, background) >= minimum) return normalized;
  const { l, c, h } = hexToOklchParts(normalized);
  const endpoint = contrastText(background) === '#ffffff' ? 1 : 0;
  if (contrastRatio(oklchToHex(endpoint, c, h), background) < minimum) return endpoint ? '#ffffff' : '#000000';
  // The smallest lightness move that reads: contrast grows steadily toward the endpoint.
  let failing = l, passing = endpoint;
  for (let i = 0; i < 24; i++) {
    const mid = (failing + passing) / 2;
    if (contrastRatio(oklchToHex(mid, c, h), background) >= minimum) passing = mid; else failing = mid;
  }
  return oklchToHex(passing, c, h);
}

// Surface references (index.css). Fills (buttons, chat bubbles, badges) must
// stand out, 3:1, from every surface they sit on: by day the darkest is the
// workspace, oklch(0.97 0.001 106.424); at night the lightest is the popover
// that dialogs use, oklch(0.235 …) in the brand's tint. A dark header's
// lightness stays in the night band, so it neither glares nor sinks into the
// page (oklch(0.15 …)).
const LIGHT_WORKSPACE = '#f5f5f4';
const DARK_POPOVER_LIGHTNESS = 0.235;
const DARK_PAGE = '#0e0e0e';
const NIGHT_BAND = [0.33, 0.48];
// Below this chroma a color reads as gray, and its hue is noise.
const ACHROMATIC = 0.03;

/**
 * The chroma of the brand's hue in the night surfaces (index.css
 * `--tint-chroma`). Only a whisper: at full strength every classroom's room
 * turned the brand's mud (brown for maroon, olive for yellow) instead of a
 * calm neutral dark with the brand in its header and fills.
 */
function tintChroma(c) {
  return c < ACHROMATIC ? 0 : Math.round(Math.min(0.007, c * 0.08) * 1000) / 1000;
}

/**
 * The header color in dark mode: the brand, deepened or lifted into the
 * night band. A brand already in the band stays exactly as chosen; a shade
 * the band forces eases its saturation a little, so a bright yellow becomes
 * deep gold rather than mustard and a candy violet stays rich, not neon.
 */
export function darkHeaderColor(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const { l, c, h } = hexToOklchParts(normalized);
  const chroma = c < ACHROMATIC ? 0 : c * 0.9;
  let band = Math.min(NIGHT_BAND[1], Math.max(NIGHT_BAND[0], l));
  // Already in the band and separating from the page: keep the brand exact.
  // (Checking the eased shade here would bless saturated blues whose true
  // color sits under 1.5:1, since easing raises their luminance.)
  if (band === l && contrastRatio(normalized, DARK_PAGE) >= 1.5) return normalized;
  // Saturated blues carry little luminance for their lightness: lift them
  // until the band still separates from the page.
  while (band < NIGHT_BAND[1] && contrastRatio(oklchToHex(band, chroma, h), DARK_PAGE) < 1.5) band += 0.005;
  return oklchToHex(band, chroma, h);
}

/**
 * The button fill in dark mode: the brand when it already stands out from the
 * night surfaces (3:1 against the popover, the lightest of them), else lifted
 * until it does. A near-black brand turns light gray instead, the way a
 * monochrome mark inverts at night.
 */
export function darkFillColor(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const { l, c, h } = hexToOklchParts(normalized);
  const surface = oklchToHex(DARK_POPOVER_LIGHTNESS, tintChroma(c), h);
  if (contrastRatio(normalized, surface) >= 3) return normalized;
  if (c < ACHROMATIC) return oklchToHex(0.93, 0, 0);
  // Ease saturation as lightness climbs: full chroma at night lightness
  // reads pastel (maroon becomes salmon) or neon, never the brand at ease.
  const liftedChroma = c * 0.92;
  let failing = l, passing = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (failing + passing) / 2;
    if (contrastRatio(oklchToHex(mid, liftedChroma, h), surface) >= 3) passing = mid; else failing = mid;
  }
  return oklchToHex(passing, liftedChroma, h);
}

/**
 * The learner bubble fill in dark mode. A bubble is a large surface, so a
 * night fill that would glare there, one that carries dark text (a pale brand
 * kept as chosen, or the light gray a near-black brand turns), deepens to the
 * darkest shade of the brand that still stands out from the popover. Every
 * night bubble then carries white text.
 */
export function darkBubbleColor(hex) {
  const fill = darkFillColor(hex);
  if (!fill || contrastText(fill) === '#ffffff') return fill;
  const { c, h } = hexToOklchParts(normalizeHex(hex));
  const chroma = c < ACHROMATIC ? 0 : c * 0.92;
  const surface = oklchToHex(DARK_POPOVER_LIGHTNESS, tintChroma(c), h);
  let failing = 0, passing = hexToOklchParts(fill).l;
  for (let i = 0; i < 24; i++) {
    const mid = (failing + passing) / 2;
    if (contrastRatio(oklchToHex(mid, chroma, h), surface) >= 3) passing = mid; else failing = mid;
  }
  return oklchToHex(passing, chroma, h);
}

/**
 * The button and bubble fill in light mode: the brand when it already stands
 * out from the light surfaces (3:1 against the workspace, the darkest of
 * them), else deepened until it does. A pale gray brand turns near-black
 * instead, the way a monochrome mark reads on paper. The header keeps the
 * brand as chosen.
 */
export function lightFillColor(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  if (contrastRatio(normalized, LIGHT_WORKSPACE) >= 3) return normalized;
  const { l, c, h } = hexToOklchParts(normalized);
  if (c < ACHROMATIC) return oklchToHex(0.205, 0, 0);
  let failing = l, passing = 0;
  for (let i = 0; i < 24; i++) {
    const mid = (failing + passing) / 2;
    if (contrastRatio(oklchToHex(mid, c, h), LIGHT_WORKSPACE) >= 3) passing = mid; else failing = mid;
  }
  return oklchToHex(passing, c, h);
}

/**
 * Notes for the Customizer: a warning when the header won't stand out in light
 * mode (there it uses the color as chosen), what each mode changes to keep the
 * buttons and the night header visible, and when night bubbles deepen.
 */
export function themeColorNotes(theme) {
  const primary = normalizeHex(theme?.primary);
  if (!primary) return [];
  const notes = [];
  const onWhite = contrastRatio(primary, '#ffffff');
  const { l, c } = hexToOklchParts(primary);
  if (onWhite < 3) {
    notes.push({
      level: 'warning',
      text: `In light mode, the header in this color barely stands out from white (${onWhite.toFixed(1)}:1). A deeper shade will read clearly.`,
    });
  }
  if (lightFillColor(primary) !== primary) {
    notes.push({
      level: 'info',
      text: c < ACHROMATIC
        ? 'In light mode, buttons turn near-black, since pale gray buttons would disappear on light cards.'
        : 'In light mode, buttons use a deeper shade so they stand out from light cards.',
    });
  }
  if (darkHeaderColor(primary) !== primary) {
    notes.push({
      level: 'info',
      text: l > NIGHT_BAND[1]
        ? `In dark mode, the header uses a deeper shade so it doesn't glare at night.`
        : 'In dark mode, the header uses a lighter shade so it stands out from the page.',
    });
  }
  if (darkFillColor(primary) !== primary) {
    notes.push({
      level: 'info',
      text: c < ACHROMATIC
        ? 'In dark mode, buttons turn light gray, since near-black buttons would disappear on dark cards.'
        : 'In dark mode, buttons use a lighter shade so they stand out from dark cards.',
    });
  }
  if (darkBubbleColor(primary) !== darkFillColor(primary)) {
    notes.push({
      level: 'info',
      text: c < ACHROMATIC
        ? `In dark mode, learners' messages turn gray with white text, so they don't glare at night.`
        : `In dark mode, learners' messages use a deeper shade with white text, so they don't glare at night.`,
    });
  }
  return notes;
}

/** Build CSS var overrides from theme primary/accent. */
export function buildThemeVars(theme) {
  const vars = {};
  if (!theme) return vars;
  const primary = normalizeHex(theme.primary);
  const accent = normalizeHex(theme.accent) || primary;
  if (primary) {
    // The header shows the brand as chosen; fills take a shade that stands
    // out from the page and cards. Fills stay hex, the exact color their
    // contrast was checked on: a rounded oklch() can land just under 3:1.
    const fill = lightFillColor(primary);
    vars['--classroom-header-bg'] = primary;
    vars['--classroom-header-text'] = contrastText(primary);
    vars['--primary'] = fill;
    vars['--primary-foreground'] = contrastText(fill);
    vars['--classroom-primary-text-light'] = hexToOklch(readableColor(primary, '#f5f5f5'));
    vars['--classroom-primary-text-dark'] = hexToOklch(readableColor(primary, '#303030'));
    // The night classroom (index.css `.dark .classroom-theme`): its own header,
    // fills, and learner bubbles, and the trace of the brand's hue its
    // surfaces carry.
    const header = darkHeaderColor(primary);
    const nightFill = darkFillColor(primary);
    const nightBubble = darkBubbleColor(primary);
    const { c, h } = hexToOklchParts(primary);
    vars['--classroom-header-bg-dark'] = header;
    vars['--classroom-header-text-dark'] = contrastText(header);
    vars['--classroom-primary-dark'] = nightFill;
    vars['--classroom-primary-foreground-dark'] = contrastText(nightFill);
    vars['--classroom-bubble-dark'] = nightBubble;
    vars['--classroom-bubble-foreground-dark'] = contrastText(nightBubble);
    vars['--classroom-tint-hue'] = h.toFixed(1);
    vars['--classroom-tint-chroma'] = tintChroma(c).toFixed(3);
  }
  if (accent) {
    vars['--classroom-link-light'] = hexToOklch(readableColor(accent, '#f5f5f5'));
    vars['--classroom-link-dark'] = hexToOklch(readableColor(accent, '#303030'));
    vars['--classroom-ring-light'] = vars['--classroom-link-light'];
    vars['--classroom-ring-dark'] = vars['--classroom-link-dark'];
    // Restore the pre-rework contract: consumers that apply these vars
    // without `.classroom-theme` still get a themed focus ring instead of
    // silently falling back to the default purple. The dark rule in
    // index.css overrides this inline (light) value with !important.
    vars['--ring'] = vars['--classroom-ring-light'];
  }
  return vars;
}

/**
 * Apply `.classroom-theme` and theme CSS variables to `:root` (`document.documentElement`)
 * so both the page and portaled dialogs/modals inherit the classroom theme.
 * Returns a cleanup function that restores the previous class and inline variables.
 */
export function applyThemeVarsToRoot(theme) {
  if (typeof document === 'undefined' || !document.documentElement || !theme) return () => {};
  const vars = buildThemeVars(theme);
  const entries = Object.entries(vars);
  if (entries.length === 0) return () => {};
  const root = document.documentElement;
  const hadThemeClass = root.classList?.contains('classroom-theme');
  root.classList?.add('classroom-theme');
  const originals = {};
  for (const [key, value] of entries) {
    originals[key] = root.style.getPropertyValue(key);
    root.style.setProperty(key, value);
  }
  return () => {
    if (!hadThemeClass) root.classList?.remove('classroom-theme');
    for (const [key, value] of Object.entries(originals)) {
      if (value) root.style.setProperty(key, value);
      else root.style.removeProperty(key);
    }
  };
}

/**
 * Generate a favicon: classroom logo (or text initial) on a rounded-rect background.
 * Returns a data URL suitable for <link rel="icon">.
 * @param {string|null} logoBase64 - logo data URL or same-origin asset URL; null for a text initial
 * @param {string} primaryColor - background color
 * @param {string} classroomName - used for text initial when no logo image
 */
export function generateFavicon(logoBase64, primaryColor, classroomName = '') {
  return new Promise((resolve) => {
    const bg = normalizeHex(primaryColor) || DEFAULT_PRIMARY;
    const size = 32;
    // A fresh tile each time: a canvas that drew an unreadable image stays tainted.
    const tile = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      // Rounded rect background
      const radius = 6;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.lineTo(size - radius, 0);
      ctx.quadraticCurveTo(size, 0, size, radius);
      ctx.lineTo(size, size - radius);
      ctx.quadraticCurveTo(size, size, size - radius, size);
      ctx.lineTo(radius, size);
      ctx.quadraticCurveTo(0, size, 0, size - radius);
      ctx.lineTo(0, radius);
      ctx.quadraticCurveTo(0, 0, radius, 0);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      return { canvas, ctx };
    };
    const drawInitial = () => {
      const { canvas, ctx } = tile();
      // The first character, never half of a surrogate pair.
      const initial = (Array.from((classroomName || '').trim())[0] || 'P').toUpperCase();
      ctx.fillStyle = contrastText(bg);
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initial, size / 2, size / 2 + 1);
      resolve(canvas.toDataURL('image/png'));
    };

    if (!logoBase64) {
      drawInitial();
      return;
    }
    // Draw logo image centered with padding
    const img = new Image();
    img.onload = () => {
      // A wordmark wider than 2:1 would shrink to an unreadable strip; the initial reads better.
      if (!img.width || !img.height || img.width > img.height * 2) {
        drawInitial();
        return;
      }
      const { canvas, ctx } = tile();
      const pad = 4;
      const area = size - pad * 2;
      const scale = Math.min(area / img.width, area / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      try {
        resolve(canvas.toDataURL('image/png'));
      } catch {
        drawInitial();
      }
    };
    // A logo that fails to load still gets the classroom's tile.
    img.onerror = drawInitial;
    img.src = logoBase64;
  });
}

/**
 * Point every icon link at the favicon: index.html declares 32px and 16px
 * icons, and a browser showing the 16px one would keep the default.
 * Returns a cleanup function that restores each link.
 */
export function setFavicon(dataUrl) {
  const existing = [...document.querySelectorAll("link[rel='icon']")];
  if (existing.length === 0) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = dataUrl;
    document.head.appendChild(link);
    return () => link.remove();
  }
  const originals = existing.map(link => ({ link, href: link.href, type: link.type }));
  for (const link of existing) {
    link.type = 'image/png';
    link.href = dataUrl;
  }
  return () => {
    for (const { link, href, type } of originals) {
      link.href = href;
      link.type = type;
    }
  };
}
