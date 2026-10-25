// The server independently enforces the encoded size and image format.
export const MAX_LOGO_DATA_URL_CHARS = 128 * 1024;
export const MAX_LOGO_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CLASSROOM_NAME = 100;

export function logoDimensions(width, height, maxWidth = 1024, maxHeight = 128) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The logo has no usable dimensions.');
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Rasterize in image mode, preserving transparency and wordmark proportions. */
export async function prepareLogo(file) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.type)) throw new Error('Choose a PNG, JPG, WebP, or SVG image.');
  if (file.size > MAX_LOGO_FILE_BYTES) throw new Error('Choose an image smaller than 5 MiB.');
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("That image couldn't be read. Try another PNG, JPG, WebP, or SVG."));
      image.src = src;
    });
    let { width, height } = logoDimensions(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    for (let attempt = 0; attempt < 8; attempt++) {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser could not prepare the logo.');
      ctx.drawImage(img, 0, 0, width, height);
      const encoded = canvas.toDataURL('image/png');
      if (encoded.startsWith('data:image/png;base64,') && encoded.length <= MAX_LOGO_DATA_URL_CHARS) return encoded;
      width = Math.max(1, Math.floor(width * 0.75));
      height = Math.max(1, Math.floor(height * 0.75));
    }
    throw new Error('The logo is too detailed to fit. Try a simpler or smaller image.');
  } finally {
    URL.revokeObjectURL(src);
  }
}
