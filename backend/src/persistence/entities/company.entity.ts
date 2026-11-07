import { Check, Column, Entity, ForeignKey, PrimaryColumn, Unique } from 'typeorm';
import { LIMITS, cleanName, normalizedKey, uuidV7 } from '../constants';
import { Organization } from './organization.entity';

/** A client brand of an organization. Companies are not deleted in the MVP. */
@Entity({ name: 'companies' })
@Unique('UQ_companies_org_name_key', ['organizationId', 'nameKey'])
// Target of every composite foreign key that must stay inside the organization.
@Unique('UQ_companies_id_org', ['id', 'organizationId'])
@Check('CK_companies_id_v7', uuidV7('id'))
@Check('CK_companies_name', cleanName('name', LIMITS.name.min, LIMITS.name.max))
@Check('CK_companies_name_key', normalizedKey('name_key', LIMITS.name.max))
@Check('CK_companies_color', "color ~ '^#[0-9a-f]{6}$'")
@Check('CK_companies_version', 'version >= 1')
@ForeignKey(() => Organization, ['organizationId'], ['id'], { name: 'FK_companies_organization', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
export class Company {
  @PrimaryColumn({ type: 'uuid', name: 'id', primaryKeyConstraintName: 'PK_companies' })
  id!: string;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId!: string;

  @Column({ type: 'varchar', length: LIMITS.name.max, name: 'name' })
  name!: string;

  /** Folded name computed by the service; unique inside the organization. */
  @Column({ type: 'varchar', length: LIMITS.name.max, name: 'name_key' })
  nameKey!: string;

  /** #rrggbb, lowercase. */
  @Column({ type: 'varchar', length: 7, name: 'color' })
  color!: string;

  @Column({ type: 'integer', name: 'version' })
  version!: number;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
