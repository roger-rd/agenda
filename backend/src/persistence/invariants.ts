/**
 * What the schema guarantees and what it cannot. Each SQL-enforced rule names the constraints that carry it (the tests
 * check that they exist); each service-enforced rule needs application logic, a transaction or both.
 */
export interface SqlRule { readonly id: string; readonly description: string; readonly constraints: readonly string[] }
export interface ServiceRule { readonly id: string; readonly description: string }

export const SQL_ENFORCED: readonly SqlRule[] = Object.freeze([
  { id: 'single_organization_references', description: 'A company, access, post, comment or session can only reference rows of its own organization.',
    constraints: ['FK_companies_organization', 'FK_company_accesses_membership', 'FK_company_accesses_company', 'FK_posts_company', 'FK_posts_responsible',
      'FK_posts_created_by', 'FK_posts_confirmed_by', 'FK_posts_deleted_by', 'FK_post_comments_post', 'FK_post_comments_author', 'FK_user_sessions_membership'] },
  { id: 'unique_email', description: 'One user per e-mail, globally; stored in canonical lowercase form.', constraints: ['UQ_users_email', 'CK_users_email'] },
  { id: 'unique_organization_name', description: 'Organization names are unique by normalized key.', constraints: ['UQ_organizations_name_key', 'CK_organizations_name_key'] },
  { id: 'unique_company_name', description: 'Company names are unique by normalized key inside an organization.', constraints: ['UQ_companies_org_name_key', 'CK_companies_name_key'] },
  { id: 'one_membership_per_user_and_organization', description: 'A user has at most one membership per organization.', constraints: ['UQ_organization_memberships_org_user'] },
  { id: 'closed_vocabularies', description: 'Roles, formats and statuses accept only the frontend values.',
    constraints: ['CK_organization_memberships_role', 'CK_posts_format', 'CK_posts_status', 'CK_company_accesses_role'] },
  { id: 'company_accesses_only_for_worker_and_client', description: 'A company access can only hang from a worker or client membership.',
    constraints: ['CK_company_accesses_role', 'FK_company_accesses_membership'] },
  { id: 'confirmation_iff_uploaded', description: 'confirmed_by_user_id and confirmed_at are both present exactly when the status is Subido.', constraints: ['CK_posts_confirmation'] },
  { id: 'soft_delete_pair', description: 'deleted_at and deleted_by_user_id are set together.', constraints: ['CK_posts_soft_delete'] },
  { id: 'text_limits', description: 'Title 1-120, description up to 5000, comment 1-2000, trimmed; Instagram URL http(s).',
    constraints: ['CK_posts_title', 'CK_posts_description', 'CK_post_comments_body', 'CK_posts_instagram_url'] },
  { id: 'company_color_format', description: 'Company color is #rrggbb in lowercase.', constraints: ['CK_companies_color'] },
  { id: 'application_generated_uuid_v7', description: 'Every primary key is a canonical UUIDv7.',
    constraints: ['CK_organizations_id_v7', 'CK_users_id_v7', 'CK_organization_memberships_id_v7', 'CK_companies_id_v7', 'CK_posts_id_v7', 'CK_post_comments_id_v7', 'CK_user_sessions_id_v7'] },
  { id: 'password_hash_shape', description: 'Only an Argon2id PHC string can be stored as a password hash.', constraints: ['CK_users_password_hash'] },
  { id: 'session_integrity', description: 'Opaque sessions store a 32-byte token hash; the active organization must be one of the user memberships; timestamps are ordered.',
    constraints: ['UQ_user_sessions_token_hash', 'CK_user_sessions_token_hash', 'CK_user_sessions_times', 'FK_user_sessions_membership'] },
  { id: 'comments_survive_soft_deleted_posts', description: 'Posts are never hard-deleted by the application: the comment foreign key is RESTRICT.', constraints: ['FK_post_comments_post'] },
  { id: 'version_positive', description: 'Optimistic-concurrency versions start at 1.', constraints: ['CK_organizations_version', 'CK_users_version', 'CK_companies_version', 'CK_posts_version'] },
]);

export const SERVICE_ENFORCED: readonly ServiceRule[] = Object.freeze([
  { id: 'keep_one_active_community_manager', description: 'An organization must always keep at least one active community manager. A table or entity cannot guarantee it: it needs a transaction with a lock on the organization memberships (or a deferred constraint trigger) around every role change, deactivation or removal.' },
  { id: 'responsible_authorization_at_write', description: 'The responsible of a post must be a community manager or a worker with access to the company when the post is saved. The schema only requires an organization member, because losing access later must keep the post.' },
  { id: 'unauthorized_responsible_cannot_operate', description: 'While the responsible has no access, the post cannot be edited by others, change status or receive comments; only a community manager may reassign it.' },
  { id: 'permission_matrix', description: 'Role permissions (src/store/permissions.ts) and client visibility (client_visible) are applied by the service on every query.' },
  { id: 'organization_and_company_context', description: 'Every query is filtered by the organization of the session and by the companies reachable by the membership; foreign ids answer 404.' },
  { id: 'santiago_civil_time', description: 'scheduled_at is a UTC instant; the service validates that the local America/Santiago date and time exist.' },
  { id: 'name_and_email_normalization', description: 'The service computes name_key (accent and case folding, collapsed Unicode spaces) and the canonical e-mail; the schema only checks the canonical form.' },
  { id: 'confirmation_transition', description: 'The service chooses who and when confirms: set on entering Subido, kept while it stays Subido, cleared on leaving. The schema only checks consistency.' },
  { id: 'soft_delete_semantics', description: 'The service sets deleted_at and deleted_by_user_id together, hides deleted posts and their comments, and never hard-deletes posts.' },
  { id: 'comment_rules', description: 'Comments are immutable; the author must be allowed to comment on a post visible to them. A trigger could enforce immutability later.' },
  { id: 'optimistic_concurrency', description: 'Updates must be conditional on the expected version and increment it.' },
  { id: 'credentials_and_sessions', description: 'Argon2id parameters, 256-bit random session tokens stored only as SHA-256, rotation, idle and absolute expiry, revocation on password change.' },
  { id: 'dates_and_defaults', description: 'Identifiers and timestamps come from the application; the schema defines no database defaults.' },
]);
