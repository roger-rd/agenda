import { InvalidInputError, NotFoundError, type DomainError } from '../common/errors/domain-error';
import { MemberConflictError } from './member-errors';
import { ASSIGNABLE_ROLES, MAX_VERSION, MEMBER_MAX_COMPANIES, type MemberRole } from './member-constants';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Deterministic order of every companyIds list the API returns or compares: ascending by the canonical text of the id. */
export function sortCompanyIds(ids: readonly string[]): string[] { return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); }

/** 0 to 50 canonical UUIDv7 values, all different, in any order. Returns them in the deterministic order, or null; never repairs values. */
export function normalizeAccessCompanyIds(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > MEMBER_MAX_COMPANIES) return null;
  if (!input.every((id): id is string => typeof id === 'string' && UUID_V7.test(id))) return null;
  return new Set(input).size === input.length ? sortCompanyIds(input) : null;
}
export function isMemberVersion(input: unknown): input is number { return Number.isInteger(input) && (input as number) >= 1 && (input as number) <= MAX_VERSION; }

export type AccessUpdateInput = { ok: true; memberId: string; version: number; companyIds: string[] } | { ok: false; error: DomainError };
/**
 * Validation before any query, in this order: the body (version, then companyIds) and then the id of the path, as in the company
 * update: a bad id with a bad body is a 400, a bad id with a good body is the same 404 as a missing member.
 */
export function normalizeAccessUpdate(input: { memberId: unknown; version: unknown; companyIds: unknown }): AccessUpdateInput {
  if (!isMemberVersion(input.version)) return { ok: false, error: new InvalidInputError('Datos de entrada inválidos.', 'version') };
  const companyIds = normalizeAccessCompanyIds(input.companyIds);
  if (companyIds === null) return { ok: false, error: new InvalidInputError('Datos de entrada inválidos.', 'companyIds') };
  if (typeof input.memberId !== 'string' || !UUID_ANY.test(input.memberId)) return { ok: false, error: new NotFoundError() };
  return { ok: true, memberId: input.memberId, version: input.version, companyIds };
}

/* ---------------------------------- decisions on the locked membership ---------------------------------- */

export interface LockedMember { id: string; role: MemberRole; version: number; deactivatedAt: Date | null }
export type MemberUpdateDecision = 'proceed' | 'not_found' | 'version_conflict' | 'not_assignable' | 'deactivated';
/**
 * Diagnostic order, evaluated on the row locked with SELECT ... FOR UPDATE and scoped by the organization: existence (a member of
 * another organization is simply not found), then version, then role, then state. A stale version is a conflict even when the
 * requested set equals the current one.
 */
export function memberUpdateDecision(member: LockedMember | null, requestedVersion: number): MemberUpdateDecision {
  if (member === null) return 'not_found';
  if (member.version !== requestedVersion) return 'version_conflict';
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(member.role)) return 'not_assignable';
  return member.deactivatedAt === null ? 'proceed' : 'deactivated';
}
export function memberUpdateFailure(decision: Exclude<MemberUpdateDecision, 'proceed'>): DomainError {
  switch (decision) {
    case 'not_found': return new NotFoundError();
    case 'version_conflict': return new MemberConflictError('version_conflict');
    case 'not_assignable': return new MemberConflictError('member_not_assignable');
    case 'deactivated': return new MemberConflictError('member_deactivated');
  }
}

export interface AccessDiff { add: string[]; remove: string[]; changed: boolean }
/** Only the differences are written. The same set in another order is not a change: no version or updated_at moves. */
export function accessDiff(current: readonly string[], requested: readonly string[]): AccessDiff {
  const before = new Set(current), after = new Set(requested);
  const add = sortCompanyIds([...after].filter(id => !before.has(id)));
  const remove = sortCompanyIds([...before].filter(id => !after.has(id)));
  return { add, remove, changed: add.length + remove.length > 0 };
}

/* ------------------------------------------------ views ------------------------------------------------ */

export interface MemberRow {
  id: string; name: string; email: string; role: MemberRole; deactivatedAt: Date | null; version: number; createdAt: Date; companyIds: readonly string[];
}
export interface MemberView {
  id: string; user: { name: string; email: string }; role: MemberRole; status: 'active' | 'deactivated'; version: number;
  companyAccess: 'all' | 'assigned'; companyIds: string[]; createdAt: string;
}
/** A community manager sees every company (`all`, with an empty list so it cannot be read as "no accesses"). */
export function memberView(row: MemberRow): MemberView {
  const assigned = row.role !== 'community_manager';
  return {
    id: row.id, user: { name: row.name, email: row.email }, role: row.role, status: row.deactivatedAt === null ? 'active' : 'deactivated',
    version: row.version, companyAccess: assigned ? 'assigned' : 'all', companyIds: assigned ? sortCompanyIds(row.companyIds) : [],
    createdAt: row.createdAt.toISOString(),
  };
}
export interface AccessUpdateResult { id: string; role: MemberRole; version: number; companyIds: string[] }
export function accessUpdateResult(input: { id: string; role: MemberRole; version: number; companyIds: readonly string[] }): AccessUpdateResult {
  return { id: input.id, role: input.role, version: input.version, companyIds: sortCompanyIds(input.companyIds) };
}
