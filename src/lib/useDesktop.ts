import { useSyncExternalStore } from 'react';
import { DESKTOP_QUERY } from './responsive';

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
export const isDesktop = () => window.matchMedia(DESKTOP_QUERY).matches;
export function useDesktop() {
  return useSyncExternalStore(subscribe, isDesktop, () => true);
}
