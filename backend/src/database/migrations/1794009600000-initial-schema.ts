import type { MigrationInterface, QueryRunner } from 'typeorm';
import { DOWN_STATEMENTS, UP_STATEMENTS } from './initial-schema.statements';

/** The only databases `down` may run against: development and test. Never production. */
const DOWN_ALLOWED_DATABASE = /^[a-z][a-z0-9_]*_(?:test|dev)$/;

/**
 * Initial schema. It consumes the frozen catalogue and runs nothing else: no data, no grants, no extensions.
 * It declares no `transaction` property, so it is compatible with `migrationsTransactionMode: 'all'` (one transaction).
 * Immutable once published.
 */
export class InitialSchema1794009600000 implements MigrationInterface {
  readonly name = 'InitialSchema1794009600000';

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
