import type { State } from '../types';
import type { WorkspacePolicy } from '../platform/access';
import { isHexColor, normalizeHex } from '../lib/color';
import { can, type Action } from './permissions';
import type { Result, WorkspaceError } from './operations';
// Misma normalización pura que plataforma, sin importar su validación privada.
export const cleanName = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
export const normalized = (value: string) => cleanName(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
interface Context { platform: WorkspacePolicy; admin: boolean }
export interface OrganizationUpdate { name: string; expectedName: string }
export interface CompanyUpdate {
  companyId: string;
  changes: { name?: string; color?: string };
  expected: { name?: string; color?: string };
}
const failure = (code: WorkspaceError, reason: string, field?: 'name' | 'color'): Result => ({ ok: false, code, reason, ...(field ? { field } : {}) });
function authorized(s: State, ctx: Context, action: Action) {
  const person = s.users.find(u => u.id === s.activeUserId);
  return s.authenticated && !ctx.admin && !!person && can(person.role, action);
}
const forbidden = () => failure('forbidden', 'Solo el community manager puede gestionar estos ajustes.');
export function nameError(rawName: string, entity: string): Result | undefined {
  const name = cleanName(rawName);
  if (name.length < 2 || name.length > 80) return failure('invalid_input', `El nombre de la ${entity} debe tener entre 2 y 80 caracteres.`, 'name');
}
export function companyNameError(s: State, name: string, exceptId?: string): Result | undefined {
  return nameError(name, 'empresa') ?? (s.companies.some(c => c.organizationId === s.organization.id && c.id !== exceptId && normalized(c.name) === normalized(name))
    ? failure('duplicate_name', 'Ya existe una empresa con ese nombre en la organización.', 'name') : undefined);
}
const colorError = () => failure('invalid_color', 'El color de la empresa debe tener el formato #RRGGBB.', 'color');
export const validateColor = (color: unknown): Result | undefined => isHexColor(color) ? undefined : colorError();
export function updateOrganization(s: State, input: OrganizationUpdate, ctx: Context): Result {
  if (!authorized(s, ctx, 'editOrganization')) return forbidden();
  if (s.organization.name !== input.expectedName) return failure('conflict', 'El nombre cambió en otra pestaña. Actualiza los datos e inténtalo de nuevo.', 'name');
  const name = cleanName(input.name);
  if (name === s.organization.name) return { ok: true, state: s };
  const error = nameError(name, 'organización');
  if (error) return error;
  if (ctx.platform.organizationNameTaken(name, s.organization.id))
    return failure('duplicate_name', 'Ya existe una organización con ese nombre.', 'name');
  return { ok: true, state: { ...s, organization: { ...s.organization, name } } };
}
export function updateCompany(s: State, input: CompanyUpdate, ctx: Context): Result {
  if (!authorized(s, ctx, 'editCompany')) return forbidden();
  const company = s.companies.find(c => c.id === input.companyId && c.organizationId === s.organization.id);
  if (!company) return failure('not_found', 'Empresa no disponible.');
  for (const field of ['name', 'color'] as const) {
    if (Object.hasOwn(input.changes, field) && company[field] !== input.expected[field])
      return failure('conflict', `El ${field === 'name' ? 'nombre' : 'color'} cambió en otra pestaña. Actualiza los datos e inténtalo de nuevo.`, field);
  }
  let name = company.name, color = company.color;
  if (Object.hasOwn(input.changes, 'name')) {
    const cleaned = cleanName(input.changes.name);
    // Datos previos: un nombre sin cambios no exige corregir longitud ni duplicados.
    if (cleaned !== cleanName(company.name)) {
      const error = companyNameError(s, cleaned, company.id);
      if (error) return error;
      name = cleaned;
    }
  }
  if (Object.hasOwn(input.changes, 'color')) {
    const error = validateColor(input.changes.color);
    if (error) return error;
    color = normalizeHex(input.changes.color!);
  }
  if (name === company.name && color === company.color) return { ok: true, state: s };
  return { ok: true, state: { ...s, companies: s.companies.map(c => c === company ? { ...c, name, color } : c) } };
}
export function createCompany(s: State, rawName: string, rawColor: string, ctx: Context): Result {
  if (!authorized(s, ctx, 'createCompany')) return forbidden();
  const name = cleanName(rawName), error = companyNameError(s, name);
  if (error) return error;
  const invalidColor = validateColor(rawColor);
  if (invalidColor) return invalidColor;
  return { ok: true, state: { ...s, companies: [...s.companies,
    { id: crypto.randomUUID(), organizationId: s.organization.id, name, color: normalizeHex(rawColor) }] } };
}
