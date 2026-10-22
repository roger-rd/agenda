import type { Role } from '../types';
import type { PLATFORM_ADMIN_ID } from './ids';
export type AdminSession = { kind: 'platform_admin'; adminId: typeof PLATFORM_ADMIN_ID };
export type AccessStatus = 'active' | 'suspended';
export interface Suspension { at: string; reason?: string }
export interface PlatformOrganization {
  id: string; name: string; status: AccessStatus; createdAt: string;
  workspaceLinked: boolean; suspension?: Suspension;
}
export interface PlatformMember {
  id: string; organizationId: string; name: string; email: string; role: Role;
  example: boolean; invitation?: { simulated: true; createdAt: string };
}
export interface PlatformCompany {
  id: string; organizationId: string; name: string; color: string; example: true;
}
export interface MemberAccess {
  organizationId: string; userId: string; status: AccessStatus; suspension?: Suspension;
}
export interface PlatformState {
  version: 1; revision: number; organizations: PlatformOrganization[];
  members: PlatformMember[]; companies: PlatformCompany[]; memberAccess: MemberAccess[];
}
export type ErrorCode = 'no_admin_session' | 'invalid_input' | 'duplicate_name' |
  'duplicate_email' | 'not_found' | 'no_change' | 'unknown_member';
export type Result<T = PlatformState> = { ok: true; value: T } |
  { ok: false; reason: string; code: ErrorCode; field?: string };
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
