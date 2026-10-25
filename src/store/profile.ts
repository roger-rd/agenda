import type { State } from '../types';
import type { WorkspacePolicy } from '../platform/access';
import type { Result, WorkspaceError } from './operations';
import { can } from './permissions';
import { cleanName, nameError } from './settings';
import { normalizeEmail, validEmail } from './invitations';

interface Context { platform: WorkspacePolicy; admin: boolean }
export interface ProfileUpdate {
  changes: { name?: string; email?: string };
  expected: { name?: string; email?: string | undefined };
}
const failure = (code: WorkspaceError, reason: string, field?: 'name' | 'email'): Result => ({ ok: false, code, reason, ...(field ? { field } : {}) });
export { normalizeEmail } from './invitations';
// Compartido por la operación y la validación informativa de la interfaz.
export function profileEmailError(s: State, raw: unknown, personId: string): Result | undefined {
  if (typeof raw !== 'string') return failure('invalid_input', 'El correo debe ser una cadena de texto.', 'email');
  const email = normalizeEmail(raw);
  if (email && (email.length > 120 || !validEmail(email)))
    return failure('invalid_input', 'Introduce un correo válido de hasta 120 caracteres.', 'email');
  if (email && s.users.some(u => u.id !== personId && u.email && normalizeEmail(u.email) === email))
    return failure('duplicate_email', 'Ya existe una persona con ese correo en la organización.', 'email');
}
export function updateProfile(s: State, input: ProfileUpdate, ctx: Context): Result {
  if (ctx.admin) return failure('forbidden', 'La sesión administrativa no puede editar este perfil.');
  const person = s.users.find(u => u.id === s.activeUserId);
  if (!person) return failure('not_found', 'La persona activa ya no está disponible.');
  if (!s.authenticated || !can(person.role, 'editOwnProfile')) return failure('forbidden', 'Debes iniciar sesión para editar tu perfil.');
  for (const field of ['name', 'email'] as const) {
    if (Object.hasOwn(input.changes, field) && person[field] !== input.expected[field])
      return failure('conflict', `El ${field === 'name' ? 'nombre' : 'correo'} cambió en otra pestaña. Actualiza los datos e inténtalo de nuevo.`, field);
  }
  const next = { ...person };
  if (Object.hasOwn(input.changes, 'name')) {
    const name = cleanName(input.changes.name);
    if (name !== person.name) {
      const error = nameError(name, 'persona');
      if (error) return error;
      next.name = name;
    }
  }
  if (Object.hasOwn(input.changes, 'email')) {
    if (typeof input.changes.email !== 'string') return failure('invalid_input', 'El correo debe ser una cadena de texto.', 'email');
    const email = normalizeEmail(input.changes.email);
    if (email !== person.email) {
      const error = profileEmailError(s, input.changes.email, person.id);
      if (error) return error;
      if (email) next.email = email;
      else delete next.email;
    } else if (!email) delete next.email;
  }
  if (next.name === person.name && next.email === person.email && Object.hasOwn(next, 'email') === Object.hasOwn(person, 'email'))
    return { ok: true, state: s };
  return { ok: true, state: { ...s, users: s.users.map(u => u === person ? next : u) } };
}
