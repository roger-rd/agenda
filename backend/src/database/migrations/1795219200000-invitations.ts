import type { MigrationInterface, QueryRunner } from 'typeorm';
import { DOWN_STATEMENTS, UP_STATEMENTS } from './invitations.statements';

/** The only databases `down` may run against: development and test. Never production. */
const DOWN_ALLOWED_DATABASE = /^[a-z][a-z0-9_]*_(?:test|dev)$/;

/**
 * Invitations schema. It consumes the frozen catalogue and runs nothing else: no data, no grants, no extensions.
 * It declares no `transaction` property, so it is compatible with `migrationsTransactionMode: 'all'` (one transaction).
 * Immutable once published.
 */
export class Invitations1795219200000 implements MigrationInterface {
  readonly name = 'Invitations1795219200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of UP_STATEMENTS) await queryRunner.query(statement);
  }

  /** Development and test only: refuses any other database before running a single statement. */
  async down(queryRunner: QueryRunner): Promise<void> {
    const database: unknown = queryRunner.dataSource.options.database;
    if (typeof database !== 'string' || !DOWN_ALLOWED_DATABASE.test(database)) throw new Error('migration_down_forbidden');
    for (const statement of DOWN_STATEMENTS) await queryRunner.query(statement);
  }
}
