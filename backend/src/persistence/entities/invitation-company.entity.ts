import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import { Company } from './company.entity';
import { Invitation } from './invitation.entity';

/** Both composite foreign keys enforce organization isolation for the invited companies. */
@Entity({ name: 'invitation_companies' })
@Index('IX_invitation_companies_company', ['companyId'])
@ForeignKey(() => Invitation, ['invitationId', 'organizationId'], ['id', 'organizationId'],
  { name: 'FK_invitation_companies_invitation', onDelete: 'CASCADE', onUpdate: 'RESTRICT' })
@ForeignKey(() => Company, ['companyId', 'organizationId'], ['id', 'organizationId'],
  { name: 'FK_invitation_companies_company', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
export class InvitationCompany {
  @PrimaryColumn({ type: 'uuid', name: 'invitation_id', primaryKeyConstraintName: 'PK_invitation_companies' })
  invitationId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'company_id', primaryKeyConstraintName: 'PK_invitation_companies' })
  companyId!: string;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId!: string;
}
