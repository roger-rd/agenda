import type { StructureRow } from '../schema-structure';

/**
 * Normalized definitions observed on agenda_test for the initial schema (read-only `plan --show-definitions`), used only offline to
 * check the pin. kind:table:name -> normalized text. Keys are sorted as the runner prints them.
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

const keyOf = (r: StructureRow): string | null =>
  r.kind === 'con' && r.type === 'c' ? `check:${r.table_name}:${r.name}` : r.kind === 'idx' && r.predicate !== null ? `predicate:${r.table_name}:${r.name}` : null;

/** What a PostgreSQL catalog returns for the initial schema: the frozen shape with the definitions as PostgreSQL prints them. */
export function withObservedDefinitions<T extends StructureRow>(rows: readonly T[]): T[] {
  return rows.map(r => {
    const k = keyOf(r);
    if (k === null || !(k in OBSERVED_INITIAL_DEFINITIONS)) return { ...r };
    return r.kind === 'con' ? { ...r, definition: OBSERVED_INITIAL_DEFINITIONS[k] } : { ...r, predicate: OBSERVED_INITIAL_DEFINITIONS[k] };
  });
}
