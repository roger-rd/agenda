import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn, Unique } from 'typeorm';
import { ROLES, literals, uuidV7 } from '../constants';
import { Organization } from './organization.entity';
import { User } from './user.entity';

/**
 * Role of a user inside one organization. A user can have several memberships.
 *
 * Keeping at least ONE ACTIVE community manager per organization is NOT guaranteed by this entity or by any single
 * constraint: it depends on the other rows of the organization and on concurrent transactions. The service must change
 * roles, deactivate or remove memberships inside a transaction that locks the organization's memberships (see
 * SERVICE_ENFORCED.keep_one_active_community_manager). The partial index below only makes that count cheap.
 */
@Entity({ name: 'organization_memberships' })
@Unique('UQ_organization_memberships_org_user', ['organizationId', 'userId'])
@Unique('UQ_organization_memberships_id_org', ['id', 'organizationId'])
// Target of the company access foreign key: it carries the role so that accesses cannot hang from a community manager.
@Unique('UQ_organization_memberships_id_org_role', ['id', 'organizationId', 'role'])
@Index('IX_organization_memberships_user', ['userId'])
@Index('IX_organization_memberships_active_managers', ['organizationId'], { where: "role = 'community_manager' AND deactivated_at IS NULL" })
@Check('CK_organization_memberships_id_v7', uuidV7('id'))
@Check('CK_organization_memberships_role', `role IN (${literals(ROLES)})`)
@Check('CK_organization_memberships_deactivated', 'deactivated_at IS NULL OR deactivated_at >= created_at')
@Check('CK_organization_memberships_version', 'version >= 1')
@ForeignKey(() => Organization, ['organizationId'], ['id'], { name: 'FK_organization_memberships_organization', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
@ForeignKey(() => User, ['userId'], ['id'], { name: 'FK_organization_memberships_user', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
export class OrganizationMembership {
  @PrimaryColumn({ type: 'uuid', name: 'id', primaryKeyConstraintName: 'PK_organization_memberships' })
  id!: string;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 20, name: 'role' })
  role!: string;

  /** NULL while the membership is active. */
  @Column({ type: 'timestamptz', name: 'deactivated_at', nullable: true })
  deactivatedAt!: Date | null;

  @Column({ type: 'integer', name: 'version' })
  version!: number;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
