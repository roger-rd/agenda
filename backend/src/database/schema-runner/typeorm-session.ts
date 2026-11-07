import { DataSource, MigrationExecutor, type QueryRunner } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { assertSafeSchemaDataSourceOptions } from './schema-data-source';
import { SessionContractError, type SchemaPort } from './schema-runner';
import { LOCK_STATEMENTS, READ_ONLY_QUERIES, TABLE_LOCK_STATEMENTS, WRITE_STATEMENTS } from './schema-sql';
import type { SchemaCommand } from './schema-target';

/**
 * The only place that talks to TypeORM. One DataSource (the owner's, built by schema-data-source.ts), ONE QueryRunner
 * that holds the pool's single connection, and a MigrationExecutor driven with that same QueryRunner inside a
 * transaction opened by the runner. TypeORM 1.1.2 (read from source) leaves a transaction it did not start alone, so
 * COMMIT and ROLLBACK stay with the runner. Nothing here can run an unpinned statement, and the DataSource methods
 * that would bypass the contract are replaced with functions that throw.
 */
export interface ExecutorLike {
  transaction: 'all' | 'none' | 'each';
  fake: boolean;
  executePendingMigrations(): Promise<readonly { readonly name: string }[]>;
  undoLastMigration(): Promise<void>;
}

export interface SessionDeps {
  readonly options: PostgresDataSourceOptions;
  readonly mode: SchemaCommand;
  /** Injection point for tests; the default builds the real, still unconnected, DataSource. */
  readonly createDataSource?: (options: PostgresDataSourceOptions) => DataSource;
  readonly createExecutor?: (dataSource: DataSource, queryRunner: QueryRunner) => ExecutorLike;
}

const READABLE: ReadonlySet<string> = new Set([...Object.values(READ_ONLY_QUERIES), ...Object.values(LOCK_STATEMENTS)]);
const WRITABLE: ReadonlySet<string> = new Set([...Object.values(WRITE_STATEMENTS), ...Object.values(TABLE_LOCK_STATEMENTS)]);
/** The transaction and migrations tables are managed by TypeORM; these DataSource entry points bypass the contract. */
const FORBIDDEN_ENTRY_POINTS = ['runMigrations', 'showMigrations', 'undoLastMigration', 'synchronize', 'dropDatabase'] as const;

export function createTypeOrmPort(deps: SessionDeps): SchemaPort {
  assertSafeSchemaDataSourceOptions(deps.options, deps.mode);
  const makeDataSource = deps.createDataSource ?? ((options: PostgresDataSourceOptions) => new DataSource(options));
  const makeExecutor = deps.createExecutor ?? ((ds: DataSource, qr: QueryRunner): ExecutorLike => new MigrationExecutor(ds, qr) as unknown as ExecutorLike);
  let dataSource: DataSource | undefined;
  let runner: QueryRunner | undefined;
  let runnersCreated = 0;

  const needRunner = (): QueryRunner => { if (!runner || runner.isReleased) throw new SessionContractError(); return runner; };
  const needTransaction = (): QueryRunner => { const qr = needRunner(); if (!qr.isTransactionActive) throw new SessionContractError(); return qr; };
  /** The executor may not have created a second runner nor ended the transaction we opened. */
  const assertContract = () => { if (runnersCreated !== 1 || !runner || !runner.isTransactionActive) throw new SessionContractError(); };

  return {
    async connect() {
      const ds = makeDataSource(deps.options);
      dataSource = ds;
      await ds.initialize();
      for (const name of FORBIDDEN_ENTRY_POINTS) Object.defineProperty(ds, name, { value: () => { throw new SessionContractError(); }, configurable: false });
      const create = ds.createQueryRunner.bind(ds);
      Object.defineProperty(ds, 'createQueryRunner', { value: (mode?: 'master' | 'slave') => { runnersCreated += 1; return create(mode); }, configurable: false });
      runner = ds.createQueryRunner();
      await runner.connect();
    },

    async query(sql, params) {
      if (!READABLE.has(sql)) throw new SessionContractError();
      return needRunner().query(sql, params === undefined ? undefined : [...params]);
    },

    async exec(sql) {
      if (!WRITABLE.has(sql)) throw new SessionContractError();
      await needRunner().query(sql);
    },

    async begin(isolation) { await needRunner().startTransaction(isolation); },
    async commit() { await needTransaction().commitTransaction(); },
    async rollback() { await needTransaction().rollbackTransaction(); },

    async applyMigrations() {
      const qr = needTransaction();
      const executor = makeExecutor(dataSource as DataSource, qr);
      executor.transaction = 'all'; executor.fake = false;
      const done = await executor.executePendingMigrations();
      assertContract();
      return done.map(migration => migration.name);
    },

    async revertLast() {
      const qr = needTransaction();
      const executor = makeExecutor(dataSource as DataSource, qr);
      executor.transaction = 'all'; executor.fake = false;
      await executor.undoLastMigration();
      assertContract();
    },

    transactionEvidence() {
      const qr = runner;
      const connection: unknown = qr ? Reflect.get(qr, 'databaseConnection') : undefined;
      const status = connection !== null && typeof connection === 'object' ? Reflect.get(connection, 'getTransactionStatus') : undefined;
      return { clientStatus: typeof status === 'function' ? (status as () => unknown).call(connection) : undefined, queryRunnerActive: qr?.isTransactionActive };
    },

    async close() {
      try { if (runner && !runner.isReleased) await runner.release(); } catch { /* verified through isClosed() */ }
      try { if (dataSource?.isInitialized) await dataSource.destroy(); } catch { /* verified through isClosed() */ }
    },

    isClosed() { return (runner === undefined || runner.isReleased) && (dataSource === undefined || !dataSource.isInitialized); },
  };
}

/** For specs: every statement the session would accept. */
export const ACCEPTED_STATEMENTS: readonly string[] = Object.freeze([...READABLE, ...WRITABLE]);
