import type { State, User } from '../../types';
import type { Result } from '../../store/operations';
import { cleanName, nameError } from '../../store/settings';
import { normalizeEmail, profileEmailError, type ProfileUpdate } from '../../store/profile';
import { can } from '../../store/permissions';

export const EMAIL_NOTICE = 'El correo no se verifica en esta demostración: no se envía ningún mensaje de confirmación.';
type Values = { name: string; email: string };
type Base = { name: string; email: string | undefined };
type Failure = Extract<Result, { ok: false }>;
export interface ProfileDraft {
  personId: string;
  organizationId: string;
  base: Base;
  values: Values;
  attempted: boolean;
  failure?: Failure;
  refreshed?: Base;
  ready: boolean;
}
export function profileDraft(s: State): ProfileDraft {
  const person = s.users.find(u => u.id === s.activeUserId)!;
  return { personId: person.id, organizationId: s.organization.id,
    base: { name: person.name, email: person.email },
    values: { name: person.name, email: person.email ?? '' }, attempted: false, ready: true };
}
export const draftIsCurrent = (s: State, d: ProfileDraft) =>
  s.activeUserId === d.personId && s.organization.id === d.organizationId;
export function changedFields(d: ProfileDraft) {
  return { name: cleanName(d.values.name) !== cleanName(d.base.name),
    email: normalizeEmail(d.values.email) !== normalizeEmail(d.base.email ?? '') };
}
export const isDirty = (d: ProfileDraft) => Object.values(changedFields(d)).some(Boolean);
export const needsDiscardConfirmation = isDirty;
export const isRetry = (d: ProfileDraft) => d.failure?.code === 'conflict' || d.failure?.code === 'storage_unavailable';
export function editDraft(d: ProfileDraft, field: keyof Values, value: string): ProfileDraft {
  return { ...d, values: { ...d.values, [field]: value },
    failure: d.failure?.field === field && !isRetry(d) && !['not_found', 'forbidden'].includes(d.failure.code ?? '') ? undefined : d.failure };
}
export function fieldErrors(s: State, d: ProfileDraft) {
  const changed = changedFields(d), errors: Partial<Record<keyof Values, string>> = {};
  const name = changed.name ? nameError(d.values.name, 'persona') : undefined;
  const email = changed.email ? profileEmailError(s, d.values.email, d.personId) : undefined;
  if (name && !name.ok) errors.name = name.reason;
  if (email && !email.ok) errors.email = email.reason;
  if ((d.failure?.field === 'name' || d.failure?.field === 'email') && !isRetry(d)) errors[d.failure.field] = d.failure.reason;
  return errors;
}
export function submitState(s: State, d: ProfileDraft) {
  const person = s.users.find(u => u.id === d.personId);
  return { label: isRetry(d) ? 'Reintentar' : 'Guardar',
    disabled: !isDirty(d) || !d.ready || !draftIsCurrent(s, d) || !person || !s.authenticated
      || !can(person.role, 'editOwnProfile') || d.failure?.code === 'not_found' || d.failure?.code === 'forbidden' };
}
// El refresh conserva la base y los valores escritos; no realiza envíos.
export function recoverDraft(d: ProfileDraft, failure: Failure, s: State, ready: boolean): ProfileDraft {
  const person = s.users.find(u => u.id === d.personId);
  return { ...d, attempted: true,
    failure: !person ? { ok: false, code: 'not_found', reason: 'La persona ya no está disponible. Cierra este diálogo.' } : failure,
    ready: ready && draftIsCurrent(s, d),
    refreshed: ready && person && draftIsCurrent(s, d) ? { name: person.name, email: person.email } : undefined };
}
export function recoveryMessages(d: ProfileDraft) {
  if (!isRetry(d)) return [];
  if (!d.ready) return ['No se pudieron actualizar los datos. Actualiza los datos antes de reintentar.'];
  if (!d.refreshed) return [];
  const changed = changedFields(d);
  return [changed.name ? `El nombre ahora es «${d.refreshed.name}».` : '',
    changed.email ? `El correo ahora es ${d.refreshed.email ? '«' + d.refreshed.email + '»' : '«sin correo»'}.` : ''].filter(Boolean);
}
// Solo el envío explícito construye expected a partir del último refresh.
export function buildSubmission(d: ProfileDraft): ProfileUpdate {
  const changed = changedFields(d);
  const base = isRetry(d) && d.ready && d.refreshed ? d.refreshed : d.base;
  const changes: ProfileUpdate['changes'] = {}, expected: ProfileUpdate['expected'] = {};
  if (changed.name) { changes.name = cleanName(d.values.name); expected.name = base.name; }
  if (changed.email) { changes.email = normalizeEmail(d.values.email); expected.email = base.email; }
  return { changes, expected };
}
export function submissionHasChanges(d: ProfileDraft) {
  const { changes, expected } = buildSubmission(d);
  return (changes.name !== undefined && changes.name !== cleanName(expected.name))
    || (changes.email !== undefined && changes.email !== normalizeEmail(expected.email ?? ''));
}
export function profileCard(s: State, person: User) {
  const companies = s.companies.filter(c => c.organizationId === s.organization.id
    && s.memberships.some(m => m.userId === person.id && m.companyId === c.id)).map(c => c.name);
  return { name: person.name, email: person.email || 'Sin correo registrado',
    role: { community_manager: 'Community manager', worker: 'Trabajador', client: 'Cliente' }[person.role],
    companies: person.role === 'community_manager' ? ['Todas las empresas'] : companies.length ? companies : ['Sin empresas asignadas'],
    example: person.example ? 'Datos de ejemplo' : undefined };
}
