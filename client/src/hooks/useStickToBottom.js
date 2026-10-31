import { useEffect, useRef } from 'react';

/**
 * Keep the chat log pinned to the bottom while content is added — but only when
 * the reader is already at the bottom.
 *
 * Contract:
 *   - At the bottom when new content arrives → stay at the bottom.
 *   - Scrolled up → nothing moves, until the reader returns to the bottom.
 *   - The reader sends a message → always jump to the bottom and resume
 *     following (sending means "show me the latest", regardless of where they
 *     had scrolled to while composing).
 *
 * Three implementation notes, all learned the hard way (#319, #321):
 *
 * 1. **Listen on `window` with capture.** The chat log element has no
 *    `overflow`, so it never emits `scroll`. `scroll` doesn't bubble, but it
 *    *does* propagate in the capture phase, so a capturing `window` listener
 *    sees whichever element scrolls without having to identify it. (Same pattern
 *    as the header pinning in `LessonChat`.)
 *
 * 2. **Trigger off DOM mutations, not a React prop.** A `scrollTrigger` string
 *    derived from render state fires on a different schedule than the layout it
 *    describes; a `MutationObserver` on the log fires for exactly the thing that
 *    matters — content was added or text grew.
 *
 * 3. **Don't try to name the one scrollport — act on all candidates.** Whether
 *    `<main>` or the document scrolls depends on the whole flex chain, and
 *    getting it wrong makes `scrollTop` a silent no-op — which looks exactly
 *    like the feature not being wired up at all. Writing to every scrollable
 *    ancestor is harmless and can't pick wrong.
 */

/** Tolerance for "at the bottom", in px. Small so a deliberate scroll up unsticks. */
export const BOTTOM_EPSILON = 16;

/**
 * Distance from the bottom of whichever scroller `el` is, in px.
 * Pass the document scroller (or null) to measure the window.
 */
export function distanceFromBottom(el) {
  const de = document.documentElement;
  const isDoc = !el || el === document || el === de || el === document.body;
  if (isDoc) return de.scrollHeight - window.scrollY - window.innerHeight;
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** Is the given scroller within `epsilon` px of its bottom? */
export function isAtBottom(el, epsilon = BOTTOM_EPSILON) {
  return distanceFromBottom(el) <= epsilon;
}

/** Does this element actually overflow — i.e. is it really scrolling? */
export function isOverflowing(el) {
  if (!el) return false;
  return el.scrollHeight > el.clientHeight + 1;
}

/**
 * Is the reader at the bottom, considering every candidate scroller?
 *
 * Only scrollers that actually overflow carry information: a candidate whose
 * content fits reports distance 0, which would read as "at bottom" and make the
 * check useless. So we judge by the overflowing ones (all must be at their
 * bottom), and fall back to the document when nothing else overflows.
 *
 * @param {Element[]} scrollers  candidates from `collectScrollers`
 */
export function computeAtBottom(scrollers = [], epsilon = BOTTOM_EPSILON, target = null) {
  if (target) {
    return scrollers.every(el => Math.abs(targetScrollTop(el, target) - el.scrollTop) <= epsilon)
      && Math.abs(targetScrollTop(null, target) - window.scrollY) <= epsilon;
  }
  const live = scrollers.filter(isOverflowing);
  const docScrolls = document.documentElement.scrollHeight > window.innerHeight + 1;
  if (live.length === 0) return docScrolls ? isAtBottom(null, epsilon) : true;
  const elementsAtBottom = live.every(el => isAtBottom(el, epsilon));
  return docScrolls ? elementsAtBottom && isAtBottom(null, epsilon) : elementsAtBottom;
}

/**
 * Every ancestor of `node` that can scroll vertically. The document is handled
 * separately by the callers, since it's measured through `window`.
 *
 * The learner shell uses document scrolling so its sticky header stays in the
 * same scroll context. Embedded authoring views may have an element scrollport,
 * and future layout changes can move that boundary. Setting `scrollTop` on an element that isn't
 * scrolling is a silent no-op, so acting on every candidate is both harmless and
 * immune to that ambiguity.
 */
export function collectScrollers(node) {
  const out = [];
  for (let el = node?.parentElement || null; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') out.push(el);
  }
  return out;
}

/**
 * Pin the log to the bottom by driving every candidate scroller to its limit.
 *
 * Two things this must get right:
 *   - **Not `scrollIntoView`.** In a lesson the compose bar lives *inside* the
 *     scroll container, after the chat log, so aligning a sentinel to the
 *     scrollport's bottom edge leaves the compose block below the fold and stops
 *     short of the true bottom.
 *   - **Over-large value, not a computed target.** Browsers clamp, so
 *     `scrollHeight` always lands exactly on the maximum without us having to
 *     know the compose height or the scrollport size.
 *
 * @param {Element[]} scrollers  candidates from `collectScrollers`
 */
function targetScrollTop(el, target) {
  const top = el ? el.scrollTop : window.scrollY;
  const height = el ? el.clientHeight : window.innerHeight;
  const edge = el ? el.getBoundingClientRect().top + (el.clientTop || 0) + height : height;
  const max = Math.max(0, (el ? el.scrollHeight : document.documentElement.scrollHeight) - height);
  return Math.max(0, Math.min(max, top + target.getBoundingClientRect().bottom - edge + 16));
}

export function scrollToBottom(scrollers = [], target = null) {
  // Embedded authoring has a preview after the composer. Align its explicit
  // composer endpoint; learner chat keeps the full-scrollport behavior below.
  if (target) {
    for (const el of scrollers) el.scrollTop = targetScrollTop(el, target);
    window.scrollTo({ top: targetScrollTop(null, target), behavior: 'auto' });
    return;
  }
  for (const el of scrollers) el.scrollTop = el.scrollHeight;
  // The document may be the real scrollport (see `collectScrollers`); scrolling
  // it when it isn't is a no-op.
  const de = document.documentElement;
  window.scrollTo({ top: de.scrollHeight, behavior: 'auto' });
}

/** Marker on the learner's own messages (see `UserMessage`). */
const USER_MESSAGE_SELECTOR = '[data-chat-message="user"]';

/**
 * Did this mutation add one of the learner's own messages?
 *
 * Checks the added node itself *and* its descendants: in a lesson the user
 * message is wrapped in a `<div>` alongside any attached images/links, so the
 * marked element arrives nested rather than as the added node.
 *
 * @param {MutationRecord} record
 */
export function containsNewUserMessage(record) {
  if (record.type !== 'childList') return false;
  return Array.from(record.addedNodes).some((node) => {
    if (node.nodeType !== 1) return false;  // text nodes can't carry the marker
    return (
      node.matches?.(USER_MESSAGE_SELECTOR) ||
      !!node.querySelector?.(USER_MESSAGE_SELECTOR)
    );
  });
}

/**
 * @param {React.RefObject} logRef  the chat log element (content container)
 */
export function useStickToBottom(logRef, scrollTargetRef, { scrollOnMount = true } = {}) {
  // Learner chat starts at its latest message. Authoring can retain its page
  // heading and tabs until the author explicitly submits a new message.
  const atBottomRef = useRef(scrollOnMount);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;

    // Re-collected rather than cached: the compose bar swaps between inline and
    // fixed as the reader scrolls, which can change what overflows.
    const scrollers = () => collectScrollers(log);
    const readScrollPositions = () => new Map([
      [window, window.scrollY], ...scrollers().map(element => [element, element.scrollTop]),
    ]);
    let scrollPositions = readScrollPositions();
    const rememberScrollPositions = () => {
      if (scrollTargetRef?.current) scrollPositions = readScrollPositions();
    };

    // Content is often added across two frames (React commit, then the image or
    // markdown settling its height). One scroll lands on the pre-layout bottom,
    // so re-assert on the next frame once heights are final.
    let raf = null;
    let wasVisible = !!log.getClientRects().length;
    const updateVisibility = () => {
      const visible = !!log.getClientRects().length;
      const appeared = visible && !wasVisible;
      wasVisible = visible;
      if (appeared) {
        // Returning to an authoring tab is navigation, not a request to jump
        // to the composer. Recompute before any observer can reuse the old pin.
        atBottomRef.current = computeAtBottom(scrollers(), BOTTOM_EPSILON, scrollTargetRef?.current);
        rememberScrollPositions();
      }
      return { visible, appeared };
    };
    const pinToBottom = () => {
      const { visible, appeared } = updateVisibility();
      if (!visible || appeared) return;
      scrollToBottom(scrollers(), scrollTargetRef?.current);
      rememberScrollPositions();
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        const { visible, appeared } = updateVisibility();
        if (visible && !appeared && atBottomRef.current) {
          scrollToBottom(scrollers(), scrollTargetRef?.current);
          rememberScrollPositions();
        }
      });
    };

    // --- track position ---------------------------------------------------
    // Capture phase: catches scroll from any element, since scroll doesn't bubble.
    const handleScroll = (e) => {
      if (!updateVisibility().visible) return;
      const target = e.target;
      const isDocTarget = target === document || target === window;
      // Ignore scrollers unrelated to the log (a dropdown, the markdown preview
      // pane) — they say nothing about the reader's position in the chat.
      if (!isDocTarget && target?.nodeType === 1 && !target.contains(log)) return;
      if (scrollTargetRef?.current) {
        // WebKit can emit scroll after the composer endpoint moves without
        // changing any scroll offset. Layout growth is not the reader leaving
        // the latest turn; only an actual position change can stop following.
        const nextPositions = readScrollPositions();
        const moved = [...nextPositions].some(([element, top]) => (scrollPositions.get(element) ?? 0) !== top);
        scrollPositions = nextPositions;
        if (!moved) return;
      }
      atBottomRef.current = computeAtBottom(scrollers(), BOTTOM_EPSILON, scrollTargetRef?.current);
    };
    const scrollListenerOptions = { capture: true, passive: true };
    window.addEventListener('scroll', handleScroll, scrollListenerOptions);

    // --- re-pin when content is added -------------------------------------
    const observer = new MutationObserver((records) => {
      const { visible, appeared } = updateVisibility();
      if (!visible) return;
      // Sending a message is an explicit "take me to the latest" — jump to the
      // bottom and resume following, even if the reader had scrolled up to
      // reference an earlier message while composing.
      if (records.some(containsNewUserMessage)) {
        atBottomRef.current = true;
        pinToBottom();
        return;
      }
      if (!appeared && atBottomRef.current) pinToBottom();
    });
    observer.observe(log, {
      childList: true,      // new messages
      subtree: true,        // …anywhere in the log
      characterData: true,  // streamed text growing inside an existing node
    });

    // Images and late-loading content change height without mutating the DOM.
    const resizeObserver = new ResizeObserver(() => {
      const { visible, appeared } = updateVisibility();
      if (!visible || appeared) return;
      if (atBottomRef.current) pinToBottom();
    });
    resizeObserver.observe(log);
    if (scrollTargetRef?.current?.parentElement) resizeObserver.observe(scrollTargetRef.current.parentElement);

    if (scrollOnMount) pinToBottom();

    return () => {
      window.removeEventListener('scroll', handleScroll, scrollListenerOptions);
      observer.disconnect();
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [logRef, scrollTargetRef, scrollOnMount]);
}
