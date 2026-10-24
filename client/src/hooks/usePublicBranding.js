import { useState, useEffect, useLayoutEffect } from 'react';
import {
  DEFAULT_PRIMARY,
  applyThemeVarsToRoot,
  generateFavicon,
  normalizeHex,
  setFavicon,
} from '../lib/branding.js';
import { cachedPublicBranding, loadPublicBranding, subscribePublicBranding } from '../lib/publicBranding.js';
import { pageTitle } from '../lib/routeTitles.js';

/**
 * Classroom branding for public pages (login, signup, forgot/reset password).
 * Applies CSS vars to :root, sets favicon, and returns branding data.
 */
export default function usePublicBranding(title) {
  const [branding, setBranding] = useState(cachedPublicBranding);

  useEffect(() => subscribePublicBranding(setBranding), []);

  useEffect(() => {
    if (branding) return;
    let cancelled = false;
    loadPublicBranding().then((data) => { if (!cancelled) setBranding(data); });
    return () => { cancelled = true; };
  }, [branding]);

  // Set document title using classroom name
  useEffect(() => {
    if (!branding) return;
    document.title = pageTitle(title, branding.classroomName);
  }, [branding, title]);

  // Apply CSS vars to :root so buttons, links, and the page backdrop (the
  // `--header` tokens) use classroom colors in either theme. A layout effect
  // runs before paint, so the page never shows a frame of the default purple.
  useLayoutEffect(() => {
    return applyThemeVarsToRoot(branding?.theme);
  }, [branding?.theme]);

  // Generate and set favicon when classroom has custom branding (logo, name, or primary color)
  useEffect(() => {
    const hasCustomBranding = Boolean(
      branding?.logoBase64 || branding?.classroomName?.trim() || branding?.theme?.primary
    );
    if (!hasCustomBranding) return;
    let cancelled = false;
    let restoreFn;
    const primaryColor = normalizeHex(branding?.theme?.primary) || DEFAULT_PRIMARY;
    generateFavicon(branding.logoBase64, primaryColor, branding.classroomName).then(dataUrl => {
      if (dataUrl && !cancelled) restoreFn = setFavicon(dataUrl);
    });
    return () => { cancelled = true; restoreFn?.(); };
  }, [branding?.logoBase64, branding?.theme?.primary, branding?.classroomName]);

  if (!branding) return null;

  return {
    logo: branding.logoBase64 || null,
    classroomName: branding.classroomName || 'plato',
    theme: branding.theme,
  };
}
