import { inspect } from 'node:util';
import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn, Unique } from 'typeorm';
import { ACCESS_ROLES, LIMITS, literals, uuidV7 } from '../constants';
import { Organization } from './organization.entity';
import { OrganizationMembership } from './organization-membership.entity';
import { User } from './user.entity';

/**
 * An opaque 32-byte token is shown once; only its SHA-256 is stored.
 * Single use requires a conditional UPDATE of an open, unexpired invitation, setting accepted_at and
 * accepted_by_user_id together. Composite foreign keys enforce organization isolation.
 */
@Entity({ name: 'invitations' })
@Unique('UQ_invitations_token_hash', ['tokenHash'])
@Unique('UQ_invitations_id_org', ['id', 'organizationId'])
@Index('IX_invitations_org_created', ['organizationId', 'createdAt', 'id'])
@Index('UQ_invitations_open_email', ['organizationId', 'email'], { unique: true, where: 'accepted_at IS NULL AND revoked_at IS NULL' })
@Check('CK_invitations_id_v7', uuidV7('id'))
@Check('CK_invitations_email', `email = lower(btrim(email)) AND char_length(email) BETWEEN ${LIMITS.email.min} AND ${LIMITS.email.max} AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'`)
@Check('CK_invitations_role', `role IN (${literals(ACCESS_ROLES)})`)
@Check('CK_invitations_token_hash', `octet_length(token_hash) = ${LIMITS.tokenHashBytes}`)
@Check('CK_invitations_times', 'expires_at > created_at AND (revoked_at IS NULL OR revoked_at >= created_at) AND (accepted_at IS NULL OR (accepted_at >= created_at AND accepted_at < expires_at))')
@Check('CK_invitations_state', 'NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)')
@Check('CK_invitations_acceptance_pair', '(accepted_at IS NULL) = (accepted_by_user_id IS NULL)')
@ForeignKey(() => Organization, ['organizationId'], ['id'], { name: 'FK_invitations_organization', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
@ForeignKey(() => OrganizationMembership, ['createdByMembershipId', 'organizationId'], ['id', 'organizationId'],
  { name: 'FK_invitations_created_by', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
@ForeignKey(() => User, ['acceptedByUserId'], ['id'], { name: 'FK_invitations_accepted_by', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
export class Invitation {
  @PrimaryColumn({ type: 'uuid', name: 'id', primaryKeyConstraintName: 'PK_invitations' })
  id!: string;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId!: string;

  @Column({ type: 'varchar', name: 'email', length: LIMITS.email.max })
  email!: string;

  @Column({ type: 'varchar', name: 'role', length: 20 })
  role!: (typeof ACCESS_ROLES)[number];

  @Column({ type: 'bytea', name: 'token_hash', select: false })
  tokenHash!: Buffer;

  @Column({ type: 'uuid', name: 'created_by_membership_id' })
  createdByMembershipId!: string;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'accepted_at', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'uuid', name: 'accepted_by_user_id', nullable: true })
  acceptedByUserId!: string | null;

  toJSON() {
    return { id: this.id, organizationId: this.organizationId, email: this.email, role: this.role, createdByMembershipId: this.createdByMembershipId, createdAt: this.createdAt, expiresAt: this.expiresAt, revokedAt: this.revokedAt, acceptedAt: this.acceptedAt, acceptedByUserId: this.acceptedByUserId };
  }

  [inspect.custom](): string { return `Invitation(${String(this.id)})`; }
}
