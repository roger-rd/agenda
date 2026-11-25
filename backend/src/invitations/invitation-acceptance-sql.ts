/**
 * Fixed statements of the acceptance (not executed yet: the service is a later block). Every value travels as a bound parameter. The
 * session row is NOT here: its creation is shared with the login and arrives with the session helper.
 * $1 of the first two is the bytea token hash (hashInvitationToken), the only way to find an invitation.
 */

/** Read without locking, to decide early (before hashing) and to inspect. Never selects token_hash. */
export const INSPECT_INVITATION_SQL = 'SELECT i.id, i.email, i.role, i.created_at, i.expires_at, i.revoked_at, i.accepted_at, o.name AS organization_name, ARRAY(SELECT c.name FROM public.invitation_companies ic JOIN public.companies c ON c.id = ic.company_id AND c.organization_id = ic.organization_id WHERE ic.invitation_id = i.id AND ic.organization_id = i.organization_id ORDER BY c.name)::text[] AS company_names FROM public.invitations i JOIN public.organizations o ON o.id = i.organization_id WHERE i.token_hash = $1';

/** Locks the row until the end of the transaction; the clock is read after this returns. */
export const LOCK_INVITATION_BY_TOKEN_SQL = 'SELECT i.id, i.organization_id, i.email, i.role, i.created_at, i.expires_at, i.revoked_at, i.accepted_at FROM public.invitations i WHERE i.token_hash = $1 FOR UPDATE OF i';

/** $1 invitation, $2 organization. */
export const ACCEPTANCE_COMPANIES_SQL = 'SELECT company_id FROM public.invitation_companies WHERE invitation_id = $1 AND organization_id = $2 ORDER BY company_id';

/** $1 normalized email. An existing account never gets a membership from this flow, whatever its state. */
export const USER_EXISTS_BY_EMAIL_SQL = 'SELECT 1 AS found FROM public.users WHERE email = $1 LIMIT 1';

/** $1 id, $2 email, $3 name, $4 password hash, $5 now (created, updated and password change). */
export const INSERT_USER_SQL = 'INSERT INTO public.users (id, email, name, password_hash, password_changed_at, version, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $5, $5)';

/** $1 id, $2 organization, $3 user, $4 role, $5 now. Never deactivated. */
export const INSERT_MEMBERSHIP_SQL = 'INSERT INTO public.organization_memberships (id, organization_id, user_id, role, deactivated_at, version, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, 1, $5, $5)';

/** $1 membership, $2 organization, $3 role (the composite foreign key requires it to equal the membership role), $4 now, $5 company ids. */
export const INSERT_ACCESSES_SQL = 'INSERT INTO public.company_accesses (membership_id, company_id, organization_id, membership_role, created_at) SELECT $1::uuid, c, $2::uuid, $3::varchar, $4::timestamptz FROM unnest($5::uuid[]) AS c';

/**
 * $1 invitation, $2 the instant read after the lock, $3 user. Both acceptance columns move together (CK_invitations_acceptance_pair)
 * and the predicate keeps created_at <= $2 < expires_at (CK_invitations_times) with no GREATEST: a row that does not qualify returns
 * nothing and the caller rolls back.
 */
export const MARK_ACCEPTED_SQL = 'UPDATE public.invitations SET accepted_at = $2::timestamptz, accepted_by_user_id = $3 WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND created_at <= $2::timestamptz AND expires_at > $2::timestamptz RETURNING id';

export const ACCEPTANCE_SQL = Object.freeze({
  INSPECT_INVITATION_SQL, LOCK_INVITATION_BY_TOKEN_SQL, ACCEPTANCE_COMPANIES_SQL, USER_EXISTS_BY_EMAIL_SQL,
  INSERT_USER_SQL, INSERT_MEMBERSHIP_SQL, INSERT_ACCESSES_SQL, MARK_ACCEPTED_SQL,
});
