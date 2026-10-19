import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useDialogViewport } from '../lib/useDialogViewport';
import { useDesktop } from '../lib/useDesktop';
import { useSheetScrollLock } from '../lib/useSheetScrollLock';
import { X, Image, Layers, Film, CirclePlay } from 'lucide-react';
import type { PostFormat, PostStatus } from '../types';
export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={`button ${className}`} {...props}/>; }
export function Avatar({ name, color = '#5753c9' }: {
    name: string;
    color?: string;
}) { return <span className="avatar" style={{ background: color }} aria-hidden="true">{name.split(' ').slice(0, 2).map(n => n[0]).join('')}</span>; }
export function StatusBadge({ status }: {
    status: PostStatus;
}) { return <span className={`status status-${status.replace(' ', '-')}`}><span aria-hidden="true">●</span> {status}</span>; }
export function FormatBadge({ format }: {
    format: PostFormat;
}) { const Icon = { Post: Image, Carrusel: Layers, Reel: Film, Historia: CirclePlay }[format]; return <span className="format"><Icon size={12}/>{format}</span>; }
export function Modal({ title, onClose, children, side = false, initialFocus, className, adaptive = false }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    side?: boolean;
    initialFocus?: string;
    className?: string;
    adaptive?: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const desktop = useDesktop();
    useDialogViewport(ref, adaptive);
    useSheetScrollLock(adaptive && !desktop);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        const dialog = ref.current;
        dialog?.showModal();
        if (initialFocus) dialog?.querySelector<HTMLElement>(initialFocus)?.focus();
        return () => {
            dialog?.close();
            if (previous?.isConnected) previous.focus();
            else document.querySelector<HTMLElement>('.view-switch [aria-pressed="true"]')?.focus();
        };
    }, [initialFocus]);
    return <dialog ref={ref} role="dialog" aria-modal="true"
        className={[side ? 'side-panel' : '', className].filter(Boolean).join(' ') || undefined}
        aria-labelledby={titleId}
        onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }}
        onClick={e => {
            if (e.target !== e.currentTarget) return;
            const box = e.currentTarget.getBoundingClientRect();
            if (e.clientX < box.left || e.clientX > box.right
                || e.clientY < box.top || e.clientY > box.bottom) onClose();
        }}
        onKeyDown={e => {
            if (e.key !== 'Tab' || e.target instanceof Element
                && e.target.closest('dialog') !== ref.current) return;
            const items = Array.from(ref.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
            )).filter(el => el.getClientRects().length && el.closest('dialog') === ref.current);
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }}>
        <div className="modal-head"><h2 id={titleId}>{title}</h2>
            <Button aria-label="Cerrar" onClick={onClose}><X size={18}/></Button>
        </div><div className="modal-body">{children}</div>
    </dialog>;
}
