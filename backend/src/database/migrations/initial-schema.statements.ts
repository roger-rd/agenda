/**
 * Frozen DDL of the initial schema (PostgreSQL 16). Written out explicitly: nothing is generated while a migration
 * runs, and the entities are never read at that time. The offline tests compare these statements with what TypeORM
 * would emit for the eight entities of src/persistence, so an entity change without a NEW migration breaks them.
 *
 * IMMUTABLE once published or applied anywhere: never edit these statements. A schema change is a new migration with its
 * own frozen statements and its own pin in schema-manifest.ts.
 *
 * Tables are qualified with "public". No extensions, no GRANT/REVOKE (the database initialization already grants DML on
 * future tables of public to the application role), no data. schema_migrations is NOT part of this migration.
 */
/** Phase 1: eight tables with columns, primary key, unique constraints and CHECK constraints; no foreign keys. */
export const CREATE_TABLES: readonly string[] = Object.freeze([
  String.raw`CREATE TABLE "public"."organizations" (
  "id" uuid NOT NULL,
  "name" character varying(80) NOT NULL,
  "name_key" character varying(80) NOT NULL,
  "version" integer NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "UQ_organizations_name_key" UNIQUE ("name_key"),
  CONSTRAINT "CK_organizations_id_v7" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')),
  CONSTRAINT "CK_organizations_name_key" CHECK (char_length(name_key) BETWEEN 2 AND 80 AND name_key = btrim(name_key) AND name_key = lower(name_key)),
  CONSTRAINT "CK_organizations_name" CHECK (char_length(name) BETWEEN 2 AND 80 AND name = btrim(name) AND name !~ '  ' AND name !~ '[[:cntrl:]]'),
  CONSTRAINT "CK_organizations_version" CHECK (version >= 1),
  CONSTRAINT "PK_organizations" PRIMARY KEY ("id")
)`,
  String.raw`CREATE TABLE "public"."users" (
  "id" uuid NOT NULL,
  "email" character varying(120) NOT NULL,
  "name" character varying(80) NOT NULL,
  "password_hash" text NOT NULL,
  "password_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "version" integer NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "UQ_users_email" UNIQUE ("email"),
  CONSTRAINT "CK_users_email" CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 120 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  CONSTRAINT "CK_users_id_v7" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')),
  CONSTRAINT "CK_users_name" CHECK (char_length(name) BETWEEN 2 AND 80 AND name = btrim(name) AND name !~ '  ' AND name !~ '[[:cntrl:]]'),
  CONSTRAINT "CK_users_password_hash" CHECK (password_hash LIKE '$argon2id$%' AND char_length(password_hash) BETWEEN 40 AND 512),
  CONSTRAINT "CK_users_version" CHECK (version >= 1),
  CONSTRAINT "PK_users" PRIMARY KEY ("id")
)`,
  String.raw`CREATE TABLE "public"."organization_memberships" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" character varying(20) NOT NULL,
  "deactivated_at" TIMESTAMP WITH TIME ZONE,
  "version" integer NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "UQ_organization_memberships_id_org_role" UNIQUE ("id", "organization_id", "role"),
  CONSTRAINT "UQ_organization_memberships_id_org" UNIQUE ("id", "organization_id"),
  CONSTRAINT "UQ_organization_memberships_org_user" UNIQUE ("organization_id", "user_id"),
  CONSTRAINT "CK_organization_memberships_deactivated" CHECK (deactivated_at IS NULL OR deactivated_at >= created_at),
  CONSTRAINT "CK_organization_memberships_id_v7" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')),
  CONSTRAINT "CK_organization_memberships_role" CHECK (role IN ('community_manager', 'worker', 'client')),
  CONSTRAINT "CK_organization_memberships_version" CHECK (version >= 1),
  CONSTRAINT "PK_organization_memberships" PRIMARY KEY ("id")
)`,
  String.raw`CREATE TABLE "public"."companies" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "name" character varying(80) NOT NULL,
  "name_key" character varying(80) NOT NULL,
  "color" character varying(7) NOT NULL,
  "version" integer NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "UQ_companies_id_org" UNIQUE ("id", "organization_id"),
  CONSTRAINT "UQ_companies_org_name_key" UNIQUE ("organization_id", "name_key"),
  CONSTRAINT "CK_companies_color" CHECK (color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT "CK_companies_id_v7" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')),
  CONSTRAINT "CK_companies_name_key" CHECK (char_length(name_key) BETWEEN 2 AND 80 AND name_key = btrim(name_key) AND name_key = lower(name_key)),
  CONSTRAINT "CK_companies_name" CHECK (char_length(name) BETWEEN 2 AND 80 AND name = btrim(name) AND name !~ '  ' AND name !~ '[[:cntrl:]]'),
  CONSTRAINT "CK_companies_version" CHECK (version >= 1),
  CONSTRAINT "PK_companies" PRIMARY KEY ("id")
)`,
  String.raw`CREATE TABLE "public"."company_accesses" (
  "membership_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "membership_role" character varying(20) NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "CK_company_accesses_role" CHECK (membership_role IN ('worker', 'client')),
  CONSTRAINT "PK_company_accesses" PRIMARY KEY ("membership_id", "company_id")
)`,
  String.raw`CREATE TABLE "public"."user_sessions" (
  "id" uuid NOT NULL,
  "token_hash" bytea NOT NULL,
  "user_id" uuid NOT NULL,
  "active_organization_id" uuid,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "revoked_at" TIMESTAMP WITH TIME ZONE,
  CONSTRAINT "UQ_user_sessions_token_hash" UNIQUE ("token_hash"),
  CONSTRAINT "CK_user_sessions_id_v7" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')),
  CONSTRAINT "CK_user_sessions_times" CHECK (expires_at > created_at AND last_seen_at >= created_at AND (revoked_at IS NULL OR revoked_at >= created_at)),
  CONSTRAINT "CK_user_sessions_token_hash" CHECK (octet_length(token_hash) = 32),
  CONSTRAINT "PK_user_sessions" PRIMARY KEY ("id")
)`,
  String.raw`CREATE TABLE "public"."posts" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "title" character varying(120) NOT NULL,
  "description" text NOT NULL,
  "scheduled_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "format" character varying(10) NOT NULL,
  "status" character varying(12) NOT NULL,
  "responsible_user_id" uuid NOT NULL,
  "client_visible" boolean NOT NULL,
  "instagram_url" character varying(2048),
  "confirmed_by_user_id" uuid,
  "confirmed_at" TIMESTAMP WITH TIME ZONE,
  "created_by_user_id" uuid NOT NULL,
  "deleted_at" TIMESTAMP WITH TIME ZONE,
  "deleted_by_user_id" uuid,
  "version" integer NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "UQ_posts_id_org" UNIQUE ("id", "organization_id"),
  CONSTRAINT "CK_posts_confirmation" CHECK (((status = 'Subido') = (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)) AND ((confirmed_by_user_id IS NULL) = (confirmed_at IS NULL))),
  CONSTRAINT "CK_posts_description" CHECK (char_length(description) <= 5000),
  CONSTRAINT "CK_posts_format" CHECK (format IN ('Post', 'Carrusel', 'Reel', 'Historia')),
  CONSTRAINT "CK_posts_id_v7" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')),
  CONSTRAINT "CK_posts_instagram_url" CHECK (instagram_url IS NULL OR (char_length(instagram_url) <= 2048 AND instagram_url ~* '^https?://[^[:space:]]+$')),
  CONSTRAINT "CK_posts_soft_delete" CHECK ((deleted_at IS NULL) = (deleted_by_user_id IS NULL)),
  CONSTRAINT "CK_posts_status" CHECK (status IN ('Pendiente', 'En proceso', 'Completado', 'Subido')),
  CONSTRAINT "CK_posts_title" CHECK (char_length(title) BETWEEN 1 AND 120 AND title = btrim(title)),
  CONSTRAINT "CK_posts_version" CHECK (version >= 1),
  CONSTRAINT "PK_posts" PRIMARY KEY ("id")
)`,
  String.raw`CREATE TABLE "public"."post_comments" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "post_id" uuid NOT NULL,
  "author_user_id" uuid NOT NULL,
  "body" text NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "CK_post_comments_body" CHECK (char_length(body) BETWEEN 1 AND 2000 AND body = btrim(body)),
  CONSTRAINT "CK_post_comments_id_v7" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')),
  CONSTRAINT "PK_post_comments" PRIMARY KEY ("id")
)`,
]);

/** Phase 2: nine non-unique indexes (four partial). */
export const CREATE_INDEXES: readonly string[] = Object.freeze([
  String.raw`CREATE INDEX "IX_organization_memberships_active_managers" ON "public"."organization_memberships" ("organization_id") WHERE role = 'community_manager' AND deactivated_at IS NULL`,
  String.raw`CREATE INDEX "IX_organization_memberships_user" ON "public"."organization_memberships" ("user_id")`,
  String.raw`CREATE INDEX "IX_company_accesses_company" ON "public"."company_accesses" ("company_id")`,
  String.raw`CREATE INDEX "IX_user_sessions_expires" ON "public"."user_sessions" ("expires_at")`,
  String.raw`CREATE INDEX "IX_user_sessions_user" ON "public"."user_sessions" ("user_id")`,
  String.raw`CREATE INDEX "IX_posts_company_schedule" ON "public"."posts" ("company_id", "scheduled_at") WHERE deleted_at IS NULL`,
  String.raw`CREATE INDEX "IX_posts_org_schedule" ON "public"."posts" ("organization_id", "scheduled_at") WHERE deleted_at IS NULL`,
  String.raw`CREATE INDEX "IX_posts_responsible" ON "public"."posts" ("organization_id", "responsible_user_id") WHERE deleted_at IS NULL`,
  String.raw`CREATE INDEX "IX_post_comments_post_created" ON "public"."post_comments" ("post_id", "created_at", "id")`,
]);

/** Phase 3: fourteen foreign keys, added once every table and every unique target exists. */
export const ADD_FOREIGN_KEYS: readonly string[] = Object.freeze([
  String.raw`ALTER TABLE "public"."organization_memberships" ADD CONSTRAINT "FK_organization_memberships_organization" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."organization_memberships" ADD CONSTRAINT "FK_organization_memberships_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."companies" ADD CONSTRAINT "FK_companies_organization" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."company_accesses" ADD CONSTRAINT "FK_company_accesses_company" FOREIGN KEY ("company_id", "organization_id") REFERENCES "public"."companies" ("id", "organization_id") ON DELETE CASCADE ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."company_accesses" ADD CONSTRAINT "FK_company_accesses_membership" FOREIGN KEY ("membership_id", "organization_id", "membership_role") REFERENCES "public"."organization_memberships" ("id", "organization_id", "role") ON DELETE CASCADE ON UPDATE CASCADE`,
  String.raw`ALTER TABLE "public"."user_sessions" ADD CONSTRAINT "FK_user_sessions_membership" FOREIGN KEY ("active_organization_id", "user_id") REFERENCES "public"."organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."user_sessions" ADD CONSTRAINT "FK_user_sessions_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."posts" ADD CONSTRAINT "FK_posts_company" FOREIGN KEY ("company_id", "organization_id") REFERENCES "public"."companies" ("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."posts" ADD CONSTRAINT "FK_posts_confirmed_by" FOREIGN KEY ("organization_id", "confirmed_by_user_id") REFERENCES "public"."organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."posts" ADD CONSTRAINT "FK_posts_created_by" FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "public"."organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."posts" ADD CONSTRAINT "FK_posts_deleted_by" FOREIGN KEY ("organization_id", "deleted_by_user_id") REFERENCES "public"."organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."posts" ADD CONSTRAINT "FK_posts_responsible" FOREIGN KEY ("organization_id", "responsible_user_id") REFERENCES "public"."organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."post_comments" ADD CONSTRAINT "FK_post_comments_author" FOREIGN KEY ("organization_id", "author_user_id") REFERENCES "public"."organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."post_comments" ADD CONSTRAINT "FK_post_comments_post" FOREIGN KEY ("post_id", "organization_id") REFERENCES "public"."posts" ("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
]);

/** Reverse of phase 1, children first, without CASCADE. */
export const DROP_TABLES: readonly string[] = Object.freeze([
  String.raw`DROP TABLE "public"."post_comments"`,
  String.raw`DROP TABLE "public"."posts"`,
  String.raw`DROP TABLE "public"."user_sessions"`,
  String.raw`DROP TABLE "public"."company_accesses"`,
  String.raw`DROP TABLE "public"."companies"`,
  String.raw`DROP TABLE "public"."organization_memberships"`,
  String.raw`DROP TABLE "public"."users"`,
  String.raw`DROP TABLE "public"."organizations"`,
]);

/** Creation order of the tables; also the order in which the foreign keys are added. */
export const TABLE_ORDER: readonly string[] = Object.freeze([
  'organizations', 'users', 'organization_memberships', 'companies', 'company_accesses', 'user_sessions', 'posts', 'post_comments',
]);

/** Everything `up` executes, in order: tables, then indexes, then foreign keys. */
export const UP_STATEMENTS: readonly string[] = Object.freeze([...CREATE_TABLES, ...CREATE_INDEXES, ...ADD_FOREIGN_KEYS]);

/** Everything `down` executes. Development and test databases only; it destroys all data of the eight tables. */
export const DOWN_STATEMENTS: readonly string[] = DROP_TABLES;

/** Expected sizes, repeated in the tests as an independent check. */
export const COUNTS = Object.freeze({ tables: 8, indexes: 9, foreignKeys: 14, uniques: 9, checks: 33, primaryKeys: 8 });
