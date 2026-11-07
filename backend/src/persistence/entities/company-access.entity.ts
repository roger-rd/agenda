import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import { ACCESS_ROLES, literals } from '../constants';
import { Company } from './company.entity';
import { OrganizationMembership } from './organization-membership.entity';

/**
 * Which companies a worker or client membership can reach. Community managers see every company of their organization
 * and never have rows here. `membership_role` repeats the role of the membership so that the foreign key (which
 * includes it) and the check make that rule a database guarantee; ON UPDATE CASCADE keeps it in step, and promoting a
 * membership to community manager fails until its accesses are removed.
 */
@Entity({ name: 'company_accesses' })
@Index('IX_company_accesses_company', ['companyId'])
@Check('CK_company_accesses_role', `membership_role IN (${literals(ACCESS_ROLES)})`)
@ForeignKey(() => OrganizationMembership, ['membershipId', 'organizationId', 'membershipRole'], ['id', 'organizationId', 'role'],
  { name: 'FK_company_accesses_membership', onDelete: 'CASCADE', onUpdate: 'CASCADE' })
@ForeignKey(() => Company, ['companyId', 'organizationId'], ['id', 'organizationId'],
  { name: 'FK_company_accesses_company', onDelete: 'CASCADE', onUpdate: 'RESTRICT' })
export class CompanyAccess {
  @PrimaryColumn({ type: 'uuid', name: 'membership_id', primaryKeyConstraintName: 'PK_company_accesses' })
  membershipId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'company_id', primaryKeyConstraintName: 'PK_company_accesses' })
  companyId!: string;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId!: string;

  @Column({ type: 'varchar', length: 20, name: 'membership_role' })
  membershipRole!: string;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
