/** Reserva el inicio del contenido; si no cabe, prioriza el encabezado. */
export function needsAgendaScroll(rect: { top: number; bottom: number }, height: number, top = 0, contentHeight = 0) {
  return rect.top < top || rect.bottom + Math.min(96, contentHeight) > top + height;
}
export const scrollBehavior = (reducedMotion: boolean): ScrollBehavior => reducedMotion ? 'auto' : 'smooth';
export const preferredScrollBehavior = (matchMedia = window.matchMedia.bind(window)) =>
  scrollBehavior(matchMedia('(prefers-reduced-motion: reduce)').matches);
export function scrollIntoViewIfNeeded(header: HTMLElement | null) {
  if (!header) return;
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const bar = document.querySelector<HTMLElement>('.mobile-topbar')?.getBoundingClientRect();
  const visibleTop = Math.max(top, bar?.bottom ?? top);
  const bottom = top + (viewport?.height ?? window.innerHeight);
  const content = header.parentElement?.querySelector<HTMLElement>('.agenda-cards > *, .agenda-empty');
  const rect = header.getBoundingClientRect();
  const contentRect = content?.getBoundingClientRect();
  const initialContent = contentRect ? Math.max(0, contentRect.bottom - rect.bottom) : 0;
  if (needsAgendaScroll(rect, bottom - visibleTop, visibleTop, initialContent)) {
    header.style.scrollMarginTop = `${visibleTop + 12}px`;
    header.scrollIntoView({ block: 'start', behavior: preferredScrollBehavior() });
  }
}
