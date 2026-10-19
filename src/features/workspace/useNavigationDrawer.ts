import { useLayoutEffect, useRef, useState } from 'react';
import { resolveDrawerOpen } from '../../lib/responsive';

import { isDesktop, useDesktop } from '../../lib/useDesktop';

function restoreNavigationFocus() {
  // A new drawer or native dialog owns focus if another action opened one.
  if (document.querySelector('.drawer-open, dialog[open]')) return;
  const trigger = document.querySelector<HTMLElement>('.menu-trigger');
  const target = trigger?.getClientRects().length ? trigger
    : document.querySelector<HTMLElement>('main[tabindex="-1"]');
  target?.focus({ preventScroll: true });
}

// Only navigation responds to the media query; pages, URL and store stay mounted.
export function useNavigationDrawer() {
  const desktop = useDesktop();
  const [requestedOpen, setRequestedOpen] = useState(false);
  const drawer = useRef<HTMLElement>(null);
  const background = useRef<HTMLDivElement>(null);
  const open = resolveDrawerOpen(requestedOpen, desktop);

  // Reconcile during render so desktop never commits modal attributes, and
  // returning to mobile cannot resurrect a previous request to open the menu.
  if (requestedOpen && desktop) setRequestedOpen(false);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = drawer.current;
    const content = background.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Wait until the panel is visible. Move focus out of the trigger before
    // making its parent inert/aria-hidden; otherwise browsers may focus BODY.
    const frame = requestAnimationFrame(() => {
      const first = panel?.querySelector<HTMLElement>('.drawer-close') ?? panel;
      first?.focus({ preventScroll: true });
      if (content) {
        content.inert = true;
        content.setAttribute('aria-hidden', 'true');
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      if (content) {
        content.inert = false;
        content.removeAttribute('aria-hidden');
      }
      // Runs after navigation or the role/logout remount has committed.
      requestAnimationFrame(restoreNavigationFocus);
    };
  }, [open]);

  function close() {
    setRequestedOpen(false);
  }

  function show() {
    // Check the current query too, including clicks before a queued render.
    setRequestedOpen(resolveDrawerOpen(true, isDesktop()));
  }

  return { open, show, close, drawer, background };
}
