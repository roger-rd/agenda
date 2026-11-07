import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import { LIMITS, uuidV7 } from '../constants';
import { OrganizationMembership } from './organization-membership.entity';
import { Post } from './post.entity';

/** Immutable comment. It survives the soft deletion of its post (RESTRICT, never CASCADE). */
@Entity({ name: 'post_comments' })
@Index('IX_post_comments_post_created', ['postId', 'createdAt', 'id'])
@Check('CK_post_comments_id_v7', uuidV7('id'))
@Check('CK_post_comments_body', `char_length(body) BETWEEN ${LIMITS.comment.min} AND ${LIMITS.comment.max} AND body = btrim(body)`)
@ForeignKey(() => Post, ['postId', 'organizationId'], ['id', 'organizationId'], { name: 'FK_post_comments_post', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
@ForeignKey(() => OrganizationMembership, ['organizationId', 'authorUserId'], ['organizationId', 'userId'], { name: 'FK_post_comments_author', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
export class PostComment {
  @PrimaryColumn({ type: 'uuid', name: 'id', primaryKeyConstraintName: 'PK_post_comments' })
  id!: string;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId!: string;

  @Column({ type: 'uuid', name: 'post_id' })
  postId!: string;

  @Column({ type: 'uuid', name: 'author_user_id' })
  authorUserId!: string;

  @Column({ type: 'text', name: 'body' })
  body!: string;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
