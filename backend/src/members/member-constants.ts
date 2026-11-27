/** A member of an organization has between 0 and 50 explicit company accesses; `[]` removes them all. */
export const MEMBER_MIN_COMPANIES = 0;
export const MEMBER_MAX_COMPANIES = 50;

/** Closed role set of the schema; kept local because only the persistence layer may import its entities. */
export const MEMBER_ROLES = ['community_manager', 'worker', 'client'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
/** Only these roles receive explicit accesses; the community manager sees every company of the organization. */
export const ASSIGNABLE_ROLES = ['worker', 'client'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const MEMBER_STATUS_FILTERS = ['active', 'deactivated', 'all'] as const;
export type MemberStatusFilter = (typeof MEMBER_STATUS_FILTERS)[number];
/** Deactivated members are only listed when asked for (`deactivated` or `all`). */
export const DEFAULT_MEMBER_STATUS: MemberStatusFilter = 'active';
/** Page size when absent and its bounds are those of the shared pagination DTO: 20, between 1 and 100. */
export const DEFAULT_MEMBER_PAGE_SIZE = 20;
export const MAX_VERSION = 2147483647;
