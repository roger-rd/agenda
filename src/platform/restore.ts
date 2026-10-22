import { LINKED_ORGANIZATION_ID, PLATFORM_ADMIN_ID } from './ids';
import { generatePlatformSeed } from './seed';
import type { AccessStatus, PlatformState, Suspension } from './types';
import { cleanName, normalized, validateReason } from './validation';
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Registro inválido');
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Texto inválido');
  return value.trim();
}
function name(value: unknown) {
  const result = cleanName(value);
  if (result.length < 2 || result.length > 80) throw new Error('Nombre inválido');
  return result;
}
function date(value: unknown) {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Fecha inválida');
  return result;
}
function status(value: unknown): AccessStatus {
  if (value !== 'active' && value !== 'suspended') throw new Error('Estado inválido');
  return value;
}
function suspension(value: unknown, access: AccessStatus): Suspension | undefined {
  if (access === 'active') return undefined;
  const raw = record(value), reason = validateReason(raw.reason);
  if (!reason.ok) throw new Error('Motivo inválido');
  return { at: date(raw.at), ...(reason.value ? { reason: reason.value } : {}) };
}
function array(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw new Error('Lista inválida');
  return value.map(record);
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error('Duplicados');
}
// Reconstrucción por lista permitida: nunca persiste propiedades ajenas al modelo.
export function sanitizePlatformState(value: unknown): PlatformState {
  const raw = record(value);
  if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) throw new Error('Versión inválida');
  const organizations = array(raw.organizations).map(o => {
    const id = text(o.id), access = status(o.status);
    if (typeof o.workspaceLinked !== 'boolean' || o.workspaceLinked !== (id === LINKED_ORGANIZATION_ID)) throw new Error('Vínculo inválido');
    const suspended = suspension(o.suspension, access);
    return { id, name: name(o.name), createdAt: date(o.createdAt), status: access,
      workspaceLinked: o.workspaceLinked, ...(suspended ? { suspension: suspended } : {}) };
  });
  unique(organizations.map(o => o.id)); unique(organizations.map(o => normalized(o.name)));
  const exists = (id: unknown) => organizations.some(o => o.id === id);
  const standalone = (id: unknown) => organizations.some(o => o.id === id && !o.workspaceLinked);
  const members: PlatformState['members'] = array(raw.members).filter(m => standalone(m.organizationId)).map(m => {
    const id = text(m.id), email = text(m.email).toLowerCase();
    if (id === PLATFORM_ADMIN_ID || !['community_manager', 'worker', 'client'].includes(String(m.role)) || typeof m.example !== 'boolean'
      || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Miembro inválido');
    let invitation;
    if (m.invitation !== undefined) {
      const rawInvitation = record(m.invitation);
      if (rawInvitation.simulated !== true) throw new Error('Invitación inválida');
      invitation = { simulated: true as const, createdAt: date(rawInvitation.createdAt) };
    }
    return { id, organizationId: text(m.organizationId), name: name(m.name), email,
      role: m.role as PlatformState['members'][number]['role'], example: m.example, ...(invitation ? { invitation } : {}) };
  });
  unique(members.map(m => m.id)); unique(members.map(m => normalized(m.email)));
  const companies = array(raw.companies).filter(c => standalone(c.organizationId)).map(c => {
    if (c.example !== true) throw new Error('Empresa inválida');
    return { id: text(c.id), organizationId: text(c.organizationId), name: name(c.name), color: text(c.color), example: true as const };
  });
  unique(companies.map(c => c.id));
  const memberAccess = array(raw.memberAccess).filter(a => exists(a.organizationId)).map(a => {
    const access = status(a.status), suspended = suspension(a.suspension, access);
    const userId = text(a.userId);
    if (userId === PLATFORM_ADMIN_ID) throw new Error('Identidad inválida');
    return { organizationId: text(a.organizationId), userId, status: access, ...(suspended ? { suspension: suspended } : {}) };
  }).filter(a => a.organizationId === LINKED_ORGANIZATION_ID || members.some(m => m.organizationId === a.organizationId && m.id === a.userId));
  unique(memberAccess.map(a => JSON.stringify([a.organizationId, a.userId])));
  return { version: 1, revision: raw.revision as number, organizations, members, companies, memberAccess };
}
export function restorePlatform(raw: string | null): PlatformState {
  try { return raw === null ? generatePlatformSeed() : sanitizePlatformState(JSON.parse(raw)); }
  catch { return generatePlatformSeed(); }
}
