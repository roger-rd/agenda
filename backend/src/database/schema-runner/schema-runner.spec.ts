import { TABLE_ORDER } from '../migrations/initial-schema.statements';
import { SCHEMA_MANIFEST } from '../migrations/schema-manifest';
import { refusal, runSchema, SessionContractError, summaryOf, type RunResult, type SchemaPort, type Timers } from './schema-runner';
import { ALL_STATEMENTS } from './schema-sql';
import { BUDGET, LOCK_KEY, SUMMARY_PREFIX, TARGET, type SchemaCommand } from './schema-target';

const SECRET = 'fake-owner-password-for-unit-tests-0003';
const NAME = SCHEMA_MANIFEST[0].name;
const LABEL = new Map(Object.entries(ALL_STATEMENTS).map(([name, sql]) => [sql, name]));
const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

type Row = Record<string, unknown>;
type Schema = 'fresh' | 'fresh-with-table' | 'applied' | 'partial' | 'foreign';
interface Plan { label: string; nth?: number; mode: 'throw' | 'hang' }

/** In-memory stand-in for a session: it answers the pinned statements and models transactional visibility. */
function fakePort(command: SchemaCommand, start: Schema, tweaks: { exposed?: boolean; appWrong?: boolean; nonEmpty?: boolean; lockHeld?: boolean; names?: string[]; clientStatus?: string | undefined; scs?: string } = {}) {
  const events: string[] = [];
  const counts = new Map<string, number>();
  const plans: Plan[] = [];
  const hooks: Record<string, () => void> = {};
  const w = { schema: start as Schema, committed: start as Schema, tx: false, closed: false, rolledBack: 0, commits: 0 };
  const failure = (code?: string) => Object.assign(new Error(SECRET), { stack: SECRET, code, driverError: { code, message: SECRET } });
  const trip = async (label: string) => {
    const n = (counts.get(label) ?? 0) + 1; counts.set(label, n);
    hooks[label]?.();
    const plan = plans.find(p => p.label === label && (p.nth ?? n) === n);
    if (plan?.mode === 'hang') return new Promise<never>(() => undefined);
    if (plan) throw failure('XX000');
    return undefined;
  };
  const ro = command === 'plan' ? 'on' : 'off';
  const relations = (): Row[] => {
    const s = w.schema;
    const tables = (s === 'applied' || s === 'partial') ? (s === 'partial' ? [...TABLE_ORDER].slice(0, 3) : [...TABLE_ORDER]) : [];
    const migrations = s !== 'fresh';
    return [
      ...tables.map(name => ({ name, kind: 'r', table_name: null })), ...tables.map(name => ({ name: `PK_${name}`, kind: 'i', table_name: name })),
      ...(migrations && s !== 'foreign' ? [{ name: 'schema_migrations', kind: 'r', table_name: null }, { name: 'PK_schema_migrations', kind: 'i', table_name: 'schema_migrations' }] : []),
      ...((s === 'applied' || s === 'fresh-with-table') ? [{ name: 'schema_migrations_id_seq', kind: 'S', table_name: null }] : []),
      ...(s === 'foreign' ? [{ name: 'secret_notes', kind: 'r', table_name: null }] : []),
    ];
  };
  const answers: Record<string, () => Row[]> = {
    LOCK_SQL: () => [{ locked: !tweaks.lockHeld }], UNLOCK_SQL: () => [{ unlocked: true }],
    IDENTITY_SQL: () => [{
      database: 'agenda_test', current_user: 'agenda_test_owner', session_user: 'agenda_test_owner', version_num: 160015, in_recovery: false,
      transaction_read_only: ro, default_read_only: ro, standard_conforming_strings: tweaks.scs ?? 'on', current_schema: 'public', effective_search_path: 'public',
      statement_timeout: '15s', lock_timeout: '5s', idle_in_transaction_session_timeout: '30s', application_name: 'agenda-schema-runner',
      rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true,
      can_use_public: true, can_create_public: true, owns_database: true, event_triggers: 0, owner_memberships: 0, app_role_exists: true }],
    RELATIONS_SQL: relations, FOREIGN_OBJECTS_SQL: () => [{ routines: 0, types: 0, extensions: 0 }],
    MIGRATIONS_COLUMNS_SQL: () => [{ name: 'id', type: 'integer' }, { name: 'timestamp', type: 'bigint' }, { name: 'name', type: 'character varying' }],
    EXECUTED_SQL: () => (w.schema === 'applied' ? (tweaks.names ?? [NAME]).map(name => ({ name })) : []),
    MIGRATIONS_PRIVILEGES_SQL: () => [
      ...TABLE_PRIVS.map(privilege => ({ kind: 'table', privilege })), ...['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].map(privilege => ({ kind: 'column', privilege })),
      ...['USAGE', 'SELECT', 'UPDATE'].map(privilege => ({ kind: 'sequence', privilege })),
    ].map(r => ({ ...r, effective: tweaks.exposed === true && r.kind === 'table' && r.privilege === 'SELECT', grantable: false })),
    APPLICATION_PRIVILEGES_SQL: () => [...TABLE_ORDER].flatMap(name => TABLE_PRIVS.map(privilege => ({
      name, privilege, effective: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege) !== (tweaks.appWrong === true && privilege === 'TRUNCATE'), grantable: false }))),
    TABLES_EMPTY_SQL: () => [Object.fromEntries(TABLE_ORDER.map(t => [t, tweaks.nonEmpty !== true]))],
    TRANSACTION_CLOSED_SQL: () => [{ no_xid: !w.tx, no_backend_xid: !w.tx, implicit_transaction: !w.tx }],
  };
  const port: SchemaPort = {
    async connect() { events.push('connect'); await trip('connect'); },
    async query(sql, params) {
      const label = LABEL.get(sql);
      if (!label || !answers[label]) throw new SessionContractError();
      events.push(`q:${label}`);
      if (label === 'LOCK_SQL' || label === 'UNLOCK_SQL') expect(params).toEqual([LOCK_KEY]);
      if (['IDENTITY_SQL', 'MIGRATIONS_PRIVILEGES_SQL'].includes(label)) expect(params).toEqual([TARGET.app]);
      if (label === 'APPLICATION_PRIVILEGES_SQL') expect(params).toEqual([TARGET.app, [...TABLE_ORDER]]);
      await trip(label);
      return answers[label]().map(r => ({ ...r }));
    },
    async exec(sql) {
      const label = LABEL.get(sql);
      if (!label || !(label.startsWith('REVOKE') || label === 'TABLE_LOCK_SQL')) throw new SessionContractError();
      events.push(`exec:${label}`); await trip(label);
    },
    async begin(isolation) { events.push(isolation ? `begin:${isolation}` : 'begin'); await trip('begin'); w.tx = true; w.committed = w.schema; },
    async commit() { events.push('commit'); w.commits++; await trip('commit'); w.tx = false; w.committed = w.schema; },
    async rollback() { events.push('rollback'); w.rolledBack++; await trip('rollback'); w.tx = false; w.schema = w.committed; },
    async applyMigrations() { events.push('migrate'); await trip('migrate'); w.schema = 'applied'; return [NAME]; },
    async revertLast() { events.push('revert'); await trip('revert'); w.schema = 'fresh-with-table'; },
    transactionEvidence() { return { clientStatus: 'clientStatus' in tweaks ? tweaks.clientStatus : (w.tx ? 'T' : 'I'), queryRunnerActive: w.tx }; },
    async close() { events.push('close'); await trip('close'); w.closed = true; },
    isClosed() { return w.closed; },
  };
  return { port, events, plans, hooks, w, failure };
}

/** Virtual time: nothing fires until advance(); drive() steps it while a promise is pending. */
function virtualTime() {
  let now = 1000; let seq = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const time = {
    clock: () => now,
    timers: { set: (fn: () => void, ms: number): unknown => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; }, clear: (h: unknown) => { timers.delete(h as number); } } as Timers,
    jump(ms: number) { now += ms; },
    pending: () => timers.size,
    async drive<T>(promise: Promise<T>, step = 500, limit = 400000): Promise<T> {
      let done = false; promise.then(() => { done = true; }, () => { done = true; });
      for (let t = 0; !done && t < limit; t += step) {
        const target = now + step;
        for (;;) { const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].fn(); await flush(); }
        now = target; await flush();
      }
      return promise;
    },
  };
  return time;
}

async function run(command: SchemaCommand, start: Schema, tweaks: Parameters<typeof fakePort>[2] = {}, setup?: (f: ReturnType<typeof fakePort>, t: ReturnType<typeof virtualTime>) => void, aborted: () => boolean = () => false) {
  const f = fakePort(command, start, tweaks); const t = virtualTime();
  setup?.(f, t);
  const result = await t.drive(runSchema({ command, port: f.port, clock: t.clock, timers: t.timers, aborted }));
  return { ...f, t, result };
}
const idx = (events: string[], e: string) => events.indexOf(e);
const noSecret = (result: RunResult) => { expect(JSON.stringify(result) + JSON.stringify(summaryOf(result))).not.toContain(SECRET); };

const APPLY_SEQUENCE = ['connect', 'q:LOCK_SQL', 'q:IDENTITY_SQL', 'q:RELATIONS_SQL', 'q:FOREIGN_OBJECTS_SQL', 'begin', 'migrate',
  'exec:REVOKE_MIGRATIONS_TABLE_SQL', 'exec:REVOKE_MIGRATIONS_SEQUENCE_SQL', 'q:MIGRATIONS_PRIVILEGES_SQL', 'q:APPLICATION_PRIVILEGES_SQL',
  'q:RELATIONS_SQL', 'q:FOREIGN_OBJECTS_SQL', 'q:MIGRATIONS_COLUMNS_SQL', 'q:EXECUTED_SQL', 'commit', 'q:TRANSACTION_CLOSED_SQL', 'q:UNLOCK_SQL', 'close'];

describe('secuencia exacta', () => {
  it('apply: bloqueo, lectura, BEGIN, migración, REVOKE, verificación, COMMIT, prueba de cierre, desbloqueo y cierre', async () => {
    const r = await run('apply', 'fresh');
    expect(r.events).toEqual(APPLY_SEQUENCE);
    expect(r.result).toMatchObject({ outcome: 'applied', ok: true, code: null, committed: true, transaction: 'committed', lock: 'released', closure: 'verified', resources: 'closed', exit: 0, state: 'applied' });
    expect(r.result.executed).toEqual([NAME]);
    expect(r.t.pending()).toBe(0);
  });
  it('el bloqueo se adquiere antes de leer el estado y se libera después de COMMIT', async () => {
    const e = (await run('apply', 'fresh')).events;
    expect(idx(e, 'q:LOCK_SQL')).toBeLessThan(idx(e, 'q:IDENTITY_SQL'));
    expect(idx(e, 'q:LOCK_SQL')).toBeLessThan(idx(e, 'q:RELATIONS_SQL'));
    expect(idx(e, 'commit')).toBeLessThan(idx(e, 'q:TRANSACTION_CLOSED_SQL'));
    expect(idx(e, 'q:TRANSACTION_CLOSED_SQL')).toBeLessThan(idx(e, 'q:UNLOCK_SQL'));
    expect(idx(e, 'q:UNLOCK_SQL')).toBeLessThan(idx(e, 'close'));
  });
  it('los dos REVOKE ocurren antes de la verificación y la verificación antes de COMMIT', async () => {
    const e = (await run('apply', 'fresh')).events;
    expect(idx(e, 'exec:REVOKE_MIGRATIONS_SEQUENCE_SQL')).toBeLessThan(idx(e, 'q:MIGRATIONS_PRIVILEGES_SQL'));
    expect(idx(e, 'q:MIGRATIONS_PRIVILEGES_SQL')).toBeLessThan(idx(e, 'commit'));
    expect(idx(e, 'q:APPLICATION_PRIVILEGES_SQL')).toBeLessThan(idx(e, 'commit'));
  });
  it('plan: transacción de lectura repetible, sin migración, REVOKE, COMMIT ni DDL; termina con ROLLBACK', async () => {
    const r = await run('plan', 'fresh');
    expect(r.events).toEqual(['connect', 'q:LOCK_SQL', 'begin:REPEATABLE READ', 'q:IDENTITY_SQL', 'q:RELATIONS_SQL', 'q:FOREIGN_OBJECTS_SQL', 'rollback', 'q:TRANSACTION_CLOSED_SQL', 'q:UNLOCK_SQL', 'close']);
    expect(r.result).toMatchObject({ outcome: 'planned', ok: true, state: 'fresh', exit: 0, pending: [NAME], executed: [] });
    expect(r.events.filter(e => /^(migrate|revert|commit|exec:)/.test(e))).toEqual([]);
  });
  it('plan sobre un esquema aplicado verifica privilegios y no ejecuta nada', async () => {
    const r = await run('plan', 'applied');
    expect(r.events).toContain('q:MIGRATIONS_PRIVILEGES_SQL'); expect(r.events).toContain('q:APPLICATION_PRIVILEGES_SQL');
    expect(r.events.filter(e => /^(migrate|revert|commit|exec:)/.test(e))).toEqual([]);
    expect(r.result).toMatchObject({ state: 'applied', pending: [], ok: true });
  });
  it('plan informa de exposición, privilegios erróneos, estado parcial y ajeno sin lanzar', async () => {
    expect((await run('plan', 'applied', { exposed: true })).result).toMatchObject({ outcome: 'planned', ok: false, code: 'migrations_table_exposed', findings: ['migrations_table_exposed'], exit: 2 });
    expect((await run('plan', 'applied', { appWrong: true })).result).toMatchObject({ code: 'app_privileges_wrong', exit: 2 });
    expect((await run('plan', 'partial')).result).toMatchObject({ state: 'partial', code: 'state_partial', exit: 2 });
    expect((await run('plan', 'foreign')).result).toMatchObject({ state: 'foreign', code: 'state_foreign', exit: 2 });
  });
});

describe('estado aplicado (idempotencia) y revert', () => {
  it('apply sobre aplicado no ejecuta DDL ni abre transacción, y verifica privilegios', async () => {
    const r = await run('apply', 'applied');
    expect(r.events.filter(e => /^(begin|migrate|revert|commit|rollback|exec:)/.test(e))).toEqual([]);
    expect(r.events).toContain('q:MIGRATIONS_PRIVILEGES_SQL'); expect(r.events).toContain('q:APPLICATION_PRIVILEGES_SQL');
    expect(r.result).toMatchObject({ outcome: 'already_applied', ok: true, committed: false, exit: 0, lock: 'released' });
  });
  it('apply sobre aplicado con la tabla de migraciones expuesta falla sin intentar repararla', async () => {
    const r = await run('apply', 'applied', { exposed: true });
    expect(r.result).toMatchObject({ ok: false, code: 'migrations_table_exposed', exit: 2 });
    expect(r.events.filter(e => /^(begin|migrate|commit|exec:)/.test(e))).toEqual([]);
  });
  it('apply sobre un registro distinto del manifiesto no se considera aplicado', async () => {
    const r = await run('apply', 'applied', { names: ['Other1'] });
    expect(r.result).toMatchObject({ ok: false, state: 'partial', code: 'state_partial' });
    expect(r.events.filter(e => /^(migrate|commit)/.test(e))).toEqual([]);
  });
  it('A. revert con tablas vacías: BEGIN, LOCK, revalidación, comprobación de vacío, reversión, verificación, COMMIT', async () => {
    const r = await run('revert', 'applied');
    expect(r.events).toEqual(['connect', 'q:LOCK_SQL', 'q:IDENTITY_SQL', 'q:RELATIONS_SQL', 'q:FOREIGN_OBJECTS_SQL', 'q:MIGRATIONS_COLUMNS_SQL', 'q:EXECUTED_SQL',
      'begin', 'exec:TABLE_LOCK_SQL', 'q:RELATIONS_SQL', 'q:FOREIGN_OBJECTS_SQL', 'q:MIGRATIONS_COLUMNS_SQL', 'q:EXECUTED_SQL', 'q:TABLES_EMPTY_SQL', 'revert', 'q:MIGRATIONS_PRIVILEGES_SQL', 'q:RELATIONS_SQL', 'q:FOREIGN_OBJECTS_SQL', 'q:MIGRATIONS_COLUMNS_SQL', 'q:EXECUTED_SQL',
      'commit', 'q:TRANSACTION_CLOSED_SQL', 'q:UNLOCK_SQL', 'close']);
    expect(r.result).toMatchObject({ outcome: 'reverted', ok: true, state: 'fresh', exit: 0 });
  });
  it('B. un fallo (o un tiempo agotado) del LOCK impide la reversión: ROLLBACK, sin comprobación de vacío y sin COMMIT', async () => {
    for (const mode of ['throw', 'hang'] as const) {
      const r = await run('revert', 'applied', {}, f => f.plans.push({ label: 'TABLE_LOCK_SQL', mode }));
      expect(r.result).toMatchObject({ ok: false, committed: false, transaction: 'rolled_back', lock: 'released', exit: 2 });
      expect(r.result.code).toBe(mode === 'throw' ? 'query_failed' : 'timeout');
      for (const forbidden of ['revert', 'q:TABLES_EMPTY_SQL', 'commit']) expect(r.events).not.toContain(forbidden);
      expect(r.events).toContain('rollback');
      noSecret(r.result);
    }
  });
  it('C. un estado distinto de applied tras adquirir el bloqueo provoca ROLLBACK antes de comprobar el vacío', async () => {
    for (const changed of ['partial', 'foreign', 'fresh'] as const) {
      const r = await run('revert', 'applied', {}, f => { f.hooks.TABLE_LOCK_SQL = () => { f.w.schema = changed; }; });
      expect(r.result).toMatchObject({ ok: false, committed: false, transaction: 'rolled_back' });
      expect(['state_partial', 'state_foreign']).toContain(r.result.code);
      for (const forbidden of ['revert', 'q:TABLES_EMPTY_SQL', 'commit']) expect(r.events).not.toContain(forbidden);
      expect(r.events).toContain('rollback');
    }
  });
  it('D. apply y plan nunca ejecutan TABLE_LOCK_SQL (ni siquiera sobre un esquema aplicado)', async () => {
    for (const [command, schema] of [['apply', 'fresh'], ['apply', 'applied'], ['plan', 'fresh'], ['plan', 'applied'], ['revert', 'fresh']] as const) {
      const r = await run(command, schema);
      expect([command, schema, r.events.includes('exec:TABLE_LOCK_SQL')]).toEqual([command, schema, false]);
    }
  });
  it('H. el bloqueo se adquiere después de BEGIN y antes de la revalidación, del vacío y del ejecutor; COMMIT va después de todo', async () => {
    const e = (await run('revert', 'applied')).events;
    const lock = idx(e, 'exec:TABLE_LOCK_SQL');
    expect(idx(e, 'begin')).toBeLessThan(lock);
    expect(lock).toBe(idx(e, 'begin') + 1);
    expect(lock).toBeLessThan(e.indexOf('q:RELATIONS_SQL', lock));
    expect(lock).toBeLessThan(idx(e, 'q:TABLES_EMPTY_SQL'));
    expect(lock).toBeLessThan(idx(e, 'revert'));
    expect(idx(e, 'q:TABLES_EMPTY_SQL')).toBeLessThan(idx(e, 'revert'));
    expect(idx(e, 'revert')).toBeLessThan(idx(e, 'commit'));
    expect(e.filter(x => x === 'exec:TABLE_LOCK_SQL')).toHaveLength(1);
  });
  it('revert exige tablas vacías: con datos revierte la transacción y no ejecuta la reversión', async () => {
    const r = await run('revert', 'applied', { nonEmpty: true });
    expect(r.result).toMatchObject({ ok: false, code: 'tables_not_empty', transaction: 'rolled_back', lock: 'released', exit: 2 });
    expect(r.events).not.toContain('revert'); expect(r.events).not.toContain('commit'); expect(r.events).toContain('rollback');
  });
  it('revert sobre esquema vacío no hace nada; sobre parcial o ajeno se niega', async () => {
    const none = await run('revert', 'fresh');
    expect(none.result).toMatchObject({ outcome: 'nothing_to_revert', ok: true });
    expect(none.events.filter(e => /^(begin|revert|commit)/.test(e))).toEqual([]);
    expect((await run('revert', 'partial')).result).toMatchObject({ ok: false, code: 'state_partial' });
    expect((await run('revert', 'foreign')).result).toMatchObject({ ok: false, code: 'state_foreign' });
    expect((await run('apply', 'partial')).result).toMatchObject({ ok: false, code: 'state_partial' });
    expect((await run('apply', 'foreign')).result).toMatchObject({ ok: false, code: 'state_foreign' });
  });
});

describe('verificaciones previas y posteriores', () => {
  it('standard_conforming_strings distinto de on detiene la ejecución antes de cualquier DDL', async () => {
    const r = await run('apply', 'fresh', { scs: 'off' });
    expect(r.result).toMatchObject({ ok: false, code: 'standard_conforming_strings_off', exit: 2, lock: 'released' });
    expect(r.events.filter(e => /^(begin|migrate|exec:|commit)/.test(e))).toEqual([]);
  });
  it('bloqueo ocupado: no avanza ni intenta desbloquear lo que no posee', async () => {
    const r = await run('apply', 'fresh', { lockHeld: true });
    expect(r.result).toMatchObject({ ok: false, code: 'lock_unavailable', lock: 'not_acquired', exit: 2 });
    expect(r.events).toEqual(['connect', 'q:LOCK_SQL', 'close']);
  });
  it.each([
    ['tabla de migraciones expuesta tras el REVOKE', { exposed: true }, 'migrations_table_exposed'],
    ['privilegios de la aplicación incorrectos', { appWrong: true }, 'app_privileges_wrong'],
    ['migraciones aplicadas distintas del manifiesto', { names: ['Other1'] }, null],
  ])('%s: revierte y no confirma', async (_name, tweaks, code) => {
    const r = await run('apply', 'fresh', tweaks as never);
    expect(r.result.ok).toBe(false); expect(r.result.committed).toBe(false);
    if (code) expect(r.result.code).toBe(code);
    expect(r.events).not.toContain('commit'); expect(r.events).toContain('rollback');
    expect(idx(r.events, 'rollback')).toBeLessThan(idx(r.events, 'q:UNLOCK_SQL'));
  });
});

describe('fallos inyectados en cada etapa de apply', () => {
  const stages: [string, number | undefined][] = [
    ['connect', undefined], ['LOCK_SQL', undefined], ['IDENTITY_SQL', undefined], ['RELATIONS_SQL', 1], ['FOREIGN_OBJECTS_SQL', 1], ['begin', undefined], ['migrate', undefined],
    ['REVOKE_MIGRATIONS_TABLE_SQL', undefined], ['REVOKE_MIGRATIONS_SEQUENCE_SQL', undefined], ['MIGRATIONS_PRIVILEGES_SQL', undefined],
    ['APPLICATION_PRIVILEGES_SQL', undefined], ['RELATIONS_SQL', 2], ['MIGRATIONS_COLUMNS_SQL', undefined], ['EXECUTED_SQL', undefined],
  ];
  it.each(stages)('fallo en %s (n=%s): sin éxito, sin COMMIT, reversión antes de desbloquear y sin secretos', async (label, nth) => {
    const r = await run('apply', 'fresh', {}, f => f.plans.push({ label, nth, mode: 'throw' }));
    expect(r.result.ok).toBe(false); expect(r.result.committed).toBe(false); expect(r.events).not.toContain('commit');
    expect(r.result.code).toMatch(/^(connect_failed|query_failed|migration_failed)$/);
    expect(r.result.sqlstate).toBe('XX000');
    if (r.events.includes('begin') && label !== 'begin') expect(r.events).toContain('rollback');
    if (r.events.includes('rollback') && r.events.includes('q:UNLOCK_SQL')) expect(idx(r.events, 'rollback')).toBeLessThan(idx(r.events, 'q:UNLOCK_SQL'));
    expect(r.events[r.events.length - 1]).toBe('close');
    expect(r.result.exit).toBe(label === 'connect' || r.result.closure === 'verified' ? r.result.exit : 3);
    noSecret(r.result);
  });
  it('fallo del BEGIN: la transacción no se da por abierta y el bloqueo se libera tras probar el cierre', async () => {
    const r = await run('apply', 'fresh', {}, f => f.plans.push({ label: 'begin', mode: 'throw' }));
    expect(r.result).toMatchObject({ lock: 'released', transaction: 'none', exit: 2 });
    expect(r.events).not.toContain('rollback');
  });
  it('fallo de la comprobación de cierre tras COMMIT: el cambio queda confirmado pero el cierre no verificado (salida 3)', async () => {
    const r = await run('apply', 'fresh', {}, f => f.plans.push({ label: 'TRANSACTION_CLOSED_SQL', mode: 'throw' }));
    expect(r.result).toMatchObject({ committed: true, outcome: 'applied', lock: 'unverified', closure: 'unverified', ok: false, exit: 3 });
    expect(r.events).not.toContain('q:UNLOCK_SQL');
  });
});

describe('COMMIT ambiguo', () => {
  it.each(['throw', 'hang'] as const)('commit %s: nunca éxito, sin ROLLBACK ni desbloqueo, salida 3 y cierre de recursos', async mode => {
    const r = await run('apply', 'fresh', {}, f => f.plans.push({ label: 'commit', mode }));
    expect(r.result).toMatchObject({ outcome: 'commit_unconfirmed', ok: false, committed: false, code: 'commit_unconfirmed', transaction: 'commit_unconfirmed', closure: 'unverified', exit: 3 });
    expect(r.events).not.toContain('rollback'); expect(r.events).not.toContain('q:UNLOCK_SQL');
    expect(r.events[r.events.length - 1]).toBe('close'); expect(r.result.resources).toBe('closed');
    noSecret(r.result);
  });
  it('la reconciliación posterior se hace con plan, que ve el estado real', async () => {
    // El servidor confirmó aunque la respuesta se perdió: el plan siguiente observa "applied".
    const first = fakePort('apply', 'fresh'); const t = virtualTime();
    first.hooks.commit = () => { first.w.schema = 'applied'; first.w.committed = 'applied'; first.plans.push({ label: 'commit', mode: 'throw' }); };
    const lost = await t.drive(runSchema({ command: 'apply', port: first.port, clock: t.clock, timers: t.timers, aborted: () => false }));
    expect(lost.outcome).toBe('commit_unconfirmed');
    const second = fakePort('plan', 'applied');
    const plan = await t.drive(runSchema({ command: 'plan', port: second.port, clock: t.clock, timers: t.timers, aborted: () => false }));
    expect(plan).toMatchObject({ outcome: 'planned', state: 'applied', ok: true, exit: 0 });
  });
});

describe('una sesión dudosa nunca se desbloquea, aunque la prueba del servidor parezca limpia', () => {
  it('COMMIT ambiguo con evidencia aparentemente limpia: no se consulta el cierre ni se desbloquea', async () => {
    const r = await run('apply', 'fresh', {}, f => { f.hooks.commit = () => { f.w.tx = false; }; f.plans.push({ label: 'commit', mode: 'throw' }); });
    expect(r.result).toMatchObject({ outcome: 'commit_unconfirmed', exit: 3, lock: 'unverified' });
    expect(r.events).not.toContain('q:TRANSACTION_CLOSED_SQL'); expect(r.events).not.toContain('q:UNLOCK_SQL');
  });
  it('ROLLBACK fallido con evidencia aparentemente limpia: tampoco se desbloquea', async () => {
    const r = await run('apply', 'fresh', {}, f => { f.plans.push({ label: 'migrate', mode: 'throw' }); f.hooks.rollback = () => { f.w.tx = false; }; f.plans.push({ label: 'rollback', mode: 'throw' }); });
    expect(r.result).toMatchObject({ transaction: 'unverified', exit: 3, lock: 'unverified' });
    expect(r.events).not.toContain('q:TRANSACTION_CLOSED_SQL'); expect(r.events).not.toContain('q:UNLOCK_SQL');
  });
});

describe('cierre no verificado', () => {
  it('ROLLBACK fallido: no se desbloquea, transacción no verificada, salida 3', async () => {
    const r = await run('apply', 'fresh', {}, f => { f.plans.push({ label: 'migrate', mode: 'throw' }); f.plans.push({ label: 'rollback', mode: 'throw' }); });
    expect(r.result).toMatchObject({ ok: false, transaction: 'unverified', lock: 'unverified', closure: 'unverified', exit: 3 });
    expect(r.events).not.toContain('q:UNLOCK_SQL');
  });
  it('ROLLBACK colgado: el límite de tiempo lo convierte en cierre no verificado', async () => {
    const r = await run('apply', 'fresh', {}, f => { f.plans.push({ label: 'migrate', mode: 'throw' }); f.plans.push({ label: 'rollback', mode: 'hang' }); });
    expect(r.result).toMatchObject({ transaction: 'unverified', closure: 'unverified', exit: 3 });
  });
  it('DESBLOQUEO fallido: éxito de datos pero cierre no verificado', async () => {
    const r = await run('apply', 'fresh', {}, f => f.plans.push({ label: 'UNLOCK_SQL', mode: 'throw' }));
    expect(r.result).toMatchObject({ committed: true, lock: 'unverified', closure: 'unverified', ok: false, exit: 3 });
  });
  it('desbloqueo que devuelve false cuenta como fallido', async () => {
    const f = fakePort('plan', 'fresh'); const t = virtualTime(); const original = f.port.query.bind(f.port);
    f.port.query = async (sql, params) => (sql === ALL_STATEMENTS.UNLOCK_SQL ? (await original(sql, params), [{ unlocked: false }]) : original(sql, params));
    const result = await t.drive(runSchema({ command: 'plan', port: f.port, clock: t.clock, timers: t.timers, aborted: () => false }));
    expect(result).toMatchObject({ lock: 'unverified', closure: 'unverified', exit: 3 });
  });
  it.each([['T'], ['E'], [undefined]])('estado del cliente %s impide probar el cierre y bloquea el desbloqueo', async status => {
    const r = await run('plan', 'fresh', { clientStatus: status });
    expect(r.result).toMatchObject({ lock: 'unverified', closure: 'unverified', exit: 3 });
    expect(r.events).not.toContain('q:UNLOCK_SQL');
  });
  it('close() que falla o no deja la conexión cerrada deja los recursos sin verificar', async () => {
    const failing = await run('plan', 'fresh', {}, f => f.plans.push({ label: 'close', mode: 'throw' }));
    expect(failing.result).toMatchObject({ resources: 'unverified', closure: 'unverified', exit: 3 });
    const notClosed = fakePort('plan', 'fresh'); const t = virtualTime(); notClosed.port.isClosed = () => false;
    expect(await t.drive(runSchema({ command: 'plan', port: notClosed.port, clock: t.clock, timers: t.timers, aborted: () => false }))).toMatchObject({ resources: 'unverified', exit: 3 });
    const hanging = await run('plan', 'fresh', {}, f => f.plans.push({ label: 'close', mode: 'hang' }));
    expect(hanging.result).toMatchObject({ resources: 'unverified', exit: 3 });
  });
});

describe('presupuestos de tiempo y señales', () => {
  it('una conexión colgada vence a los 5 s', async () => {
    const f = fakePort('plan', 'fresh'); f.plans.push({ label: 'connect', mode: 'hang' }); const t = virtualTime();
    const promise = runSchema({ command: 'plan', port: f.port, clock: t.clock, timers: t.timers, aborted: () => false });
    const before = t.clock(); const result = await t.drive(promise);
    expect(result).toMatchObject({ code: 'timeout', stage: 'connect', exit: 2 });
    expect(t.clock() - before).toBeGreaterThanOrEqual(BUDGET.connectMs); expect(t.clock() - before).toBeLessThan(BUDGET.connectMs + 3000);
  });
  it('una sentencia colgada vence a los 15 s, revierte y no confirma', async () => {
    const r = await run('apply', 'fresh', {}, f => f.plans.push({ label: 'APPLICATION_PRIVILEGES_SQL', mode: 'hang' }));
    expect(r.result).toMatchObject({ code: 'timeout', committed: false });
    expect(r.events).toContain('rollback'); expect(r.events).not.toContain('commit');
  });
  it('agotar el presupuesto total de ejecución impide seguir', async () => {
    const r = await run('apply', 'fresh', {}, (f, t) => { f.hooks.migrate = () => t.jump(BUDGET.executionMs + 1); });
    expect(r.result).toMatchObject({ ok: false, code: 'timeout', committed: false });
    expect(r.events).not.toContain('commit');
  });
  it('una señal antes de empezar no ejecuta nada', async () => {
    const r = await run('apply', 'fresh', {}, undefined, () => true);
    expect(r.result).toMatchObject({ code: 'aborted_by_signal', ok: false, exit: 2 });
    expect(r.events).toEqual(['close']);
  });
  it('una señal antes de COMMIT revierte; una señal durante COMMIT no lo interrumpe', async () => {
    let flag = false;
    const early = await run('apply', 'fresh', {}, f => { f.hooks.EXECUTED_SQL = () => { flag = true; }; }, () => flag);
    expect(early.result).toMatchObject({ code: 'aborted_by_signal', committed: false });
    expect(early.events).toContain('rollback'); expect(early.events).not.toContain('commit');
    let late = false;
    const during = await run('apply', 'fresh', {}, f => { f.hooks.commit = () => { late = true; }; }, () => late);
    expect(during.result).toMatchObject({ outcome: 'applied', ok: true, committed: true });
  });
});

describe('secretos y errores del driver', () => {
  it('el mensaje, la traza y los valores del error nunca llegan al resultado; solo un SQLSTATE válido', async () => {
    const r = await run('apply', 'fresh', {}, f => f.plans.push({ label: 'migrate', mode: 'throw' }));
    expect(r.result).toMatchObject({ code: 'migration_failed', sqlstate: 'XX000' });
    noSecret(r.result);
    const odd = fakePort('plan', 'fresh'); const t = virtualTime();
    odd.port.query = async () => { throw Object.assign(new Error(SECRET), { code: `${SECRET}`, driverError: { code: 'not-a-state' } }); };
    const result = await t.drive(runSchema({ command: 'plan', port: odd.port, clock: t.clock, timers: t.timers, aborted: () => false }));
    expect(result.sqlstate).toBeNull(); noSecret(result);
  });
  it('un error con getters hostiles no rompe el resultado', async () => {
    const hostile = fakePort('plan', 'fresh'); const t = virtualTime();
    hostile.port.query = async () => { throw new Proxy({}, { get() { throw new Error(SECRET); } }); };
    const result = await t.drive(runSchema({ command: 'plan', port: hostile.port, clock: t.clock, timers: t.timers, aborted: () => false }));
    expect(result.code).toBe('query_failed'); noSecret(result);
  });
  it('un error del contrato de la sesión se informa como executor_contract', async () => {
    const r = await run('apply', 'fresh', {}, f => { f.hooks.migrate = () => { throw new SessionContractError(); }; });
    expect(r.result).toMatchObject({ code: 'executor_contract', committed: false });
  });
  it('el resumen es una proyección cerrada: descarta campos extra y valores fuera de formato', () => {
    const base = refusal('apply', 'args_invalid');
    const hostile = { ...base, code: SECRET as never, stage: `${SECRET} x`, executed: [SECRET, 'Good1'], findings: [SECRET as never], extra: SECRET, password: SECRET, sqlstate: SECRET } as unknown as RunResult;
    const summary = summaryOf(hostile);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(Object.keys(summary).sort()).toEqual(['code', 'command', 'closure', 'committed', 'elapsedMs', 'executed', 'exit', 'findings', 'lock', 'ok', 'outcome', 'pending', 'resources', 'sqlstate', 'stage', 'state', 'target', 'transaction'].sort());
    expect(summary.executed).toEqual(['Good1']);
    expect(SUMMARY_PREFIX.endsWith(' ')).toBe(true);
  });
  it('la negativa previa a cualquier conexión usa la salida 2 y la del límite duro la 3', () => {
    expect(refusal('plan', 'confirmation_invalid')).toMatchObject({ exit: 2, outcome: 'refused', closure: 'verified', lock: 'not_acquired' });
    expect(refusal(null, 'hard_timeout', 90000, 3)).toMatchObject({ exit: 3, closure: 'unverified', resources: 'unverified' });
  });
});
