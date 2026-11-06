import { useState } from 'react';
import { logoMatteFromPixels, sampleLogoImage } from '../lib/logoPalette.js';

/**
 * The classroom logo, or `fallback` (its name) when there is none or the image
 * fails to load. The logo is a request of its own, so it can fail while the
 * rest of the branding arrives; a broken-image glyph would replace the name.
 */
export default function ClassroomLogo({ src, fallback, style, ...props }) {
  const [failed, setFailed] = useState(null);
  const [matte, setMatte] = useState(null);
  if (!src || failed === src) return fallback;
  return <img src={src} {...props} style={{ ...style, backgroundColor: matte?.src === src ? matte.color : undefined }}
    onLoad={event => {
      try {
        setMatte({ src, color: logoMatteFromPixels(sampleLogoImage(event.currentTarget)) });
      } catch { /* A readable image can still have an unreadable canvas. Keep it. */ }
    }} onError={() => setFailed(src)} />;
}
