import { useEffect, useId, useRef, useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { actions, useStore } from '../../store';
import { canManageTeam, invitationStatus, type InvitationInput } from '../../store/invitations';
import type { Invitation } from '../../types';
import { zonedFormat } from '../../lib/dates';
import { recoverAccessDraft } from './teamPresentation';
import { invitationActions, invitationCompanies, invitationErrors, invitationLabels, invitationLink, invitationList, type InvitationFilter } from './invitationsPresentation';

function CopyText({ label, text }: { label: string; text: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState('');
  async function copy() {
    setMessage('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Portapapeles no disponible');
      await navigator.clipboard.writeText(text); setMessage('Copiado'); return;
    } catch { /* Selección nativa como respaldo, dentro del diálogo activo. */ }
    const previous = document.activeElement as HTMLElement | null;
    try {
      ref.current?.focus(); ref.current?.select();
      if (!document.execCommand('copy')) throw new Error('Copia no disponible');
      previous?.focus(); setMessage('Copiado');
    } catch {
      ref.current?.focus(); ref.current?.select();
      setMessage('No se pudo copiar. Selecciona el texto y cópialo manualmente.');
    }
  }
  return <div className="invitation-copy"><label>{label}<textarea ref={ref} readOnly value={text} rows={2} onFocus={e => e.target.select()} /></label>
    <Button onClick={copy} aria-label={`Copiar ${label.toLowerCase()}`}>Copiar</Button><span role="status" aria-live="polite">{message}</span></div>;
}
function InvitationResult({ invitation }: { invitation: Invitation }) {
  const s = useStore();
  const current = s.invitations.find(i => i.id === invitation.id);
  if (!current || invitationStatus(current) !== 'pendiente') return <p role="status">Esta invitación ya no está pendiente.</p>;
  return <div><p role="status">Invitación disponible para {invitation.email}.</p>
    <CopyText label="Código" text={invitation.code} /><CopyText label="Enlace" text={invitationLink(window.location.origin, invitation.code)} />
    <a href={`/invitacion/${invitation.code}`} target="_blank" rel="noopener noreferrer">Abrir enlace</a></div>;
}
type Editor = { mode: 'create' } | { mode: 'revoke' | 'renew'; invitation: Invitation };
function InvitationDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const s = useStore(), id = useId();
  const [draft, setDraft] = useState<InvitationInput & { message: string; ready: boolean }>(() => ({
    email: editor.mode === 'create' ? '' : editor.invitation.email,
    role: editor.mode === 'create' ? 'worker' : editor.invitation.role,
    companyIds: editor.mode === 'create' ? [] : editor.invitation.companyIds,
    validityDays: 7, message: '', ready: true,
  }));
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<Invitation | null>(null);
  const errors = invitationErrors(draft);
  function save() {
    setSubmitted(true);
    if (editor.mode !== 'revoke' && Object.values(errors).some(Boolean)) return;
    const response = editor.mode === 'create' ? actions.createInvitation(draft)
      : editor.mode === 'renew' ? actions.renewInvitation(editor.invitation.id, draft.validityDays)
        : actions.revokeInvitation(editor.invitation.id);
    if (!response.ok) { setDraft(recoverAccessDraft(draft, response, actions.refresh)); return; }
    if (editor.mode === 'revoke') { onClose(); return; }
    setResult(response.state.invitations.at(-1)!);
  }
  const error = (field: keyof typeof errors) => submitted && errors[field] ? <p id={`${id}-${field}`} role="alert">{errors[field]}</p> : null;
  return <Modal adaptive className="filters-sheet team-dialog invitation-dialog" title={result ? (editor.mode === 'renew' ? 'Invitación renovada' : 'Invitación creada') : editor.mode === 'create' ? 'Invitar persona' : editor.mode === 'renew' ? 'Renovar invitación' : 'Revocar invitación'} initialFocus=".invitation-initial" onClose={onClose}>
    {result ? <><InvitationResult invitation={result} /><Button autoFocus className="invitation-initial" onClick={onClose}>Cerrar</Button></> : <form noValidate onSubmit={e => { e.preventDefault(); if (draft.ready) save(); }}>
      {draft.message && <p role="alert">{draft.message} Revisa los datos antes de reintentar.</p>}
      {!draft.ready && <Button type="button" onClick={() => setDraft({ ...draft, ready: actions.refresh() })}>Actualizar datos para reintentar</Button>}
      {editor.mode === 'create' ? <>
        <label>Correo del destinatario<input className="invitation-initial" type="email" required maxLength={120} value={draft.email} aria-invalid={submitted && !!errors.email} aria-describedby={`${id}-email`} onChange={e => setDraft({ ...draft, email: e.target.value })} /></label>{error('email')}
        <label>Rol<select value={draft.role} aria-describedby={`${id}-role`} onChange={e => setDraft({ ...draft, role: e.target.value as InvitationInput['role'] })}><option value="worker">Trabajador</option><option value="client">Cliente</option></select></label>{error('role')}
        <fieldset aria-describedby={`${id}-companyIds`}><legend>Empresas</legend>{s.companies.filter(c => c.organizationId === s.organization.id).map(c => <label className="team-check" key={c.id}><input type="checkbox" checked={draft.companyIds.includes(c.id)} onChange={e => setDraft({ ...draft, companyIds: e.target.checked ? [...draft.companyIds, c.id] : draft.companyIds.filter(cid => cid !== c.id) })} />{c.name}</label>)}</fieldset>{error('companyIds')}
      </> : <><p>{editor.invitation.email}</p><p>{editor.mode === 'renew' ? 'El código anterior quedará revocado. Se generará uno nuevo con el mismo rol y empresas.' : 'El código dejará de ser válido. ¿Confirmas la revocación?'}</p></>}
      {editor.mode !== 'revoke' && <><label>Vigencia<select value={draft.validityDays} aria-describedby={`${id}-validityDays`} onChange={e => setDraft({ ...draft, validityDays: Number(e.target.value) as 1 | 7 | 30 })}>{([1, 7, 30] as const).map(days => <option key={days} value={days}>{days} {days === 1 ? 'día' : 'días'}</option>)}</select></label>{error('validityDays')}</>}
      <div className="modal-actions"><Button type="button" className={editor.mode === 'create' ? '' : 'invitation-initial'} onClick={onClose}>Cancelar</Button><Button type="submit" className="primary" disabled={!draft.ready}>{draft.message ? 'Reintentar' : editor.mode === 'create' ? 'Crear invitación' : editor.mode === 'renew' ? 'Confirmar renovación' : 'Confirmar revocación'}</Button></div>
    </form>}
  </Modal>;
}
export function Invitations() {
  const s = useStore();
  const heading = useRef<HTMLHeadingElement>(null);
  const [filter, setFilter] = useState<InvitationFilter>('todas');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [copy, setCopy] = useState<{ invitation: Invitation; field: 'Código' | 'Enlace' } | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, []);
  if (!canManageTeam(s)) return null;
  const { rows, counts } = invitationList(s, filter, now);
  const currentCopy = copy && s.invitations.find(i => i.id === copy.invitation.id);
  const copyAvailable = currentCopy && invitationStatus(currentCopy, now) === 'pendiente';
  function close() {
    setEditor(null); setCopy(null);
    // Si la acción desapareció (p. ej. Revocar), devolver el foco a la sección.
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) heading.current?.focus();
    });
  }
  return <section className="invitations-section" aria-label="Invitaciones">
    <div className="invitation-heading"><h2 ref={heading} tabIndex={-1}>Invitaciones</h2><Button className="primary" onClick={() => setEditor({ mode: 'create' })}>Invitar persona</Button></div>
    <label>Estado de invitación<select value={filter} onChange={e => setFilter(e.target.value as InvitationFilter)}>{(Object.keys(invitationLabels) as InvitationFilter[]).map(value => <option value={value} key={value}>{invitationLabels[value]} ({counts[value]})</option>)}</select></label>
    {!rows.length && <div><p>{counts.todas ? 'No hay invitaciones con este estado' : 'No hay invitaciones en esta organización.'}</p>{filter !== 'todas' && <Button onClick={() => setFilter('todas')}>Limpiar filtro</Button>}</div>}
    <ul className="team-list">{rows.map(i => {
      const status = invitationStatus(i, now), available = invitationActions(status);
      return <li key={i.id} className="invitation-row"><div><strong>{i.email}</strong><p>{i.role === 'worker' ? 'Trabajador' : 'Cliente'}</p><p>{invitationCompanies(s, i).join(', ')}</p>
        <span className={`team-chip invitation-${status}`}>{status}</span>{i.usedAt && <p>Aceptó: {s.users.find(u => u.id === i.usedBy)?.name ?? 'Persona no disponible'}</p>}</div>
        <div><p>Vigencia: {i.validityDays} {i.validityDays === 1 ? 'día' : 'días'}</p><p>Creación: {zonedFormat(i.createdAt, 'dd/MM/yyyy HH:mm')}</p><p>Vencimiento: {zonedFormat(i.expiresAt, 'dd/MM/yyyy HH:mm')}</p><small>America/Santiago</small></div>
        <div className="invitation-actions">{available.copy && <><Button onClick={() => setCopy({ invitation: i, field: 'Código' })}>Copiar código</Button><Button onClick={() => setCopy({ invitation: i, field: 'Enlace' })}>Copiar enlace</Button><a href={`/invitacion/${i.code}`} target="_blank" rel="noopener noreferrer">Abrir enlace</a></>}{available.revoke && <Button onClick={() => setEditor({ mode: 'revoke', invitation: i })}>Revocar</Button>}{available.renew && <Button onClick={() => setEditor({ mode: 'renew', invitation: i })}>Renovar</Button>}</div></li>;
    })}</ul>
    {editor && <InvitationDialog editor={editor} onClose={close} />}
    {copy && <Modal adaptive className="filters-sheet team-dialog invitation-dialog" title={`Copiar ${copy.field.toLowerCase()}`} onClose={close}>
      {copyAvailable ? <CopyText label={copy.field} text={copy.field === 'Código' ? copy.invitation.code : invitationLink(window.location.origin, copy.invitation.code)} /> : <p role="alert">Esta invitación ya no está pendiente.</p>}
      <Button onClick={close}>Cerrar</Button>
    </Modal>}
  </section>;
}
