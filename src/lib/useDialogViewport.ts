import { useEffect, type RefObject } from 'react';
import { dialogViewport } from './dialogViewport';
import { DESKTOP_QUERY } from './responsive';
import { preferredScrollBehavior } from './scroll';

/** No remonta el contenido ni enfoca campos al rotar o abrir el teclado. */
export function useDialogViewport(ref: RefObject<HTMLDialogElement | null>, enabled: boolean) {
  useEffect(() => {
    const dialog = ref.current;
    if (!enabled || !dialog) return;
    const media = window.matchMedia(DESKTOP_QUERY);
    const viewport = window.visualViewport;
    let frame = 0;
    let focused: HTMLElement | null = null;
    function reveal() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (media.matches || !focused || document.activeElement !== focused) return;
        // La etiqueta contiene también el error accesible del campo.
        (focused.closest('label') ?? focused).scrollIntoView({ block: 'nearest', behavior: preferredScrollBehavior() });
      });
    }
    const footer = dialog.querySelector<HTMLElement>(':scope > .modal-body > form > .modal-actions, :scope > .modal-body > .detail-actions');
    function measureFooter() {
      dialog!.style.setProperty('--footer-space', `${(footer?.getBoundingClientRect().height ?? 0) + 24}px`);
    }
    const observer = new ResizeObserver(measureFooter);
    if (footer) observer.observe(footer);
    function update() {
      const metrics = dialogViewport(window.innerHeight, viewport ?? undefined);
      dialog!.style.setProperty('--dialog-height', `${metrics.height}px`);
      dialog!.style.setProperty('--dialog-top', `${metrics.offsetTop}px`);
      dialog!.style.setProperty('--keyboard-inset', `${metrics.keyboardInset}px`);
      dialog!.classList.toggle('compact-footer', !media.matches && metrics.staticFooter);
      measureFooter();
      if (focused) reveal();
    }
    function focus(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('dialog') !== dialog || !target.matches('input, textarea, select')) return;
      focused = target;
      reveal();
    }
    update();
    dialog.addEventListener('focusin', focus);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dialog.removeEventListener('focusin', focus);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [enabled, ref]);
}
