/** Un overlay activo conserva el foco; la recuperación precede al retorno al disparador. */
export function recoveryFocusTarget({ pending, noticeVisible, overlayOpen }: {
  pending: boolean; noticeVisible: boolean; overlayOpen: boolean;
}): 'notice' | 'main' | null {
  if (!pending || overlayOpen) return null;
  return noticeVisible ? 'notice' : 'main';
}
/** Devuelve true también al posponer, para impedir restauraciones competidoras. */
export function restorePendingWorkspaceFocus() {
  const main = document.querySelector<HTMLElement>('main[data-recovery-focus]');
  if (!main) {
    // Una limpieza tardía del árbol anterior no desplaza el foco ya entregado.
    const completed = document.querySelector<HTMLElement>('main[data-recovery-complete]');
    return !!completed && (document.activeElement === completed ||
      document.activeElement === completed.querySelector('[data-recovery-notice]'));
  }
  const notice = main.querySelector<HTMLElement>('[data-recovery-notice]');
  const destination = recoveryFocusTarget({ pending: true, noticeVisible: !!notice,
    overlayOpen: !!document.querySelector('.drawer-open, dialog[open]') });
  if (!destination) return true;
  const target = destination === 'notice' ? notice! : main;
  target.focus({ preventScroll: true });
  if (notice) notice.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  delete main.dataset.recoveryFocus;
  main.dataset.recoveryComplete = '';
  return true;
}
