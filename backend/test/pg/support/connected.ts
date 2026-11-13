import { registerHttpTest } from './http-register';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager, type Logger } from 'typeorm';
import { validateDatabaseEnvironment } from '../../../src/config/database-environment';
import { createDataSourceOptions } from '../../../src/database/data-source-options';
import { evaluateDatabaseIdentity } from '../../../src/database/database-identity.service';
import { ConstraintRegistry } from '../../../src/database/errors/constraint-registry';
import { configureHttpApp } from '../../../src/common/http/configure-http-app';
import { RegistrationService, REGISTRATION_NOW, REGISTRATION_NORMALIZERS, type RegistrationResult } from '../../../src/registration/registration.service';
import { DataSourceTransactionRunner, TransactionRunner } from '../../../src/registration/transaction-runner';
import { PasswordHasher } from '../../../src/identity/password-hasher';
import { IdGenerator } from '../../../src/common/ids/id-generator';
import { UserSession } from '../../../src/persistence/entities/user-session.entity';
import { User } from '../../../src/persistence/entities/user.entity';
import { Organization } from '../../../src/persistence/entities/organization.entity';
import { OrganizationMembership } from '../../../src/persistence/entities/organization-membership.entity';
import { ConflictError, InvalidInputError } from '../../../src/common/errors/domain-error';
import { classifyDatabaseError } from '../../../src/database/errors/database-failure';
import { DatabaseOperationError } from '../../../src/database/errors/database-operation-error';
import { normalizePersonName, organizationNameKey } from '../../../src/identity/person-name';
import { normalizeEmail } from '../../../src/identity/email';
import { DeleteGate, httpCleanupSQL, httpCleanupTargets, markers, runId, validateRunId } from './markers';
import { accepted, checkRejected, columnTypeRejected, collisions, distinct, normalizerRejected } from './unicode-cases';
import type { Phase } from './phase';
import { assertFingerprint, businessFingerprint, migrationFingerprint, fingerprintSQL } from './schema-fingerprint';
import { classifyMigrationHistory, type MigrationHistory } from './migration-history';

const tables = ['organizations', 'users', 'organization_memberships', 'companies', 'company_accesses', 'posts', 'post_comments', 'user_sessions'] as const;
const identitySQL = "select current_user as usuario, current_database() as base, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, has_schema_privilege(current_user, 'public', 'CREATE') as crea_en_public, has_database_privilege(current_user, current_database(), 'CREATE') as crea_en_base from pg_roles r where r.rolname = current_user";
const sessionSQL = "SELECT pid, backend_start FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND application_name = 'agenda-backend'";
const roSQL = "SELECT pg_sleep(0.2), pg_backend_pid() AS pid, current_setting('transaction_read_only') AS ro, current_setting('default_transaction_read_only') AS dro";
// No query or parameter logging: failures are asserted via sanitized classification.
const logger: Logger = { logQuery() {}, logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} };
type Session = { pid: number; backend_start: Date };
const failure = (error: unknown) => error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);

export function registerConnectedSuite(phase: Exclude<Phase, 'offline'>): void {
  describe(`B2B ${phase}`, () => {
    const id = runId(), gate = new DeleteGate(phase), saved: RegistrationResult[] = [];
    const httpTargets = phase === 'http' ? httpCleanupTargets(id) : undefined;
    let observer: DataSource | undefined, source: DataSource, app: INestApplication | undefined, moduleRef: TestingModule | undefined;
    let service: RegistrationService, sequence = 0, ready = false;
    let migrationHistory: MigrationHistory = 'unverified';
    let beforePids = new Set<number>(), ownSessions: Session[] = [];
    const input = (suffix = `org-${sequence}`) => ({ ...markers(id, sequence++, suffix), name: 'B2B Tester', password: 'B2b-test-only-long-passphrase-2026!' });
    async function counts(): Promise<number[]> {
      return Promise.all(tables.map(async table => {
        const rows: { n: number }[] = await observer!.query(`SELECT count(*)::int AS n FROM public.${table}`);
        return rows[0].n;
      }));
    }
    async function empty(): Promise<void> {
      const values = await counts();
      const occupied = tables.filter((_, i) => values[i] !== 0);
      if (occupied.length) throw new Error(`[b2b] runId=${id}: tablas no vacías ${occupied.join(', ')}; conteos=${values.join(',')}`);
    }
    async function cleanup(): Promise<void> {
      gate.assertArmed(); validateRunId(id);
      const userIds = saved.map(r => r.user.id), orgIds = saved.map(r => r.organization.id);
      // First saved ids, then exact HTTP reservations or DML run patterns. Always WHERE.
      if (httpTargets) {
        await observer!.query('DELETE FROM public.organization_memberships WHERE id = ANY($1::uuid[])', [saved.map(r => r.membership.id)]);
      }
      await observer!.query('DELETE FROM public.organization_memberships WHERE user_id = ANY($1::uuid[]) OR organization_id = ANY($2::uuid[])', [userIds, orgIds]);
      await observer!.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [userIds]);
      await observer!.query('DELETE FROM public.organizations WHERE id = ANY($1::uuid[])', [orgIds]);
      if (httpTargets) {
        await observer!.query(httpCleanupSQL.memberships, [httpTargets.emails, httpTargets.organizationNames]);
        await observer!.query(httpCleanupSQL.users, [httpTargets.emails]);
        await observer!.query(httpCleanupSQL.organizations, [httpTargets.organizationNames]);
      } else {
        const emailPattern = `^b2b-${id}-[0-9]+@agenda-b2b[.]test$`, orgPattern = `B2B-${id}-%`;
        await observer!.query('DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email ~ $1) OR organization_id IN (SELECT id FROM public.organizations WHERE name LIKE $2)', [emailPattern, orgPattern]);
        await observer!.query('DELETE FROM public.users WHERE email ~ $1', [emailPattern]);
        await observer!.query('DELETE FROM public.organizations WHERE name LIKE $1', [orgPattern]);
      }
      await empty();
    }
    async function register(value: ReturnType<typeof input>, target = service): Promise<RegistrationResult> {
      gate.assertArmed(); const result = await target.register(value); saved.push(result); return result;
    }
    async function captureSessions(): Promise<void> {
      const sessions: Session[] = await observer!.query(sessionSQL);
      ownSessions = sessions.filter(s => !beforePids.has(s.pid));
      console.info(`[b2b] runId=${id} sesiones=${JSON.stringify(ownSessions)}`);
    }
    async function close(): Promise<void> {
      try {
        if (observer?.isInitialized && moduleRef) await captureSessions();
      } finally {
        try { if (app) await app.close(); else if (moduleRef) await moduleRef.close(); }
        finally {
          if (observer?.isInitialized) {
            try {
              const deadline = Date.now() + 5000;
              let remaining: Session[] = [];
              do {
                const sessions: Session[] = await observer.query(sessionSQL);
                remaining = sessions.filter(s => ownSessions.some(o => o.pid === s.pid && String(o.backend_start) === String(s.backend_start)));
                if (!remaining.length) break;
                await new Promise(resolve => setTimeout(resolve, 100));
              } while (Date.now() < deadline);
              expect(remaining).toEqual([]);
            } finally { await observer.destroy(); }
          }
        }
      }
    }
    beforeAll(async () => {
      console.info(`[b2b] runId=${id} phase=${phase}`);
      process.env.DATABASE_POOL_MAX ??= '10';
      const database = validateDatabaseEnvironment({ ...process.env }, { nodeEnv: 'test', role: 'app' });
      if (process.env.DATABASE_PORT !== '5433' || process.env.DATABASE_NAME !== 'agenda_test') throw new Error('Se exige DATABASE_PORT=5433 y DATABASE_NAME=agenda_test exactos');
      if (database.poolMax !== 10) throw new Error('Se exige pool 10 para las sondas concurrentes');
      const options = createDataSourceOptions(database, { logger });
      observer = new DataSource({ ...options, entities: [], extra: { ...options.extra, max: 1, application_name: `agenda-b2b-${id}` } });
      try {
        await observer.initialize();
        if (phase === 'readonly') {
          const rows: { ro: string; dro: string }[] = await observer.query(roSQL);
          expect(rows[0]).toMatchObject({ ro: 'on', dro: 'on' });
        }
        const rows: unknown[] = await observer.query(identitySQL);
        expect(rows).toHaveLength(1);
        expect(evaluateDatabaseIdentity(rows[0], { user: 'agenda_test_app', database: 'agenda_test' })).toBe(true);
        gate.mark('identity');
        const settings = await observer.query("SELECT current_setting('server_version') AS version, pg_is_in_recovery() AS recovery, current_setting('server_encoding') AS encoding, d.datctype AS ctype, d.datcollate AS collate FROM pg_catalog.pg_database d WHERE d.datname = current_database()");
        expect(settings).toHaveLength(1);
        console.info('[b2b] configuración servidor', settings);
        expect(settings[0].version).toMatch(/^16\./); expect(settings[0].recovery).toBe(false); expect(settings[0].encoding).toBe('UTF8');
        for (const table of [...tables, 'schema_migrations']) {
          const found = await observer.query('SELECT to_regclass($1) AS relation', [`public.${table}`]);
          expect(found[0].relation).not.toBeNull();
        }
        // Structural checks are independent of SELECT on schema_migrations.
        const fingerprint = await observer.query(fingerprintSQL, [tables]);
        console.info('[b2b] huella negocio (referencia 68/64/26)', fingerprint);
        assertFingerprint('negocio', fingerprint[0], businessFingerprint);
        const migrations = await observer.query(fingerprintSQL, [['schema_migrations']]);
        console.info('[b2b] huella schema_migrations (referencia 3/1/1)', migrations);
        assertFingerprint('schema_migrations', migrations[0], migrationFingerprint);
        gate.mark('schema');
        // Only a pg permission error from this history query may be tolerated.
        let historyResult: { rows: unknown[] } | { error: unknown };
        try {
          historyResult = { rows: await observer.query('SELECT name FROM public.schema_migrations WHERE name = $1', ['InitialSchema1794009600000']) };
        } catch (error) { historyResult = { error }; }
        migrationHistory = classifyMigrationHistory(historyResult);
        if (migrationHistory === 'unverified') console.warn('[b2b] historial de migraciones SIN VERIFICAR (sin SELECT sobre schema_migrations)');
        await empty(); gate.mark('baseline');
        beforePids = new Set((await observer.query(sessionSQL) as Session[]).map(s => s.pid));
        const { AppModule } = await import('../../../src/app.module');
        moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication(); await configureHttpApp(app); await app.init();
        source = app.get(DataSource);
        if (phase === 'readonly') {
          // Hold five different physical connections concurrently, including verification before other assertions.
          const runners = Array.from({ length: 5 }, () => source.createQueryRunner());
          try {
            await Promise.all(runners.map(r => r.connect()));
            const readings = await Promise.all(runners.map(r => r.query(roSQL)));
            expect(new Set(readings.map(r => r[0].pid)).size).toBe(5);
            for (const reading of readings) expect(reading[0]).toMatchObject({ ro: 'on', dro: 'on' });
          } finally { await Promise.all(runners.map(r => r.release())); }
        }
        await captureSessions();
        expect(source.isInitialized).toBe(true); service = app.get(RegistrationService); expect(service).toBeInstanceOf(RegistrationService);
        expect(app.get(ConstraintRegistry).size).toBe(14);
        expect(new Set(source.entityMetadatas.map(m => m.target))).toEqual(new Set([User, Organization, OrganizationMembership, UserSession]));
        ready = true;
        console.info(`[b2b] preflight completado: migrationHistory=${migrationHistory}`);
      } catch (error) { await close(); throw error; }
    });
    if (phase === 'dml' || phase === 'http') {
      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });
    } else {
      afterAll(close); // readonly never registers a cleanup hook.
    }
    test('preflight y AppModule reales', () => expect(ready).toBe(true));
    if (phase === 'http') registerHttpTest(() => ({ app: app!, observer: observer!, gate, saved, id, ready, counts, credentials: input('http') }));
    if (phase === 'dml') {
      test('registro, rollback, concurrencia y equivalencia Unicode', async () => {
        expect(ready).toBe(true);
        gate.arm(); // Immediately before the first write, after all preflights succeeded.
        try {
          const firstInput = input('success'), first = await register(firstInput);
          for (const row of [first.user, first.organization, first.membership]) expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          expect((await counts()).slice(0, 3)).toEqual([1, 1, 1]);
          const joined = await observer!.query(`SELECT m.role, m.deactivated_at, u.version AS uv, o.version AS ov, m.version AS mv,
            u.created_at = u.updated_at AND u.created_at = o.created_at AND o.created_at = o.updated_at AND o.created_at = m.created_at AND m.created_at = m.updated_at AS dates,
            password_hash LIKE '$argon2id$%' AND char_length(password_hash) BETWEEN 40 AND 512 AS hash_ok
            FROM public.users u JOIN public.organization_memberships m ON m.user_id = u.id JOIN public.organizations o ON o.id = m.organization_id
            WHERE u.id = $1 AND o.id = $2 AND m.id = $3`, [first.user.id, first.organization.id, first.membership.id]);
          expect(joined).toEqual([{ role: 'community_manager', deactivated_at: null, uv: 1, ov: 1, mv: 1, dates: true, hash_ok: true }]);
          const duplicate = { ...input(), organizationName: firstInput.organizationName };
          await expect(register(duplicate)).rejects.toBeInstanceOf(ConflictError);
          await expect(register(duplicate)).rejects.toMatchObject({ field: 'organizationName' });
          expect(await observer!.query('SELECT id FROM public.users WHERE email = $1', [duplicate.email])).toEqual([]);
          const synthetic = new Error('B2B synthetic membership failure'); let inserts = 0;
          class FailingRunner extends DataSourceTransactionRunner {
            override run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
              return super.run(manager => work(new Proxy(manager, { get(target, property) {
                if (property === 'insert') return async (...args: Parameters<EntityManager['insert']>) => {
                  if (args[0] === OrganizationMembership) { expect(inserts).toBe(2); throw synthetic; }
                  const result = await target.insert(...args); inserts++; return result;
                };
                const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
              } })));
            }
          }
          const failingService = new RegistrationService(app!.get(PasswordHasher), app!.get(IdGenerator), new FailingRunner(source), app!.get(REGISTRATION_NOW), app!.get(REGISTRATION_NORMALIZERS));
          const forced = input('forced'); await expect(register(forced, failingService)).rejects.toBe(synthetic);
          expect(await observer!.query('SELECT id FROM public.users WHERE email = $1', [forced.email])).toEqual([]);
          expect(await observer!.query('SELECT id FROM public.organizations WHERE name = $1', [forced.organizationName])).toEqual([]);
          for (const c of normalizerRejected) {
            const initial = await counts(), runner = app!.get<TransactionRunner>(TransactionRunner), spy = jest.spyOn(runner, 'run');
            try {
              await expect(register({ ...input(), [c.field]: c.input })).rejects.toBeInstanceOf(InvalidInputError);
              await expect(register({ ...input(), [c.field]: c.input })).rejects.toMatchObject({ field: c.field });
              expect(spy).not.toHaveBeenCalled(); expect(await counts()).toEqual(initial);
            } finally { spy.mockRestore(); }
          }
          const started = Date.now();
          for (let round = 0; round < 5; round++) {
            for (const mode of ['email', 'organizationName', 'cross'] as const) {
              const before = await counts(), seed = sequence;
              const batch = Array.from({ length: mode === 'cross' ? 4 : 8 }, (_, index) => {
                const value = input(`round-${round}-${mode}-${index}`);
                if (mode === 'email') value.email = markers(id, seed, 'unused').email;
                if (mode === 'organizationName') value.organizationName = markers(id, seed, `round-${round}-fold-${index % 2 ? 'CAFE' : 'Café'}`).organizationName;
                if (mode === 'cross') {
                  value.email = markers(id, seed + (index % 2), 'unused').email;
                  value.organizationName = markers(id, seed, `cross-${round}-${Math.floor(index / 2)}`).organizationName;
                }
                return value;
              });
              const outcomes = await Promise.allSettled(batch.map(value => register(value)));
              const wins = outcomes.filter(o => o.status === 'fulfilled');
              if (mode !== 'cross') expect(wins).toHaveLength(1); else expect(wins.length).toBeGreaterThan(0);
              for (let i = 0; i < outcomes.length; i++) {
                const outcome = outcomes[i];
                if (outcome.status === 'rejected') {
                  const error: unknown = outcome.reason;
                  expect(['40P01', '55P03']).not.toContain(failure(error)?.sqlState);
                  expect(error).toBeInstanceOf(ConflictError);
                  if (mode !== 'cross') expect(error).toMatchObject({ field: mode });
                  if (mode === 'email') expect(await observer!.query('SELECT id FROM public.organizations WHERE name = $1', [batch[i].organizationName])).toEqual([]);
                  if (mode === 'organizationName') expect(await observer!.query('SELECT id FROM public.users WHERE email = $1', [batch[i].email])).toEqual([]);
                } else {
                  const r = outcome.value;
                  expect(await observer!.query('SELECT id FROM public.organization_memberships WHERE id = $1 AND user_id = $2 AND organization_id = $3', [r.membership.id, r.user.id, r.organization.id])).toHaveLength(1);
                }
              }
              const after = await counts(); expect(after.slice(0, 3).map((n, i) => n - before[i])).toEqual([wins.length, wins.length, wins.length]);
            }
          }
          expect(Date.now() - started).toBeLessThan(120000);
          for (const c of collisions) {
            const a = input(`collision-${c.id}-${c.first}`), b = input(`collision-${c.id}-${c.second}`);
            await register(a); await expect(register(b)).rejects.toBeInstanceOf(ConflictError);
            await expect(register(b)).rejects.toMatchObject({ field: 'organizationName' });
            await probe(async query => {
              await expect(query('INSERT INTO public.organizations (id,name,name_key,version,created_at,updated_at) VALUES ($1,$2,$3,1,now(),now())',
                [app!.get(IdGenerator).next(), normalizePersonName(b.organizationName), organizationNameKey(b.organizationName)])).rejects.toMatchObject({ driverError: { code: '23505', constraint: 'UQ_organizations_name_key' } });
            });
          }
          for (const c of distinct) {
            const a = input(`distinct-${c.id}-${c.first}`), b = input(`distinct-${c.id}-${c.second}`);
            expect(organizationNameKey(a.organizationName)).not.toBe(organizationNameKey(b.organizationName));
            await register(a); await register(b);
          }
          const phc = await app!.get(PasswordHasher).hash('B2b-test-only-long-passphrase-2026!');
          await probe(async query => {
            // Collect all case results so a CHECK mismatch does not hide the rest of the corpus.
            const actual: unknown[] = [], expected: unknown[] = [];
            for (const c of [...checkRejected, ...columnTypeRejected, ...accepted, { id: 'nbsp', input: 'Acme\u00a0Team', expected: 'accepted', reason: 'NBSP es aceptado sin normalizar por PostgreSQL' }]) {
              await query('SAVEPOINT unicode_case');
              try {
                let error: unknown;
                const name = c.expected === 'accepted' && c.id !== 'nbsp' ? normalizePersonName(c.input)! : 'Acme Team';
                try {
                  if ('column' in c && (c.column === 'email' || c.column === 'password_hash')) {
                    await query('INSERT INTO public.users (id,email,name,password_hash,password_changed_at,version,created_at,updated_at) VALUES ($1,$2,$3,$4,now(),1,now(),now())',
                      [app!.get(IdGenerator).next(), c.column === 'email' ? c.input : normalizeEmail(input().email), normalizePersonName('B2B Tester'), c.column === 'password_hash' ? c.input : phc]);
                  } else {
                    const rawName = 'column' in c && c.column === 'name' || c.id === 'nbsp' ? c.input : name;
                    const key = 'column' in c && c.column === 'name_key' ? c.input : organizationNameKey(name);
                    await query('INSERT INTO public.organizations (id,name,name_key,version,created_at,updated_at) VALUES ($1,$2,$3,1,now(),now())', [app!.get(IdGenerator).next(), rawName, key]);
                  }
                } catch (caught) { error = caught; }
                if ('constraint' in c) {
                  actual.push({ case: c.id, sqlState: failure(error)?.sqlState, constraint: failure(error)?.constraint });
                  expected.push({ case: c.id, sqlState: c.expected, constraint: c.constraint });
                } else if (c.expected === '22001') {
                  const classified = failure(error);
                  actual.push({ case: c.id, category: classified?.category, sqlState: classified?.sqlState, constraint: classified?.constraint });
                  expected.push({ case: c.id, category: 'data_exception', sqlState: c.expected, constraint: undefined });
                } else {
                  actual.push({ case: c.id, failure: failure(error), succeeded: error === undefined });
                  expected.push({ case: c.id, failure: undefined, succeeded: true });
                }
                if (c.id === 'nbsp' && error === undefined) console.info('[b2b] NBSP sin normalizar aceptado por PostgreSQL');
              } finally { await query('ROLLBACK TO SAVEPOINT unicode_case'); await query('RELEASE SAVEPOINT unicode_case'); }
            }
            expect(actual).toEqual(expected);
          });
        } finally { await cleanup(); }
      }, 240000);
    }
    async function probe(work: (query: (sql: string, values?: unknown[]) => Promise<unknown>) => Promise<void>): Promise<void> {
      gate.assertArmed(); const runner = source.createQueryRunner();
      try { await runner.connect(); await runner.startTransaction(); await work((sql, values) => runner.query(sql, values)); }
      finally { try { if (runner.isTransactionActive) await runner.rollbackTransaction(); } finally { await runner.release(); } }
    }
  });
}
