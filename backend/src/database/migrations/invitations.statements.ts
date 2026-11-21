/** Frozen invitation DDL. No runtime generation, data, grants or extensions. Immutable once published. */
/** Phase 1: tables without foreign keys. */
export const CREATE_TABLES: readonly string[] = Object.freeze([
  String.raw`CREATE TABLE "public"."invitations" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "email" character varying(120) NOT NULL,
  "role" character varying(20) NOT NULL,
  "token_hash" bytea NOT NULL,
  "created_by_membership_id" uuid NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "revoked_at" TIMESTAMP WITH TIME ZONE,
  "accepted_at" TIMESTAMP WITH TIME ZONE,
  "accepted_by_user_id" uuid,
  CONSTRAINT "UQ_invitations_id_org" UNIQUE ("id", "organization_id"),
  CONSTRAINT "UQ_invitations_token_hash" UNIQUE ("token_hash"),
  CONSTRAINT "CK_invitations_acceptance_pair" CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
  CONSTRAINT "CK_invitations_email" CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 120 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  CONSTRAINT "CK_invitations_id_v7" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')),
  CONSTRAINT "CK_invitations_role" CHECK (role IN ('worker', 'client')),
  CONSTRAINT "CK_invitations_state" CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT "CK_invitations_times" CHECK (expires_at > created_at AND (revoked_at IS NULL OR revoked_at >= created_at) AND (accepted_at IS NULL OR (accepted_at >= created_at AND accepted_at < expires_at))),
  CONSTRAINT "CK_invitations_token_hash" CHECK (octet_length(token_hash) = 32),
  CONSTRAINT "PK_invitations" PRIMARY KEY ("id")
)`,
  String.raw`CREATE TABLE "public"."invitation_companies" (
  "invitation_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  CONSTRAINT "PK_invitation_companies" PRIMARY KEY ("invitation_id", "company_id")
)`,
]);

/** Phase 2: foreign keys after all unique targets exist. */
export const ADD_FOREIGN_KEYS: readonly string[] = Object.freeze([
  String.raw`ALTER TABLE "public"."invitations" ADD CONSTRAINT "FK_invitations_organization" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."invitations" ADD CONSTRAINT "FK_invitations_created_by" FOREIGN KEY ("created_by_membership_id", "organization_id") REFERENCES "public"."organization_memberships" ("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."invitations" ADD CONSTRAINT "FK_invitations_accepted_by" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."invitation_companies" ADD CONSTRAINT "FK_invitation_companies_invitation" FOREIGN KEY ("invitation_id", "organization_id") REFERENCES "public"."invitations" ("id", "organization_id") ON DELETE CASCADE ON UPDATE RESTRICT`,
  String.raw`ALTER TABLE "public"."invitation_companies" ADD CONSTRAINT "FK_invitation_companies_company" FOREIGN KEY ("company_id", "organization_id") REFERENCES "public"."companies" ("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
]);

/** Phase 3: explicit indexes, including one partial unique index. */
export const CREATE_INDEXES: readonly string[] = Object.freeze([
  String.raw`CREATE INDEX "IX_invitations_org_created" ON "public"."invitations" ("organization_id", "created_at", "id")`,
  String.raw`CREATE UNIQUE INDEX "UQ_invitations_open_email" ON "public"."invitations" ("organization_id", "email") WHERE accepted_at IS NULL AND revoked_at IS NULL`,
  String.raw`CREATE INDEX "IX_invitation_companies_company" ON "public"."invitation_companies" ("company_id")`,
]);

/** Reverse creation order; children first. */
export const DROP_TABLES: readonly string[] = Object.freeze([
  String.raw`DROP TABLE "public"."invitation_companies"`,
  String.raw`DROP TABLE "public"."invitations"`,
]);

export const TABLE_ORDER: readonly string[] = Object.freeze(['invitations', 'invitation_companies']);
export const UP_STATEMENTS: readonly string[] = Object.freeze([...CREATE_TABLES, ...ADD_FOREIGN_KEYS, ...CREATE_INDEXES]);
export const DOWN_STATEMENTS: readonly string[] = DROP_TABLES;
/** Explicit indexes only; PK and UNIQUE backing indexes are derived in offline tests. */
export const COUNTS = Object.freeze({ tables: 2, indexes: 3, foreignKeys: 5, uniques: 2, checks: 7, primaryKeys: 2 });
