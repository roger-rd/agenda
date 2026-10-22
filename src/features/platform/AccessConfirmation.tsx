import { useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { useSheetScrollLock } from '../../lib/useSheetScrollLock';
import { platformStore } from '../../platform/store';
import { validateReason } from '../../platform/validation';
import { WORKSPACE_BLOCKING_NOTICE } from './detailLogic';
import type { Result } from '../../platform/types';
export interface AccessAction { userId?: string; name: string; suspend: boolean }
export function AccessConfirmation({ organizationId, action, description, onClose, onResult }: {
  organizationId: string; action: AccessAction; description: string; onClose: () => void; onResult: (result: Result) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  useSheetScrollLock(true);
  const verb = action.suspend ? 'Suspender' : 'Reactivar';
  return <Modal adaptive className="filters-sheet confirmation-sheet platform-confirmation" title={`${verb} ${action.userId ? 'acceso' : 'organización'}`}
    initialFocus=".cancel-access" onClose={onClose}>
    <p>{description}</p>
    <p className="notice">{WORKSPACE_BLOCKING_NOTICE}</p>
    {action.suspend && <label>Motivo (opcional, solo visible para el administrador)
      <textarea value={reason} maxLength={200} aria-invalid={!!error} aria-describedby="reason-count reason-error"
        onChange={event => { setReason(event.target.value); setError(''); }} />
      <span id="reason-count" aria-live="polite">{reason.length}/200 caracteres</span>
      <span id="reason-error" role={error ? 'alert' : undefined}>{error}</span>
    </label>}
    <div className="modal-actions"><Button className="cancel-access" onClick={onClose}>Cancelar</Button>
      <Button className={`primary ${action.suspend ? 'destructive' : ''}`} onClick={() => {
        const valid = validateReason(reason);
        if (!valid.ok) { setError(valid.reason); return; }
        const input = { organizationId, reason: action.suspend ? valid.value : undefined };
        const result = action.userId
          ? action.suspend ? platformStore.suspendMember({ ...input, userId: action.userId }) : platformStore.reactivateMember({ ...input, userId: action.userId })
          : action.suspend ? platformStore.suspendOrganization(input) : platformStore.reactivateOrganization(input);
        if (!result.ok && result.code === 'invalid_input') setError(result.reason);
        else onResult(result);
      }}>{verb}</Button></div>
  </Modal>;
}
