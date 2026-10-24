import { useState, useSyncExternalStore } from 'react';
import { Invitations } from './Invitations';
import { Button, Modal } from '../../components/ui';
import { actions, useStore } from '../../store';
import { teamNotices } from './teamNotices';
import { companyAccess } from '../../store/teamAccess';
import { can } from '../../store/permissions';
import { accessDraft, accessLabel, draftValidity, recoverAccessDraft, retainedContent, retentionText } from './teamPresentation';

function ManageCompanies({ userId, onClose, onSaved }: { userId: string; onClose: () => void; onSaved: (text: string) => void }) {
  const s = useStore(), user = s.users.find(u => u.id === userId);
  const [draft, setDraft] = useState(() => accessDraft(s, userId));
  const [confirmRevision, setConfirmRevision] = useState<number | null>(null);
  const validity = draftValidity(s, userId, draft);
  const removed = companyAccess(s, userId).filter(id => !draft.selected.includes(id));
  const rows = retainedContent(s, userId, removed);
  function save() {
    // La confirmación caduca si otra pestaña cambia el documento.
    if (removed.length && confirmRevision !== s.revision) { setConfirmRevision(s.revision); return; }
    const result = actions.setCompanyAccess(userId, draft.selected, s.revision);
    if (result.ok) { onSaved(removed.length ? retentionText(rows, true) : 'Accesos actualizados.'); onClose(); }
    else { setConfirmRevision(null); setDraft(recoverAccessDraft(draft, result, actions.refresh)); }
  }
  return <Modal adaptive className="filters-sheet team-dialog" title={`Gestionar empresas · ${user?.name ?? 'Persona no disponible'}`} onClose={onClose}>
    {draft.message && <p role="alert">{draft.message} Revisa la selección antes de reintentar.</p>}
    {!draft.ready && <Button onClick={() => setDraft({ ...draft, ready: actions.refresh() })}>Actualizar datos para reintentar</Button>}
    {validity.changed && <p role="status">Los datos cambiaron. Se conserva tu selección; revisa los accesos antes de guardar.</p>}
    {!validity.valid && <p role="alert">La persona o alguna empresa seleccionada ya no está disponible. Cancela y vuelve a abrir la gestión.</p>}
    <fieldset><legend>Empresas asignadas</legend>{s.companies.filter(c => c.organizationId === s.organization.id).map(c => <label className="team-check" key={c.id}>
      <input type="checkbox" checked={draft.selected.includes(c.id)} disabled={!user || user.role === 'community_manager'} onChange={e => {
        setConfirmRevision(null); setDraft({ ...draft, selected: e.target.checked ? [...draft.selected, c.id] : draft.selected.filter(id => id !== c.id) });
      }} />{c.name}</label>)}</fieldset>
    <p>Retirar todas las empresas conserva a la persona en la organización.</p>
    <div className="modal-actions"><Button onClick={onClose}>Cancelar</Button><Button className="primary" disabled={!validity.valid || !draft.ready} onClick={save}>{draft.message ? 'Reintentar' : 'Guardar'}</Button></div>
    {confirmRevision !== null && <Modal adaptive className="filters-sheet confirmation-sheet team-dialog" title="Confirmar retirada de acceso" initialFocus=".cancel-team" onClose={() => setConfirmRevision(null)}>
      <p>Se retirará el acceso a estas empresas. La persona seguirá en la organización; no se eliminarán publicaciones ni comentarios.</p>
      <p className="team-summary">{retentionText(rows)}</p>
      {confirmRevision !== s.revision && <p role="alert">Los datos cambiaron. Revisa de nuevo el resumen antes de confirmar.</p>}
      <div className="modal-actions"><Button className="cancel-team" onClick={() => setConfirmRevision(null)}>Cancelar</Button><Button className="primary destructive" disabled={!validity.valid} onClick={save}>Confirmar y guardar</Button></div>
    </Modal>}
  </Modal>;
}
export function Team() {
  const s = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const notices = useSyncExternalStore(teamNotices.subscribe, teamNotices.getSnapshot).filter(n => n.organizationId === s.organization.id);
  if (!can(s.role, 'viewTeam')) return null;
  return <section className="team-page"><div className="page-heading"><div><span className="eyebrow">ORGANIZACIÓN</span><h1>Equipo</h1><p>Personas y acceso a las empresas de {s.organization.name}.</p></div></div>
    {notices.map(notice => <div className="notice" role="status" key={notice.id}><p className="team-summary">{notice.text}</p><Button onClick={() => teamNotices.dismiss(notice.id)}>Entendido</Button></div>)}
    {([['community_manager', 'Community manager'], ['worker', 'Trabajadores'], ['client', 'Clientes']] as const).map(([role, title]) => <section key={role} aria-label={title}>
      <h2>{title}</h2><ul className="team-list">{s.users.filter(u => u.role === role).map(u => <li className="team-row" key={u.id}>
        <div><strong>{u.name}</strong>{u.email && <p>{u.email}</p>}{u.example && <span className="team-chip">Datos de ejemplo</span>}
          {actions.memberSuspended(u.id) && <p className="team-chip">Acceso suspendido por la plataforma</p>}</div>
        <div className="team-companies">{accessLabel(s, u.id) || s.companies.filter(c => c.organizationId === s.organization.id && companyAccess(s, u.id).includes(c.id)).map(c => <span className="team-chip" key={c.id}>{c.name}</span>)}</div>
        {u.role !== 'community_manager' && <Button aria-label={`Gestionar empresas de ${u.name}`} onClick={() => setEditing(u.id)}>Gestionar empresas</Button>}
      </li>)}</ul></section>)}
    <Invitations />
    {editing && <ManageCompanies userId={editing} onClose={() => setEditing(null)} onSaved={text => teamNotices.add(s.organization.id, text)} />}
  </section>;
}
