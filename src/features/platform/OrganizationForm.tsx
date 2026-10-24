import { useRef, useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { platformStore } from '../../platform/store';
import { organizationFields, organizationResultError, SIMULATED_INVITATION_NOTICE, validateOrganizationField,
  type OrganizationErrors, type OrganizationInput } from '../../platform/validation';
import type { WorkspaceDirectory } from '../../platform/directory';
import type { PlatformState } from '../../platform/types';

export function OrganizationForm({ onClose, onSaved, workspace }: { workspace: WorkspaceDirectory; onClose: () => void; onSaved: (state: PlatformState) => void }) {
  const [draft, setDraft] = useState<OrganizationInput>({ name: '', managerName: '', email: '' });
  const [errors, setErrors] = useState<OrganizationErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const close = () => { if (Object.values(draft).some(Boolean)) setConfirm(true); else onClose(); };
  const focus = (field: string) => form.current?.querySelector<HTMLElement>(`#organization-${field}`)?.focus();
  const labels = { name: 'Nombre de la organización', managerName: 'Nombre del community manager', email: 'Correo del community manager' };
  return <Modal title="Nueva organización" adaptive className="organization-dialog" initialFocus="#organization-name" onClose={close}>
    <form ref={form} noValidate onSubmit={event => {
      event.preventDefault(); setAttempted(true); setMessage('');
      const next: OrganizationErrors = {};
      for (const field of organizationFields) {
        const error = validateOrganizationField(platformStore.getState(), field, draft[field], workspace);
        if (error) next[field] = error;
      }
      setErrors(next);
      if (Object.keys(next).length) { focus(Object.keys(next)[0]); return; }
      const result = platformStore.createOrganization(draft, workspace);
      if (result.ok) { onSaved(result.value); onClose(); }
      else {
        const error = organizationResultError(result);
        if (error.field) { setErrors({ [error.field]: error.message }); focus(error.field); }
        else setMessage(error.message);
      }
    }}>
      <p className="notice">{SIMULATED_INVITATION_NOTICE}</p>
      {Object.values(errors).some(Boolean) && <p role="alert" className="field-error">Revisa los campos indicados antes de guardar.</p>}
      {message && <p role="alert" className="field-error">{message}</p>}
      {organizationFields.map(field => <label key={field}>{labels[field]}
        <input id={`organization-${field}`} required type={field === 'email' ? 'email' : 'text'}
          inputMode={field === 'email' ? 'email' : 'text'} autoCapitalize={field === 'email' ? 'none' : 'words'}
          spellCheck={false} autoComplete="off" value={draft[field]}
          aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `organization-error-${field}` : undefined}
          onBlur={() => { if (attempted) setErrors(previous => ({ ...previous, [field]: validateOrganizationField(platformStore.getState(), field, draft[field], workspace) })); }}
          onChange={event => {
            const value = event.target.value; setDraft(previous => ({ ...previous, [field]: value })); setMessage('');
            if (attempted) setErrors(previous => ({ ...previous, [field]: validateOrganizationField(platformStore.getState(), field, value, workspace) }));
          }} />
        {errors[field] && <span className="field-error" id={`organization-error-${field}`}>{errors[field]}</span>}
      </label>)}
      <div className="modal-actions"><Button type="button" onClick={close}>Cancelar</Button><Button className="primary" type="submit">Crear organización</Button></div>
    </form>
    {confirm && <Modal adaptive className="filters-sheet confirmation-sheet" title="Descartar cambios sin guardar" initialFocus=".keep-editing" onClose={() => setConfirm(false)}>
      <p>Hay cambios sin guardar. ¿Quieres descartarlos?</p>
      <div className="modal-actions"><Button className="keep-editing" onClick={() => setConfirm(false)}>Seguir editando</Button><Button onClick={onClose}>Descartar cambios</Button></div>
    </Modal>}
  </Modal>;
}
