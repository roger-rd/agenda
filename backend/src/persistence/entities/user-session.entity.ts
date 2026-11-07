import { inspect } from 'node:util';
import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn, Unique } from 'typeorm';
import { LIMITS, uuidV7 } from '../constants';
import { OrganizationMembership } from './organization-membership.entity';
import { User } from './user.entity';

/**
 * Opaque, revocable server-side session. The cookie carries a random token; only its SHA-256 is stored here, never the
 * token. `active_organization_id` is NULL until the user picks an organization; when present, the composite foreign key
 * requires the user to be a member of it (MATCH SIMPLE: no check while it is NULL).
 */
@Entity({ name: 'user_sessions' })
@Unique('UQ_user_sessions_token_hash', ['tokenHash'])
@Index('IX_user_sessions_user', ['userId'])
@Index('IX_user_sessions_expires', ['expiresAt'])
@Check('CK_user_sessions_id_v7', uuidV7('id'))
@Check('CK_user_sessions_token_hash', `octet_length(token_hash) = ${LIMITS.tokenHashBytes}`)
@Check('CK_user_sessions_times', 'expires_at > created_at AND last_seen_at >= created_at AND (revoked_at IS NULL OR revoked_at >= created_at)')
@ForeignKey(() => User, ['userId'], ['id'], { name: 'FK_user_sessions_user', onDelete: 'CASCADE', onUpdate: 'RESTRICT' })
@ForeignKey(() => OrganizationMembership, ['activeOrganizationId', 'userId'], ['organizationId', 'userId'], { name: 'FK_user_sessions_membership', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
export class UserSession {
  @PrimaryColumn({ type: 'uuid', name: 'id', primaryKeyConstraintName: 'PK_user_sessions' })
  id!: string;

  /** SHA-256 of the session token. Never selected by default, serialized or printed. */
  @Column({ type: 'bytea', name: 'token_hash', select: false })
  tokenHash!: Buffer;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'active_organization_id', nullable: true })
  activeOrganizationId!: string | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  lastSeenAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  toJSON() {
    return { id: this.id, userId: this.userId, activeOrganizationId: this.activeOrganizationId, createdAt: this.createdAt,
      lastSeenAt: this.lastSeenAt, expiresAt: this.expiresAt, revokedAt: this.revokedAt };
  }

  [inspect.custom](): string { return `UserSession(${String(this.id)})`; }
}
