import type { State } from '../../types';
import type { Result } from '../../store/operations';
import { cleanName, companyNameError, nameError, validateColor, type CompanyUpdate } from '../../store/settings';
import { normalizeHex } from '../../lib/color';

type Values = { name: string; color: string };
type Failure = Extract<Result, { ok: false }>;
export interface SettingsDraft {
  companyId?: string;
  base: Values;
  values: Values;
  attempted: boolean;
  failure?: Failure;
  refreshed?: Values;
  ready: boolean;
}
export function settingsDraft(s: State, companyId?: string): SettingsDraft {
  const entity = companyId ? s.companies.find(c => c.id === companyId)! : s.organization;
  const base = { name: entity.name, color: 'color' in entity && typeof entity.color === 'string' ? entity.color : '' };
  return { companyId, base, values: { ...base }, attempted: false, ready: true };
}
export function changedFields(d: SettingsDraft) {
  return { name: cleanName(d.values.name) !== cleanName(d.base.name),
    color: !!d.companyId && normalizeHex(d.values.color) !== normalizeHex(d.base.color) };
}
export const isDirty = (d: SettingsDraft) => Object.values(changedFields(d)).some(Boolean);
export const needsDiscardConfirmation = isDirty;
export const isRetry = (d: SettingsDraft) => d.failure?.code === 'conflict' || d.failure?.code === 'storage_unavailable';
export function editDraft(d: SettingsDraft, field: keyof Values, value: string): SettingsDraft {
  return { ...d, values: { ...d.values, [field]: value },
    failure: d.failure?.field === field && !isRetry(d) && !['forbidden', 'not_found'].includes(d.failure.code ?? '') ? undefined : d.failure };
}
export function fieldErrors(s: State, d: SettingsDraft) {
  const changed = changedFields(d);
  const errors: Partial<Record<keyof Values, string>> = {};
  const name = changed.name ? (d.companyId ? companyNameError(s, cleanName(d.values.name), d.companyId) : nameError(d.values.name, 'organización')) : undefined;
  const color = changed.color ? validateColor(d.values.color) : undefined;
  if (name && !name.ok) errors.name = name.reason;
  if (color && !color.ok) errors.color = color.reason;
  if ((d.failure?.field === 'name' || d.failure?.field === 'color') && !isRetry(d)) errors[d.failure.field] = d.failure.reason;
  return errors;
}
export function submitState(s: State, d: SettingsDraft) {
  const missing = !!d.companyId && !s.companies.some(c => c.id === d.companyId && c.organizationId === s.organization.id);
  return { label: isRetry(d) ? 'Reintentar' : 'Guardar',
    disabled: !isDirty(d) || !d.ready || missing || d.failure?.code === 'not_found' || d.failure?.code === 'forbidden' };
}
// Refrescar nunca cambia la base ni el borrador. Solo el envío explícito usa la base refrescada.
export function recoverDraft(d: SettingsDraft, failure: Failure, refreshed: State, ready: boolean): SettingsDraft {
  const entity = d.companyId ? refreshed.companies.find(c => c.id === d.companyId && c.organizationId === refreshed.organization.id) : refreshed.organization;
  return { ...d, attempted: true, failure: !entity ? { ok: false, code: 'not_found', reason: 'La empresa ya no está disponible. Cierra este diálogo.' } : failure,
    ready, refreshed: ready && entity ? { name: entity.name, color: 'color' in entity && typeof entity.color === 'string' ? entity.color : '' } : undefined };
}
export function recoveryMessages(d: SettingsDraft) {
  if (!isRetry(d)) return [];
  if (!d.ready) return ['No se pudieron actualizar los datos. Actualiza los datos antes de reintentar.'];
  if (!d.refreshed) return [];
  return [d.refreshed.name !== d.base.name ? `El nombre ahora es «${d.refreshed.name}».` : '',
    d.companyId && d.refreshed.color !== d.base.color ? `El color ahora es «${d.refreshed.color}».` : ''].filter(Boolean);
}
export function buildSubmission(d: SettingsDraft) {
  const changed = changedFields(d), expectedBase = isRetry(d) && d.ready && d.refreshed ? d.refreshed : d.base;
  const changes: CompanyUpdate['changes'] = {}, expected: CompanyUpdate['expected'] = {};
  if (changed.name) { changes.name = cleanName(d.values.name); expected.name = expectedBase.name; }
  if (changed.color) { changes.color = normalizeHex(d.values.color); expected.color = expectedBase.color; }
  return { companyId: d.companyId ?? '', changes, expected };
}
export function submissionHasChanges(d: SettingsDraft) {
  const { changes, expected } = buildSubmission(d);
  return (Object.keys(changes) as (keyof Values)[]).some(field => changes[field] !== expected[field]);
}
