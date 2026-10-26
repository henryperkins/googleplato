// The server independently enforces the encoded size and image format.
export const MAX_LOGO_DATA_URL_CHARS = 128 * 1024;
export const MAX_LOGO_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CLASSROOM_NAME = 100;

const UNREADABLE = "That image couldn't be read. Try another PNG, JPG, WebP, or SVG.";
// Some systems report no type, or an old alias, for ordinary image files.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/jpg', 'image/pjpeg', 'image/x-png', ''];

/** Fit within the header box. A vector (`upscale`) grows to fill it; a bitmap never does. */
export function logoDimensions(width, height, maxWidth = 1024, maxHeight = 128, { upscale = false } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The logo has no usable dimensions.');
  const fit = Math.min(maxWidth / width, maxHeight / height);
  const scale = upscale ? fit : Math.min(1, fit);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The box around every pixel that isn't fully transparent, or null for an empty image. */
export function opaqueBounds({ data, width, height }) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[(y * width + x) * 4 + 3]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not prepare the logo.');
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

// Halve large reductions step by step: WebKit and Firefox sample sparsely in a
// single big drawImage, which makes thin strokes jagged. A vector is drawn once,
// at the final size: its intrinsic size can exceed what a canvas can hold.
function drawScaled(source, width, height, { vector = false } = {}) {
  let current = source;
  let currentWidth = source.naturalWidth || source.width;
  let currentHeight = source.naturalHeight || source.height;
  while (!vector && currentWidth / 2 >= width && currentHeight / 2 >= height) {
    const half = canvasOf(Math.max(1, Math.floor(currentWidth / 2)), Math.max(1, Math.floor(currentHeight / 2)));
    half.ctx.drawImage(current, 0, 0, half.canvas.width, half.canvas.height);
    current = half.canvas;
    currentWidth = half.canvas.width;
    currentHeight = half.canvas.height;
  }
  const { canvas, ctx } = canvasOf(width, height);
  ctx.drawImage(current, 0, 0, width, height);
  return canvas;
}

// Cut away fully transparent edges, such as the square padding earlier versions added.
function trimmed(img) {
  const { canvas, ctx } = canvasOf(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, 0, 0);
  const bounds = opaqueBounds(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (!bounds) throw new Error('The logo is empty. Choose another image.');
  const crop = canvasOf(bounds.width, bounds.height);
  crop.ctx.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  return crop.canvas;
}

/** A data URL as a Blob, so a stored logo can go through `prepareLogo` again. */
export function dataUrlBlob(dataUrl) {
  const [, type, encoded] = dataUrl.match(/^data:([^;,]+);base64,(.*)$/) || [];
  if (!type) throw new Error(UNREADABLE);
  return new Blob([Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0))], { type });
}

/** Recover original bytes as an attachment. Never open or render a blocked SVG. */
export function downloadOriginalLogo(value) {
  let bytes;
  let extension = 'txt';
  try {
    bytes = dataUrlBlob(value);
    extension = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[bytes.type] || 'txt';
  } catch {
    bytes = new Blob([value]);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `classroom-logo.${extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Rasterize in image mode, preserving transparency and wordmark proportions.
 * `trim` also crops transparent edges.
 */
export async function prepareLogo(file, { trim = false } = {}) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Choose a PNG, JPG, WebP, or SVG image.');
  if (file.size > MAX_LOGO_FILE_BYTES) throw new Error('Choose an image smaller than 5 MiB.');
  const vector = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '');
  // Browsers render SVG only from a blob that says it is SVG.
  const src = URL.createObjectURL(vector && file.type !== 'image/svg+xml' ? new Blob([file], { type: 'image/svg+xml' }) : file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(UNREADABLE));
      image.src = src;
    });
    const source = trim && !vector ? trimmed(img) : img;
    let { width, height } = logoDimensions(source.naturalWidth || source.width, source.naturalHeight || source.height, 1024, 128, { upscale: vector });
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = drawScaled(source, width, height, { vector });
      let encoded;
      try {
        encoded = canvas.toDataURL('image/png');
      } catch {
        // An SVG that embeds HTML taints the canvas, so it can't be exported.
        throw new Error(UNREADABLE);
      }
      // A browser that can't draw the image hands back an empty canvas instead of failing.
      if (attempt === 0 && !opaqueBounds(canvas.getContext('2d').getImageData(0, 0, width, height))) throw new Error(UNREADABLE);
      if (encoded.startsWith('data:image/png;base64,') && encoded.length <= MAX_LOGO_DATA_URL_CHARS) return encoded;
      width = Math.max(1, Math.floor(width * 0.75));
      height = Math.max(1, Math.floor(height * 0.75));
    }
    throw new Error('The logo is too detailed to fit. Try a simpler or smaller image.');
  } finally {
    URL.revokeObjectURL(src);
  }
}
