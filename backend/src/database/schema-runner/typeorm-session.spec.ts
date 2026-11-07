import { DataSource, MigrationExecutor, type QueryRunner } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { DatabaseConnectionConfig, DatabaseCredentials } from '../../config/database-credentials';
import { DOWN_STATEMENTS, TABLE_ORDER, UP_STATEMENTS } from '../migrations/initial-schema.statements';
import { SCHEMA_MANIFEST } from '../migrations/schema-manifest';
import { SafeTypeOrmLogger } from '../safe-typeorm-logger';
import { createSchemaDataSourceOptions } from './schema-data-source';
import { runSchema, SessionContractError, summaryOf, type RunResult } from './schema-runner';
import * as SQL from './schema-sql';
import { LOCK_KEY, SchemaRunnerError, type SchemaCommand } from './schema-target';
import { ACCEPTED_STATEMENTS, createTypeOrmPort, type ExecutorLike } from './typeorm-session';

const password = 'fake-owner-password-for-unit-tests-0004';
const logger = new SafeTypeOrmLogger({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
const config = new DatabaseConnectionConfig('127.0.0.1', 5433, 'agenda_test', new DatabaseCredentials('agenda_test_owner', password), 1);
const NAME = SCHEMA_MANIFEST[0].name;

interface World { migrationsTable: boolean; tables: boolean; executed: { id: number; timestamp: number; name: string }[]; tx: 'I' | 'T' | 'E' }
const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** Rows for the pinned statements, from the same world the library mutates. */
function pinned(text: string, world: World, mode: SchemaCommand): unknown[] | undefined {
  const ro = mode === 'plan' ? 'on' : 'off';
  switch (text) {
    case SQL.LOCK_SQL: return [{ locked: true }];
    case SQL.UNLOCK_SQL: return [{ unlocked: true }];
    case SQL.IDENTITY_SQL: return [{
      database: 'agenda_test', current_user: 'agenda_test_owner', session_user: 'agenda_test_owner', version_num: 160015, in_recovery: false,
      transaction_read_only: ro, default_read_only: ro, standard_conforming_strings: 'on', current_schema: 'public', effective_search_path: 'public',
      statement_timeout: '15s', lock_timeout: '5s', idle_in_transaction_session_timeout: '30s', application_name: 'agenda-schema-runner',
      rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true,
      can_use_public: true, can_create_public: true, owns_database: true, event_triggers: 0, owner_memberships: 0, app_role_exists: true }];
    case SQL.RELATIONS_SQL: return [
      ...(world.tables ? [...TABLE_ORDER].flatMap(name => [{ name, kind: 'r', table_name: null }, { name: `PK_${name}`, kind: 'i', table_name: name }]) : []),
      ...(world.migrationsTable ? [{ name: 'schema_migrations', kind: 'r', table_name: null }, { name: 'PK_schema_migrations', kind: 'i', table_name: 'schema_migrations' },
        { name: 'schema_migrations_id_seq', kind: 'S', table_name: null }] : [])];
    case SQL.FOREIGN_OBJECTS_SQL: return [{ routines: 0, types: 0, extensions: 0 }];
    case SQL.MIGRATIONS_COLUMNS_SQL: return [{ name: 'id', type: 'integer' }, { name: 'timestamp', type: 'bigint' }, { name: 'name', type: 'character varying' }];
    case SQL.EXECUTED_SQL: return [...world.executed].reverse().map(e => ({ name: e.name }));
    case SQL.MIGRATIONS_PRIVILEGES_SQL: return [
      ...TABLE_PRIVS.map(privilege => ({ kind: 'table', privilege })), ...['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].map(privilege => ({ kind: 'column', privilege })),
      ...['USAGE', 'SELECT', 'UPDATE'].map(privilege => ({ kind: 'sequence', privilege }))].map(r => ({ ...r, effective: false, grantable: false }));
    case SQL.APPLICATION_PRIVILEGES_SQL: return [...TABLE_ORDER].flatMap(name => TABLE_PRIVS.map(privilege => ({ name, privilege, effective: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), grantable: false })));
    case SQL.TABLES_EMPTY_SQL: return [Object.fromEntries(TABLE_ORDER.map(t => [t, true]))];
    case SQL.TRANSACTION_CLOSED_SQL: return [{ no_xid: world.tx === 'I', no_backend_xid: world.tx === 'I', implicit_transaction: world.tx === 'I' }];
    case SQL.REVOKE_MIGRATIONS_TABLE_SQL: case SQL.REVOKE_MIGRATIONS_SEQUENCE_SQL: return [];
    default: return undefined;
  }
}

/**
 * A pg client stand-in under a REAL TypeORM 1.1.2 DataSource, query runner and migration executor. Only the socket is
 * missing: every statement TypeORM itself emits (transactions, hasTable, createTable, the bookkeeping INSERT/DELETE) is
 * produced by the library and recorded here.
 */
function harness(mode: SchemaCommand, start: Partial<World> = {}, over: { createExecutor?: (ds: DataSource, qr: QueryRunner) => ExecutorLike; failOn?: RegExp } = {}) {
  const world: World = { migrationsTable: false, tables: false, executed: [], tx: 'I', ...start };
  const log: { text: string; values?: unknown[] }[] = [];
  const texts = () => log.map(l => l.text);
  const client = {
    getTransactionStatus: () => world.tx,
    async query(text: string, values?: unknown[]) {
      log.push({ text, values });
      const rows = (r: unknown[] = []) => ({ rows: r, rowCount: r.length, command: /^\s*(\w+)/.exec(text)?.[1].toUpperCase() ?? '' });
      if (over.failOn?.test(text)) { world.tx = world.tx === 'T' ? 'E' : world.tx; throw Object.assign(new Error(password), { code: '23505', stack: password }); }
      if (/^START TRANSACTION/.test(text)) { world.tx = 'T'; return rows(); }
      if (text === 'COMMIT' || text === 'ROLLBACK') { world.tx = 'I'; return rows(); }
      const known = pinned(text, world, mode);
      if (known) return rows(known);
      if (/information_schema/i.test(text)) return rows(world.migrationsTable ? [{ table_schema: 'public', table_name: 'schema_migrations' }] : []);
      if (/^CREATE TABLE "public"\."schema_migrations"/.test(text)) { world.migrationsTable = true; return rows(); }
      if (/^SELECT .* FROM "public"\."schema_migrations"/.test(text)) return rows(world.executed.map(e => ({ ...e })).reverse());
      if (/^INSERT INTO "public"\."schema_migrations"/.test(text)) { world.executed.push({ id: world.executed.length + 1, timestamp: Number(values?.[0]), name: String(values?.[1]) }); return rows(); }
      if (/^DELETE FROM "public"\."schema_migrations"/.test(text)) { world.executed = world.executed.filter(e => e.name !== values?.[1]); return rows(); }
      if (/^CREATE TABLE "public"\."organizations"/.test(text)) world.tables = true;
      if (/^DROP TABLE "public"\."organizations"/.test(text)) world.tables = false;
      return rows();
    },
  };
  const options = createSchemaDataSourceOptions(config, mode, { logger });
  const created: DataSource[] = [];
  let driverRunners = 0;
  const createDataSource = (o: PostgresDataSourceOptions): DataSource => {
    const ds = new DataSource(o);
    const driver = ds.driver as unknown as { createQueryRunner(m: string): Record<string, unknown> };
    const make = driver.createQueryRunner.bind(driver);
    driver.createQueryRunner = (m: string) => { driverRunners++; const qr = make(m); qr.connect = async () => { qr.databaseConnection = client; return client; }; return qr; };
    let initialized = false;
    Object.defineProperty(ds, 'isInitialized', { get: () => initialized });
    ds.initialize = async () => { await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas(); initialized = true; return ds; };
    ds.destroy = async () => { initialized = false; };
    created.push(ds);
    return ds;
  };
  const executors: ExecutorLike[] = [];
  const port = createTypeOrmPort({
    options, mode, createDataSource,
    createExecutor: over.createExecutor ?? ((ds, qr) => { const e = new MigrationExecutor(ds, qr) as unknown as ExecutorLike; executors.push(e); return e; }),
  });
  return { port, world, log, texts, created, executors, options, runners: () => driverRunners };
}
const transactional = (texts: string[]) => texts.filter(t => /^(START TRANSACTION|COMMIT|ROLLBACK|SET TRANSACTION)/.test(t));
const BOOKKEEPING = [/^SELECT \* FROM "information_schema"\."tables"/, /^CREATE TABLE "public"\."schema_migrations"/, /^SELECT \* FROM "public"\."schema_migrations"/,
  /^INSERT INTO "public"\."schema_migrations"/, /^DELETE FROM "public"\."schema_migrations"/];
const virtual = () => ({ clock: () => 0, timers: { set: () => 0, clear: () => undefined }, aborted: () => false });

describe('A. contrato real de TypeORM 1.1.2', () => {
  it('apply: TypeORM emite solo transacción nuestra, contabilidad de migraciones y las 31 sentencias congeladas, en orden', async () => {
    const h = harness('apply');
    await h.port.connect(); await h.port.begin();
    expect(await h.port.applyMigrations()).toEqual([NAME]);
    await h.port.commit();
    const texts = h.texts();
    const ddl = texts.filter(t => UP_STATEMENTS.includes(t));
    expect(ddl).toEqual([...UP_STATEMENTS]);
    const rest = texts.filter(t => !UP_STATEMENTS.includes(t) && !/^(START TRANSACTION|COMMIT)$/.test(t));
    for (const t of rest) expect([t, BOOKKEEPING.some(re => re.test(t))]).toEqual([t, true]);
    expect(texts[0]).toBe('START TRANSACTION'); expect(texts[texts.length - 1]).toBe('COMMIT');
    expect(h.log.find(l => l.text.startsWith('INSERT INTO'))?.values).toEqual([SCHEMA_MANIFEST[0].timestamp, NAME]);
    expect(h.world.executed.map(e => e.name)).toEqual([NAME]);
    await h.port.close();
  });
  it('revert: elimina en orden las 8 tablas congeladas y borra el registro, sin tocar la transacción', async () => {
    const h = harness('revert', { migrationsTable: true, tables: true, executed: [{ id: 1, timestamp: SCHEMA_MANIFEST[0].timestamp, name: NAME }] });
    await h.port.connect(); await h.port.begin(); await h.port.revertLast();
    expect(h.texts().filter(t => DOWN_STATEMENTS.includes(t))).toEqual([...DOWN_STATEMENTS]);
    expect(h.texts().some(t => t.startsWith('DELETE FROM "public"."schema_migrations"'))).toBe(true);
    expect(transactional(h.texts())).toEqual(['START TRANSACTION']);
    expect(h.world.executed).toEqual([]);
    await h.port.rollback(); await h.port.close();
  });
  it('el ejecutor se configura con transacción "all" y sin modo falso', async () => {
    const h = harness('apply');
    await h.port.connect(); await h.port.begin(); await h.port.applyMigrations();
    expect(h.executors).toHaveLength(1);
    expect(h.executors[0]).toMatchObject({ transaction: 'all', fake: false });
    await h.port.rollback(); await h.port.close();
  });
  it('las opciones reales del DataSource llevan solo la migración congelada, tabla schema_migrations y transacción única', async () => {
    const h = harness('apply');
    await h.port.connect();
    const ds = h.created[0];
    expect(ds.options).toMatchObject({ migrationsTableName: 'schema_migrations', migrationsTransactionMode: 'all', synchronize: false, migrationsRun: false, installExtensions: false, entities: [] });
    expect(ds.migrations.map(m => m.constructor.name)).toEqual([NAME]);
    await h.port.close();
  });
});

describe('B. MigrationExecutor no crea un segundo QueryRunner', () => {
  it('apply y revert usan el único QueryRunner (ni el DataSource ni el driver crean otro)', async () => {
    const h = harness('apply');
    await h.port.connect(); await h.port.begin(); await h.port.applyMigrations();
    expect(h.runners()).toBe(1);
    await h.port.rollback(); await h.port.close();
    const r = harness('revert', { migrationsTable: true, tables: true, executed: [{ id: 1, timestamp: SCHEMA_MANIFEST[0].timestamp, name: NAME }] });
    await r.port.connect(); await r.port.begin(); await r.port.revertLast();
    expect(r.runners()).toBe(1);
    await r.port.rollback(); await r.port.close();
  });
  it('un ejecutor que pida otro QueryRunner rompe el contrato', async () => {
    const h = harness('apply', {}, { createExecutor: (ds) => ({ transaction: 'all', fake: false, executePendingMigrations: async () => { ds.createQueryRunner(); return []; }, undoLastMigration: async () => undefined }) });
    await h.port.connect(); await h.port.begin();
    await expect(h.port.applyMigrations()).rejects.toBeInstanceOf(SessionContractError);
    await h.port.rollback(); await h.port.close();
  });
});

describe('C. el ejecutor no confirma ni revierte la transacción abierta por nosotros', () => {
  it('tras la migración solo existe nuestro START TRANSACTION; COMMIT y ROLLBACK los emite el runner', async () => {
    const h = harness('apply');
    await h.port.connect(); await h.port.begin();
    await h.port.applyMigrations();
    expect(transactional(h.texts())).toEqual(['START TRANSACTION']);
    expect(h.world.tx).toBe('T');
    expect(h.port.transactionEvidence()).toEqual({ clientStatus: 'T', queryRunnerActive: true });
    await h.port.commit();
    expect(transactional(h.texts())).toEqual(['START TRANSACTION', 'COMMIT']);
    expect(h.port.transactionEvidence()).toEqual({ clientStatus: 'I', queryRunnerActive: false });
    await h.port.close();
  });
  it('si la migración falla, el ejecutor no hace ROLLBACK: lo hace el runner una sola vez', async () => {
    const h = harness('apply', {}, { failOn: /^CREATE TABLE "public"\."users"/ });
    await h.port.connect(); await h.port.begin();
    await expect(h.port.applyMigrations()).rejects.toBeDefined();
    expect(transactional(h.texts())).toEqual(['START TRANSACTION']);
    await h.port.rollback();
    expect(transactional(h.texts())).toEqual(['START TRANSACTION', 'ROLLBACK']);
    await h.port.close();
  });
  it.each(['commit', 'rollback'] as const)('un ejecutor que haga %s por su cuenta rompe el contrato', async which => {
    const h = harness('apply', {}, { createExecutor: (_ds, qr) => ({ transaction: 'all', fake: false,
      executePendingMigrations: async () => { await (which === 'commit' ? qr.commitTransaction() : qr.rollbackTransaction()); return []; }, undoLastMigration: async () => undefined }) });
    await h.port.connect(); await h.port.begin();
    await expect(h.port.applyMigrations()).rejects.toBeInstanceOf(SessionContractError);
    await h.port.close();
  });
  it('sin transacción abierta por el runner no se ejecuta la migración ni el revert', async () => {
    const h = harness('apply');
    await h.port.connect();
    await expect(h.port.applyMigrations()).rejects.toBeInstanceOf(SessionContractError);
    await expect(h.port.revertLast()).rejects.toBeInstanceOf(SessionContractError);
    await expect(h.port.commit()).rejects.toBeInstanceOf(SessionContractError);
    await expect(h.port.rollback()).rejects.toBeInstanceOf(SessionContractError);
    expect(h.texts().filter(t => UP_STATEMENTS.includes(t) || DOWN_STATEMENTS.includes(t))).toEqual([]);
    await h.port.close();
  });
});

describe('C2. la transacción previa es condición de cada operación del ejecutor', () => {
  it('revert sin BEGIN no llega a ejecutar nada: el ejecutor abriría y confirmaría su propia transacción', async () => {
    const h = harness('revert', { migrationsTable: true, tables: true, executed: [{ id: 1, timestamp: SCHEMA_MANIFEST[0].timestamp, name: NAME }] });
    await h.port.connect();
    await expect(h.port.revertLast()).rejects.toBeInstanceOf(SessionContractError);
    expect(h.texts()).toEqual([]);
    expect(h.executors).toHaveLength(0);
    await h.port.close();
  });
  it('el ejecutor recibe transacción "all" y modo falso desactivado aunque la fábrica lo cree de otro modo', async () => {
    const seen: { transaction: string; fake: boolean }[] = [];
    const h = harness('apply', {}, { createExecutor: () => {
      const e: ExecutorLike = { transaction: 'each', fake: true, executePendingMigrations: async () => { seen.push({ transaction: e.transaction, fake: e.fake }); return []; },
        undoLastMigration: async () => { seen.push({ transaction: e.transaction, fake: e.fake }); } };
      return e;
    } });
    await h.port.connect(); await h.port.begin();
    await h.port.applyMigrations(); await h.port.revertLast();
    expect(seen).toEqual([{ transaction: 'all', fake: false }, { transaction: 'all', fake: false }]);
    await h.port.rollback(); await h.port.close();
  });
});

describe('J. puntos de entrada prohibidos y plan sin DDL', () => {
  it.each(['runMigrations', 'showMigrations', 'undoLastMigration', 'synchronize', 'dropDatabase'])('DataSource.%s() lanza y no ejecuta nada', async name => {
    const h = harness('apply');
    await h.port.connect();
    const before = h.log.length;
    expect(() => (h.created[0] as unknown as Record<string, () => unknown>)[name]()).toThrow(SessionContractError);
    expect(h.log.length).toBe(before);
    await h.port.close();
  });
  it('plan de extremo a extremo: ningún DDL, ninguna contabilidad de migraciones, ningún showMigrations, solo ROLLBACK', async () => {
    const h = harness('plan');
    const result = await runSchema({ command: 'plan', port: h.port, ...virtual() });
    expect(result).toMatchObject({ outcome: 'planned', ok: true, state: 'fresh', exit: 0, lock: 'released', resources: 'closed' });
    expect(transactional(h.texts())).toEqual(['START TRANSACTION', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'ROLLBACK']);
    expect(h.texts().some(t => /CREATE|ALTER|DROP|INSERT|DELETE|information_schema|schema_migrations"/.test(t.replace(/"public"\."?schema_migrations"?/g, '')) && !Object.values(SQL.ALL_STATEMENTS).includes(t))).toBe(false);
    expect(h.executors).toHaveLength(0);
    for (const t of h.texts()) expect(Object.values(SQL.ALL_STATEMENTS).concat(['START TRANSACTION', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'ROLLBACK']).includes(t)).toBe(true);
    expect(h.log.find(l => l.text === SQL.LOCK_SQL)?.values).toEqual([LOCK_KEY]);
  });
  it('el puerto no expone ninguna operación de migración fuera de apply y revert', async () => {
    expect(Object.keys(harness('plan').port).sort()).toEqual(['applyMigrations', 'begin', 'close', 'commit', 'connect', 'exec', 'isClosed', 'query', 'revertLast', 'rollback', 'transactionEvidence']);
  });
});

describe('integración: apply y revert completos con el ejecutor real', () => {
  it('apply: secuencia de sentencias del servidor y resultado verificado', async () => {
    const h = harness('apply');
    const result = await runSchema({ command: 'apply', port: h.port, ...virtual() });
    expect(result).toMatchObject({ outcome: 'applied', ok: true, committed: true, state: 'applied', lock: 'released', closure: 'verified', resources: 'closed', exit: 0 });
    const t = h.texts();
    const at = (text: string, from = 0) => t.indexOf(text, from);
    const begin = at('START TRANSACTION'); const revokeTable = at(SQL.REVOKE_MIGRATIONS_TABLE_SQL); const revokeSeq = at(SQL.REVOKE_MIGRATIONS_SEQUENCE_SQL);
    const commit = at('COMMIT'); const unlock = at(SQL.UNLOCK_SQL);
    expect(at(SQL.LOCK_SQL)).toBeLessThan(at(SQL.IDENTITY_SQL)); expect(at(SQL.IDENTITY_SQL)).toBeLessThan(begin);
    expect(begin).toBeLessThan(at(UP_STATEMENTS[0])); expect(at(UP_STATEMENTS[UP_STATEMENTS.length - 1])).toBeLessThan(revokeTable);
    expect(revokeTable).toBeLessThan(revokeSeq); expect(revokeSeq).toBeLessThan(at(SQL.MIGRATIONS_PRIVILEGES_SQL, revokeSeq));
    expect(at(SQL.MIGRATIONS_PRIVILEGES_SQL, revokeSeq)).toBeLessThan(commit);
    expect(commit).toBeLessThan(at(SQL.TRANSACTION_CLOSED_SQL, commit)); expect(at(SQL.TRANSACTION_CLOSED_SQL, commit)).toBeLessThan(unlock);
    expect(t.filter(x => x === 'COMMIT' || x === 'ROLLBACK')).toEqual(['COMMIT']);
    expect(t.filter(x => x === 'START TRANSACTION')).toHaveLength(1);
    expect(h.log.find(l => l.text === SQL.MIGRATIONS_PRIVILEGES_SQL)?.values).toEqual(['agenda_test_app']);
    expect(JSON.stringify(h.log)).not.toContain(password);
  });
  it('revert: comprobación de vacío dentro de la transacción y COMMIT final', async () => {
    const h = harness('revert', { migrationsTable: true, tables: true, executed: [{ id: 1, timestamp: SCHEMA_MANIFEST[0].timestamp, name: NAME }] });
    const result = await runSchema({ command: 'revert', port: h.port, ...virtual() });
    expect(result).toMatchObject({ outcome: 'reverted', ok: true, state: 'fresh', exit: 0 });
    const t = h.texts();
    expect(t.indexOf('START TRANSACTION')).toBeLessThan(t.indexOf(SQL.TABLES_EMPTY_SQL));
    expect(t.indexOf(SQL.TABLES_EMPTY_SQL)).toBeLessThan(t.indexOf(DOWN_STATEMENTS[0]));
    expect(t.filter(x => x === 'COMMIT' || x === 'ROLLBACK')).toEqual(['COMMIT']);
    expect(t.filter(x => x === SQL.TABLE_LOCK_SQL)).toHaveLength(1);
  });
  it('A/F/H/I. revert con el ejecutor real: START, LOCK, revalidación, vacío, los 8 DROP bajo el mismo bloqueo, un único COMMIT', async () => {
    const h = harness('revert', { migrationsTable: true, tables: true, executed: [{ id: 1, timestamp: SCHEMA_MANIFEST[0].timestamp, name: NAME }] });
    const result = await runSchema({ command: 'revert', port: h.port, ...virtual() });
    expect(result).toMatchObject({ outcome: 'reverted', ok: true, exit: 0 });
    const t = h.texts();
    const start = t.indexOf('START TRANSACTION'); const lock = t.indexOf(SQL.TABLE_LOCK_SQL); const empty = t.indexOf(SQL.TABLES_EMPTY_SQL);
    const drops = DOWN_STATEMENTS.map(d => t.indexOf(d)); const commit = t.indexOf('COMMIT');
    expect(start).toBeGreaterThanOrEqual(0); expect(lock).toBe(start + 1);
    expect(t.indexOf(SQL.RELATIONS_SQL, lock)).toBeLessThan(empty); expect(lock).toBeLessThan(empty);
    expect(empty).toBeLessThan(Math.min(...drops));
    expect(drops).toEqual([...drops].sort((a, b) => a - b)); expect(drops.every(i => i > empty && i < commit)).toBe(true);
    // I. Entre el bloqueo y el COMMIT no hay ninguna sentencia que libere nada: un único START, un único COMMIT, ningún ROLLBACK.
    expect(t.slice(lock, commit + 1).filter(x => /^(START TRANSACTION|COMMIT|ROLLBACK)$/.test(x))).toEqual(['COMMIT']);
    expect(t.filter(x => x === 'START TRANSACTION')).toHaveLength(1);
    expect(t.filter(x => x === SQL.TABLE_LOCK_SQL)).toHaveLength(1);
  });
  it('D. apply y plan de extremo a extremo no envían el bloqueo de tablas', async () => {
    for (const command of ['apply', 'plan'] as const) {
      const h = harness(command);
      await runSchema({ command, port: h.port, ...virtual() });
      expect([command, h.texts().includes(SQL.TABLE_LOCK_SQL)]).toEqual([command, false]);
    }
  });
  it('un fallo del servidor en la migración: ROLLBACK, sin COMMIT, sin filtrar el error del driver (K)', async () => {
    const h = harness('apply', {}, { failOn: /^CREATE TABLE "public"\."posts"/ });
    const result: RunResult = await runSchema({ command: 'apply', port: h.port, ...virtual() });
    expect(result).toMatchObject({ ok: false, code: 'migration_failed', sqlstate: '23505', committed: false, transaction: 'rolled_back', lock: 'released', exit: 2 });
    expect(h.texts().filter(x => x === 'COMMIT' || x === 'ROLLBACK')).toEqual(['ROLLBACK']);
    expect(JSON.stringify(result) + JSON.stringify(summaryOf(result))).not.toContain(password);
    expect(h.texts()).not.toContain(SQL.REVOKE_MIGRATIONS_TABLE_SQL);
  });
  it('un fallo del COMMIT en el servidor es ambiguo: sin éxito y sin ROLLBACK posterior', async () => {
    const h = harness('apply', {}, { failOn: /^COMMIT$/ });
    const result = await runSchema({ command: 'apply', port: h.port, ...virtual() });
    expect(result).toMatchObject({ outcome: 'commit_unconfirmed', ok: false, committed: false, exit: 3 });
    expect(h.texts().filter(x => x === 'ROLLBACK')).toEqual([]);
    expect(h.texts()).not.toContain(SQL.UNLOCK_SQL);
  });
});

describe('L. las sentencias aceptadas coinciden con los contratos de F1.2b-1', () => {
  it('solo las 15 sentencias fijadas (10 de lectura, 2 de bloqueo advisory, 2 REVOKE y el bloqueo de tablas) son aceptadas', () => {
    expect(ACCEPTED_STATEMENTS).toHaveLength(15);
    expect(new Set(ACCEPTED_STATEMENTS)).toEqual(new Set(Object.entries(SQL.ALL_STATEMENTS).filter(([name]) => !['BEGIN_READ_ONLY_SQL', 'ROLLBACK_SQL'].includes(name)).map(([, sql]) => sql)));
  });
  it('query() acepta lo fijado y reenvía texto y parámetros sin alterarlos', async () => {
    const h = harness('apply');
    await h.port.connect();
    await h.port.query(SQL.MIGRATIONS_PRIVILEGES_SQL, ['agenda_test_app']);
    await h.port.query(SQL.APPLICATION_PRIVILEGES_SQL, ['agenda_test_app', [...TABLE_ORDER]]);
    expect(h.log.map(l => [l.text, l.values])).toEqual([[SQL.MIGRATIONS_PRIVILEGES_SQL, ['agenda_test_app']], [SQL.APPLICATION_PRIVILEGES_SQL, ['agenda_test_app', [...TABLE_ORDER]]]]);
    await h.port.close();
  });
  it.each([
    'SELECT 1', 'CREATE TABLE x (a int)', 'DROP TABLE "public"."users"', 'TRUNCATE "public"."users"', `${SQL.IDENTITY_SQL} `, SQL.REVOKE_MIGRATIONS_TABLE_SQL,
    'REVOKE ALL ON TABLE "public"."users" FROM "agenda_test_app"', 'GRANT ALL ON TABLE "public"."users" TO PUBLIC', 'COMMIT', 'ROLLBACK', SQL.BEGIN_READ_ONLY_SQL, '',
  ])('query() rechaza %j sin llegar al servidor', async text => {
    const h = harness('apply');
    await h.port.connect();
    await expect(h.port.query(text)).rejects.toBeInstanceOf(SessionContractError);
    expect(h.log).toEqual([]);
    await h.port.close();
  });
  it('exec() acepta solo los dos REVOKE exactos', async () => {
    const h = harness('apply');
    await h.port.connect();
    await h.port.exec(SQL.REVOKE_MIGRATIONS_TABLE_SQL); await h.port.exec(SQL.REVOKE_MIGRATIONS_SEQUENCE_SQL);
    expect(h.texts()).toEqual(['REVOKE ALL ON TABLE "public"."schema_migrations" FROM "agenda_test_app"', 'REVOKE ALL ON SEQUENCE "public"."schema_migrations_id_seq" FROM "agenda_test_app"']);
    for (const text of [SQL.IDENTITY_SQL, SQL.LOCK_SQL, 'REVOKE ALL ON TABLE "public"."users" FROM "agenda_test_app"', 'DROP TABLE "public"."users"', `${SQL.REVOKE_MIGRATIONS_TABLE_SQL};`])
      await expect(h.port.exec(text)).rejects.toBeInstanceOf(SessionContractError);
    expect(h.log).toHaveLength(2);
    expect(Object.values(SQL.WRITE_STATEMENTS)).toHaveLength(2);
    await h.port.close();
  });
  it('E. exec() acepta solo la sentencia exacta del bloqueo de tablas y query() la rechaza', async () => {
    const h = harness('revert');
    await h.port.connect();
    await h.port.exec(SQL.TABLE_LOCK_SQL);
    expect(h.texts()).toEqual([SQL.TABLE_LOCK_SQL]);
    const variants = [
      SQL.TABLE_LOCK_SQL.replace('ACCESS EXCLUSIVE', 'SHARE'), SQL.TABLE_LOCK_SQL.replace('ACCESS EXCLUSIVE', 'ACCESS SHARE'), `${SQL.TABLE_LOCK_SQL};`,
      SQL.TABLE_LOCK_SQL.replace('"public"."organizations", ', ''), SQL.TABLE_LOCK_SQL.replace('LOCK TABLE', 'LOCK TABLE ONLY'), `${SQL.TABLE_LOCK_SQL} NOWAIT`,
      'LOCK TABLE "public"."users" IN ACCESS EXCLUSIVE MODE', `${SQL.TABLE_LOCK_SQL} `, 'LOCK TABLE "public"."schema_migrations" IN ACCESS EXCLUSIVE MODE',
    ];
    for (const text of variants) await expect(h.port.exec(text)).rejects.toBeInstanceOf(SessionContractError);
    await expect(h.port.query(SQL.TABLE_LOCK_SQL)).rejects.toBeInstanceOf(SessionContractError);
    expect(h.log).toHaveLength(1);
    await h.port.close();
  });
  it('antes de conectar no se acepta ninguna consulta', async () => {
    const h = harness('apply');
    await expect(h.port.query(SQL.LOCK_SQL, [LOCK_KEY])).rejects.toBeInstanceOf(SessionContractError);
  });
});

describe('opciones y cierre de recursos', () => {
  it('opciones inseguras o de otro modo se rechazan al crear el puerto', () => {
    const base = createSchemaDataSourceOptions(config, 'apply', { logger });
    expect(() => createTypeOrmPort({ options: { ...base, synchronize: true }, mode: 'apply' })).toThrow(SchemaRunnerError);
    expect(() => createTypeOrmPort({ options: base, mode: 'plan' })).toThrow(SchemaRunnerError);
    expect(() => createTypeOrmPort({ options: { ...base, username: 'agenda_test_app' }, mode: 'apply' })).toThrow(SchemaRunnerError);
  });
  it('close() libera el QueryRunner y destruye el DataSource; isClosed lo comprueba y es idempotente', async () => {
    const h = harness('apply');
    expect(h.port.isClosed()).toBe(true);
    await h.port.connect();
    expect(h.port.isClosed()).toBe(false);
    await h.port.close(); await h.port.close();
    expect(h.port.isClosed()).toBe(true);
  });
  it('si la liberación o la destrucción fallan, el cierre no se da por verificado', async () => {
    const h = harness('apply');
    await h.port.connect();
    const ds = h.created[0];
    ds.destroy = async () => { throw new Error(password); };
    await h.port.close();
    expect(h.port.isClosed()).toBe(false);
  });
  it('un fallo al inicializar el DataSource se propaga y no deja nada abierto', async () => {
    const h = harness('apply');
    const failing = createTypeOrmPort({ options: h.options, mode: 'apply', createDataSource: o => { const ds = new DataSource(o); ds.initialize = async () => { throw new Error(password); }; return ds; } });
    await expect(failing.connect()).rejects.toBeDefined();
    await failing.close();
    expect(failing.isClosed()).toBe(true);
  });
});
