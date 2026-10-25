import { useRef, useState } from 'react';
import { Avatar, Button, Modal } from '../../components/ui';
import { actions, getState, useStore } from '../../store';
import { buildSubmission, draftIsCurrent, editDraft, EMAIL_NOTICE, fieldErrors, isRetry, needsDiscardConfirmation, profileCard, profileDraft, recoverDraft, recoveryMessages, submissionHasChanges, submitState } from './profilePresentation';

function ProfileDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const s = useStore();
  const [draft, setDraft] = useState(() => profileDraft(s));
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const errors = fieldErrors(s, draft), submit = submitState(s, draft);
  function close() { if (needsDiscardConfirmation(draft)) setConfirm(true); else onClose(); }
  function save() {
    const live = getState();
    if (!draftIsCurrent(live, draft)) { onClose(); return; }
    setDraft({ ...draft, attempted: true });
    const currentErrors = fieldErrors(live, draft);
    const first = currentErrors.name ? 'name' : currentErrors.email ? 'email' : undefined;
    if (first) { form.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus(); return; }
    if (submitState(live, draft).disabled) return;
    if (!submissionHasChanges(draft)) { onClose(); return; }
    const before = live.users.find(u => u.id === draft.personId);
    const result = actions.updateProfile(buildSubmission(draft));
    if (result.ok) {
      const after = result.state.users.find(u => u.id === draft.personId);
      if (before?.name !== after?.name || before?.email !== after?.email) onSaved();
      onClose();
    } else {
      const ready = result.code === 'conflict' || result.code === 'storage_unavailable' ? actions.refresh() : true;
      setDraft(recoverDraft(draft, result, getState(), ready));
      if ((result.field === 'name' || result.field === 'email') && result.code !== 'conflict')
        form.current?.querySelector<HTMLInputElement>(`[name="${result.field}"]`)?.focus();
    }
  }
  // App y Profile se desmontan por identidad; esta guarda impide mostrar un borrador ajeno.
  if (!draftIsCurrent(s, draft)) return null;
  return <Modal adaptive className="filters-sheet team-dialog settings-dialog profile-dialog" title="Editar perfil" initialFocus="#profile-name" onClose={close}>
    <form ref={form} noValidate onSubmit={e => { e.preventDefault(); save(); }}>
      <label htmlFor="profile-name">Nombre</label>
      <input id="profile-name" name="name" autoComplete="name" value={draft.values.name} aria-invalid={draft.attempted && !!errors.name} aria-describedby={`profile-name-help${draft.attempted && errors.name ? ' profile-name-error' : ''}`} onChange={e => setDraft(editDraft(draft, 'name', e.target.value))} />
      <p id="profile-name-help">Entre 2 y 80 caracteres. Se limpian los espacios sobrantes.</p>
      {draft.attempted && errors.name && <p id="profile-name-error" role="alert">{errors.name}</p>}
      <label htmlFor="profile-email">Correo electrónico</label>
      <input id="profile-email" name="email" type="email" autoComplete="email" value={draft.values.email} aria-invalid={draft.attempted && !!errors.email} aria-describedby={`profile-email-help${draft.attempted && errors.email ? ' profile-email-error' : ''}`} onChange={e => setDraft(editDraft(draft, 'email', e.target.value))} />
      <p id="profile-email-help">Opcional, hasta 120 caracteres. Se eliminan los espacios exteriores y se convierte a minúsculas. Déjalo vacío para quedar sin correo.</p>
      {draft.attempted && errors.email && <p id="profile-email-error" role="alert">{errors.email}</p>}
      <p className="notice">{EMAIL_NOTICE}</p>
      {draft.failure && <p role="alert">{draft.failure.reason}</p>}
      {recoveryMessages(draft).map(message => <p role="status" key={message}>{message}</p>)}
      {isRetry(draft) && !draft.ready && <Button type="button" onClick={() => {
        const ready = actions.refresh(); setDraft(recoverDraft(draft, draft.failure!, getState(), ready));
      }}>Actualizar datos</Button>}
      <div className="modal-actions"><Button type="button" onClick={close}>Cerrar</Button><Button className="primary" type="submit" disabled={submit.disabled}>{submit.label}</Button></div>
    </form>
    {confirm && <Modal adaptive className="filters-sheet confirmation-sheet team-dialog" title="Descartar cambios sin guardar" initialFocus=".keep-profile" onClose={() => setConfirm(false)}>
      <p>Hay cambios sin guardar. ¿Quieres descartarlos?</p><div className="modal-actions"><Button className="keep-profile" onClick={() => setConfirm(false)}>Seguir editando</Button><Button onClick={onClose}>Descartar cambios</Button></div>
    </Modal>}
  </Modal>;
}
export function Profile() {
  const s = useStore(), person = s.users.find(u => u.id === s.activeUserId);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState(false);
  if (!person) return <p role="alert">La persona ya no está disponible.</p>;
  const card = profileCard(s, person);
  return <section className="settings-page team-page profile-page">
    <div className="page-heading"><div><h1>Mi perfil</h1></div></div>
    {notice && <div className="notice" role="status"><p>Perfil actualizado.</p><Button onClick={() => setNotice(false)}>Entendido</Button></div>}
    <section className="profile-card" aria-label="Datos de mi perfil">
      <div className="settings-company"><Avatar name={person.name} /><strong>{card.name}</strong></div>
      <dl><div><dt>Nombre</dt><dd>{card.name}</dd></div><div><dt>Correo</dt><dd>{card.email}</dd></div>
        <div><dt>Rol</dt><dd>{card.role}</dd></div><div><dt>Empresas</dt><dd><ul>{card.companies.map(name => <li key={name}>{name}</li>)}</ul></dd></div></dl>
      {card.example && <span className="team-chip">{card.example}</span>}
      <p>El rol y las empresas los gestiona el community manager desde Equipo.</p>
      <Button onClick={() => setEditing(true)}>Editar perfil</Button>
    </section>
    {editing && <ProfileDialog onClose={() => setEditing(false)} onSaved={() => setNotice(true)} />}
  </section>;
}
