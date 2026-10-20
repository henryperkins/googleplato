import { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext.jsx';
import { buildThemeVars, generateFavicon, setFavicon } from '../lib/branding.js';
import { cachedPublicBranding, loadPublicBranding } from '../lib/publicBranding.js';

const EMPTY_BRANDING = { theme: null, logoBase64: null, classroomName: '' };

const BrandingContext = createContext(null);

/**
 * Provides classroom branding to learner-facing UI.
 * The plato dashboard is never affected.
 */
export function BrandingProvider({ children }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Usually already loaded: App requests branding at boot (lib/publicBranding.js).
  const [branding, setBranding] = useState(() => {
    const cached = cachedPublicBranding();
    return cached ? { ...EMPTY_BRANDING, ...cached, loaded: true } : { ...EMPTY_BRANDING, loaded: false };
  });

  useEffect(() => {
    if (branding.loaded) return;
    let cancelled = false;
    loadPublicBranding().then((data) => {
      if (!cancelled) setBranding({ ...EMPTY_BRANDING, ...data, loaded: true });
    });
    return () => { cancelled = true; };
  }, [branding.loaded]);

  // Generate and set favicon — only when classroom has a logo image; otherwise use plato default
  useEffect(() => {
    if (!branding.logoBase64 || !branding.theme?.primary || isAdmin) return;
    let cancelled = false;
    let restoreFn;
    generateFavicon(branding.logoBase64, branding.theme.primary).then(dataUrl => {
      if (dataUrl && !cancelled) restoreFn = setFavicon(dataUrl);
    });
    return () => { cancelled = true; restoreFn?.(); };
  }, [branding.logoBase64, branding.theme?.primary, isAdmin]);

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
