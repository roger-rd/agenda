import type { Invitation, State } from '../../types';
import { invitationStatus, normalizeEmail, validEmail, type InvitationInput } from '../../store/invitations';
export type InvitationStatus = ReturnType<typeof invitationStatus>;
export type InvitationFilter = 'todas' | InvitationStatus;
export const invitationLabels = { todas: 'Todas', pendiente: 'Pendientes', usada: 'Usadas', revocada: 'Revocadas', vencida: 'Vencidas' } as const;
export const invitationLink = (origin: string, code: string) => `${origin}/invitacion/${code}`;
export const invitationActions = (status: InvitationStatus) => ({ copy: status === 'pendiente', revoke: status === 'pendiente', renew: status !== 'usada' });
export const invitationCompanies = (s: State, i: Invitation) => i.companyIds.map(id => s.companies.find(c => c.id === id && c.organizationId === i.organizationId)?.name ?? 'empresa eliminada');
export function invitationList(s: State, filter: InvitationFilter, now: number) {
  const all = s.invitations.filter(i => i.organizationId === s.organization.id).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const counts = { todas: all.length, pendiente: 0, usada: 0, revocada: 0, vencida: 0 };
  all.forEach(i => counts[invitationStatus(i, now)]++);
  return { counts, rows: all.filter(i => filter === 'todas' || invitationStatus(i, now) === filter) };
}
export function invitationErrors(input: InvitationInput) {
  return {
    email: !validEmail(normalizeEmail(input.email)) || input.email.trim().length > 120 ? 'Escribe un correo válido de hasta 120 caracteres.' : '',
    role: !['worker', 'client'].includes(input.role) ? 'Selecciona Trabajador o Cliente.' : '',
    companyIds: !input.companyIds.length ? 'Selecciona al menos una empresa.' : '',
    validityDays: ![1, 7, 30].includes(input.validityDays ?? 7) ? 'Selecciona 1, 7 o 30 días.' : '',
  };
}
