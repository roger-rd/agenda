import { normalizeEmail, validEmail } from '../../store/invitations';
import type { WorkspaceError } from '../../store/operations';
export const invitationMessages = {
  invalid: 'Enlace no válido', expired: 'Esta invitación ha vencido', revoked: 'Esta invitación fue revocada',
  used: 'Esta invitación ya fue usada', organization_unavailable: 'Organización no disponible',
  companies_unavailable: 'Las empresas de esta invitación ya no están disponibles',
};
export const acceptanceErrors: Partial<Record<WorkspaceError, string>> = {
  email_mismatch: 'El correo no coincide con esta invitación.',
  used: invitationMessages.used, revoked: invitationMessages.revoked, expired: invitationMessages.expired,
  organization_unavailable: invitationMessages.organization_unavailable,
  invalid_companies: invitationMessages.companies_unavailable,
  existing_member: 'Este correo ya pertenece a una persona de la organización. Solicita acceso al community manager.',
  duplicate_email: 'Este correo ya está registrado.',
  session_active: 'Para aceptar esta invitación primero cierra tu sesión actual',
  conflict: 'Los datos cambiaron en otra pestaña. Revisa el estado y pulsa Reintentar.',
  storage_unavailable: 'No se pudo acceder al almacenamiento de este navegador.',
  invalid_input: 'Revisa tu nombre y correo.', not_found: invitationMessages.invalid,
};
export function acceptanceFields(name: string, email: string) {
  return {
    name: !name.trim() || name.trim().length > 120 ? 'Escribe un nombre de entre 1 y 120 caracteres.' : '',
    email: email.trim().length > 120 || !validEmail(normalizeEmail(email)) ? 'Escribe un correo válido de hasta 120 caracteres.' : '',
  };
}

export function acceptanceSubmitState(code?: WorkspaceError | null, ready = true) {
  return {
    label: code === 'conflict' || code === 'storage_unavailable' ? 'Reintentar' : 'Aceptar invitación',
    disabled: !ready,
  };
}
