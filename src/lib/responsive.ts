// Keep in sync with styles.css: mobile <640, tablet 640–1023, desktop >=1024.
export const BREAKPOINTS = { tablet: 640, desktop: 1024 } as const;
export const DESKTOP_QUERY = `(min-width: ${BREAKPOINTS.desktop}px)`;

export function viewportMode(width: number) {
  return width >= BREAKPOINTS.desktop ? 'desktop'
    : width >= BREAKPOINTS.tablet ? 'tablet' : 'mobile';
}

// null means the browser can move focus normally.
export function trappedFocusIndex(index: number, count: number, backwards: boolean) {
  if (!count) return null;
  if (index < 0) return backwards ? count - 1 : 0;
  if (backwards && index === 0) return count - 1;
  if (!backwards && index === count - 1) return 0;
  return null;
}

// A pending mobile open request must never make the desktop sidebar modal.
export function resolveDrawerOpen(requestedOpen: boolean, desktop: boolean) {
  return requestedOpen && !desktop;
}
