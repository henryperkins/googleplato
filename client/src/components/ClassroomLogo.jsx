import { useState } from 'react';

/**
 * The classroom logo, or `fallback` (its name) when there is none or the image
 * fails to load. The logo is a request of its own, so it can fail while the
 * rest of the branding arrives; a broken-image glyph would replace the name.
 */
export default function ClassroomLogo({ src, fallback, ...props }) {
  const [failed, setFailed] = useState(null);
  if (!src || failed === src) return fallback;
  return <img src={src} {...props} onError={() => setFailed(src)} />;
}
