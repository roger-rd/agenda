/**
 * Fixed statements of the members block (not executed yet: the service is a later block). Every value travels as a bound parameter and
 * every statement is scoped by the organization of the session. The access update is one transaction:
 *   1. LOCK_MEMBER_SQL            lock the membership (FOR UPDATE), scoped by organization;
 *   2. decide on that row         existence, version, role, state (memberUpdateDecision);
 *   3. COUNT_ORG_COMPANIES_SQL    every requested company belongs to the organization; CURRENT_ACCESSES_SQL and accessDiff;
 *   4. only if something changes  DELETE_ACCESSES_SQL (removed), INSERT_ACCESSES_SQL (added), BUMP_MEMBER_VERSION_SQL once.
 * The same set changes nothing: neither version nor updated_at.
 */
export const LOCK_MEMBER_SQL = 'SELECT m.id, m.role, m.version, m.deactivated_at FROM public.organization_memberships m WHERE m.id = $1 AND m.organization_id = $2 FOR UPDATE OF m';
/** $1 organization, $2 company ids. Fewer rows than ids asked: some are missing or of another organization (same answer). */
export const COUNT_ORG_COMPANIES_SQL = 'SELECT count(*)::int AS found FROM public.companies WHERE organization_id = $1 AND id = ANY($2::uuid[])';
export const CURRENT_ACCESSES_SQL = 'SELECT company_id FROM public.company_accesses WHERE membership_id = $1 AND organization_id = $2 ORDER BY company_id';
export const DELETE_ACCESSES_SQL = 'DELETE FROM public.company_accesses WHERE membership_id = $1 AND organization_id = $2 AND company_id = ANY($3::uuid[])';
/** $1 membership, $2 organization, $3 role of the locked row (required by the composite foreign key), $4 now, $5 added company ids. */
export const INSERT_ACCESSES_SQL = 'INSERT INTO public.company_accesses (membership_id, company_id, organization_id, membership_role, created_at) SELECT $1::uuid, c, $2::uuid, $3::varchar, $4::timestamptz FROM unnest($5::uuid[]) AS c';
/** $1 membership, $2 organization, $3 now, $4 version checked under the lock. Runs once per effective change. */
export const BUMP_MEMBER_VERSION_SQL = 'UPDATE public.organization_memberships SET version = version + 1, updated_at = $3::timestamptz WHERE id = $1 AND organization_id = $2 AND version = $4 RETURNING version';
/**
 * $1 organization, $2 cursor id or null, $3 role or null, $4 'active' | 'deactivated' | 'all', $5 limit + 1.
 * Order by member id; company ids in the same deterministic order as the API (ascending).
 */
export const LIST_MEMBERS_SQL = "SELECT m.id, u.name, u.email, m.role, m.deactivated_at, m.version, m.created_at, ARRAY(SELECT a.company_id::text FROM public.company_accesses a WHERE a.membership_id = m.id AND a.organization_id = m.organization_id ORDER BY a.company_id)::text[] AS company_ids FROM public.organization_memberships m JOIN public.users u ON u.id = m.user_id WHERE m.organization_id = $1 AND ($2::uuid IS NULL OR m.id > $2::uuid) AND ($3::text IS NULL OR m.role = $3::text) AND ($4::text = 'all' OR ($4::text = 'active' AND m.deactivated_at IS NULL) OR ($4::text = 'deactivated' AND m.deactivated_at IS NOT NULL)) ORDER BY m.id LIMIT $5";

export const MEMBER_SQL = Object.freeze({
  LOCK_MEMBER_SQL, COUNT_ORG_COMPANIES_SQL, CURRENT_ACCESSES_SQL, DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL, BUMP_MEMBER_VERSION_SQL, LIST_MEMBERS_SQL,
});
