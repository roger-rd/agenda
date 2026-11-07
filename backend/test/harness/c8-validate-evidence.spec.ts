/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { main, AUTHORIZATION, REAL_AUTHORIZATION, SUMMARY_PREFIX, APPLICATION_NAME, BEGIN_SQL, ROLLBACK_SQL, BUDGET, PREFLIGHT_ROWS, PLAN, PINNED,
  EXIT_CODES, sanitizeSummary, runProbes, armHardExit, privilegeGate, contextGate, observationCode } from '../../scripts/c8-validate-evidence.cjs';
import * as script from '../../scripts/c8-validate-evidence.cjs';
import { CATALOG, get } from '../../scripts/harness/c8-evidence-queries.cjs';
import { lookup } from '../../scripts/harness/c8-pg-queries.cjs';
import { MATRIX } from '../../scripts/harness/c8-timeouts.cjs';
import { mapRoles, mapDefaultAclSchema, mapGlobalDefaultAcl, mapPrivileges, L0_KEY } from '../../scripts/harness/c8-pg-adapter.cjs';
import { evaluate, evaluateGlobalDefaultAcl } from '../../scripts/harness/c8-gate.cjs';
import { coverage, effective } from './support/c8-pg-fakes';
import { world, richWorld, evidenceFake, fakeTime, fakeSignals, sqlError, SCHEMA, RUN, PID, PASSWORD, TEXT, type World } from './support/c8-evidence-pg-fake';

const GOOD = ['--real', `--confirm=${AUTHORIZATION}`, `--schema=${SCHEMA}`, `--run=${RUN}`];
const FULL = [BEGIN_SQL, ...PLAN.map(s => TEXT[s.id]), ROLLBACK_SQL];
const ALL_TEXT = new Set(FULL);
const BASE_SCRIPT = path.resolve(__dirname, '../../scripts/c8-validate-evidence.cjs');

function setup(w: World = world()) {
  const time = fakeTime();
  const fake = evidenceFake(w, time);
  const stdout = jest.fn();
  const signals = fakeSignals();
  const readEnvFile = jest.fn(async () => ({ host: '127.0.0.1', port: 5433, database: 'agenda_test', user: 'agenda_test_app', password: PASSWORD, major: 16 }));
  const deps = { pgModule: fake.pgModule, readEnvFile, clock: time.clock, timers: time.timers, stdout, signals };
  const summary = (): Record<string, any> => {
    expect(stdout).toHaveBeenCalledTimes(1);
    const line = stdout.mock.calls[0][0] as string;
    expect(line.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    return JSON.parse(line.slice(SUMMARY_PREFIX.length));
  };
  const run = async (argv: string[] = GOOD, extra: Record<string, unknown> = {}) => {
    const code = await time.drive(main(argv, { ...deps, ...extra } as never));
    return { code, s: summary() };
  };
  return { time, fake, stdout, signals, readEnvFile, deps, summary, run };
}
const invariants = (s: Record<string, any>) => {
  expect(s).toMatchObject({ provenance: 'unauthenticated', demonstration: 'not_demonstrated', eligible: false, serverValidated: false, schemaVersion: 1 });
};
const failed = async (w: World, code: string, statements: string[] | null = null) => {
  const x = setup(w);
  const r = await x.run();
  expect(r.s.code).toBe(code); expect(r.s.status).toBe('failed'); expect(r.code).toBe(EXIT_CODES[code as keyof typeof EXIT_CODES]);
  invariants(r.s);
  if (statements) expect(x.fake.texts()).toEqual(statements);
  return { ...x, ...r };
};
const until = async (cond: () => boolean, time: ReturnType<typeof fakeTime>) => {
  for (let i = 0; i < 3000 && !cond(); i++) await time.advance(1);
  if (!cond()) throw new Error('condición no alcanzada');
};
const upto = (id: string) => [BEGIN_SQL, ...PLAN.slice(0, PLAN.findIndex(s => s.id === id) + 1).map(s => TEXT[s.id]), ROLLBACK_SQL];

describe('catálogo cerrado, plan y límites', () => {
  it('el plan tiene 27 consultas únicas: las 22 del catálogo más 5 del preflight, en el orden aprobado', () => {
    expect(PLAN).toHaveLength(27);
    expect(new Set(PLAN.map(s => s.id)).size).toBe(27);
    expect(PLAN.filter(s => s.source === 'evidence').map(s => s.id).sort()).toEqual(CATALOG.map(q => q.id).sort());
    expect(PLAN.filter(s => s.source === 'preflight').map(s => s.id)).toEqual(['effective_coverage', 'role_attrs', 'auth_members', 'database', 'effective']);
    expect(PLAN.slice(0, 10).map(s => s.id)).toEqual(['ev_context', 'ev_namespace', 'effective_coverage', 'role_attrs', 'auth_members', 'database',
      'ev_role_membership', 'ev_default_acl_schema', 'ev_default_acl_global', 'effective']);
    expect(PLAN.slice(10).map(s => s.id)).toEqual(CATALOG.map(q => q.id).filter(id => !PLAN.slice(0, 10).some(s => s.id === id)));
    expect(PLAN.filter(s => s.gate).map(s => [s.id, s.gate])).toEqual([['ev_context', 'context'], ['ev_namespace', 'schema'], ['effective_coverage', 'coverage'], ['effective', 'privileges']]);
  });
  it('sentencias: 27 consultas + BEGIN + ROLLBACK = 29, y las filas son la suma de los topes', () => {
    expect(BUDGET.queries).toBe(PLAN.length); expect(BUDGET.control).toBe(2); expect(BUDGET.statements).toBe(29);
    const evidence = CATALOG.reduce((n, q) => n + q.maxRows + 1, 0);
    expect(evidence).toBe(10605);
    expect(Object.values(PREFLIGHT_ROWS).reduce((a, b) => a + b, 0)).toBe(2604);
    expect(BUDGET.rows).toBe(evidence + 2604);
  });
  it('los hashes fijados coinciden con el SQL del catálogo y del preflight, y las 22 siguen sin validarse en servidor', () => {
    for (const s of PLAN) {
      const text = s.source === 'evidence' ? get(s.id).sql : lookup(s.id).sql;
      expect(hash('sha256', text, 'hex')).toBe((PINNED as Record<string, string>)[s.id]);
    }
    for (const q of CATALOG) { expect(q.serverValidated).toBe(false); expect(q.sqlSha256).toBe((PINNED as Record<string, string>)[q.id]); }
  });
  it('los límites son inmutables y no superan la matriz existente', () => {
    for (const value of [BUDGET, PREFLIGHT_ROWS, PLAN, PINNED, EXIT_CODES, jest.requireActual('../../scripts/c8-validate-evidence.cjs')]) expect(Object.isFrozen(value)).toBe(true);
    for (const s of PLAN) expect(Object.isFrozen(s)).toBe(true);
    expect(() => { (BUDGET as Record<string, number>).queries = 99; }).toThrow(TypeError);
    expect(() => { (PLAN as unknown as unknown[]).push({}); }).toThrow(TypeError);
    expect(() => { (PREFLIGHT_ROWS as Record<string, number>).effective = 1e9; }).toThrow(TypeError);
    expect(BUDGET).toEqual({ queries: 27, control: 2, statements: 29, rows: 13209, effectiveRows: 2000, authMembersRows: 600, memoryBytes: 8388608,
      connectMs: 5000, connectOuterMs: 5500, statementMs: 5000, statementOuterMs: 6000, lockMs: 2000, idleInTxMs: 15000, executionMs: 60000,
      rollbackMs: 3000, endMs: 3000, closeMs: 8000, hardExitMs: 75000 });
    expect(BUDGET.statementMs).toBeLessThanOrEqual(MATRIX.appStatement);
    expect(BUDGET.lockMs).toBeLessThanOrEqual(MATRIX.appLock);
    expect(BUDGET.idleInTxMs).toBeLessThanOrEqual(MATRIX.appIdleInTx);
    expect(BUDGET.connectMs).toBeLessThanOrEqual(MATRIX.preflightConnection);
    expect(BUDGET.rollbackMs + BUDGET.endMs).toBeLessThan(BUDGET.closeMs);
    expect(BUDGET.executionMs + BUDGET.closeMs).toBeLessThan(BUDGET.hardExitMs);
    expect(BEGIN_SQL).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); expect(ROLLBACK_SQL).toBe('ROLLBACK');
  });
});

describe('bloque 0: mapeadores y puerta P6b', () => {
  it('las filas de las consultas de evidencia tienen las columnas que esperan los mapeadores del preflight', () => {
    expect(get('ev_role_membership').columns.map(c => c.name)).toEqual(['oid', 'membership', 'set_membership']);
    expect(get('ev_default_acl_schema').columns.map(c => c.name)).toEqual(['oid']);
    expect(get('ev_default_acl_global').columns.map(c => c.name)).toEqual(['owner_role', 'object_type', 'grantee_public', 'grantee_app']);
  });
  it('mapRoles acepta ev_role_membership (también con 501 filas) y trata un NULL como no evaluable', () => {
    const roles = [{ oid: 11, membership: false, set_membership: false }, { oid: 12, membership: false, set_membership: false }];
    expect(mapRoles(roles, [], 10)).toEqual({ evaluable: true, membership: false, setMembership: false });
    expect(mapRoles(Array.from({ length: 501 }, (_, i) => ({ oid: 100 + i, membership: false, set_membership: false })), [], 10).evaluable).toBe(true);
    expect(mapRoles([{ oid: 11, membership: null, set_membership: false }], [], 10).evaluable).toBe(false);
    const edge = [{ roleid: 11, member: 10, inherit_option: true, set_option: true, admin_option: false }];
    expect(mapRoles([{ oid: 11, membership: true, set_membership: true }], edge, 10)).toEqual({ evaluable: true, membership: true, setMembership: true });
  });
  it('mapDefaultAclSchema y mapGlobalDefaultAcl aceptan las filas de evidencia', () => {
    expect(mapDefaultAclSchema([])).toBe(false); expect(mapDefaultAclSchema([{ oid: 5 }])).toBe(true);
    const row = { owner_role: 'agenda_test_owner', object_type: 'r', grantee_public: false, grantee_app: false };
    expect(evaluateGlobalDefaultAcl(mapGlobalDefaultAcl([row])).code).toBe('ok');
    expect(evaluateGlobalDefaultAcl(mapGlobalDefaultAcl([])).code).toBe('ok');
    expect(evaluateGlobalDefaultAcl(mapGlobalDefaultAcl([{ ...row, grantee_app: true }])).code).toBe('gate_default_acl');
    expect(evaluateGlobalDefaultAcl(mapGlobalDefaultAcl([{ ...row, object_type: 'z' }])).code).toBe('gate_unknown');
  });
  const schema = { name: SCHEMA, comment: `agenda-test/v1/run/${RUN}`, owner: 'agenda_test_owner', ageMs: 0, lease: 'unknown' as const, leaseOwned: false, empty: false };
  const none = { evaluable: true, membership: false, setMembership: false };
  const p6b = (flip?: (rows: any[]) => void, cov: unknown = coverage()) => {
    const rows = effective() as any[]; flip?.(rows);
    return evaluate([schema], () => mapPrivileges(rows, cov, []), 'P6b', none).code;
  };
  const on = (kind: string, privilege: string, field = 'effective') => (rows: any[]) => { rows.find(r => r.kind === kind && r.privilege === privilege)[field] = true; };
  it('P6b acepta ningún privilegio, que es lo único que hace falta para leer los catálogos', () => { expect(p6b()).toBe('ok'); });
  it.each([
    ['lectura: USAGE de esquema', 'schema', 'USAGE'], ['lectura: SELECT de tabla', 'table', 'SELECT'], ['lectura: SELECT de columna', 'column', 'SELECT'],
    ['lectura: USAGE de secuencia', 'sequence', 'USAGE'], ['lectura: SELECT de secuencia', 'sequence', 'SELECT'],
    ['escritura: INSERT', 'table', 'INSERT'], ['escritura: UPDATE', 'table', 'UPDATE'], ['escritura: DELETE', 'table', 'DELETE'],
    ['escritura: TRUNCATE', 'table', 'TRUNCATE'], ['escritura: UPDATE de columna', 'column', 'UPDATE'], ['escritura: UPDATE de secuencia', 'sequence', 'UPDATE'],
    ['creación: CREATE en el esquema', 'schema', 'CREATE'], ['función: EXECUTE', 'routine', 'EXECUTE'],
  ])('P6b rechaza (%s): es más estricta que lo necesario, no más laxa', (_name, kind, privilege) => { expect(p6b(on(kind, privilege))).toBe('gate_residual'); });
  it('P6b rechaza un privilegio concedible aunque no haya privilegio efectivo', () => { expect(p6b(on('table', 'SELECT', 'is_grantable'))).toBe('gate_residual'); });
  it('limitación documentada: un EXECUTE heredado de PUBLIC (por defecto en funciones nuevas) es indistinguible de uno directo', () => {
    expect(p6b(on('routine', 'EXECUTE'))).toBe('gate_residual');
  });
  it('NULL o cobertura incompleta no son evaluables', () => {
    expect(p6b(rows => { rows[0].effective = null; })).toBe('gate_unknown');
    expect(p6b(undefined, [{ schema_oid: 20, tables: '2', sequences: '1', routines: '1' }])).toBe('gate_unknown');
  });
  it('un esquema sin reconocer pasaría vacío por evaluate: la herramienta lo prohíbe antes', () => {
    expect(evaluate([{ ...schema, comment: '' }], () => { throw new Error('no se inspecciona'); }, 'P6b', none).code).toBe('ok');
    const rowsOf = (id: string) => (richWorld() as Record<string, any>)[id];
    expect(privilegeGate(rowsOf, { name: SCHEMA, comment: '', owner: 'agenda_test_owner' })).toBe('gate_unknown');
    expect(privilegeGate(rowsOf, { name: SCHEMA, comment: schema.comment, owner: 'otro' })).toBe('gate_unknown');
    expect(privilegeGate(rowsOf, { name: SCHEMA, comment: schema.comment, owner: 'agenda_test_owner' })).toBeNull();
  });
});

describe('autorización y selección', () => {
  const disabled = `${SUMMARY_PREFIX}${JSON.stringify(sanitizeSummary({ code: 'stage_not_authorized', phase: 'authorization' }))}\n`;
  it.each([
    [[]], [['--real']], [[`--confirm=${AUTHORIZATION}`]], [['--real', '--confirm=otro']], [[...GOOD, '--real']], [[...GOOD, '--unknown']],
    [[...GOOD, `--confirm=${AUTHORIZATION}`]], [[...GOOD, '--schema=uow_2611011200_abc123_2']], [['--real=1', `--confirm=${AUTHORIZATION}`, `--schema=${SCHEMA}`, `--run=${RUN}`]],
    [[`--real`, `--confirm=${AUTHORIZATION}\n`, `--schema=${SCHEMA}`, `--run=${RUN}`]],
  ])('argumentos incompletos o ambiguos %# no leen entorno, no cargan pg y no abren cliente', async argv => {
    const x = setup();
    expect(await main(argv as string[], x.deps as never)).toBe(2);
    expect(x.stdout).toHaveBeenCalledTimes(1); expect(x.stdout).toHaveBeenCalledWith(disabled);
    expect(x.readEnvFile).not.toHaveBeenCalled(); expect(x.fake.instances).toHaveLength(0); expect(x.signals.count()).toBe(0);
  });
  it('sin dependencias inyectadas se exige además la confirmación de la primera ejecución real, y se rechaza antes de leer nada', async () => {
    const stdout = jest.fn();
    expect(await main(GOOD, { stdout } as never)).toBe(2);
    expect(stdout).toHaveBeenCalledWith(disabled);
    expect(await main([...GOOD, '--confirm-real=mal'], { stdout } as never)).toBe(2);
    expect(REAL_AUTHORIZATION).toBe('C8_EVIDENCE_FIRST_REAL_RUN');
  });
  it('proceso sin confirmación bajo net-trap: ningún módulo del harness, ningún .env, salida fija', () => {
    const child = spawnSync(process.execPath, ['--require', path.resolve(__dirname, 'support/net-trap.preload.cjs'), BASE_SCRIPT, '--real'],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8', env: {} });
    expect(child.status).toBe(2); expect(child.stdout).toBe(disabled); expect(child.stderr).toBe('');
    const audit = JSON.parse(String(child.output[3])) as { opened: string[]; modules: string[] };
    expect(audit.modules).toEqual([]);
    expect(audit.opened.every(name => name.endsWith('/scripts/c8-validate-evidence.cjs'))).toBe(true);
  });
  it.each([
    ['sin --schema', [`--real`, `--confirm=${AUTHORIZATION}`, `--run=${RUN}`]], ['sin --run', [`--real`, `--confirm=${AUTHORIZATION}`, `--schema=${SCHEMA}`]],
    ['esquema public', ['--real', `--confirm=${AUTHORIZATION}`, '--schema=public', `--run=${RUN}`]], ['patrón incorrecto', ['--real', `--confirm=${AUTHORIZATION}`, '--schema=uow_1_a_1', `--run=${RUN}`]],
    ['inyección', ['--real', `--confirm=${AUTHORIZATION}`, '--schema=uow_2611011200_abc123_1";drop', `--run=${RUN}`]], ['run en mayúsculas', ['--real', `--confirm=${AUTHORIZATION}`, `--schema=${SCHEMA}`, `--run=${RUN.toUpperCase()}`]],
    ['run corto', ['--real', `--confirm=${AUTHORIZATION}`, `--schema=${SCHEMA}`, '--run=abc']], ['valores vacíos', ['--real', `--confirm=${AUTHORIZATION}`, '--schema=', '--run=']],
  ])('selección inválida (%s): se rechaza antes de leer entorno o abrir cliente', async (_name, argv) => {
    const x = setup(); const r = await x.run(argv as string[]);
    expect(r.s.code).toBe('selection_invalid'); expect(r.code).toBe(2); expect(x.readEnvFile).not.toHaveBeenCalled(); expect(x.fake.instances).toHaveLength(0);
    expect(r.s.selection).toBeUndefined(); invariants(r.s);
  });
});

describe('recorrido correcto', () => {
  it('una sola conexión, una transacción, 29 sentencias en el orden exacto y solo SQL catalogado', async () => {
    const x = setup(); const r = await x.run();
    expect(r.code).toBe(0); expect(x.readEnvFile).toHaveBeenCalledTimes(1);
    expect(x.fake.instances).toHaveLength(1);
    expect(x.fake.texts()).toEqual(FULL); expect(x.fake.log).toHaveLength(29);
    expect(x.fake.texts().every(t => ALL_TEXT.has(t))).toBe(true);
    expect(x.fake.texts().filter(t => /^(COMMIT|SAVEPOINT|RELEASE|SET|END|ABORT|PREPARE)\b/i.test(t))).toEqual([]);
    expect(x.fake.texts().filter(t => /^BEGIN/.test(t))).toEqual([BEGIN_SQL]);
    expect(x.fake.events.at(-2)).toBe('ROLLBACK'); expect(x.fake.events.at(-1)).toBe('end');
    expect(x.fake.instances[0].txState).toBe('I'); expect(x.fake.instances[0].ended).toBe(true);
    expect(x.signals.count()).toBe(0); expect(x.time.pending()).toBe(0);
  });
  it('la configuración del cliente es exacta y siempre del rol agenda_test_app', async () => {
    const x = setup(); await x.run();
    expect(x.fake.configs).toEqual([{ host: '127.0.0.1', port: 5433, database: 'agenda_test', user: 'agenda_test_app', password: PASSWORD, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 15000, options: '-c default_transaction_read_only=on',
      application_name: APPLICATION_NAME, ssl: false }]);
  });
  it('los parámetros enviados son los del plan: esquema, rol de la aplicación y la clave del harness', async () => {
    const x = setup(); await x.run();
    const values = (id: string) => x.fake.log.find(l => l.text === TEXT[id])?.values;
    expect(values('ev_namespace')).toEqual([SCHEMA]); expect(values('effective')).toEqual([SCHEMA, 'agenda_test_app']);
    expect(values('effective_coverage')).toEqual([SCHEMA]); expect(values('database')).toEqual(['agenda_test_app']);
    expect(values('ev_role_membership')).toEqual(['agenda_test_app']); expect(values('ev_advisory_holders')).toEqual([L0_KEY]);
    expect(values('ev_context')).toEqual([]); expect(values('role_attrs')).toEqual([]);
  });
  it('resumen: ok, compuertas superadas, cierre confirmado, cadena sin autenticar y 27 entradas', async () => {
    const x = setup(); const { s } = await x.run();
    expect(s.queries.filter((q: any) => !['ok', 'empty'].includes(q.status)).slice(0, 3)).toEqual([]);
    expect(s).toMatchObject({ status: 'ok', code: 'ok', exitCode: 0, phase: 'done', tool: 'c8-validate-evidence' });
    expect(s.gates).toEqual({ context: true, schema: true, rows: true, privileges: true });
    expect(s.close).toEqual({ rollback: 'confirmed', end: 'ok' });
    expect(s.budget).toMatchObject({ queries: 27, control: 2, statements: 29, rows: s.budget.rows });
    expect(s.server).toEqual({ major: 16, minor: 15 });
    expect(s.selection).toMatchObject({ valid: true, markMatched: true, ownerMatched: true });
    expect(s.queries).toHaveLength(27); expect(s.queries.map((q: any) => q.id)).toEqual(PLAN.map(p => p.id));
    expect(s.queries.every((q: any) => ['ok', 'empty'].includes(q.status) && /^[0-9a-f]{12}$/.test(q.sql))).toBe(true);
    expect(s.diagnosticOnly).toBe(false);
    expect(s.normalized).toEqual({ structural: 'structurally_valid', reasons: [] });
    expect(s.chain.assembly).toMatchObject({ coherent: true, evidence: true });
    expect(s.otherNamespaces).toBe(3); expect(s.probes).not.toBeNull(); invariants(s);
  });
  it('no usa el reloj de pared: Date.now y new Date() no intervienen', async () => {
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now'); });
    try { const x = setup(); expect((await x.run()).code).toBe(0); } finally { spy.mockRestore(); }
  });
});

describe('puerta de contexto (G1): versión, aislamiento, solo lectura, identidad', () => {
  const ctx = (over: Record<string, unknown>) => { const w = world(); Object.assign(w.ev_context[0], over); return w; };
  it.each([
    ['aislamiento read committed', { transaction_isolation: 'read committed' }], ['aislamiento serializable', { transaction_isolation: 'serializable' }],
    ['solo lectura apagado', { transaction_read_only: 'off' }], ['PostgreSQL 15', { server_version_num: '150004' }], ['PostgreSQL 17', { server_version_num: '170001' }],
    ['versión mal formada', { server_version_num: '16' }], ['en recuperación', { in_recovery: true }], ['base distinta', { database: 'agenda_dev' }],
    ['rol distinto', { current_user: 'agenda_test_owner' }], ['sesión distinta', { session_user: 'agenda_test_owner' }],
    ['statement_timeout distinto', { statement_timeout: '30s' }], ['lock_timeout distinto', { lock_timeout: '5s' }], ['idle distinto', { idle_in_transaction_session_timeout: '60s' }],
  ])('%s: NO-GO tras la primera consulta, con ROLLBACK y sin más sentencias', async (_name, over) => {
    await failed(ctx(over), 'context_invalid', upto('ev_context'));
  });
  it('un pid distinto del del cliente es identidad dudosa (salida 3)', async () => {
    const r = await failed(ctx({ pid: PID + 1 }), 'identity_unknown', upto('ev_context'));
    expect(r.code).toBe(3);
  });
  it('el contexto debe ser exactamente una fila', async () => {
    await failed({ ...world(), ev_context: [] }, 'context_invalid', upto('ev_context'));
  });
  it('contextGate acepta el contexto válido y rechaza tipos inesperados', () => {
    const row = world().ev_context[0];
    expect(contextGate(row, PID)).toBeNull();
    expect(contextGate({ ...row, pid: '4242' }, PID)).toBe('identity_unknown');
    expect(contextGate(row, 'x')).toBe('identity_unknown');
    expect(contextGate({ ...row, statement_timeout: 5000 }, PID)).toBe('context_invalid');
    expect(contextGate(null, PID)).toBe('context_invalid');
  });
});

describe('esquema y marca (Gs)', () => {
  const ns = (row: Record<string, unknown> | null) => { const w = world(); w.ev_namespace = row === null ? [] : [{ ...w.ev_namespace[0], ...row }]; return w; };
  it('esquema ausente es NO-GO y no se confunde con uno vacío', async () => {
    const r = await failed(ns(null), 'schema_absent', upto('ev_namespace'));
    expect(r.s.gates.schema).toBe(false); expect(r.s.chain).toBeNull();
  });
  it.each([
    ['otro nombre', { name: 'uow_2611011200_abc123_2' }], ['marca de otra ejecución', { comment: `agenda-test/v1/run/${'b'.repeat(32)}` }],
    ['sin comentario', { comment: null }], ['comentario ajeno', { comment: 'otro' }], ['marca con espacio', { comment: `agenda-test/v1/run/${RUN} ` }],
    ['dueño distinto', { owner: 'agenda_test_app' }], ['dueño vacío', { owner: 'x' }],
  ])('%s: NO-GO y no se ejecuta nada más', async (_name, row) => {
    const r = await failed(ns(row), 'schema_not_authorized', upto('ev_namespace'));
    expect(r.s.gates.privileges).toBeNull();
  });
  it('dos filas de namespace (el tope es una) también son NO-GO', async () => {
    const w = world(); w.ev_namespace = [w.ev_namespace[0], w.ev_namespace[0]];
    await failed(w, 'truncated', upto('ev_namespace'));
  });
  it('ningún esquema residual se examina: los demás espacios de nombres solo se cuentan', async () => {
    const x = setup(); await x.run();
    expect(x.fake.log.filter(l => l.values.some(v => typeof v === 'string' && v.startsWith('uow_')) && l.values[0] !== SCHEMA)).toEqual([]);
    expect(x.fake.log.map(l => l.text).includes(lookup('schemas').sql)).toBe(false);
  });
});

describe('privilegios y presupuesto de filas del preflight', () => {
  const rich = () => richWorld();
  it('el mundo rico con ningún privilegio pasa', async () => { expect((await setup(rich()).run()).code).toBe(0); });
  it('cobertura demasiado grande: NO-GO antes de ejecutar effective', async () => {
    const w = rich(); w.effective_coverage = [{ schema_oid: 20, tables: '200', sequences: '0', routines: '0' }];
    const r = await failed(w, 'budget_exceeded', upto('effective_coverage'));
    expect(r.s.gates.rows).toBe(false);
  });
  it('cobertura mal formada es NO-GO', async () => {
    const w = rich(); w.effective_coverage = [{ schema_oid: 20, tables: 'x', sequences: '0', routines: '0' }];
    await failed(w, 'gate_unknown', upto('effective_coverage'));
  });
  const flip = (kind: string, privilege: string, field = 'effective') => (w: World) => { (w.effective.find(r => r.kind === kind && r.privilege === privilege) as any)[field] = true; };
  it.each([
    ['SELECT de tabla', flip('table', 'SELECT')], ['INSERT de tabla', flip('table', 'INSERT')], ['CREATE en el esquema', flip('schema', 'CREATE')],
    ['USAGE de esquema', flip('schema', 'USAGE')], ['EXECUTE de rutina', flip('routine', 'EXECUTE')], ['UPDATE de secuencia', flip('sequence', 'UPDATE')],
    ['concedible', flip('table', 'SELECT', 'is_grantable')],
  ])('privilegio %s: gate_residual tras la décima consulta', async (_name, mutate) => {
    const w = rich(); mutate(w);
    const r = await failed(w, 'gate_residual', upto('effective'));
    expect(r.s.gates.privileges).toBe(false);
  });
  it.each([
    ['pertenencia a un rol', (w: World) => { w.ev_role_membership[0] = { oid: 10, membership: true, set_membership: true }; w.auth_members = [{ roleid: 10, member: 11, inherit_option: true, set_option: true, admin_option: false }]; }, 'gate_residual'],
    ['membresía inconsistente', (w: World) => { w.ev_role_membership[0] = { oid: 10, membership: true, set_membership: false }; }, 'gate_unknown'],
    ['CREATE en la base', (w: World) => { w.database[0].can_create = true; }, 'gate_residual'],
    ['TEMP en la base', (w: World) => { w.database[0].can_temporary = true; }, 'gate_residual'],
    ['sin CONNECT', (w: World) => { w.database[0].can_connect = false; }, 'gate_unknown'],
    ['base distinta', (w: World) => { w.database[0].datname = 'otra'; }, 'gate_unknown'],
    ['superusuario', (w: World) => { (w.role_attrs[1] as any).rolsuper = true; }, 'gate_unknown'],
    ['ACL por defecto global', (w: World) => { w.ev_default_acl_global = [{ owner_role: 'agenda_test_owner', object_type: 'r', grantee_public: false, grantee_app: true }]; }, 'gate_default_acl'],
    ['ACL por defecto del esquema', (w: World) => { w.ev_default_acl_schema = [{ oid: 5 }]; }, 'gate_residual'],
    ['effective con NULL', (w: World) => { (w.effective[0] as any).effective = null; }, 'gate_unknown'],
  ])('%s', async (_name, mutate, code) => {
    const w = rich(); (mutate as (w: World) => void)(w);
    await failed(w, code as string, upto('effective'));
  });
});

describe('fallos de ejecución: parada ante el primero, sin reintento', () => {
  it.each([
    ['ev_closure', '57014', 'timeout'], ['ev_relations', '42501', 'permission'], ['ev_types', 'XX000', 'other'], ['role_attrs', '57014', 'timeout'], ['ev_internal_edges', '55P03', 'timeout'],
  ])('error SQL en %s (%s): la transacción queda abortada, solo se envía ROLLBACK y se confirma', async (id, state) => {
    const x = setup(); x.fake.script.set(id, { error: sqlError(state) });
    const r = await x.run();
    expect(r.s.code).toBe('query_failed'); expect(r.code).toBe(2); invariants(r.s);
    expect(x.fake.texts()).toEqual(upto(id));
    expect(r.s.close).toEqual({ rollback: 'confirmed', end: 'ok' });
    expect(r.s.queries.find((q: any) => q.id === id).status).toBe('failed');
    expect(r.s.queries.filter((q: any) => q.status === 'skipped').length).toBe(PLAN.length - PLAN.findIndex(p => p.id === id) - 1);
    expect(r.s.chain).toBeNull(); expect(x.fake.instances[0].txState).toBe('I');
  });
  it('tras un error la transacción solo acepta ROLLBACK: cualquier otra sentencia fallaría con 25P02', async () => {
    const x = setup(); x.fake.script.set('ev_closure', { error: sqlError('57014') });
    await x.run();
    expect(x.fake.log.filter(l => l.text !== ROLLBACK_SQL).map(l => l.text)).toEqual(upto('ev_closure').slice(0, -1));
  });
  it('un error de conexión (sin SQLSTATE) omite el ROLLBACK, que ya no es posible, y cierra', async () => {
    const x = setup(); x.fake.script.set('ev_closure', { error: Object.assign(new Error('Connection terminated unexpectedly'), { stack: PASSWORD }) });
    const r = await x.run();
    expect(r.s.code).toBe('query_failed'); expect(r.s.close).toEqual({ rollback: 'skipped_connection_lost', end: 'ok' });
    expect(x.fake.texts()).toEqual(upto('ev_closure').slice(0, -1));
  });
  it('un evento error del cliente marca la conexión perdida aunque la consulta falle con SQLSTATE', async () => {
    const x = setup();
    const original = x.fake.pgModule.Client.prototype.query;
    x.fake.pgModule.Client.prototype.query = async function (this: any, text: string, values?: unknown[]) {
      if (text === TEXT.ev_routines) { this.emit('error', new Error('socket')); throw sqlError('XX000'); }
      return original.call(this, text, values);
    };
    try { const r = await x.run(); expect(r.s.code).toBe('query_failed'); expect(r.s.close).toEqual({ rollback: 'skipped_connection_lost', end: 'ok' }); } finally { x.fake.pgModule.Client.prototype.query = original; }
  });
  it('BEGIN que falla: begin_failed, sin ROLLBACK porque no hay transacción', async () => {
    const x = setup(); x.fake.control.begin = 'fail';
    const r = await x.run();
    expect(r.s.code).toBe('begin_failed'); expect(x.fake.texts()).toEqual([BEGIN_SQL]); expect(r.s.close).toEqual({ rollback: 'not_needed', end: 'ok' });
  });
  it('la conexión que falla es connect_failed y se intenta cerrar el cliente', async () => {
    const x = setup(); x.fake.control.connect = 'fail';
    const r = await x.run();
    expect(r.s.code).toBe('connect_failed'); expect(x.fake.log).toEqual([]); expect(x.fake.events).toContain('end');
  });
  it('entorno o destino inválidos no abren cliente', async () => {
    const a = setup(); const ra = await a.run(GOOD, { readEnvFile: async () => { throw new Error(PASSWORD); } });
    expect(ra.s.code).toBe('environment_invalid'); expect(a.fake.instances).toHaveLength(0);
    const b = setup(); const rb = await b.run(GOOD, { readEnvFile: async () => ({ host: '127.0.0.1', port: 5433, database: 'agenda_dev', user: 'agenda_test_app', password: PASSWORD, major: 16 }) });
    expect(rb.s.code).toBe('target_invalid'); expect(b.fake.instances).toHaveLength(0);
    const c = setup(); const rc = await c.run(GOOD, { readEnvFile: async () => ({ host: '127.0.0.1', port: 5433, database: 'agenda_test', user: 'agenda_test_owner', password: PASSWORD, major: 16 }) });
    expect(rc.s.code).toBe('target_invalid');
    const d = setup(); const rd = await d.run(GOOD, { readEnvFile: async () => ({ host: '127.0.0.1', port: 5433, database: 'agenda_test', user: 'agenda_test_app', password: '', major: 16 }) });
    expect(rd.s.code).toBe('environment_invalid'); expect(d.fake.instances).toHaveLength(0);
  });
  it('un resultado truncado (tope + 1 filas) detiene la ejecución', async () => {
    const w = world(); w.ev_relations = Array.from({ length: 501 }, (_, i) => ({ oid: i + 1 }));
    const r = await failed(w, 'truncated', upto('ev_relations'));
    expect(r.s.queries.find((q: any) => q.id === 'ev_relations')).toMatchObject({ status: 'truncated', rows: 501 });
    expect(r.s.diagnosticOnly).toBe(true);
  });
  it('M2: las sondas que dependen de un resultado truncado no son evaluables (null), no parciales presentadas como completas', async () => {
    const w = world(); w.ev_closure = Array.from({ length: 501 }, (_, i) => ({ depth: 1, classid: 'pg_class', objid: i + 1, objsubid: 0, deptype: 'n' }));
    w.ev_relations = [{ oid: 7, relkind: 'i' }];
    const r = await failed(w, 'truncated', upto('ev_closure'));
    expect(r.s.probes.closure).toBeNull(); expect(r.s.probes.classSpelling).toBeNull();
    expect(r.s.probes.indexBacking).toBeNull(); expect(r.s.probes.rowTypes).not.toBeNull(); // rowTypes solo usa resultados completos
    expect(r.s.chain).toBeNull(); expect(r.s.diagnosticOnly).toBe(true);
  });
  it('más filas que el tope (el LIMIT no se cumplió) o más que el preflight permite es budget_exceeded', async () => {
    const a = world(); a.ev_relations = Array.from({ length: 502 }, (_, i) => ({ oid: i + 1 }));
    await failed(a, 'budget_exceeded', upto('ev_relations'));
    const b = world(); b.auth_members = Array.from({ length: 601 }, (_, i) => ({ roleid: i + 1, member: 1, inherit_option: true, set_option: true, admin_option: false }));
    await failed(b, 'budget_exceeded', upto('auth_members'));
  });
  it('la memoria retenida se limita a 8 MiB sin serializar nada', async () => {
    const w = world(); w.ev_relations = Array.from({ length: 450 }, (_, i) => ({ oid: i + 1, acl: 'x'.repeat(10000) }));
    const r = await failed(w, 'memory_exceeded', upto('ev_relations'));
    expect(r.s.budget.bytes).toBeGreaterThan(BUDGET.memoryBytes);
  });
  it('filas hostiles (acceso, proxy, no array, tipos raros) son query_failed y nunca se ejecutan', async () => {
    const getter = { oid: 1 }; Object.defineProperty(getter, 'x', { enumerable: true, get() { throw new Error('getter ejecutado'); } });
    const cases: unknown[] = [{ rows: [getter] }, { rows: [new Proxy({}, { get() { throw new Error('trampa'); }, getPrototypeOf() { throw new Error('trampa'); } })] },
      { rows: 'no' }, {}, { rows: [[1]] }, { rows: [{ f() { return 1; } }] }, { rows: [Object.create({ oid: 1 })] }, { rows: [{ big: 10n }] }];
    for (const raw of cases) {
      const x = setup(); x.fake.script.set('ev_relations', { raw });
      const r = await x.run();
      expect(r.s.code).toBe('query_failed'); expect(x.fake.texts()).toEqual(upto('ev_relations'));
    }
  });
  it('observationCode normaliza SQLSTATE a un vocabulario cerrado', () => {
    expect(['57014', '55P03'].map(observationCode)).toEqual(['timeout', 'timeout']);
    expect(observationCode('42501')).toBe('permission');
    expect(['08006', '57P01', '25P03', undefined].map(observationCode)).toEqual(['connection_lost', 'connection_lost', 'connection_lost', 'connection_lost']);
    expect(observationCode('23505')).toBe('other');
  });
});

describe('tiempo, cierre acotado y señales', () => {
  const settle = async (x: ReturnType<typeof setup>, argv = GOOD) => {
    const p = main(argv, x.deps as never);
    const code = await x.time.drive(p);
    return { code, s: x.summary() };
  };
  it('una consulta que nunca resuelve: time_exceeded, sin ROLLBACK (se encolaría detrás) y con end() acotado', async () => {
    const x = setup(); x.fake.script.set('ev_closure', { hang: true });
    const r = await settle(x);
    expect(r.s.code).toBe('time_exceeded'); expect(r.s.close).toEqual({ rollback: 'skipped_in_flight', end: 'ok' });
    expect(x.fake.texts()).toEqual(upto('ev_closure').slice(0, -1)); invariants(r.s);
    expect(r.s.queries.find((q: any) => q.id === 'ev_closure').status).toBe('failed');
  });
  it('BEGIN que nunca resuelve: time_exceeded y se omite el ROLLBACK', async () => {
    const x = setup(); x.fake.control.begin = 'hang';
    const r = await settle(x);
    expect(r.s.code).toBe('time_exceeded'); expect(r.s.close.rollback).toBe('skipped_in_flight'); expect(x.fake.texts()).toEqual([BEGIN_SQL]);
  });
  it('connect que nunca resuelve: time_exceeded, se intenta end() y no hay transacción', async () => {
    const x = setup(); x.fake.control.connect = 'hang';
    const r = await settle(x);
    expect(r.s.code).toBe('time_exceeded'); expect(r.s.close.rollback).toBe('not_needed'); expect(x.fake.events).toContain('end');
  });
  it('el ROLLBACK que nunca resuelve se acota a 3 s y end() se intenta igualmente; el resultado es close_failed', async () => {
    const x = setup(); x.fake.control.rollback = 'hang';
    const r = await settle(x);
    expect(r.s.code).toBe('close_failed'); expect(r.s.close).toEqual({ rollback: 'timeout', end: 'ok' });
    expect(r.s.budget.closeMs).toBeGreaterThanOrEqual(BUDGET.rollbackMs); expect(r.s.budget.closeMs).toBeLessThan(BUDGET.closeMs);
    expect(r.s.chain).not.toBeNull();
  });
  it('end() que nunca resuelve se acota y se informa; el cierre completo no supera su presupuesto', async () => {
    const x = setup(); x.fake.control.end = 'hang'; x.fake.control.rollback = 'hang';
    const r = await settle(x);
    expect(r.s.code).toBe('close_failed'); expect(r.s.close).toEqual({ rollback: 'timeout', end: 'timeout' });
    expect(r.s.budget.closeMs).toBeLessThanOrEqual(BUDGET.closeMs);
  });
  it.each([
    ['ROLLBACK rechazado', { rollback: 'fail' as const }, { rollback: 'failed', end: 'ok' }],
    ['end() rechazado', { end: 'fail' as const }, { rollback: 'confirmed', end: 'error' }],
  ])('%s: close_failed sin ocultar los resultados', async (_name, control, close) => {
    const x = setup(); Object.assign(x.fake.control, control);
    const r = await settle(x);
    expect(r.s.code).toBe('close_failed'); expect(r.s.close).toEqual(close); invariants(r.s);
  });
  it('un ROLLBACK que no devuelve la conexión a reposo no se da por confirmado', async () => {
    const x = setup(); x.fake.control.rollbackStatus = 'T';
    const r = await settle(x);
    expect(r.s.close.rollback).toBe('unconfirmed'); expect(r.s.code).toBe('close_failed');
  });
  it('si un fallo SQL y un cierre defectuoso coinciden, se conserva el primer código y se informa el cierre', async () => {
    const x = setup(); x.fake.script.set('ev_closure', { error: sqlError('57014') }); x.fake.control.rollback = 'fail';
    const r = await settle(x);
    expect(r.s.code).toBe('query_failed'); expect(r.s.close.rollback).toBe('failed');
  });
  it('presupuesto de ejecución agotado entre sentencias: time_exceeded sin consulta en vuelo y con ROLLBACK confirmado', async () => {
    const x = setup(); let skew = 0;
    x.fake.script.set('role_attrs', { after: () => { skew = 61000; } });
    const r = await settle(Object.assign(x, { deps: { ...x.deps, clock: () => x.time.clock() + skew } }));
    expect(r.s.code).toBe('time_exceeded'); expect(r.s.close).toEqual({ rollback: 'confirmed', end: 'ok' });
    expect(x.fake.texts()).toEqual(upto('role_attrs')); expect(x.fake.texts().at(-1)).toBe(ROLLBACK_SQL);
  });
  it('el cierre tiene presupuesto propio aunque la ejecución esté agotada', async () => {
    const x = setup(); let skew = 0; x.fake.control.rollback = 'hang'; x.fake.control.end = 'hang';
    x.fake.script.set('role_attrs', { after: () => { skew = 61000; } });
    const r = await settle(Object.assign(x, { deps: { ...x.deps, clock: () => x.time.clock() + skew } }));
    expect(r.s.code).toBe('time_exceeded'); expect(r.s.close).toEqual({ rollback: 'timeout', end: 'timeout' });
    expect(r.s.budget.closeMs).toBeLessThanOrEqual(BUDGET.closeMs); expect(x.fake.texts().at(-1)).toBe(ROLLBACK_SQL);
  });
  it('cada consulta lenta cuenta: 14 consultas de 4,5 s agotan los 60 s con la siguiente en vuelo', async () => {
    const x = setup(); for (const s of PLAN) x.fake.script.set(s.id, { delayMs: 4500 });
    const r = await settle(x);
    expect(r.s.code).toBe('time_exceeded'); expect(r.s.close.rollback).toBe('skipped_in_flight');
    expect(x.fake.log.length).toBeLessThan(29);
  });
  it('H1: pérdida de conexión después de la última consulta y antes de ROLLBACK nunca es ok', async () => {
    const x = setup(); x.fake.script.set('ev_internal_edges', { after: () => { x.fake.instances[0].emit('error', new Error('socket')); } });
    const r = await settle(x);
    expect(r.s.status).toBe('failed'); expect(r.s.code).toBe('close_failed'); expect(r.code).toBe(2);
    expect(r.s.close).toEqual({ rollback: 'skipped_connection_lost', end: 'ok' });
    expect(x.fake.texts()).toEqual(FULL.slice(0, -1)); invariants(r.s);
  });
  it('M1: si el cierre falla se conserva el diagnóstico sin presentarlo como evidencia satisfactoria', async () => {
    const x = setup(); x.fake.control.rollback = 'fail';
    const r = await settle(x);
    expect(r.s.code).toBe('close_failed'); expect(r.s.diagnosticOnly).toBe(true);
    expect(r.s.chain).not.toBeNull(); expect(r.s.chain.assembly.coherent).toBe(true); expect(r.s.chain.assembly.evidence).toBe(false);
    expect(r.s.probes).not.toBeNull(); expect(r.s.normalized).not.toBeNull(); invariants(r.s);
  });
  it.each([
    ['skipped_connection_lost', (x: ReturnType<typeof setup>) => { x.fake.script.set('ev_internal_edges', { after: () => { x.fake.instances[0].emit('error', new Error('socket')); } }); }, 'close_failed', { rollback: 'skipped_connection_lost', end: 'ok' }],
    ['skipped_in_flight', (x: ReturnType<typeof setup>) => { x.fake.script.set('ev_internal_edges', { hang: true }); }, 'time_exceeded', { rollback: 'skipped_in_flight', end: 'ok' }],
    ['timeout', (x: ReturnType<typeof setup>) => { x.fake.control.rollback = 'hang'; }, 'close_failed', { rollback: 'timeout', end: 'ok' }],
    ['failed', (x: ReturnType<typeof setup>) => { x.fake.control.rollback = 'fail'; }, 'close_failed', { rollback: 'failed', end: 'ok' }],
    ['unconfirmed', (x: ReturnType<typeof setup>) => { x.fake.control.rollbackStatus = 'E'; }, 'close_failed', { rollback: 'unconfirmed', end: 'ok' }],
  ])('H1: close.rollback=%s impide status ok aunque end() termine bien', async (_state, arrange, code, close) => {
    const x = setup(); arrange(x);
    const r = await settle(x);
    expect(r.s.status).not.toBe('ok'); expect(r.s.status).toBe('failed'); expect(r.s.code).toBe(code); expect(r.s.close).toEqual(close); expect(r.s.diagnosticOnly).toBe(true);
    expect(r.code).toBe(2);
  });
  it('H1: not_needed solo es satisfactorio cuando no se inició ninguna transacción', async () => {
    const a = setup(); a.fake.control.begin = 'fail';
    const ra = await settle(a);
    expect(ra.s.close.rollback).toBe('not_needed'); expect(ra.s.code).toBe('begin_failed'); expect(ra.s.status).toBe('failed');
    const b = setup(); const rb = await settle(b);
    expect(rb.s.status).toBe('ok'); expect(rb.s.close).toEqual({ rollback: 'confirmed', end: 'ok' });
  });
  it('SIGINT con una consulta en vuelo: interrupted, sin ROLLBACK posible, end() y manejadores retirados', async () => {
    const x = setup(); x.fake.script.set('ev_closure', { hang: true });
    const p = main(GOOD, x.deps as never);
    await until(() => x.fake.events.includes('ev_closure'), x.time);
    expect(x.signals.count()).toBe(2); x.signals.emit('SIGINT'); x.signals.emit('SIGTERM');
    const code = await x.time.drive(p); const s = x.summary();
    expect(code).toBe(2); expect(s.code).toBe('interrupted'); expect(s.close).toEqual({ rollback: 'skipped_in_flight', end: 'ok' });
    expect(x.signals.count()).toBe(0);
  });
  it('señal durante la lectura del entorno: no se abre cliente ni transacción', async () => {
    const x = setup(); const sig = x.signals;
    const r = await settle(Object.assign(x, { deps: { ...x.deps, readEnvFile: async () => { sig.emit('SIGTERM'); return { host: '127.0.0.1', port: 5433, database: 'agenda_test', user: 'agenda_test_app', password: PASSWORD, major: 16 }; } } }));
    expect(r.s.code).toBe('interrupted'); expect(r.s.close.rollback).toBe('not_needed'); expect(x.fake.log).toEqual([]);
  });
  it('SIGINT entre dos sentencias: nada queda en vuelo y el ROLLBACK se confirma', async () => {
    const x = setup(); let sent = false;
    const clock = () => { if (!sent && x.fake.events.includes('role_attrs')) { sent = true; x.signals.emit('SIGINT'); } return x.time.clock(); };
    const r = await settle(Object.assign(x, { deps: { ...x.deps, clock } }));
    expect(r.s.code).toBe('interrupted'); expect(r.s.close).toEqual({ rollback: 'confirmed', end: 'ok' });
    expect(x.fake.texts()).toEqual(upto('role_attrs'));
  });
  it('una señal durante el cierre no impide el ROLLBACK', async () => {
    const x = setup(); x.fake.script.set('ev_closure', { error: sqlError('57014') }); x.fake.control.rollbackDelayMs = 1000;
    const p = main(GOOD, x.deps as never);
    await until(() => x.fake.events.includes('ROLLBACK'), x.time);
    x.signals.emit('SIGINT');
    const code = await x.time.drive(p); const s = x.summary();
    expect(code).toBe(2); expect(s.code).toBe('query_failed'); expect(s.close).toEqual({ rollback: 'confirmed', end: 'ok' });
  });
  it('el respaldo del proceso de la línea de comandos escribe un resumen fijo y termina; desarmado no actúa', async () => {
    const time = fakeTime(); const write = jest.fn(); const exit = jest.fn();
    const disarm = armHardExit({ set: time.timers.set, clear: time.timers.clear, exit, write, ms: BUDGET.hardExitMs });
    await time.advance(BUDGET.hardExitMs - 1); expect(exit).not.toHaveBeenCalled();
    await time.advance(2);
    expect(exit).toHaveBeenCalledWith(2); expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0][0] as string;
    expect(JSON.parse(line.slice(SUMMARY_PREFIX.length))).toMatchObject({ status: 'failed', code: 'time_exceeded', eligible: false, serverValidated: false });
    disarm();
    const other = fakeTime(); const exit2 = jest.fn();
    armHardExit({ set: other.timers.set, clear: other.timers.clear, exit: exit2, write: jest.fn(), ms: 10 })();
    await other.advance(100); expect(exit2).not.toHaveBeenCalled(); expect(other.pending()).toBe(0);
  });
});

describe('sondas sobre datos crudos y cadena offline', () => {
  const rowsFrom = (data: Record<string, any[]>) => (id: string) => data[id] ?? null;
  const onlyNumbers = (value: unknown): boolean => value === null || typeof value === 'number' || typeof value === 'boolean' ||
    (typeof value === 'object' && Object.values(value as object).every(onlyNumbers));
  it('indexBacking: el índice de una PK con solo la arista i hacia la constraint no tiene arista a hacia la tabla', () => {
    const p: any = runProbes(rowsFrom({
      ev_relations: [{ oid: 10, relkind: 'i' }, { oid: 11, relkind: 'i' }],
      ev_companion_items: [{ item_kind: 'constraint', subtype: 'p', related_classid: 'pg_class', related_oid: 10 }, { item_kind: 'constraint', subtype: 'u', related_classid: 'pg_class', related_oid: 11 }],
      ev_internal_edges: [{ source_classid: 'pg_class', source_objid: 10, deptype: 'i', ref_classid: 'pg_constraint' }, { source_classid: 'pg_class', source_objid: 11, deptype: 'a', ref_classid: 'pg_class' },
        { source_classid: 'pg_class', source_objid: 11, deptype: 'i', ref_classid: 'pg_constraint' }],
    }));
    expect(p.indexBacking).toEqual({ backed: 2, withTableEdge: 1, withConstraintEdge: 2 });
  });
  it('composite: dirección de la dependencia del tipo compuesto autónomo', () => {
    const p: any = runProbes(rowsFrom({
      ev_relations: [{ oid: 5, relkind: 'c' }, { oid: 6, relkind: 'r' }], ev_types: [{ oid: 50, typrelid: 5 }, { oid: 60, typrelid: 6 }],
      ev_internal_edges: [{ source_classid: 'pg_class', source_objid: 5, deptype: 'i', ref_classid: 'pg_type' }, { source_classid: 'pg_type', source_objid: 60, deptype: 'i', ref_classid: 'pg_class' }],
    }));
    expect(p.composite).toEqual({ composites: 1, reverseEdges: 1, forwardEdges: 0 });
  });
  it('extensionClass, classSpelling y closure', () => {
    const p: any = runProbes(rowsFrom({
      ev_extension_members: [{ classid: 'pg_catalog.pg_extension' }, { classid: 'pg_extension' }, { classid: 'pg_class' }],
      ev_closure: [{ classid: 'pg_class', objid: 1, depth: 1 }, { classid: 'pg_class', objid: 1, depth: 2 }, { classid: 'pg_type', objid: 2, depth: 3 }],
    }));
    expect(p.extensionClass).toEqual({ qualified: 1, unqualified: 1 });
    expect(p.classSpelling).toEqual({ distinct: 4, qualified: 1 }); expect(p.closure).toEqual({ rows: 3, distinct: 2, maxDepth: 3 });
  });
  it('unmappedTargets, rowTypes, flags, toastNames y sessions', () => {
    const p: any = runProbes(rowsFrom({
      ev_outbound_references: [{ source_classid: 'pg_proc', target_schema: null }, { source_classid: 'pg_class', target_schema: null }, { source_classid: 'pg_class', target_schema: 'x' }],
      ev_external_dependents: [{ namespace: null }, { namespace: 'pg_toast' }], ev_routines: [{ oid: 1 }],
      ev_relations: [{ oid: 1, relkind: 'r', relhastriggers: true, relhasrules: true }, { oid: 2, relkind: 'S' }, { oid: 3, relkind: 'v', relhastriggers: false, relhasrules: false }],
      ev_types: [{ oid: 9, typrelid: 1 }, { oid: 8, typrelid: 2 }],
      ev_companion_items: [{ item_kind: 'trigger', group_oid: 3 }, { item_kind: 'toast_candidate', group_oid: 1, name: 'pg_toast_1' }, { item_kind: 'toast_candidate', group_oid: 1, name: 'otro' }],
      ev_sessions: [{ state: null }, { state: 'idle' }],
    }));
    expect(p.unmappedTargets).toEqual({ relation: 1, routine: 1, type: 0, companion: 0, other: 0, externalNull: 1, routines: 1 });
    expect(p.rowTypes).toEqual({ sequence: 1, index: 0, toast: 0, table: 1, view: 0, withoutType: 1 });
    expect(p.flags).toEqual({ triggersFlagNoItem: 1, rulesFlagNoItem: 1, itemNoTriggerFlag: 1 });
    expect(p.toastNames).toEqual({ candidates: 2, expectedName: 1 }); expect(p.sessions).toEqual({ total: 2, nullState: 1 });
    expect(onlyNumbers(p)).toBe(true);
  });
  it('sin la consulta necesaria la sonda es null, y los datos hostiles no la rompen', () => {
    const p: any = runProbes(() => null);
    expect(Object.values(p).every(v => v === null)).toBe(true);
    const hostile = runProbes(() => [new Proxy({}, { get() { throw new Error('trampa'); }, getOwnPropertyDescriptor() { throw new Error('trampa'); } })] as never) as any;
    expect(onlyNumbers(hostile)).toBe(true);
  });
  it('las sondas ven filas que C3-B oculta: un destino NULL vuelve el resultado unresolved y aun así se cuenta', async () => {
    const w = world();
    w.ev_outbound_references = [{ source_classid: 'pg_class', source_objid: 100, source_subid: 0, group_classid: 'pg_class', group_oid: 100, deptype: 'n',
      ref_classid: 'pg_language', ref_objid: 14, ref_subid: 0, target_schema: null }];
    const x = setup(w); const r = await x.run();
    expect(r.s.code).toBe('ok');
    expect(r.s.probes.unmappedTargets).toMatchObject({ relation: 1 });
    expect(r.s.normalized.structural).toBe('unresolved'); expect(r.s.normalized.reasons).toContain('unmapped_class');
    expect(r.s.chain.classification.findings.input_unresolved).toBe(1);
    expect(r.s.queries.find((q: any) => q.id === 'ev_outbound_references').status).toBe('ok');
  });
  it('la cadena produce una proyección de recuentos por código, no hallazgos con sujetos', async () => {
    const w = world(); w.ev_namespace_catalog_counts[0].extension = '1';
    const r = await setup(w).run();
    expect(r.s.chain.reconciliation.findings.extension_count_mismatch).toBe(1);
    expect(Object.values(r.s.chain.reconciliation.findings).every(n => typeof n === 'number')).toBe(true);
    expect(r.s.chain.assembly.coherent).toBe(true);
  });
  it('con una ejecución parcial se calculan las sondas disponibles y se omite la cadena', async () => {
    const w = world(); w.ev_closure = [{ classid: 'pg_class', objid: 1, objsubid: 0, deptype: 'n', depth: 1 }];
    const x = setup(w); x.fake.script.set('ev_event_triggers', { error: sqlError('57014') });
    const r = await x.run();
    expect(r.s.code).toBe('query_failed'); expect(r.s.chain).toBeNull(); expect(r.s.normalized).toBeNull();
    expect(r.s.probes.closure).toEqual({ rows: 1, distinct: 1, maxDepth: 1 });
  });
});

describe('resumen seguro y ausencia de filtraciones', () => {
  it('ni credenciales, ni nombres, ni oids, ni el run, ni filas aparecen en la salida o en la consola', async () => {
    const w = world();
    w.ev_relations = [{ oid: 31337313, relname: 'SENTINEL_NAME', relkind: 'r', owner: 'SENTINEL_OWNER', relispartition: false, relpersistence: 'p', reltoastrelid: 0,
      relhasrules: false, relhastriggers: false, relrowsecurity: false, acl: 'SENTINEL_ACL' }];
    const spies = [jest.spyOn(console, 'log'), jest.spyOn(console, 'error'), jest.spyOn(console, 'warn')];
    try {
      const x = setup(w); const r = await x.run();
      const line = x.stdout.mock.calls[0][0] as string;
      for (const forbidden of [PASSWORD, 'SENTINEL', '31337313', SCHEMA, RUN, 'agenda_test_owner', 'SELECT', 'pg_catalog']) expect(line).not.toContain(forbidden);
      expect(r.s.code).toBe('ok');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
  it('un error SQL cuyo mensaje y traza contienen el secreto solo deja un código', async () => {
    const x = setup(); x.fake.script.set('ev_closure', { error: sqlError('XX000') });
    const r = await x.run(); const line = x.stdout.mock.calls[0][0] as string;
    expect(r.s.code).toBe('query_failed'); expect(line).not.toContain(PASSWORD);
    const y = setup(); y.fake.control.connect = 'fail'; await y.run(); expect(y.stdout.mock.calls[0][0]).not.toContain(PASSWORD);
  });
  it('sanitizeSummary descarta claves desconocidas, tipos incorrectos y entradas hostiles', () => {
    const getter = {}; Object.defineProperty(getter, 'code', { enumerable: true, get() { throw new Error('getter'); } });
    for (const hostile of [null, undefined, 5, 'x', [], getter, new Proxy({}, { get() { throw new Error('t'); }, getOwnPropertyDescriptor() { throw new Error('t'); } })]) {
      const s: any = sanitizeSummary(hostile);
      expect(s).toMatchObject({ code: 'internal_error', exitCode: 2, status: 'failed', provenance: 'unauthenticated', eligible: false, serverValidated: false });
    }
    const s: any = sanitizeSummary({ code: 'ok', password: PASSWORD, rows: [{ a: 1 }], sql: 'SELECT', budget: { queries: -1, rows: 1.5, bytes: '9', extra: 1 },
      queries: [{ id: 'ev_context', status: 'raro', rows: -3, ms: 1.5, extra: 1 }, { id: 'inventado', status: 'ok' }], close: { rollback: 'x', end: 'y' }, probes: { ok: { a: 1, b: 'texto' }, 'mal nombre': { a: 1 } },
      selection: { digest: 'no-hex', valid: true }, server: { major: 'x' }, gates: { context: 'sí' }, eligible: true, serverValidated: true, provenance: 'authenticated' });
    expect(JSON.stringify(s)).not.toContain(PASSWORD); expect(JSON.stringify(s)).not.toContain('SELECT');
    expect(s.budget).toEqual({ queries: 0, control: 0, statements: 0, rows: 0, bytes: 0, executionMs: 0, closeMs: 0 });
    expect(s.queries).toEqual([{ id: 'ev_context', status: 'skipped', rows: 0, ms: 0, sql: (PINNED as Record<string, string>).ev_context.slice(0, 12) }]);
    expect(s.close).toEqual({ rollback: 'not_needed', end: 'not_needed' }); expect(s.probes).toEqual({ ok: { a: 1, b: 0 } });
    expect(s.selection).toBeUndefined(); expect(s.server).toBeUndefined(); expect(s.gates.context).toBeNull();
    invariants(s);
  });
  it('M1: diagnosticOnly es verdadero salvo en ok, y la evidencia ensamblada solo se afirma en ok', () => {
    const chain = { classification: { structural: 'structurally_valid' }, reconciliation: { structural: 'structurally_valid' }, assembly: { structural: 'structurally_valid', coherent: true, evidence: true } };
    for (const code of ['close_failed', 'query_failed', 'time_exceeded']) {
      const s: any = sanitizeSummary({ code, chain }); expect(s.diagnosticOnly).toBe(true); expect(s.chain.assembly.evidence).toBe(false); expect(s.chain.assembly.coherent).toBe(true);
    }
    const ok: any = sanitizeSummary({ code: 'ok', chain }); expect(ok.diagnosticOnly).toBe(false); expect(ok.chain.assembly.evidence).toBe(true);
  });
  it.each(['ok', 'stage_not_authorized', 'close_failed', 'identity_unknown', 'schema_absent'])('invariantes y código de salida para %s', code => {
    const s: any = sanitizeSummary({ code });
    invariants(s); expect(s.exitCode).toBe(EXIT_CODES[code as keyof typeof EXIT_CODES]);
  });
});

describe('H2: columnas array (rolconfig) y memoria', () => {
  const CONFIG = ['statement_timeout=30s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s'];
  const withConfig = (config: unknown) => { const w = richWorld(); (w.role_attrs[1] as any).rolconfig = config; return w; };
  it('el rolconfig real de agenda_test_app (tres entradas) supera el preflight y la puerta P6b sin relajarla', async () => {
    const x = setup(withConfig(CONFIG)); const r = await x.run();
    expect(r.s.code).toBe('ok'); expect(r.s.gates.privileges).toBe(true); expect(r.code).toBe(0);
    expect(x.fake.texts()).toEqual(FULL);
  });
  it('cada elemento del array se contabiliza en la memoria retenida', async () => {
    const base = await setup(richWorld()).run(); const withArray = await setup(withConfig(CONFIG)).run();
    const array = 16 + CONFIG.reduce((n, entry) => n + 8 + 16 + 2 * entry.length, 0);
    expect(withArray.s.budget.bytes - base.s.budget.bytes).toBe(array - 8);
  });
  it('P6b sigue rechazando privilegios con el mismo rolconfig', async () => {
    const w = withConfig(CONFIG); (w.effective.find(r => r.kind === 'table' && r.privilege === 'INSERT') as any).effective = true;
    await failed(w, 'gate_residual', upto('effective'));
  });
  it('un rolconfig que el mapeador no admite sigue siendo NO-GO, aunque supere la contabilidad', async () => {
    await failed(withConfig(['search_path=public']), 'gate_unknown', upto('effective'));
    await failed(withConfig(['statement_timeout=30s', 'statement_timeout=30s']), 'gate_unknown', upto('effective'));
  });
  it('arrays vacíos y de escalares permitidos se aceptan', async () => {
    const w = world(); (w.role_attrs[1] as any).rolconfig = [];
    expect((await setup(w).run()).s.code).toBe('ok');
    const y = world(); y.ev_relations = [{ oid: 1, relname: 'x', arr: ['a', 1, true, null] }];
    expect((await setup(y).run()).s.queries.find((q: any) => q.id === 'ev_relations').rows).toBe(1);
  });
  const hostileArrays: [string, () => unknown][] = [
    ['array anidado', () => [['a']]], ['objeto como elemento', () => [{ a: 1 }]], ['demasiados elementos', () => Array.from({ length: 65 }, () => 'x')],
    ['array con huecos', () => { const a = new Array(3); a[0] = 'x'; return a; }], ['propiedad extra', () => Object.assign(['a'], { extra: 1 })],
    ['clave símbolo', () => { const a: unknown[] = ['a']; (a as any)[Symbol('s')] = 1; return a; }], ['proxy de array', () => new Proxy(['a'], {})],
    ['elemento con getter', () => { const a = ['a']; Object.defineProperty(a, '0', { enumerable: true, get() { throw new Error('getter ejecutado'); } }); return a; }],
    ['subclase de Array', () => { class Sub extends Array {} return Sub.from(['a']); }], ['elemento bigint', () => [10n]], ['elemento función', () => [() => 1]],
    ['elemento símbolo', () => [Symbol('s')]], ['objeto en lugar de array', () => ({ 0: 'a', length: 1 })], ['Date', () => new Date(0)],
  ];
  it.each(hostileArrays)('rechaza %s: query_failed y nada más se ejecuta', async (_name, build) => {
    const x = setup(richWorld());
    const rows = JSON.parse(JSON.stringify(x.fake.data.role_attrs)); rows[1].rolconfig = build();
    x.fake.script.set('role_attrs', { raw: { rows } });
    const r = await x.run();
    expect(r.s.code).toBe('query_failed'); expect(x.fake.texts()).toEqual(upto('role_attrs'));
  });
  it('el presupuesto de 8 MiB se mantiene y cuenta el contenido de los arrays', async () => {
    expect(BUDGET.memoryBytes).toBe(8 * 1024 * 1024);
    const w = world(); w.ev_relations = Array.from({ length: 100 }, (_, i) => ({ oid: i + 1, many: Array.from({ length: 64 }, () => 'y'.repeat(1000)) }));
    const r = await failed(w, 'memory_exceeded', upto('ev_relations'));
    expect(r.s.budget.bytes).toBeGreaterThan(BUDGET.memoryBytes);
  });
});

describe('catálogo manipulado y aislamiento de la herramienta', () => {
  const real = (name: string) => jest.requireActual(`../../scripts/harness/${name}`) as any;
  /** The tool loads its collaborators lazily, so the mocks must stay active while main runs. */
  const withMocks = async <T>(mocks: Record<string, () => unknown>, fn: (tool: typeof script) => Promise<T>): Promise<T> => {
    jest.resetModules();
    for (const [name, factory] of Object.entries(mocks)) jest.doMock(`../../scripts/harness/${name}`, factory);
    try { return await fn(jest.requireActual('../../scripts/c8-validate-evidence.cjs')); } finally {
      for (const name of Object.keys(mocks)) jest.dontMock(`../../scripts/harness/${name}`);
      jest.resetModules();
    }
  };
  const refused = async (mocks: Record<string, () => unknown>) => withMocks(mocks, async tool => {
    const x = setup(); const stdout = jest.fn();
    const code = await tool.main(GOOD, { ...x.deps, stdout } as never);
    expect(code).toBe(2); expect(x.fake.instances).toHaveLength(0); expect(x.readEnvFile).not.toHaveBeenCalled();
    return JSON.parse((stdout.mock.calls[0][0] as string).slice(SUMMARY_PREFIX.length));
  });
  it('un SQL del preflight alterado se rechaza antes de abrir cliente', async () => {
    const s = await refused({ 'c8-pg-queries.cjs': () => { const r = real('c8-pg-queries.cjs'); return { ...r, lookup: (id: string) => (id === 'effective' ? { ...r.lookup(id), sql: `${r.lookup(id).sql} ` } : r.lookup(id)) }; } });
    expect(s.code).toBe('catalog_invalid');
  });
  it.each([
    ['SQL de evidencia alterado', (r: any) => ({ ...r, get: (id: string) => (id === 'ev_routines' ? { ...r.get(id), sql: `${r.get(id).sql} ` } : r.get(id)) })],
    ['hash propio desalineado', (r: any) => ({ ...r, get: (id: string) => (id === 'ev_types' ? { ...r.get(id), sqlSha256: '0'.repeat(64) } : r.get(id)) })],
    ['serverValidated verdadero', (r: any) => ({ ...r, get: (id: string) => (id === 'ev_types' ? { ...r.get(id), serverValidated: true } : r.get(id)) })],
    ['catálogo con 21 consultas', (r: any) => ({ ...r, CATALOG: r.CATALOG.slice(1) })],
    ['catálogo con una consulta de más', (r: any) => ({ ...r, CATALOG: [...r.CATALOG, r.CATALOG[0]] })],
    ['tope de filas distinto', (r: any) => ({ ...r, get: (id: string) => (id === 'ev_types' ? { ...r.get(id), maxRows: 400 } : r.get(id)) })],
  ])('%s: catalog_invalid sin cliente', async (_name, tweak) => {
    const s = await refused({ 'c8-evidence-queries.cjs': () => (tweak as (r: any) => unknown)(real('c8-evidence-queries.cjs')) });
    expect(s.code).toBe('catalog_invalid');
  });
  it('el script solo importa los módulos de lectura previstos y nunca política, DDL, limpieza, C1 ni el conector actual', () => {
    const source = fs.readFileSync(BASE_SCRIPT, 'utf8');
    const required = [...source.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]).sort();
    expect([...new Set(required)]).toEqual(['./harness/c8-evidence-assemble.cjs', './harness/c8-evidence-classify.cjs', './harness/c8-evidence-normalize.cjs',
      './harness/c8-evidence-queries.cjs', './harness/c8-evidence-reconcile.cjs', './harness/c8-evidence-states.cjs', './harness/c8-gate.cjs', './harness/c8-names.cjs',
      './harness/c8-pg-adapter.cjs', './harness/c8-pg-queries.cjs', './harness/c8-target.cjs', './harness/c8-timeouts.cjs', './harness/env-files.cjs', 'node:crypto',
      'node:fs', 'node:path', 'node:util', 'pg'].sort());
  });
  it('análisis estático: sin escritura de ficheros, consola, process.env, módulos de red ni literales de entorno', () => {
    const source = fs.readFileSync(BASE_SCRIPT, 'utf8');
    const ast = ts.createSourceFile('tool.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const hits = new Set<string>();
    const writes = /^(?:writeFile|writeFileSync|writev|appendFile|createWriteStream|mkdir|rm|rmdir|unlink|rename|chmod|chown|truncate|copyFile|cp|link|symlink|utimes)(?:Sync)?$/;
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) && /^(?:node:)?(?:child_process|net|http|https|http2|dns|tls|dgram)(?:\/|$)/.test(node.text)) hits.add('forbidden-module');
      if (ts.isStringLiteralLike(node) && /(?:^|[/\\])\.env(?:$|[./\\])/.test(node.text)) hits.add('env-literal');
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && writes.test(node.text)) hits.add('fs-write');
      if (ts.isIdentifier(node) && (node.text === 'console' || node.text === 'eval' || node.text === 'Function' || node.text === 'Date')) hits.add(node.text);
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === 'process' && node.name.text === 'env') hits.add('process-env');
      if (ts.isStringLiteralLike(node) && /^\s*(COMMIT|SAVEPOINT|RELEASE|ROLLBACK TO|SET |INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|REVOKE|TRUNCATE)\b/.test(node.text)) hits.add(`sql:${node.text}`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect([...hits]).toEqual([]);
  });
});
