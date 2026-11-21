import type { MigrationInterface, QueryRunner } from 'typeorm';
import { digestOf, SCHEMA_MANIFEST, type ManifestEntry } from '../migrations/schema-manifest';
import { classifyState, decideAction, evaluateExecuted, tablesOfPrefix } from './schema-guards';
import { runSchema, summaryOf, refusal, type SchemaPort } from './schema-runner';
import { deriveStructure, definitionsDigest, type StructureRow } from './schema-structure';
import * as SQL from './schema-sql';
import { type SchemaCommand } from './schema-target';

const UP_A = ['CREATE TABLE "public"."alpha" ("id" integer NOT NULL, CONSTRAINT "PK_alpha" PRIMARY KEY ("id"), CONSTRAINT "CK_alpha_id" CHECK (id > 0))',
  'CREATE INDEX "IX_alpha_positive" ON "public"."alpha" ("id") WHERE id > 0'];
const UP_B = ['CREATE TABLE "public"."beta" ("id" integer NOT NULL, CONSTRAINT "PK_beta" PRIMARY KEY ("id"), CONSTRAINT "CK_beta_id" CHECK (id < 100))',
  'CREATE INDEX "IX_beta_small" ON "public"."beta" ("id") WHERE id < 100'];
class Alpha1800000000000 implements MigrationInterface {
  async up(q: QueryRunner) { for (const s of UP_A) await q.query(s); }
  async down(q: QueryRunner) { await q.query('DROP TABLE "public"."alpha"'); }
}
class Beta1800000000001 implements MigrationInterface {
  async up(q: QueryRunner) { for (const s of UP_B) await q.query(s); }
  async down(q: QueryRunner) { await q.query('DROP TABLE "public"."beta"'); }
}
const manifest: readonly ManifestEntry[] = [Alpha1800000000000, Beta1800000000001].map((migration, i) => {
  const up = i ? UP_B : UP_A; const down = [`DROP TABLE "public"."${i ? 'beta' : 'alpha'}"`];
  return { ...SCHEMA_MANIFEST[0], name: migration.name, timestamp: 1800000000000 + i, migration, up, down, sha256: digestOf(up, down), tables: [i ? 'beta' : 'alpha'], definitionsDigest: null };
});
const history = (k: number) => manifest.slice(0, k).map((e, i) => ({ id: i + 1, name: e.name, timestamp: String(e.timestamp) }));
const zero = [{ routines: 0, types: 0, extensions: 0 }];
const relations = (k: number) => [...tablesOfPrefix(manifest, k).map(name => ({ name, kind: 'r' })),
  { name: 'schema_migrations', kind: 'r' }, { name: 'schema_migrations_id_seq', kind: 'S' }];
const snapshot = (k: number) => ({ relations: relations(k), executed: history(k), foreignObjects: zero });

describe('prefijos del historial y tablas acumuladas', () => {
  it('distingue ninguno, prefijo y todas con bigint decimal o número exacto', () => {
    expect(evaluateExecuted([], manifest)).toBe('none');
    expect(evaluateExecuted(history(1), manifest)).toEqual({ kind: 'prefix', applied: 1 });
    expect(evaluateExecuted(history(2), manifest)).toBe('all');
    expect(evaluateExecuted(history(2).map(r => ({ ...r, timestamp: Number(r.timestamp) })), manifest)).toBe('all');
  });
  it.each([
    ['desconocido', [{ name: 'Other1800000000000', timestamp: 1800000000000 }]],
    ['orden', history(2).reverse()], ['duplicado', [history(1)[0], history(1)[0]]], ['hueco', [history(2)[1]]],
    ['por delante', [...history(2), { name: 'Future1800000000002', timestamp: 1800000000002 }]],
    ['timestamp', [{ ...history(1)[0], timestamp: 1800000000001 }]], ['timestamp ausente', [{ name: manifest[0].name }]],
  ])('rechaza historial %s', (_name, rows) => {
    expect(evaluateExecuted(rows, manifest)).toBe('diverged');
    expect(() => classifyState({ ...snapshot(1), executed: rows }, manifest)).toThrow('history_diverged');
  });
  it.each([null, {}, [null], [{ name: 1 }], 'ilegible'])('rechaza filas ilegibles: %j', rows => {
    expect(evaluateExecuted(rows, manifest)).toBe('unreadable');
  });
  it('conserva el orden, rechaza duplicados e índices de prefijo inválidos', () => {
    expect(tablesOfPrefix(manifest, 0)).toEqual([]);
    expect(tablesOfPrefix(manifest, 1)).toEqual(['alpha']);
    expect(tablesOfPrefix(manifest, 2)).toEqual(['alpha', 'beta']);
    expect(tablesOfPrefix([{ ...manifest[0], tables: ['zeta', 'alpha'] }, manifest[1]], 2)).toEqual(['zeta', 'alpha', 'beta']);
    expect(() => tablesOfPrefix([manifest[0], { ...manifest[1], tables: ['alpha'] }], 1)).toThrow('manifest_invalid');
    for (const k of [-1, 3, 0.5, NaN]) expect(() => tablesOfPrefix(manifest, k)).toThrow('manifest_invalid');
  });
  it('clasifica esquema vacío, prefijo exacto, aplicado y todas las inconsistencias', () => {
    expect(classifyState(snapshot(0), manifest)).toBe('fresh');
    expect(classifyState(snapshot(1), manifest)).toBe('upgradable');
    expect(classifyState(snapshot(2), manifest)).toBe('applied');
    for (const rows of [relations(2), relations(1).filter(r => r.name !== 'alpha'), relations(1).filter(r => r.kind !== 'S')])
      expect(classifyState({ ...snapshot(1), relations: rows }, manifest)).toBe('partial');
    for (const key of ['routines', 'types', 'extensions']) expect(classifyState({ ...snapshot(1), foreignObjects: [{ ...zero[0], [key]: 1 }] }, manifest)).toBe('foreign');
    expect(classifyState({ ...snapshot(1), relations: [...relations(1), { name: 'alien', kind: 'r' }] }, manifest)).toBe('foreign');
  });
  it.each(['plan', 'apply', 'revert'] as const)('decide todos los estados en %s', command => {
    const expected = command === 'plan' ? ['proceed', 'proceed', 'proceed', 'proceed', 'refuse'] : command === 'apply' ?
      ['proceed', 'proceed', 'noop', 'refuse', 'refuse'] : ['noop', 'proceed', 'proceed', 'refuse', 'refuse'];
    expect((['fresh', 'upgradable', 'applied', 'partial', 'foreign'] as const).map(s => decideAction(command, s).action)).toEqual(expected);
  });
});

const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const virtual = { clock: () => 0, timers: { set: () => 0, clear: () => undefined }, aborted: () => false };
function fake(command: SchemaCommand, start: number, options: { structure?: unknown; history?: unknown; change?: 'history' | 'state'; fail?: 'migrate' | 'privileges' | 'structure' | 'history' | 'commit'; drift?: boolean; nonEmpty?: boolean; locked?: boolean; returned?: string[]; pin?: boolean } = {}) {
  const events: string[] = []; const args: { sql: string; params?: readonly unknown[] }[] = [];
  let k = start; let durable = start; let tx = false; let closed = false; let migrated = false; let inspections = 0;
  const entries = options.pin ? manifest.map((e, i) => ({ ...e, definitionsDigest: definitionsDigest(deriveStructure(manifest.slice(0, i + 1).flatMap(e => [...e.up]))) })) : manifest;
  const label = (sql: string) => Object.entries(SQL.ALL_STATEMENTS).find(([, text]) => text === sql)?.[0] ?? sql;
  const port: SchemaPort = {
    async connect() { events.push('connect'); },
    async query(sql, params) {
      events.push(label(sql)); args.push({ sql, params });
      switch (sql) {
        case SQL.LOCK_SQL: return [{ locked: !options.locked }];
        case SQL.UNLOCK_SQL: return [{ unlocked: true }];
        case SQL.IDENTITY_SQL: return [{ database: 'agenda_test', current_user: 'agenda_test_owner', session_user: 'agenda_test_owner', version_num: 160015,
          in_recovery: false, transaction_read_only: command === 'plan' ? 'on' : 'off', default_read_only: command === 'plan' ? 'on' : 'off', standard_conforming_strings: 'on',
          current_schema: 'public', effective_search_path: 'public', statement_timeout: '15s', lock_timeout: '5s', idle_in_transaction_session_timeout: '30s',
          application_name: 'agenda-schema-runner', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true,
          can_use_public: true, can_create_public: true, owns_database: true, event_triggers: 0, owner_memberships: 0, app_role_exists: true }];
        case SQL.RELATIONS_SQL:
          inspections++;
          return options.change === 'state' && inspections === 2 ? relations(k).filter(r => r.name !== 'alpha') : relations(k);
        case SQL.FOREIGN_OBJECTS_SQL: return zero;
        case SQL.MIGRATIONS_COLUMNS_SQL: return [{ name: 'id', type: 'integer' }, { name: 'timestamp', type: 'bigint' }, { name: 'name', type: 'character varying' }];
        case SQL.EXECUTED_SQL:
          return options.history ?? (options.change === 'history' && inspections === 2 ? history(2) : migrated && options.fail === 'history' ? history(1) : history(k));
        case SQL.STRUCTURE_SQL: if ('structure' in options) return options.structure; return options.drift || (migrated && options.fail === 'structure') ? [] : deriveStructure(manifest.slice(0, k).flatMap(e => [...e.up]));
        case SQL.MIGRATIONS_PRIVILEGES_SQL: return [
          ...privileges.map(privilege => ({ kind: 'table', privilege })), ...['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].map(privilege => ({ kind: 'column', privilege })),
          ...['USAGE', 'SELECT', 'UPDATE'].map(privilege => ({ kind: 'sequence', privilege })),
        ].map(r => ({ ...r, effective: false, grantable: false }));
        case SQL.APPLICATION_PRIVILEGES_SQL: return (params![1] as string[]).flatMap(name => privileges.map(privilege => ({ name, privilege,
          effective: !(migrated && options.fail === 'privileges') && ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), grantable: false })));
        case SQL.TRANSACTION_CLOSED_SQL: return [{ no_xid: !tx, no_backend_xid: !tx, implicit_transaction: !tx }];
        default:
          for (const e of manifest) if (sql === SQL.tablesEmptySql(e.tables)) return [Object.fromEntries(e.tables.map(t => [t, !options.nonEmpty]))];
          throw new Error('consulta inesperada');
      }
    },
    async exec(sql) { events.push(label(sql)); },
    async begin(isolation) { events.push(isolation ? 'BEGIN_READ_ONLY' : 'BEGIN'); tx = true; },
    async commit() { events.push('COMMIT'); if (options.fail === 'commit') throw new Error('respuesta perdida'); durable = k; tx = false; },
    async rollback() { events.push('ROLLBACK'); k = durable; tx = false; },
    async applyMigrations() { events.push('migrate'); const pending = manifest.slice(k).map(e => e.name); k = 2; migrated = true; if (options.fail === 'migrate') throw new Error('fallo'); return options.returned ?? pending; },
    async revertLast() { events.push('revert'); k--; migrated = true; },
    transactionEvidence() { return { clientStatus: tx ? 'T' : 'I', queryRunnerActive: tx }; },
    async close() { events.push('close'); closed = true; }, isClosed() { return closed; },
  };
  return { events, args, prefix: () => k, durable: () => durable, run: (showDefinitions = false) => runSchema({ command, showDefinitions, port, manifest: entries, ...virtual }) };
}

describe('flujo transaccional con manifiesto sintético de dos entradas', () => {
  it.each([0, 1])('apply desde prefijo %i aplica solo pendientes en una transacción', async k => {
    const f = fake('apply', k, { pin: true }); const result = await f.run();
    expect(result).toMatchObject({ outcome: 'applied', state: 'applied', structure: 'verified', ok: true, executed: manifest.map(e => e.name), pending: [] });
    expect(f.events.filter(e => ['BEGIN', 'COMMIT', 'ROLLBACK', 'migrate'].includes(e))).toEqual(['BEGIN', 'migrate', 'COMMIT']);
    expect(f.durable()).toBe(2);
    expect(f.args.find(a => a.sql === SQL.APPLICATION_PRIVILEGES_SQL)?.params).toEqual(['agenda_test_app', ['alpha', 'beta']]);
    const inspect = ['RELATIONS_SQL', 'FOREIGN_OBJECTS_SQL', 'MIGRATIONS_COLUMNS_SQL', 'EXECUTED_SQL'];
    expect(f.events).toEqual(['connect', 'LOCK_SQL', 'IDENTITY_SQL', ...inspect,
      ...(k ? ['STRUCTURE_SQL'] : []), 'BEGIN', ...(k ? [SQL.tableLockSql(['alpha'])] : []), ...inspect,
      ...(k ? ['STRUCTURE_SQL'] : []), 'migrate', 'REVOKE_MIGRATIONS_TABLE_SQL', 'REVOKE_MIGRATIONS_SEQUENCE_SQL',
      'MIGRATIONS_PRIVILEGES_SQL', 'APPLICATION_PRIVILEGES_SQL', ...inspect, 'STRUCTURE_SQL', 'COMMIT', 'TRANSACTION_CLOSED_SQL', 'UNLOCK_SQL', 'close']);
  });
  it('rechaza una lista devuelta que incluye migraciones previas', async () => {
    const f = fake('apply', 1, { returned: manifest.map(e => e.name) });
    expect(await f.run()).toMatchObject({ code: 'executed_unexpected', transaction: 'rolled_back' });
    expect(f.durable()).toBe(1);
  });
  it.each(['history', 'state'] as const)('revalida %s tras BEGIN y bloqueo, antes de migrar', async change => {
    const f = fake('apply', 1, { change });
    expect(await f.run()).toMatchObject({ code: change === 'history' ? 'history_diverged' : 'state_partial', transaction: 'rolled_back', outcome: 'failed' });
    expect(f.events).not.toContain('migrate'); expect(f.events).not.toContain('COMMIT'); expect(f.prefix()).toBe(1);
  });
  it.each(['migrate', 'privileges', 'structure', 'history'] as const)('fallo en %s revierte todas las pendientes y conserva el prefijo', async fail => {
    for (const k of [0, 1]) {
      const f = fake('apply', k, { fail });
      expect(await f.run()).toMatchObject({ outcome: 'failed', committed: false, transaction: 'rolled_back' });
      expect(f.prefix()).toBe(k); expect(f.durable()).toBe(k); expect(f.events).not.toContain('COMMIT');
    }
  });
  it('COMMIT ambiguo conserva salida no confirmada', async () => {
    const f = fake('apply', 1, { fail: 'commit' });
    expect(await f.run()).toMatchObject({ outcome: 'commit_unconfirmed', exit: 3 });
    expect(f.events).not.toContain('ROLLBACK'); expect(f.events).not.toContain('UNLOCK_SQL');
  });
  it.each(['apply', 'revert', 'plan'] as const)('informa historial divergente en %s sin migraciones ni escrituras', async command => {
    for (const rows of [[history(2)[1]], history(2).reverse(), [...history(2), history(1)[0]], [{ name: 'Unknown', timestamp: 1 }]]) {
      const f = fake(command, 1, { history: rows });
      expect(await f.run()).toMatchObject({ code: 'history_diverged', outcome: command === 'plan' ? 'planned' : 'refused' });
      expect(f.events.filter(e => ['migrate', 'revert', 'COMMIT'].includes(e) || e.startsWith('REVOKE'))).toEqual([]);
      if (command !== 'plan') expect(f.events).not.toContain('BEGIN');
    }
  });
  it('deriva previa se rechaza antes de BEGIN o bloqueos de tablas', async () => {
    const f = fake('apply', 1, { drift: true });
    expect(await f.run()).toMatchObject({ outcome: 'refused', structure: 'drift', code: 'schema_drift' });
    expect(f.events).not.toContain('BEGIN'); expect(f.events).not.toContain('migrate');
  });
  it('bloqueo ocupado impide toda lectura de estado', async () => {
    const f = fake('apply', 1, { locked: true });
    expect(await f.run()).toMatchObject({ code: 'lock_unavailable' });
    expect(f.events).toEqual(['connect', 'LOCK_SQL', 'close']);
  });
  it.each([1, 2])('revert desde %i elimina solo la última entrada y verifica el prefijo resultante', async k => {
    const f = fake('revert', k);
    expect(await f.run()).toMatchObject({ outcome: 'reverted', state: k === 1 ? 'fresh' : 'upgradable', structure: k === 1 ? 'unchecked' : 'definitions_unpinned', ok: true });
    expect(f.durable()).toBe(k - 1);
    const lock = f.events.indexOf(SQL.tableLockSql(tablesOfPrefix(manifest, k)));
    expect(lock).toBe(f.events.indexOf('BEGIN') + 1);
    expect(f.events.indexOf(SQL.tablesEmptySql(manifest[k - 1].tables))).toBeGreaterThan(lock);
    expect(f.events.filter(e => e === 'revert')).toHaveLength(1);
    expect(f.args.filter(a => a.sql === SQL.STRUCTURE_SQL).map(a => a.params)).toEqual([
      [tablesOfPrefix(manifest, k)], [tablesOfPrefix(manifest, k)], ...(k > 1 ? [[tablesOfPrefix(manifest, k - 1)]] : []),
    ]);
    const blocked = fake('revert', k, { nonEmpty: true });
    expect(await blocked.run()).toMatchObject({ code: 'tables_not_empty', transaction: 'rolled_back' });
    expect(blocked.events).not.toContain('revert'); expect(blocked.durable()).toBe(k);
  });
  it('revert con deriva previa o posterior no confirma y conserva el prefijo', async () => {
    const before = fake('revert', 2, { drift: true });
    expect(await before.run()).toMatchObject({ code: 'schema_drift', outcome: 'refused' });
    expect(before.events).not.toContain('BEGIN');
    const after = fake('revert', 2, { fail: 'structure' });
    expect(await after.run()).toMatchObject({ code: 'schema_drift', outcome: 'failed', transaction: 'rolled_back' });
    expect(after.prefix()).toBe(2); expect(after.durable()).toBe(2);
  });
  it('plan informa pendientes y digest observado sin escrituras', async () => {
    const f = fake('plan', 1); const result = await f.run();
    expect(result).toMatchObject({ state: 'upgradable', executed: [manifest[0].name], pending: [manifest[1].name], structure: 'definitions_unpinned', outcome: 'planned' });
    expect(result.structureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.events.filter(e => e === 'COMMIT' || e === 'migrate' || e === 'revert' || e.startsWith('REVOKE') || e.startsWith('LOCK TABLE'))).toEqual([]);
    expect(summaryOf(result).structureDigest).toBe(result.structureDigest);
  });
  it('la proyección descarta estructura y digest arbitrarios', () => {
    expect(summaryOf({ ...refusal('plan', 'args_invalid'), structureDigest: 'a'.repeat(64) + '\n' }).structureDigest).toBeNull();
    expect(summaryOf({ ...refusal('plan', 'args_invalid'), structure: 'secreto' as never, structureDigest: 'z'.repeat(64) })).toMatchObject({ structure: 'unchecked', structureDigest: null });
  });
});

describe('plan muestra definiciones validadas sin escrituras ni consultas adicionales', () => {
  const expected = [
    { kind: 'check', table: 'alpha', name: 'CK_alpha_id', definition: 'CHECK ( id > 0 )' },
    { kind: 'check', table: 'beta', name: 'CK_beta_id', definition: 'CHECK ( id < 100 )' },
    { kind: 'predicate', table: 'alpha', name: 'IX_alpha_positive', definition: 'id > 0' },
    { kind: 'predicate', table: 'beta', name: 'IX_beta_small', definition: 'id < 100' },
  ];
  it.each([false, true])('catálogo verificado con pin=%s, orden estable y digest observado', async pin => {
    const rows = deriveStructure(manifest.flatMap(e => [...e.up]));
    const normal = fake('plan', 2, { pin, structure: rows });
    const reversed = fake('plan', 2, { pin, structure: [...rows].reverse() });
    const plain = fake('plan', 2, { pin, structure: rows });
    const result = await normal.run(true), other = await reversed.run(true);
    expect(result.definitions).toEqual(expected);
    expect(result.definitionsOmitted).toBe(false);
    expect(other).toEqual(result);
    expect(result.structureDigest).toBe(definitionsDigest(rows));
    expect((await plain.run()).definitions).toEqual([]);
    expect(normal.args).toEqual(plain.args);
    expect(normal.events.filter(e => ['BEGIN', 'COMMIT', 'migrate', 'revert'].includes(e) || e.startsWith('REVOKE') || e.startsWith('LOCK TABLE'))).toEqual([]);
    expect(normal.events).toContain('BEGIN_READ_ONLY');
  });
  it('prefijo inicial upgradable solo muestra sus definiciones', async () => {
    const result = await fake('plan', 1).run(true);
    expect(result.state).toBe('upgradable');
    expect(result.definitions).toEqual(expected.filter(d => d.table === 'alpha'));
  });
  it.each(['deriva', 'fresh', 'ilegible', 'apply', 'revert'] as const)('omite definiciones en %s', async mode => {
    const f = mode === 'apply' || mode === 'revert' ? fake(mode, 1) : mode === 'fresh' ? fake('plan', 0) :
      fake('plan', 2, { structure: mode === 'deriva' ? [] : null });
    const result = await f.run(true);
    expect(result.definitions).toEqual([]);
    expect(result.definitionsOmitted).toBe(false);
  });
  it.each(["CHECK (id > 0 AND 'á' = 'á')", `CHECK ('${'x'.repeat(2001)}' = 'x')`, 'CHECK (\nid > 0)', 'CHECK (id > 0)\n', "CHECK ('\t' = '')"])(
    'una definición insegura descarta todas: %j', async definition => {
      const rows: StructureRow[] = deriveStructure(manifest.flatMap(e => [...e.up]));
      rows.find(r => r.type === 'c')!.definition = definition;
      const f = fake('plan', 2, { structure: rows }); const result = await f.run(true);
      expect(result).toMatchObject({ structure: 'definitions_unpinned', definitions: [], definitionsOmitted: true, exit: 0 });
      expect(summaryOf(result).definitionsOmitted).toBe(true);
      expect(JSON.stringify(summaryOf(result))).not.toContain(definition);
      expect(f.events).not.toContain('BEGIN');
    });
});
