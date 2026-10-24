import type { Invitation, State } from '../types';
import type { WorkspacePolicy } from '../platform/access';
import type { Result, WorkspaceError } from './operations';
import { changeCompanyAccess } from './teamAccess';
import { can } from './permissions';
import { selectUser } from './selectors';
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export const failure = (code: WorkspaceError, reason: string): Result => ({ ok: false, code, reason });
export const invitationStatus = (i: Invitation, now = Date.now()) =>
  i.usedAt ? 'usada' : i.revokedAt ? 'revocada' : Date.parse(i.expiresAt) <= now ? 'vencida' : 'pendiente';
export interface InvitationInput { email: string; role: 'worker' | 'client'; companyIds: string[]; validityDays?: 1 | 7 | 30 }
export interface InvitationContext { platform: WorkspacePolicy; admin: boolean; now: number }
function companiesValid(s: State, companyIds: string[]) {
  return companyIds.length > 0 && companyIds.every(id => s.companies.some(c => c.id === id && c.organizationId === s.organization.id));
}
function environment(s: State, ctx: InvitationContext, companyIds: string[]): Result | undefined {
  if (!ctx.platform.organizationActive(s.organization.id))
    return failure('organization_unavailable', 'La organización no existe o está suspendida.');
  if (!companiesValid(s, companyIds)) return failure('invalid_companies', 'Selecciona empresas existentes de la organización.');
}
function emailAvailable(s: State, ctx: InvitationContext, email: string): Result | undefined {
  if (s.users.some(u => u.email && normalizeEmail(u.email) === email))
    return failure('existing_member', 'Esta persona ya pertenece a la organización. Sus empresas se gestionan desde Equipo.');
  if (ctx.platform.emailExists(email))
    return failure('duplicate_email', 'El correo ya pertenece a un miembro de plataforma.');
}
export function canManageTeam(s: State, admin = false) {
  return !admin && s.authenticated && !!selectUser(s) && can(selectUser(s).role, 'manageInvitations');
}
export function createInvitation(s: State, input: InvitationInput, ctx: InvitationContext): Result {
  if (!canManageTeam(s, ctx.admin)) return failure('forbidden', 'Solo el community manager puede gestionar invitaciones.');
  const days = input.validityDays ?? 7;
  if (typeof input.email !== 'string' || input.email.trim().length > 120 || !validEmail(normalizeEmail(input.email)) || ![1, 7, 30].includes(days)
    || !['worker', 'client'].includes(input.role) || !Array.isArray(input.companyIds))
    return failure('invalid_input', 'Revisa correo, rol y vigencia (1, 7 o 30 días).');
  const email = normalizeEmail(input.email), companyIds = [...new Set(input.companyIds)];
  const error = environment(s, ctx, companyIds) ?? emailAvailable(s, ctx, email);
  if (error) return error;
  let code = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    code = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (!s.invitations.some(i => i.code === code)) break;
    code = '';
  }
  if (!code) return failure('conflict', 'No se pudo generar un código único. Inténtalo de nuevo.');
  const invitation: Invitation = { id: crypto.randomUUID(), code, organizationId: s.organization.id, email,
    role: input.role, companyIds, validityDays: days, createdAt: new Date(ctx.now).toISOString(),
    expiresAt: new Date(ctx.now + days * 86400000).toISOString() };
  return { ok: true, state: { ...s, invitations: [...s.invitations, invitation] } };
}
export function changeInvitation(s: State, id: string, mode: 'revoke' | 'renew', ctx: InvitationContext, days: 1 | 7 | 30 = 7): Result {
  if (!canManageTeam(s, ctx.admin)) return failure('forbidden', 'Solo el community manager puede gestionar invitaciones.');
  const invitation = s.invitations.find(i => i.id === id);
  if (!invitation) return failure('not_found', 'Invitación no encontrada.');
  if (invitation.usedAt) return failure('used', 'La invitación ya fue utilizada.');
  if (invitation.organizationId !== s.organization.id) return failure('organization_unavailable', 'La organización no existe.');
  if (![1, 7, 30].includes(days) || !['worker', 'client'].includes(invitation.role)) return failure('invalid_input', 'Vigencia o rol no válido.');
  const error = environment(s, ctx, invitation.companyIds);
  if (error) return error;
  if (mode === 'renew') {
    const result = createInvitation(s, { ...invitation, validityDays: days }, ctx);
    if (!result.ok) return result;
    return { ok: true, state: { ...result.state, invitations: result.state.invitations.map(i => i.id === id
      ? { ...i, revokedAt: new Date(ctx.now).toISOString() } : i) } };
  }
  return { ok: true, state: { ...s, invitations: s.invitations.map(i => i.id === id
    ? { ...i, revokedAt: new Date(ctx.now).toISOString() } : i) } };
}
export function acceptInvitation(s: State, code: string, input: { name: string; email: string }, ctx: InvitationContext): Result {
  if (s.authenticated || ctx.admin) return failure('session_active', 'Cierra tu sesión antes de aceptar la invitación.');
  const invitation = s.invitations.find(i => i.code === code);
  if (!invitation) return failure('not_found', 'Invitación no encontrada.');
  if (invitation.usedAt) return failure('used', 'La invitación ya fue utilizada.');
  if (invitation.revokedAt) return failure('revoked', 'La invitación fue revocada.');
  if (Date.parse(invitation.expiresAt) <= ctx.now) return failure('expired', 'La invitación ha vencido.');
  if (invitation.organizationId !== s.organization.id) return failure('organization_unavailable', 'La organización no existe.');
  const error = environment(s, ctx, invitation.companyIds);
  if (error) return error;
  if (typeof input.email !== 'string' || input.email.trim().length > 120 || !validEmail(normalizeEmail(input.email)))
    return failure('invalid_input', 'Escribe un correo válido de hasta 120 caracteres.');
  const email = normalizeEmail(invitation.email);
  if (normalizeEmail(input.email) !== email)
    return failure('email_mismatch', 'El correo no coincide con esta invitación.');
  const unavailable = emailAvailable(s, ctx, email);
  if (unavailable) return unavailable;
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120)
    return failure('invalid_input', 'Escribe un nombre de entre 1 y 120 caracteres.');
  const user = { id: crypto.randomUUID(), name: input.name.trim(), email, role: invitation.role, example: false };
  return { ok: true, state: { ...s, users: [...s.users, user], memberships: [...s.memberships,
    ...invitation.companyIds.map(companyId => ({ id: crypto.randomUUID(), userId: user.id, companyId }))],
    invitations: s.invitations.map(i => i.id === invitation.id ? { ...i, usedAt: new Date(ctx.now).toISOString(), usedBy: user.id } : i) } };
}
export function removeWorkerCompanyAccess(s: State, userId: string, companyId: string, admin = false): Result {
  if (!canManageTeam(s, admin)) return failure('forbidden', 'Solo el community manager puede gestionar accesos.');
  if (!s.users.some(u => u.id === userId && u.role === 'worker') || !companiesValid(s, [companyId]))
    return failure('invalid_input', 'Selecciona un trabajador y una empresa de la organización.');
  return changeCompanyAccess(s, userId, companyId, false, admin);
}

export type InvitationInspection =
  | { status: 'valid'; organization: string; companies: string[]; role: 'worker' | 'client' }
  | { status: 'invalid' | 'expired' | 'revoked' | 'used' | 'organization_unavailable' | 'companies_unavailable' };
export function inspectInvitation(s: State, code: string, ctx: Pick<InvitationContext, 'platform' | 'now'>): InvitationInspection {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(code)) return { status: 'invalid' };
  const i = s.invitations.find(i => i.code === code);
  if (!i) return { status: 'invalid' };
  if (i.usedAt) return { status: 'used' };
  if (i.revokedAt) return { status: 'revoked' };
  if (Date.parse(i.expiresAt) <= ctx.now) return { status: 'expired' };
  if (i.organizationId !== s.organization.id || !ctx.platform.organizationActive(i.organizationId))
    return { status: 'organization_unavailable' };
  if (!companiesValid(s, i.companyIds)) return { status: 'companies_unavailable' };
  return { status: 'valid', organization: s.organization.name, role: i.role,
    companies: i.companyIds.map(id => s.companies.find(c => c.id === id)!.name) };
}
