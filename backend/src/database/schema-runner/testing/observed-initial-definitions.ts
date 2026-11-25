import type { StructureRow } from '../schema-structure';

/**
 * OBSERVED_INITIAL_DEFINITIONS: the 37 normalized definitions of the initial schema as printed by a read-only
 * `plan --show-definitions` on agenda_test (33 CHECK + 4 predicates). kind:table:name -> normalized text.
 *
 * RECONSTRUCTED_INVITATION_DEFINITIONS: the 8 definitions of the invitations migration (7 CHECK + 1 predicate). Their text was NOT
 * received from the database: it was reconstructed from the frozen statements applying the same PostgreSQL printing rules seen in
 * the 37 observed ones, and then confirmed through the observed structure digest of prefix 2 (66741a61...), which the reconstruction
 * reproduces exactly. The digest proves the text matches; it does not replace having read the original lines.
 *
 * Used only offline, so simulated catalogs return PostgreSQL's canonical text.
 */
const ID_V7 = "CHECK ( substr ( id :: text , 15 , 1 ) = '7' :: text AND ( substr ( id :: text , 20 , 1 ) = ANY ( ARRAY [ '8' :: text , '9' :: text , 'a' :: text , 'b' :: text ] ) ) )";
const NAME = "CHECK ( char_length ( name :: text ) >= 2 AND char_length ( name :: text ) <= 80 AND name :: text = btrim ( name :: text ) AND name :: text !~ '  ' :: text AND name :: text !~ '[[:cntrl:]]' :: text )";
const NAME_KEY = "CHECK ( char_length ( name_key :: text ) >= 2 AND char_length ( name_key :: text ) <= 80 AND name_key :: text = btrim ( name_key :: text ) AND name_key :: text = lower ( name_key :: text ) )";
const VERSION = 'CHECK ( version >= 1 )';
const enumOf = (column: string, values: readonly string[]) =>
  `CHECK ( ${column} :: text = ANY ( ARRAY [ ${values.map(v => `'${v}' :: character varying`).join(' , ')} ] :: text [ ] ) )`;

export const OBSERVED_INITIAL_DEFINITIONS: Readonly<Record<string, string>> = {
  'check:companies:CK_companies_color': "CHECK ( color :: text ~ '^#[0-9a-f]{6}$' :: text )",
  'check:companies:CK_companies_id_v7': ID_V7,
  'check:companies:CK_companies_name': NAME,
  'check:companies:CK_companies_name_key': NAME_KEY,
  'check:companies:CK_companies_version': VERSION,
  'check:company_accesses:CK_company_accesses_role': enumOf('membership_role', ['worker', 'client']),
  'check:organization_memberships:CK_organization_memberships_deactivated': 'CHECK ( deactivated_at IS NULL OR deactivated_at >= created_at )',
  'check:organization_memberships:CK_organization_memberships_id_v7': ID_V7,
  'check:organization_memberships:CK_organization_memberships_role': enumOf('role', ['community_manager', 'worker', 'client']),
  'check:organization_memberships:CK_organization_memberships_version': VERSION,
  'check:organizations:CK_organizations_id_v7': ID_V7,
  'check:organizations:CK_organizations_name': NAME,
  'check:organizations:CK_organizations_name_key': NAME_KEY,
  'check:organizations:CK_organizations_version': VERSION,
  'check:post_comments:CK_post_comments_body': 'CHECK ( char_length ( body ) >= 1 AND char_length ( body ) <= 2000 AND body = btrim ( body ) )',
  'check:post_comments:CK_post_comments_id_v7': ID_V7,
  'check:posts:CK_posts_confirmation': "CHECK ( ( status :: text = 'Subido' :: text ) = ( confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL ) AND ( confirmed_by_user_id IS NULL ) = ( confirmed_at IS NULL ) )",
  'check:posts:CK_posts_description': 'CHECK ( char_length ( description ) <= 5000 )',
  'check:posts:CK_posts_format': enumOf('format', ['Post', 'Carrusel', 'Reel', 'Historia']),
  'check:posts:CK_posts_id_v7': ID_V7,
  'check:posts:CK_posts_instagram_url': "CHECK ( instagram_url IS NULL OR char_length ( instagram_url :: text ) <= 2048 AND instagram_url :: text ~* '^https?://[^[:space:]]+$' :: text )",
  'check:posts:CK_posts_soft_delete': 'CHECK ( ( deleted_at IS NULL ) = ( deleted_by_user_id IS NULL ) )',
  'check:posts:CK_posts_status': enumOf('status', ['Pendiente', 'En proceso', 'Completado', 'Subido']),
  'check:posts:CK_posts_title': 'CHECK ( char_length ( title :: text ) >= 1 AND char_length ( title :: text ) <= 120 AND title :: text = btrim ( title :: text ) )',
  'check:posts:CK_posts_version': VERSION,
  'check:user_sessions:CK_user_sessions_id_v7': ID_V7,
  'check:user_sessions:CK_user_sessions_times': 'CHECK ( expires_at > created_at AND last_seen_at >= created_at AND ( revoked_at IS NULL OR revoked_at >= created_at ) )',
  'check:user_sessions:CK_user_sessions_token_hash': 'CHECK ( octet_length ( token_hash ) = 32 )',
  'check:users:CK_users_email': "CHECK ( email :: text = lower ( btrim ( email :: text ) ) AND char_length ( email :: text ) >= 3 AND char_length ( email :: text ) <= 120 AND email :: text ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' :: text )",
  'check:users:CK_users_id_v7': ID_V7,
  'check:users:CK_users_name': NAME,
  'check:users:CK_users_password_hash': "CHECK ( password_hash ~~ '$argon2id$%' :: text AND char_length ( password_hash ) >= 40 AND char_length ( password_hash ) <= 512 )",
  'check:users:CK_users_version': VERSION,
  'predicate:organization_memberships:IX_organization_memberships_active_managers': "( ( ( role ) :: text = 'community_manager' :: text ) AND ( deactivated_at IS NULL ) )",
  'predicate:posts:IX_posts_company_schedule': '( deleted_at IS NULL )',
  'predicate:posts:IX_posts_org_schedule': '( deleted_at IS NULL )',
  'predicate:posts:IX_posts_responsible': '( deleted_at IS NULL )',
};

export const RECONSTRUCTED_INVITATION_DEFINITIONS: Readonly<Record<string, string>> = {
  'check:invitations:CK_invitations_acceptance_pair': 'CHECK ( ( accepted_at IS NULL ) = ( accepted_by_user_id IS NULL ) )',
  'check:invitations:CK_invitations_email': OBSERVED_INITIAL_DEFINITIONS['check:users:CK_users_email'],
  'check:invitations:CK_invitations_id_v7': ID_V7,
  'check:invitations:CK_invitations_role': enumOf('role', ['worker', 'client']),
  'check:invitations:CK_invitations_state': 'CHECK ( NOT ( accepted_at IS NOT NULL AND revoked_at IS NOT NULL ) )',
  'check:invitations:CK_invitations_times': 'CHECK ( expires_at > created_at AND ( revoked_at IS NULL OR revoked_at >= created_at ) AND ( accepted_at IS NULL OR accepted_at >= created_at AND accepted_at < expires_at ) )',
  'check:invitations:CK_invitations_token_hash': 'CHECK ( octet_length ( token_hash ) = 32 )',
  'predicate:invitations:UQ_invitations_open_email': '( ( accepted_at IS NULL ) AND ( revoked_at IS NULL ) )',
};

const ALL_DEFINITIONS: Readonly<Record<string, string>> = { ...OBSERVED_INITIAL_DEFINITIONS, ...RECONSTRUCTED_INVITATION_DEFINITIONS };

const keyOf = (r: StructureRow): string | null =>
  r.kind === 'con' && r.type === 'c' ? `check:${r.table_name}:${r.name}` : r.kind === 'idx' && r.predicate !== null ? `predicate:${r.table_name}:${r.name}` : null;

/** What a PostgreSQL catalog returns: the frozen shape with the definitions of both migrations as PostgreSQL prints them. */
export function withObservedDefinitions<T extends StructureRow>(rows: readonly T[]): T[] {
  return rows.map(r => {
    const k = keyOf(r);
    if (k === null || !(k in ALL_DEFINITIONS)) return { ...r };
    return r.kind === 'con' ? { ...r, definition: ALL_DEFINITIONS[k] } : { ...r, predicate: ALL_DEFINITIONS[k] };
  });
}
