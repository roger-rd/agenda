import { inspect } from 'node:util';
import { Check, Column, Entity, PrimaryColumn, Unique } from 'typeorm';
import { LIMITS, cleanName, uuidV7 } from '../constants';

/** A person. Global: role and company access live in the memberships, one per organization. */
@Entity({ name: 'users' })
@Unique('UQ_users_email', ['email'])
@Check('CK_users_id_v7', uuidV7('id'))
@Check('CK_users_email', `email = lower(btrim(email)) AND char_length(email) BETWEEN ${LIMITS.email.min} AND ${LIMITS.email.max} AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'`)
@Check('CK_users_name', cleanName('name', LIMITS.name.min, LIMITS.name.max))
@Check('CK_users_password_hash', `password_hash LIKE '$argon2id$%' AND char_length(password_hash) BETWEEN ${LIMITS.passwordHash.min} AND ${LIMITS.passwordHash.max}`)
@Check('CK_users_version', 'version >= 1')
export class User {
  @PrimaryColumn({ type: 'uuid', name: 'id', primaryKeyConstraintName: 'PK_users' })
  id!: string;

  /** Canonical form: trimmed and lowercase. Globally unique. */
  @Column({ type: 'varchar', length: LIMITS.email.max, name: 'email' })
  email!: string;

  @Column({ type: 'varchar', length: LIMITS.name.max, name: 'name' })
  name!: string;

  /** Argon2id PHC string. Never selected by default, serialized or printed. */
  @Column({ type: 'text', name: 'password_hash', select: false })
  passwordHash!: string;

  @Column({ type: 'timestamptz', name: 'password_changed_at' })
  passwordChangedAt!: Date;

  @Column({ type: 'integer', name: 'version' })
  version!: number;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  toJSON() {
    return { id: this.id, email: this.email, name: this.name, passwordChangedAt: this.passwordChangedAt, version: this.version,
      createdAt: this.createdAt, updatedAt: this.updatedAt };
  }

  [inspect.custom](): string { return `User(${String(this.id)})`; }
}
