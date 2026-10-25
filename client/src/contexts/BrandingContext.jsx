import { createContext, useContext, useState, useEffect, useLayoutEffect } from 'react';
import {
  DEFAULT_PRIMARY,
  applyThemeVarsToRoot,
  buildThemeVars,
  generateFavicon,
  normalizeHex,
  setFavicon,
} from '../lib/branding.js';
import { cachedPublicBranding, loadPublicBranding, subscribePublicBranding } from '../lib/publicBranding.js';

const EMPTY_BRANDING = { theme: null, logoUrl: null, classroomName: '' };

const BrandingContext = createContext(null);

/**
 * Provides classroom branding to learner-facing UI.
 * The plato dashboard is never affected.
 */
export function BrandingProvider({ children }) {
  // Usually already loaded: App requests branding at boot (lib/publicBranding.js).
  const [branding, setBranding] = useState(() => {
    const cached = cachedPublicBranding();
    return cached ? { ...EMPTY_BRANDING, ...cached, loaded: true } : { ...EMPTY_BRANDING, loaded: false };
  });

  useEffect(() => {
    return subscribePublicBranding((data) => {
      if (data) setBranding({ ...EMPTY_BRANDING, ...data, loaded: true });
      else setBranding({ ...EMPTY_BRANDING, loaded: false });
    });
  }, []);

  useEffect(() => {
    if (branding.loaded) return;
    let cancelled = false;
    loadPublicBranding().then((data) => {
      if (!cancelled) setBranding({ ...EMPTY_BRANDING, ...data, loaded: true });
    });
    return () => { cancelled = true; };
  }, [branding.loaded]);

  // Apply CSS vars to :root as well so portaled dialogs/modals on document.body
  // inherit the classroom theme while classroom routes are active.
  useLayoutEffect(() => {
    return applyThemeVarsToRoot(branding.theme);
  }, [branding.theme]);

  // Generate and set favicon when classroom has custom branding (logo, name, or primary color)
  useEffect(() => {
    const hasCustomBranding = Boolean(
      branding.logoUrl || branding.classroomName?.trim() || branding.theme?.primary
    );
    if (!hasCustomBranding) return;
    let cancelled = false;
    let restoreFn;
    const primaryColor = normalizeHex(branding.theme?.primary) || DEFAULT_PRIMARY;
    generateFavicon(branding.logoUrl, primaryColor, branding.classroomName).then(dataUrl => {
      if (dataUrl && !cancelled) restoreFn = setFavicon(dataUrl);
    });
    return () => { cancelled = true; restoreFn?.(); };
  }, [branding.logoUrl, branding.theme?.primary, branding.classroomName]);

  const classroomStyle = buildThemeVars(branding.theme);

  if (!branding.loaded) return null;

  return (
    <BrandingContext.Provider value={branding}>
      <div style={classroomStyle} className="classroom-theme flex flex-col flex-1 min-w-0">
        {children}
      </div>
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
