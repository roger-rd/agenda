import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
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
export function Modal({ title, onClose, children }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => { const previous = document.activeElement as HTMLElement; const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
    return <dialog ref={ref} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget)
        onClose(); }} aria-labelledby="dialog-title"><div className="modal-head"><h2 id="dialog-title">{title}</h2><Button aria-label="Cerrar" onClick={onClose}><X size={18}/></Button></div><div className="modal-body">{children}</div></dialog>;
}
