import { Check, Column, Entity, PrimaryColumn, Unique } from 'typeorm';
import { LIMITS, cleanName, normalizedKey, uuidV7 } from '../constants';

/** Tenant root. Everything the product stores hangs from an organization. */
@Entity({ name: 'organizations' })
@Unique('UQ_organizations_name_key', ['nameKey'])
@Check('CK_organizations_id_v7', uuidV7('id'))
@Check('CK_organizations_name', cleanName('name', LIMITS.name.min, LIMITS.name.max))
@Check('CK_organizations_name_key', normalizedKey('name_key', LIMITS.name.max))
@Check('CK_organizations_version', 'version >= 1')
export class Organization {
  @PrimaryColumn({ type: 'uuid', name: 'id', primaryKeyConstraintName: 'PK_organizations' })
  id!: string;

  @Column({ type: 'varchar', length: LIMITS.name.max, name: 'name' })
  name!: string;

  /** Case- and accent-folded name computed by the service; unique across the platform. */
  @Column({ type: 'varchar', length: LIMITS.name.max, name: 'name_key' })
  nameKey!: string;

  @Column({ type: 'integer', name: 'version' })
  version!: number;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
