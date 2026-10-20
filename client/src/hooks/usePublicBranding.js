import { useState, useEffect, useLayoutEffect } from 'react';
import { buildThemeVars, contrastText, generateFavicon, setFavicon } from '../lib/branding.js';
import { cachedPublicBranding, loadPublicBranding } from '../lib/publicBranding.js';

/**
 * Classroom branding for public pages (login, signup, forgot/reset password).
 * Applies CSS vars to :root, sets favicon, and returns branding data.
 */
export default function usePublicBranding(pageTitle) {
  const [branding, setBranding] = useState(cachedPublicBranding);

  useEffect(() => {
    if (branding) return;
    let cancelled = false;
    loadPublicBranding().then((data) => { if (!cancelled) setBranding(data); });
    return () => { cancelled = true; };
  }, [branding]);

  // Set document title using classroom name
  useEffect(() => {
    if (!branding) return;
    const name = branding.classroomName || 'plato';
    document.title = `${pageTitle} — ${name}`;
  }, [branding, pageTitle]);

  // Apply CSS vars to :root so buttons/links use classroom colors. A layout
  // effect runs before paint, so the page never shows a frame of the default
  // purple first.
  useLayoutEffect(() => {
    if (!branding?.theme) return;
    const vars = buildThemeVars(branding.theme);
    const root = document.documentElement;
    const hadThemeClass = root.classList.contains('classroom-theme');
    root.classList.add('classroom-theme');
    const originals = {};
    for (const [key, value] of Object.entries(vars)) {
      originals[key] = root.style.getPropertyValue(key);
      root.style.setProperty(key, value);
    }
    return () => {
      if (!hadThemeClass) root.classList.remove('classroom-theme');
      for (const [key, value] of Object.entries(originals)) {
        if (value) root.style.setProperty(key, value);
        else root.style.removeProperty(key);
      }
    };
  }, [branding?.theme]);

  // Generate and set favicon — only when classroom has a logo image; otherwise use plato default
  useEffect(() => {
    if (!branding?.logoBase64 || !branding?.theme?.primary) return;
    let cancelled = false;
    let restoreFn;
    generateFavicon(branding.logoBase64, branding.theme.primary).then(dataUrl => {
      if (dataUrl && !cancelled) restoreFn = setFavicon(dataUrl);
    });
    return () => { cancelled = true; restoreFn?.(); };
  }, [branding?.logoBase64, branding?.theme?.primary]);

  if (!branding) return null;

  return {
    primary: branding.theme?.primary || '#8b1a1a',
    foreground: contrastText(branding.theme?.primary || '#8b1a1a'),
    logo: branding.logoBase64 || null,
    classroomName: branding.classroomName || 'plato',
    theme: branding.theme,
  };
}
