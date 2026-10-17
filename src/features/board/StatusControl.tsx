import { useEffect, useId, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { StatusBadge } from '../../components/ui';
import { actions, useStore } from '../../store';
import { can } from '../../store/permissions';
import { statuses } from '../../store/transitions';
import type { Post } from '../../types';

export function StatusControl({ post }: { post: Post }) {
  const state = useStore();
  const [error, setError] = useState('');
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const allowed = can(state.role, 'changeStatus');
  const open = position !== null && allowed;
  function close(restoreFocus = true) {
    setPosition(null);
    if (restoreFocus) trigger.current?.focus();
  }
  function show() {
    setPortalTarget(trigger.current!.closest('dialog') ?? document.body);
    const rect = trigger.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 196)), top: rect.bottom + 180 > window.innerHeight ? Math.max(8, rect.top - 180) : rect.bottom + 4 });
  }
  useEffect(() => {
    if (!open) return;
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
  }, [open]);
  if (!allowed) return <StatusBadge status={post.status} />;
  return <>
    <button data-status-post={post.id} ref={trigger} type="button" className="status-trigger" aria-label={`Cambiar estado de ${post.title}: ${post.status}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
      }}><StatusBadge status={post.status} /><ChevronDown size={12} /></button>
    {error && <span role="alert">{error}</span>}
    {open && portalTarget && createPortal(<div ref={menu} id={id} role="menu" aria-label={`Estado de ${post.title}`} className="status-menu" style={position}
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
          const scope = trigger.current?.closest('dialog') ?? document;
          flushSync(() => {
            close(false);
            const result = actions.changeStatus(post.id, status);
            if (!result.ok) setError(result.reason);
          });
          const control = Array.from(scope.querySelectorAll<HTMLButtonElement>('[data-status-post]'))
            .find(el => el.dataset.statusPost === post.id);
          control?.focus();
          control?.scrollIntoView({ block: 'nearest' });
          if (!control) document.querySelector<HTMLElement>('.filters select')?.focus();
        }}><StatusBadge status={status} /></button>)}
    </div>, portalTarget)}
  </>;
}
