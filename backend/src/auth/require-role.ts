import { SetMetadata } from '@nestjs/common';

export type RequiredRole = 'community_manager' | 'worker' | 'client';
export const REQUIRED_ROLES = Symbol('REQUIRED_ROLES');
export const RequireRole = (...roles: RequiredRole[]) => SetMetadata(REQUIRED_ROLES, roles);
