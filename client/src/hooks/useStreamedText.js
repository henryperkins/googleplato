import { useState, useEffect, useRef } from 'react';

const TICK_MS = 30;
const CATCH_UP_SHARE = 0.1;

/**
 * How many characters to show after one tick. The reveal keeps a steady
 * typing cadence (one character per tick, more after a throttled background
 * tab) and also takes a share of whatever text is waiting. A reply that
 * arrives all at once lands in about a second and a half whatever its
 * length, instead of typing out at a fixed ~33 characters a second while the
 * composer waits; a slow stream still reads as typing. Exported for tests.
 */
export function nextRevealLength(shown, available, elapsedMs) {
  const backlog = available - shown;
  if (backlog <= 0) return shown;
  const cadence = Math.max(1, Math.floor(elapsedMs / TICK_MS));
  const catchUp = Math.ceil(backlog * CATCH_UP_SHARE);
  return Math.min(available, shown + Math.max(cadence, catchUp));
}

/**
 * Smoothly reveals streamed text, catching up when text arrives faster than
 * it can be typed (see nextRevealLength).
 *
 * rawText: the full accumulated text from the API (or null when not streaming).
 * Returns [displayText, isDraining]:
 *   - displayText: the portion to render (null when inactive)
 *   - isDraining: true while the drain is still catching up to the buffer
 *
 * Continues streaming in background tabs (browsers throttle setInterval to 1000ms
 * when hidden, making it appear that streaming paused). When the tab becomes visible
 * again, the display catches up immediately.
 */
export function useStreamedText(rawText) {
  const [motionPreference] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)'));
  const [display, setDisplay] = useState(null);
  const bufferRef = useRef('');
  const posRef = useRef(0);
  const doneRef = useRef(false);   // API finished sending
  const activeRef = useRef(false);
  const timerRef = useRef(null);
  const lastTickRef = useRef(0);

  // Update buffer when new text arrives
  useEffect(() => {
    if (rawText == null) {
      // API is done — mark it but DON'T reset yet. Let the drain finish.
      doneRef.current = true;
      return;
    }
    // New stream starting
    if (!activeRef.current) {
      activeRef.current = true;
      doneRef.current = false;
      posRef.current = 0;
      lastTickRef.current = Date.now();
      setDisplay('');
    }
    bufferRef.current = rawText;
  }, [rawText]);

  // Drain buffer at a steady pace, continuing in background
  useEffect(() => {
    if (!activeRef.current && rawText == null) return;
    if (timerRef.current) return; // already running

    const tick = () => {
      const now = Date.now();
      const elapsed = now - lastTickRef.current;
      const target = bufferRef.current;

      // Reduced motion shows each received chunk without artificial typing.
      const newPos = motionPreference.matches
        ? target.length
        : nextRevealLength(posRef.current, target.length, elapsed);

      if (newPos > posRef.current) {
        posRef.current = newPos;
        lastTickRef.current = now;
        setDisplay(target.slice(0, posRef.current));
      }

      if (posRef.current >= target.length && doneRef.current) {
        // Drain caught up and API is done — finish
        clearInterval(timerRef.current);
        timerRef.current = null;
        activeRef.current = false;
        setDisplay(null);
        bufferRef.current = '';
        posRef.current = 0;
        doneRef.current = false;
      }
    };

    timerRef.current = setInterval(tick, TICK_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [rawText, motionPreference]);

  // Catch up immediately when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && activeRef.current) {
        // Reset timer to catch up now that we're visible
        lastTickRef.current = Date.now();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  return display;
}
