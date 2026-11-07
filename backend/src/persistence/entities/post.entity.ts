import { Check, Column, DeleteDateColumn, Entity, ForeignKey, Index, PrimaryColumn, Unique } from 'typeorm';
import { LIMITS, POST_FORMATS, POST_STATUSES, literals, uuidV7 } from '../constants';
import { Company } from './company.entity';
import { OrganizationMembership } from './organization-membership.entity';

/**
 * A scheduled publication of one company. Posts are never hard-deleted by the application: `deleted_at` hides them and
 * their comments are kept (the comment foreign key is RESTRICT). Optional foreign keys (confirmation, deletion) include
 * `organization_id`, which is NOT NULL, and a nullable user column: PostgreSQL's default MATCH SIMPLE skips the check
 * while the nullable column is NULL, so they are enforced only when the user is present.
 */
@Entity({ name: 'posts' })
@Unique('UQ_posts_id_org', ['id', 'organizationId'])
@Index('IX_posts_company_schedule', ['companyId', 'scheduledAt'], { where: 'deleted_at IS NULL' })
@Index('IX_posts_org_schedule', ['organizationId', 'scheduledAt'], { where: 'deleted_at IS NULL' })
@Index('IX_posts_responsible', ['organizationId', 'responsibleUserId'], { where: 'deleted_at IS NULL' })
@Check('CK_posts_id_v7', uuidV7('id'))
@Check('CK_posts_title', `char_length(title) BETWEEN ${LIMITS.title.min} AND ${LIMITS.title.max} AND title = btrim(title)`)
@Check('CK_posts_description', `char_length(description) <= ${LIMITS.description}`)
@Check('CK_posts_format', `format IN (${literals(POST_FORMATS)})`)
@Check('CK_posts_status', `status IN (${literals(POST_STATUSES)})`)
@Check('CK_posts_instagram_url', `instagram_url IS NULL OR (char_length(instagram_url) <= ${LIMITS.instagramUrl} AND instagram_url ~* '^https?://[^[:space:]]+$')`)
@Check('CK_posts_confirmation', "((status = 'Subido') = (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)) AND ((confirmed_by_user_id IS NULL) = (confirmed_at IS NULL))")
@Check('CK_posts_soft_delete', '(deleted_at IS NULL) = (deleted_by_user_id IS NULL)')
@Check('CK_posts_version', 'version >= 1')
@ForeignKey(() => Company, ['companyId', 'organizationId'], ['id', 'organizationId'], { name: 'FK_posts_company', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
@ForeignKey(() => OrganizationMembership, ['organizationId', 'responsibleUserId'], ['organizationId', 'userId'], { name: 'FK_posts_responsible', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
@ForeignKey(() => OrganizationMembership, ['organizationId', 'createdByUserId'], ['organizationId', 'userId'], { name: 'FK_posts_created_by', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
@ForeignKey(() => OrganizationMembership, ['organizationId', 'confirmedByUserId'], ['organizationId', 'userId'], { name: 'FK_posts_confirmed_by', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
@ForeignKey(() => OrganizationMembership, ['organizationId', 'deletedByUserId'], ['organizationId', 'userId'], { name: 'FK_posts_deleted_by', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
export class Post {
  @PrimaryColumn({ type: 'uuid', name: 'id', primaryKeyConstraintName: 'PK_posts' })
  id!: string;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: LIMITS.title.max, name: 'title' })
  title!: string;

  @Column({ type: 'text', name: 'description' })
  description!: string;

  /** UTC instant. Presentation and validation of the civil time use America/Santiago. */
  @Column({ type: 'timestamptz', name: 'scheduled_at' })
  scheduledAt!: Date;

  @Column({ type: 'varchar', length: 10, name: 'format' })
  format!: string;

  @Column({ type: 'varchar', length: 12, name: 'status' })
  status!: string;

  /** Must be an organization member. Being authorized for the company is checked when saving, not here. */
  @Column({ type: 'uuid', name: 'responsible_user_id' })
  responsibleUserId!: string;

  /** Frontend field visible_para_cliente. */
  @Column({ type: 'boolean', name: 'client_visible' })
  clientVisible!: boolean;

  @Column({ type: 'varchar', length: LIMITS.instagramUrl, name: 'instagram_url', nullable: true })
  instagramUrl!: string | null;

  /** Optional: present together with confirmed_at exactly when the status is Subido. */
  @Column({ type: 'uuid', name: 'confirmed_by_user_id', nullable: true })
  confirmedByUserId!: string | null;

  @Column({ type: 'timestamptz', name: 'confirmed_at', nullable: true })
  confirmedAt!: Date | null;

  @Column({ type: 'uuid', name: 'created_by_user_id' })
  createdByUserId!: string;

  /** Soft delete: queries exclude these rows by default. The service sets deleted_by_user_id in the same update. */
  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'uuid', name: 'deleted_by_user_id', nullable: true })
  deletedByUserId!: string | null;

  @Column({ type: 'integer', name: 'version' })
  version!: number;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
