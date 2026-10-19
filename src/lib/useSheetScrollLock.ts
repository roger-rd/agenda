import { useEffect } from 'react';

let locks = 0;
let restore: (() => void) | undefined;
/** Los diálogos anidados comparten bloqueo, incluso si se desmontan juntos. */
export function useSheetScrollLock(open: boolean) {
  useEffect(() => {
    if (!open) return;
    if (locks++ === 0) {
      const main = document.querySelector<HTMLElement>('.main-content');
      const previous = document.body.style.overflow;
      const mainOverflow = main?.style.overflow;
      document.body.style.overflow = 'hidden';
      if (main) main.style.overflow = 'hidden';
      restore = () => {
        document.body.style.overflow = previous;
        if (main) main.style.overflow = mainOverflow ?? '';
      };
    }
    return () => {
      if (--locks === 0) { restore?.(); restore = undefined; }
    };
  }, [open]);
}
