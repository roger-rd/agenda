import { DomainError } from '../common/errors/domain-error';
import { STALE } from '../database/errors/database-http';

/** Distinguishable 409s of the access update; fixed messages. A member that does not exist or belongs to another organization is a 404. */
export const MEMBER_CONFLICTS = Object.freeze({
  version_conflict: STALE,
  member_deactivated: 'El miembro está desactivado: sus accesos no se pueden cambiar.',
  member_not_assignable: 'El community manager ya accede a todas las empresas: no tiene accesos por empresa.',
} as const);
export type MemberConflictCode = keyof typeof MEMBER_CONFLICTS;
export class MemberConflictError extends DomainError {
  constructor(code: MemberConflictCode) { super(code, 409, MEMBER_CONFLICTS[code]); }
}
