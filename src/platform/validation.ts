import { organizationDisplayName, type WorkspaceDirectory } from './directory';
import type { PlatformState, Result } from './types';
export const SIMULATED_INVITATION_NOTICE = 'Invitación simulada: no se envía ningún correo ni se habilita un espacio de trabajo funcional para esta organización.';
export const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const cleanName = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
export interface OrganizationInput { name: string; managerName: string; email: string }
export type OrganizationField = keyof OrganizationInput;
export type OrganizationErrors = Partial<Record<OrganizationField, string>>;
export const organizationFields: OrganizationField[] = ['name', 'managerName', 'email'];
const duplicateName = 'Ya existe una organización con ese nombre (se ignoran mayúsculas y tildes).';
const duplicateEmail = 'Ya existe un miembro con ese correo.';
export function validateOrganizationField(state: PlatformState, field: OrganizationField, raw: unknown, workspace?: WorkspaceDirectory): string | undefined {
  const value = cleanName(raw);
  if (!value) return { name: 'Escribe el nombre de la organización.', managerName: 'Escribe el nombre del community manager.', email: 'Escribe el correo del community manager.' }[field];
  if (field === 'email') {
    if (value.length > 120) return 'El correo admite hasta 120 caracteres.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Escribe un correo válido, por ejemplo nombre@dominio.com.';
    if (state.members.some(m => normalized(m.email) === normalized(value))) return duplicateEmail;
  } else {
    if (value.length < 2 || value.length > 80) return 'El nombre debe tener entre 2 y 80 caracteres.';
    if (field === 'name' && state.organizations.some(o => normalized(workspace ? organizationDisplayName(state, workspace, o.id)! : o.name) === normalized(value))) return duplicateName;
  }
}
export function organizationResultError(result: Extract<Result, { ok: false }>): { field?: OrganizationField; message: string } {
  if (result.code === 'duplicate_name') return { field: 'name', message: duplicateName };
  if (result.code === 'duplicate_email') return { field: 'email', message: duplicateEmail };
  return { field: organizationFields.find(field => field === result.field), message: result.reason };
}
export function validateOrganization(state: PlatformState, input: unknown, workspace?: WorkspaceDirectory): Result<OrganizationInput> {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  for (const field of organizationFields) {
    const reason = validateOrganizationField(state, field, raw[field], workspace);
    if (reason) return { ok: false, field, reason, code: reason === duplicateName ? 'duplicate_name' : reason === duplicateEmail ? 'duplicate_email' : 'invalid_input' };
  }
  return { ok: true, value: { name: cleanName(raw.name), managerName: cleanName(raw.managerName), email: cleanName(raw.email).toLowerCase() } };
}
export function validateReason(input: unknown): Result<string | undefined> {
  if (input !== undefined && typeof input !== 'string') return { ok: false, code: 'invalid_input', field: 'reason', reason: 'El motivo debe ser texto.' };
  const value = (input as string | undefined)?.trim();
  return value && value.length > 200 ? { ok: false, code: 'invalid_input', field: 'reason', reason: 'El motivo admite hasta 200 caracteres.' } : { ok: true, value: value || undefined };
}
