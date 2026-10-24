import { useRef, useState } from 'react';
import { Avatar, Button, Modal } from '../../components/ui';
import { actions, getState, useStore } from '../../store';
import { isHexColor, normalizeHex } from '../../lib/color';
import { buildSubmission, editDraft, fieldErrors, isRetry, needsDiscardConfirmation, recoverDraft, recoveryMessages, settingsDraft, submissionHasChanges, submitState } from './settingsPresentation';

function SettingsDialog({ companyId, onClose, onSaved }: { companyId?: string; onClose: () => void; onSaved: (message: string) => void }) {
  const s = useStore();
  const [draft, setDraft] = useState(() => settingsDraft(s, companyId));
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const errors = fieldErrors(s, draft), submit = submitState(s, draft);
  function close() { if (needsDiscardConfirmation(draft)) setConfirm(true); else onClose(); }
  function save() {
    setDraft({ ...draft, attempted: true });
    const first = errors.name ? 'name' : errors.color ? 'color' : undefined;
    if (first) { form.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus(); return; }
    if (submit.disabled) return;
    if (!submissionHasChanges(draft)) { onClose(); return; }
    const input = buildSubmission(draft);
    const result = companyId ? actions.updateCompany(input) : actions.updateOrganization({ name: input.changes.name!, expectedName: input.expected.name! });
    if (result.ok) {
      onSaved(companyId ? `Empresa «${result.state.companies.find(c => c.id === companyId)!.name}» actualizada.` : 'Nombre de la organización actualizado.');
      onClose();
    } else {
      const ready = (result.code === 'conflict' || result.code === 'storage_unavailable') ? actions.refresh() : true;
      setDraft(recoverDraft(draft, result, getState(), ready));
      if (result.field && result.code !== 'conflict') form.current?.querySelector<HTMLInputElement>(`[name="${result.field}"]`)?.focus();
    }
  }
  return <Modal adaptive className="filters-sheet team-dialog settings-dialog" title={companyId ? 'Editar empresa' : 'Editar organización'} initialFocus="#settings-name" onClose={close}>
    <form ref={form} noValidate onSubmit={e => { e.preventDefault(); save(); }}>
      <label htmlFor="settings-name">Nombre de la {companyId ? 'empresa' : 'organización'}</label>
      <input id="settings-name" name="name" value={draft.values.name} aria-invalid={draft.attempted && !!errors.name} aria-describedby={`settings-name-help${draft.attempted && errors.name ? ' settings-name-error' : ''}`} onChange={e => setDraft(editDraft(draft, 'name', e.target.value))} />
      <p id="settings-name-help">Entre 2 y 80 caracteres. Se limpian los espacios sobrantes.</p>
      {draft.attempted && errors.name && <p id="settings-name-error" role="alert">{errors.name}</p>}
      {companyId && <><label htmlFor="settings-color">Color de la empresa</label><div className="settings-color">
        <input id="settings-color" name="color" type="color" value={draft.values.color} aria-invalid={draft.attempted && !!errors.color} aria-describedby={`settings-color-value${draft.attempted && errors.color ? ' settings-color-error' : ''}`} onChange={e => setDraft(editDraft(draft, 'color', e.target.value))} />
        <span id="settings-color-value">{normalizeHex(draft.values.color)}</span>
        <Avatar name={draft.values.name} color={isHexColor(draft.values.color) ? draft.values.color : undefined} />
      </div>{draft.attempted && errors.color && <p id="settings-color-error" role="alert">{errors.color}</p>}</>}
      {draft.failure && <p role="alert">{draft.failure.reason}</p>}
      {recoveryMessages(draft).map(message => <p role="status" key={message}>{message}</p>)}
      {isRetry(draft) && !draft.ready && <Button type="button" onClick={() => { const ready = actions.refresh(); setDraft(recoverDraft(draft, draft.failure!, getState(), ready)); }}>Actualizar datos</Button>}
      <div className="modal-actions"><Button type="button" onClick={close}>Cerrar</Button><Button className="primary" disabled={submit.disabled} type="submit">{submit.label}</Button></div>
    </form>
    {confirm && <Modal adaptive className="filters-sheet confirmation-sheet team-dialog" title="Descartar cambios sin guardar" initialFocus=".keep-settings" onClose={() => setConfirm(false)}>
      <p>Hay cambios sin guardar. ¿Quieres descartarlos?</p><div className="modal-actions"><Button className="keep-settings" onClick={() => setConfirm(false)}>Seguir editando</Button><Button onClick={onClose}>Descartar cambios</Button></div>
    </Modal>}
  </Modal>;
}
export function Settings() {
  const s = useStore();
  const [editing, setEditing] = useState<{ companyId?: string } | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const companies = s.companies.filter(c => c.organizationId === s.organization.id);
  return <section className="settings-page team-page"><div className="page-heading"><div><span className="eyebrow">ORGANIZACIÓN</span><h1>Ajustes</h1></div></div>
    {notices.map((message, index) => <div className="notice" role="status" key={index}><p>{message}</p><Button onClick={() => setNotices(notices.filter((_, i) => i !== index))}>Entendido</Button></div>)}
    <section aria-labelledby="settings-organization"><h2 id="settings-organization">Organización</h2><div className="settings-organization"><strong>{s.organization.name}</strong><Button onClick={() => setEditing({})}>Editar nombre</Button></div></section>
    <section aria-labelledby="settings-companies"><h2 id="settings-companies">Empresas</h2>{companies.length ? <ul className="team-list">{companies.map(company => <li className="team-row" key={company.id}>
      <div className="settings-company"><Avatar name={company.name} color={company.color} /><strong>{company.name}</strong></div>
      <div className="settings-color"><span className="company-color-sample" style={{ background: company.color }} aria-hidden="true" /><span>{normalizeHex(company.color)}</span></div>
      <Button aria-label={`Editar ${company.name}`} onClick={() => setEditing({ companyId: company.id })}>Editar</Button>
    </li>)}</ul> : <p>No hay empresas en esta organización.</p>}</section>
    {editing && <SettingsDialog companyId={editing.companyId} onClose={() => setEditing(null)} onSaved={message => setNotices(previous => [...previous, message])} />}
  </section>;
}
