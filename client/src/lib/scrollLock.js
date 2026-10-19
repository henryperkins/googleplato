// Reference-counted background scroll lock with iOS Safari position preservation.
// Avoids non-passive touchmove preventDefault() handlers so scrolling inside
// sheets and dialogs remains native and unobstructed.

let lockCount = 0;
let savedScrollY = 0;
let savedStyles = null;

function isIosTouchDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function lockBackgroundScroll() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (lockCount === 0) {
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    const html = document.documentElement;
    const body = document.body;
    savedStyles = {
      htmlOverflow: html.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
    };
    html.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'contain';
    body.style.overflow = 'hidden';
    if (isIosTouchDevice()) {
      body.style.position = 'fixed';
      body.style.top = `-${savedScrollY}px`;
      body.style.left = '0';
      body.style.right = '0';
      body.style.width = '100%';
    }
  }
  lockCount += 1;
}

export function unlockBackgroundScroll() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || lockCount === 0) return;
  lockCount -= 1;
  if (lockCount === 0 && savedStyles) {
    const html = document.documentElement;
    const body = document.body;
    const wasFixed = body.style.position === 'fixed';
    html.style.overflow = savedStyles.htmlOverflow;
    html.style.overscrollBehavior = savedStyles.htmlOverscroll;
    body.style.overflow = savedStyles.bodyOverflow;
    body.style.position = savedStyles.bodyPosition;
    body.style.top = savedStyles.bodyTop;
    body.style.left = savedStyles.bodyLeft;
    body.style.right = savedStyles.bodyRight;
    body.style.width = savedStyles.bodyWidth;
    savedStyles = null;
    if (wasFixed) {
      window.scrollTo(0, savedScrollY);
    }
  }
}

export function resetScrollLockForTests() {
  lockCount = 0;
  savedScrollY = 0;
  savedStyles = null;
}
