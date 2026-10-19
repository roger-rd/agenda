import { useEffect, useId, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { Modal, Button, StatusBadge } from '../../components/ui';
import { actions, useStore } from '../../store';
import { can } from '../../store/permissions';
import { statuses } from '../../store/transitions';
import { DESKTOP_QUERY } from '../../lib/responsive';
import { useDesktop } from '../../lib/useDesktop';
import { useSheetScrollLock } from '../../lib/useSheetScrollLock';
import { preferredScrollBehavior } from '../../lib/scroll';
import { statusPresentation, statusAnnouncement } from './boardPresentation';
import type { PostStatus } from '../../types';
import type { Post } from '../../types';

export function StatusControl({ post, board = false, onAnnounce }: {
  post: Post; board?: boolean; onAnnounce?: (message: string) => void;
}) {
  const desktop = useDesktop();
  const sheet = statusPresentation(desktop ? 'desktop' : 'mobile') === 'sheet';
  const [openedMode, setOpenedMode] = useState(sheet);
  const state = useStore();
  const [error, setError] = useState('');
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const allowed = can(state.role, 'changeStatus');
  const open = position !== null && allowed && openedMode === sheet;
  if (position && openedMode !== sheet) setPosition(null);
  useSheetScrollLock(open && sheet);
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    function closeOnModeChange() {
      if (trigger.current?.getAttribute('aria-expanded') !== 'true') return;
      setPosition(null);
      trigger.current.focus({ preventScroll: true });
    }
    media.addEventListener('change', closeOnModeChange);
    return () => media.removeEventListener('change', closeOnModeChange);
  }, []);
  function close(restoreFocus = true) {
    setPosition(null);
    if (restoreFocus) trigger.current?.focus();
  }
  function show() {
    setOpenedMode(sheet);
    setPortalTarget(trigger.current!.closest('dialog') ?? document.body);
    const rect = trigger.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 196)), top: rect.bottom + 180 > window.innerHeight ? Math.max(8, rect.top - 180) : rect.bottom + 4 });
  }
  useEffect(() => {
    if (!open || sheet) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    function outside(event: PointerEvent) {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    }
    function reposition() { setPosition(null); trigger.current?.focus(); }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    // Close on ancestor scroll so the menu never drifts away from its trigger.
    function scroll(event: Event) { if (!menu.current?.contains(event.target as Node)) reposition(); }
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open, sheet]);
  function choose(status: PostStatus) {
    const scope = trigger.current?.closest('dialog') ?? document;
    let changed = false;
    flushSync(() => {
      close(false);
      const result = actions.changeStatus(post.id, status);
      if (!result.ok) setError(result.reason);
      else if (status !== post.status) {
        changed = true;
        onAnnounce?.(statusAnnouncement(post.title, status));
      }
    });
    // El store puede desmontar esta tarjeta y montarla en otra columna.
    const control = Array.from(scope.querySelectorAll<HTMLButtonElement>('[data-status-post]'))
      .find(el => el.dataset.statusPost === post.id);
    control?.focus({ preventScroll: true });
    if (control && changed) {
      const target = board ? control.closest<HTMLElement>('.board-card') : control;
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: preferredScrollBehavior() });
    }
    // Con filtro de estado la tarjeta puede desaparecer: conservar los filtros.
    if (!control) document.querySelector<HTMLElement>(desktop ? '.filters select' : '.compact-filter-trigger button')?.focus();
  }
  if (!allowed) return <StatusBadge status={post.status} />;
  return <>
    <button data-status-post={post.id} ref={trigger} type="button" className="status-trigger" aria-label={`Cambiar estado de ${post.title}: ${post.status}`} aria-haspopup={sheet ? 'dialog' : 'menu'} aria-expanded={open} aria-controls={open && !sheet ? id : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
      }}><StatusBadge status={post.status} /><ChevronDown size={12} /></button>
    {error && <span role="alert">{error}</span>}
    {open && sheet && <Modal title={`Cambiar estado · ${post.title}`} className="filters-sheet status-sheet"
      initialFocus='[aria-checked="true"]' onClose={() => close()}>
      <div role="radiogroup" aria-label="Estado de la publicación" className="sheet-controls"
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = statuses.indexOf(post.status);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? statuses.length - 1
            : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + statuses.length) % statuses.length;
          choose(statuses[next]);
        }}>
        {statuses.map(status => <button type="button" role="radio" aria-checked={post.status === status}
          key={status} onClick={() => choose(status)}>
          <StatusBadge status={status} />{post.status === status && <span>✓ Actual</span>}
        </button>)}
      </div>
      <Button onClick={() => close()}>Cancelar</Button>
      {error && <p role="alert">{error}</p>}
    </Modal>}
    {open && !sheet && portalTarget && createPortal(<div ref={menu} id={id} role="menu" aria-label={`Estado de ${post.title}`} className="status-menu" style={position}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}
      onKeyDown={event => {
        const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === 'Tab') { event.preventDefault(); close(); }
      }}>
      {statuses.map(status => <button type="button" role="menuitemradio" aria-checked={post.status === status} tabIndex={-1} key={status}
        onClick={() => {
          choose(status);
        }}><StatusBadge status={status} /></button>)}
    </div>, portalTarget)}
  </>;
}
