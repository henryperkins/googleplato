import { useState, useEffect } from 'react';

function isEditableElement(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

/**
 * Tracks software keyboard occlusion via `window.visualViewport` for engines
 * (such as iOS Safari / WebKit) where `interactive-widget=resizes-content`
 * does not shrink the layout viewport (`window.innerHeight`).
 *
 * Per the mobile audit contract:
 * - Acts ONLY while an editable field has focus.
 * - Accounts for pinch-zoom (`scale`), `offsetTop`, and orientation changes so
 *   zooming never hides or displaces fixed/sticky controls.
 * - Returns 0 on browsers where `interactive-widget=resizes-content` already
 *   shrunk `window.innerHeight` to match `visualViewport.height`.
 */
export function useVisualViewportKeyboardOffset() {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return undefined;
    const vv = window.visualViewport;

    function update() {
      // Do not displace controls while the user is pinch-zoomed in.
      if (vv.scale && vv.scale > 1.01) {
        setOffset(0);
        return;
      }
      if (!isEditableElement(document.activeElement)) {
        setOffset(0);
        return;
      }
      const occluded = Math.round(window.innerHeight - (vv.height + vv.offsetTop));
      // Only apply when the software keyboard occludes a meaningful slice (> 80px)
      // of the layout viewport.
      setOffset(occluded > 80 ? occluded : 0);
    }

    function handleFocusOut() {
      requestAnimationFrame(() => {
        if (!isEditableElement(document.activeElement)) {
          setOffset(0);
        } else {
          update();
        }
      });
    }

    const passiveOption = { passive: true };
    vv.addEventListener('resize', update, passiveOption);
    vv.addEventListener('scroll', update, passiveOption);
    window.addEventListener('orientationchange', update, passiveOption);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      vv.removeEventListener('resize', update, passiveOption);
      vv.removeEventListener('scroll', update, passiveOption);
      window.removeEventListener('orientationchange', update, passiveOption);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  return offset;
}
