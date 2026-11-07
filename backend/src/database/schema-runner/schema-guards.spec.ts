import { SCHEMA_MANIFEST, type ManifestEntry } from '../migrations/schema-manifest';
import { TABLE_ORDER } from '../migrations/initial-schema.statements';
import {
  authorize, classifyState, confirmationFor, decideAction, evaluateApplicationPrivileges, evaluateEmpty, evaluateExecuted, evaluateIdentity,
  evaluateLock, evaluateMigrationsTablePrivileges, evaluateMigrationsTableShape, evaluateTransactionClosed, evaluateUnlock, manifestDigest,
  parseArguments, type Row, type StateSnapshot,
} from './schema-guards';
import { SchemaRunnerError, type SchemaCommand } from './schema-target';

const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof SchemaRunnerError ? e.code : 'other'; } return null; };
const tables = [...TABLE_ORDER];
const short = manifestDigest().slice(0, 8);

describe('argumentos y confirmación', () => {
  const base = ['--env=test', '--target=agenda_test'];
  it('acepta cada orden con sus tres opciones exactas', () => {
    expect(parseArguments(['plan', ...base, '--confirm=PLAN:agenda_test'])).toEqual({ command: 'plan', confirm: 'PLAN:agenda_test' });
    expect(parseArguments(['apply', '--confirm=x', ...base]).command).toBe('apply');
    expect(parseArguments(['revert', ...base, '--confirm=x']).command).toBe('revert');
  });
  it.each([
    [[], 'args_invalid'], [['migrate', ...base, '--confirm=x'], 'args_invalid'], [['plan', ...base], 'args_invalid'],
    [['plan', '--env=test', '--confirm=x'], 'args_invalid'], [['plan', '--target=agenda_test', '--confirm=x'], 'args_invalid'],
    [['plan', ...base, '--confirm=x', '--confirm=y'], 'args_invalid'], [['plan', ...base, '--env=test', '--confirm=x'], 'args_invalid'],
    [['plan', ...base, '--confirm=x', '--force'], 'args_invalid'], [['plan', ...base, '--confirm=x', 'extra'], 'args_invalid'],
    [['plan', '--env=production', '--target=agenda_test', '--confirm=x'], 'env_forbidden'],
    [['plan', '--env=development', '--target=agenda_test', '--confirm=x'], 'env_forbidden'],
    [['plan', '--env=staging', '--target=agenda_test', '--confirm=x'], 'args_invalid'],
    [['plan', '--env=test', '--target=agenda', '--confirm=x'], 'target_invalid'],
    [['plan', '--env=test', '--target=agenda_dev', '--confirm=x'], 'target_invalid'],
    [['plan', '--env=test', '--target=agenda_test ', '--confirm=x'], 'target_invalid'],
  ])('rechaza %j con %s', (argv, code) => { expect(codeOf(() => parseArguments(argv as string[]))).toBe(code); });
  it('rechaza argumentos que no son texto', () => { expect(codeOf(() => parseArguments([1 as unknown as string]))).toBe('args_invalid'); });

  it('las confirmaciones quedan atadas a la orden y al resumen del manifiesto', () => {
    expect(confirmationFor('plan')).toBe('PLAN:agenda_test');
    expect(confirmationFor('apply')).toBe(`APPLY:agenda_test:${short}`);
    expect(confirmationFor('revert')).toBe(`REVERT:agenda_test:${short}`);
    expect(short).toMatch(/^[0-9a-f]{8}$/);
    expect(confirmationFor('apply')).not.toBe(confirmationFor('revert').replace('REVERT', 'APPLY') + 'x');
  });
  it('authorize exige el token exacto de cada orden', () => {
    expect(authorize(['plan', ...base, '--confirm=PLAN:agenda_test'])).toBe('plan');
    expect(authorize(['apply', ...base, `--confirm=APPLY:agenda_test:${short}`])).toBe('apply');
    expect(authorize(['revert', ...base, `--confirm=REVERT:agenda_test:${short}`])).toBe('revert');
    for (const argv of [
      ['apply', ...base, '--confirm=PLAN:agenda_test'], ['revert', ...base, `--confirm=APPLY:agenda_test:${short}`],
      ['apply', ...base, `--confirm=REVERT:agenda_test:${short}`], ['apply', ...base, '--confirm=APPLY:agenda_test:00000000'],
      ['apply', ...base, '--confirm=APPLY:agenda_test'], ['plan', ...base, '--confirm=plan:agenda_test'], ['plan', ...base, '--confirm='],
    ]) expect(codeOf(() => authorize(argv))).toBe('confirmation_invalid');
  });
  it('un manifiesto alterado invalida la autorización y cambia el resumen', () => {
    const altered: ManifestEntry[] = [{ ...SCHEMA_MANIFEST[0], sha256: '0'.repeat(64) }];
    expect(codeOf(() => authorize(['plan', ...base, '--confirm=PLAN:agenda_test'], altered))).toBe('manifest_invalid');
    expect(manifestDigest(altered)).not.toBe(manifestDigest());
    expect(codeOf(() => authorize(['apply', ...base, `--confirm=APPLY:agenda_test:${short}`], altered))).toBe('manifest_invalid');
  });
});

const identity = (mode: SchemaCommand, over: Row = {}): Row[] => {
  const ro = mode === 'plan' ? 'on' : 'off';
  return [{
    database: 'agenda_test', current_user: 'agenda_test_owner', session_user: 'agenda_test_owner', version_num: 160015, in_recovery: false,
    transaction_read_only: ro, default_read_only: ro, standard_conforming_strings: 'on', current_schema: 'public', effective_search_path: 'public',
    statement_timeout: '15s', lock_timeout: '5s', idle_in_transaction_session_timeout: '30s', application_name: 'agenda-schema-runner',
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true,
    can_use_public: true, can_create_public: true, owns_database: true, event_triggers: 0, owner_memberships: 0, app_role_exists: true, ...over,
  }];
};

describe('identidad de la sesión', () => {
  it.each(['plan', 'apply', 'revert'] as const)('acepta la identidad válida en modo %s', mode => { expect(evaluateIdentity(identity(mode), mode)).toBeNull(); });
  it.each([
    [{ database: 'agenda_dev' }, 'identity_database'], [{ database: 'postgres' }, 'identity_database'],
    [{ current_user: 'agenda_test_app' }, 'identity_user'], [{ session_user: 'postgres' }, 'identity_user'],
    [{ version_num: 150014 }, 'identity_version'], [{ version_num: 170001 }, 'identity_version'], [{ version_num: '160015' }, 'identity_version'],
    [{ in_recovery: true }, 'identity_recovery'], [{ in_recovery: null }, 'identity_recovery'],
    [{ transaction_read_only: 'on' }, 'identity_read_only'], [{ default_read_only: 'on' }, 'identity_read_only'],
    [{ standard_conforming_strings: 'off' }, 'standard_conforming_strings_off'], [{ standard_conforming_strings: undefined }, 'standard_conforming_strings_off'],
    [{ current_schema: 'agenda' }, 'identity_search_path'], [{ effective_search_path: 'public,other' }, 'identity_search_path'],
    [{ rolsuper: true }, 'identity_role_privileged'], [{ rolcreaterole: true }, 'identity_role_privileged'], [{ rolcreatedb: true }, 'identity_role_privileged'],
    [{ rolreplication: true }, 'identity_role_privileged'], [{ rolbypassrls: true }, 'identity_role_privileged'], [{ rolcanlogin: false }, 'identity_role_privileged'],
    [{ can_use_public: false }, 'identity_schema_privilege'], [{ can_create_public: false }, 'identity_schema_privilege'],
    [{ owns_database: false }, 'identity_database_owner'], [{ event_triggers: 1 }, 'identity_event_triggers'], [{ event_triggers: '0' }, 'identity_event_triggers'],
    [{ owner_memberships: 1 }, 'identity_role_memberships'], [{ app_role_exists: false }, 'identity_app_role'],
    [{ statement_timeout: '0' }, 'identity_timeouts'], [{ lock_timeout: '30s' }, 'identity_timeouts'], [{ idle_in_transaction_session_timeout: '0' }, 'identity_timeouts'],
    [{ application_name: 'psql' }, 'identity_timeouts'],
  ])('rechaza %j con %s', (over, code) => { expect(evaluateIdentity(identity('apply', over as Row), 'apply')).toBe(code); });
  it('plan exige sesión de solo lectura y apply la exige de escritura', () => {
    expect(evaluateIdentity(identity('apply'), 'plan')).toBe('identity_read_only');
    expect(evaluateIdentity(identity('plan'), 'apply')).toBe('identity_read_only');
  });
  it.each([[undefined], [null], [[]], [[1]], [identity('apply').concat(identity('apply'))], ['x']])('filas ilegibles %j', rows => { expect(evaluateIdentity(rows, 'apply')).toBe('identity_unreadable'); });
});

const executedRows = (names: string[]) => names.map(name => ({ name }));
const manifestNames = SCHEMA_MANIFEST.map(e => e.name);
const relations = (over: { tables?: string[]; extra?: Row[]; migrations?: boolean; sequence?: boolean } = {}): Row[] => [
  ...(over.tables ?? tables).map(name => ({ name, kind: 'r', table_name: null })),
  ...(over.tables ?? tables).map(name => ({ name: `PK_${name}`, kind: 'i', table_name: name })),
  ...(over.migrations === false ? [] : [{ name: 'schema_migrations', kind: 'r', table_name: null }, { name: 'PK_schema_migrations', kind: 'i', table_name: 'schema_migrations' }]),
  ...(over.sequence === false ? [] : [{ name: 'schema_migrations_id_seq', kind: 'S', table_name: null }]),
  ...(over.extra ?? []),
];
const zero = [{ routines: 0, types: 0, extensions: 0 }];
const snap = (relationsRows: unknown, executed: unknown, foreignObjects: unknown = zero): StateSnapshot => ({ relations: relationsRows, foreignObjects, executed });

describe('clasificación del estado del esquema', () => {
  it('fresh: esquema vacío, con o sin la tabla de migraciones vacía', () => {
    expect(classifyState(snap([], null))).toBe('fresh');
    expect(classifyState(snap(relations({ tables: [] }), []))).toBe('fresh');
  });
  it('applied: 8 tablas, tabla y secuencia de migraciones, y exactamente el manifiesto', () => {
    expect(classifyState(snap(relations(), executedRows(manifestNames)))).toBe('applied');
  });
  it('partial: lo nuestro, incompleto o inconsistente', () => {
    expect(classifyState(snap(relations({ tables: tables.slice(0, 3) }), []))).toBe('partial');
    expect(classifyState(snap(relations(), []))).toBe('partial');
    expect(classifyState(snap(relations({ migrations: false, sequence: false }), null))).toBe('partial');
    expect(classifyState(snap(relations({ tables: [] }), executedRows(manifestNames)))).toBe('partial');
    expect(classifyState(snap(relations({ sequence: false }), executedRows(manifestNames)))).toBe('partial');
  });
  it('foreign: cualquier objeto que no es nuestro en public', () => {
    for (const extra of [
      { name: 'secret_notes', kind: 'r', table_name: null }, { name: 'v_users', kind: 'v', table_name: null }, { name: 'mv', kind: 'm', table_name: null },
      { name: 'other_seq', kind: 'S', table_name: null }, { name: 'ix_foreign', kind: 'i', table_name: 'secret_notes' }, { name: 'ix_orphan', kind: 'i', table_name: null },
      { name: 'ct', kind: 'c', table_name: null }, { name: 'ft', kind: 'f', table_name: null }, { name: 'pt', kind: 'p', table_name: null },
    ]) expect(classifyState(snap(relations({ extra: [extra] }), executedRows(manifestNames)))).toBe('foreign');
    for (const objects of [{ routines: 1, types: 0, extensions: 0 }, { routines: 0, types: 1, extensions: 0 }, { routines: 0, types: 0, extensions: 1 }])
      expect(classifyState(snap([], null, [objects]))).toBe('foreign');
  });
  it('una secuencia ajena tiene prioridad sobre un estado parcial', () => {
    expect(classifyState(snap(relations({ tables: tables.slice(0, 2), extra: [{ name: 'x', kind: 'S', table_name: null }] }), []))).toBe('foreign');
  });
  it('lecturas ilegibles, truncadas o ambiguas fallan cerradas con código', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `t${i}`, kind: 'r', table_name: null }));
    expect(codeOf(() => classifyState(snap(many, null)))).toBe('state_truncated');
    expect(codeOf(() => classifyState(snap('x', null)))).toBe('state_unreadable');
    expect(codeOf(() => classifyState(snap([], null, [])))).toBe('state_unreadable');
    expect(codeOf(() => classifyState(snap([], null, [{ routines: '0', types: 0, extensions: 0 }])))).toBe('state_unreadable');
    expect(codeOf(() => classifyState(snap([{ name: 1, kind: 'r' }], null)))).toBe('state_unreadable');
    expect(codeOf(() => classifyState(snap(relations(), 'x')))).toBe('executed_unreadable');
    expect(codeOf(() => classifyState(snap(relations(), null)))).toBe('executed_unreadable');
  });
  it('evaluateExecuted distingue nada, todo y lo inesperado', () => {
    expect(evaluateExecuted([])).toBe('none');
    expect(evaluateExecuted(executedRows(manifestNames))).toBe('all');
    expect(evaluateExecuted(executedRows(['Other1']))).toBe('unexpected');
    expect(evaluateExecuted(executedRows([...manifestNames, 'Extra2']))).toBe('unexpected');
    expect(evaluateExecuted([{ name: 5 }])).toBe('unreadable');
    expect(evaluateExecuted(null)).toBe('unreadable');
  });
  it('cada orden decide qué hacer con cada estado', () => {
    expect(decideAction('plan', 'foreign')).toEqual({ action: 'refuse', code: 'state_foreign' });
    for (const s of ['fresh', 'applied', 'partial'] as const) expect(decideAction('plan', s).action).toBe('proceed');
    expect(decideAction('apply', 'fresh').action).toBe('proceed');
    expect(decideAction('apply', 'applied').action).toBe('noop');
    expect(decideAction('apply', 'partial')).toEqual({ action: 'refuse', code: 'state_partial' });
    expect(decideAction('apply', 'foreign').code).toBe('state_foreign');
    expect(decideAction('revert', 'applied').action).toBe('proceed');
    expect(decideAction('revert', 'fresh').action).toBe('noop');
    expect(decideAction('revert', 'partial').code).toBe('state_partial');
    expect(decideAction('revert', 'foreign').code).toBe('state_foreign');
  });
  it('la forma de la tabla de migraciones es exacta', () => {
    const ok = [{ name: 'id', type: 'integer' }, { name: 'timestamp', type: 'bigint' }, { name: 'name', type: 'character varying' }];
    expect(evaluateMigrationsTableShape(ok)).toBeNull();
    expect(evaluateMigrationsTableShape(ok.slice(0, 2))).toBe('migrations_table_shape');
    expect(evaluateMigrationsTableShape([...ok.slice(0, 2), { name: 'name', type: 'text' }])).toBe('migrations_table_shape');
    expect(evaluateMigrationsTableShape([ok[1], ok[0], ok[2]])).toBe('migrations_table_shape');
    expect(evaluateMigrationsTableShape(null)).toBe('migrations_table_shape');
  });
});

const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const migrationsPrivileges = (over: (r: Row) => Row = r => r): Row[] => [
  ...TABLE_PRIVS.map(privilege => ({ kind: 'table', privilege })), ...['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].map(privilege => ({ kind: 'column', privilege })),
  ...['USAGE', 'SELECT', 'UPDATE'].map(privilege => ({ kind: 'sequence', privilege })),
].map(r => over({ ...r, effective: false, grantable: false }));

describe('privilegios efectivos sobre la tabla de migraciones (herencia y PUBLIC incluidos)', () => {
  it('acepta solo el caso en que ningún privilegio es efectivo', () => { expect(evaluateMigrationsTablePrivileges(migrationsPrivileges())).toBeNull(); });
  it('cada privilegio efectivo o con opción de concesión expone la tabla, venga de donde venga', () => {
    const all = migrationsPrivileges();
    expect(all).toHaveLength(14);
    all.forEach((row, index) => {
      for (const key of ['effective', 'grantable'] as const) {
        const rows = migrationsPrivileges(r => (r === row || (r.kind === row.kind && r.privilege === row.privilege) ? { ...r, [key]: true } : r));
        expect([index, key, evaluateMigrationsTablePrivileges(rows)]).toEqual([index, key, 'migrations_table_exposed']);
      }
    });
  });
  it('la cobertura incompleta o dudosa es "no verificado", nunca "limpio"', () => {
    const rows = migrationsPrivileges();
    for (const bad of [
      rows.slice(1), [...rows, rows[0]], rows.map((r, i) => (i === 0 ? { ...r, effective: null } : r)),
      rows.map((r, i) => (i === 0 ? { ...r, grantable: undefined } : r)), rows.map((r, i) => (i === 0 ? { ...r, privilege: 'USAGE' } : r)),
      rows.map((r, i) => (i === 0 ? { ...r, kind: 'view' } : r)), [...rows, { kind: 'table', privilege: 'MAINTAIN', effective: false, grantable: false }], null, 'x', [],
    ]) expect(evaluateMigrationsTablePrivileges(bad)).toBe('migrations_privileges_unverified');
  });
});

const appPrivileges = (over: (r: Row) => Row = r => r): Row[] => tables.flatMap(name => TABLE_PRIVS.map(privilege => over({
  name, privilege, effective: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), grantable: false })));

describe('privilegios del rol de aplicación sobre las tablas de negocio', () => {
  it('exige DML y nada más, sin opción de concesión', () => { expect(evaluateApplicationPrivileges(appPrivileges())).toBeNull(); });
  it.each([
    ['falta DML', (r: Row) => (r.privilege === 'DELETE' ? { ...r, effective: false } : r)],
    ['sobra TRUNCATE', (r: Row) => (r.privilege === 'TRUNCATE' ? { ...r, effective: true } : r)],
    ['sobra REFERENCES', (r: Row) => (r.privilege === 'REFERENCES' ? { ...r, effective: true } : r)],
    ['sobra TRIGGER', (r: Row) => (r.privilege === 'TRIGGER' ? { ...r, effective: true } : r)],
    ['opción de concesión', (r: Row) => (r.privilege === 'SELECT' ? { ...r, grantable: true } : r)],
  ])('%s', (_name, over) => { expect(evaluateApplicationPrivileges(appPrivileges(over))).toBe('app_privileges_wrong'); });
  it('cobertura incompleta o con NULL no se verifica', () => {
    const rows = appPrivileges();
    for (const bad of [rows.slice(1), [...rows, rows[0]], rows.map((r, i) => (i === 0 ? { ...r, effective: null } : r)), null, []])
      expect(evaluateApplicationPrivileges(bad)).toBe('app_privileges_unverified');
  });
});

describe('bloqueo, vacío de tablas y transacción cerrada', () => {
  it('bloqueo y desbloqueo', () => {
    expect(evaluateLock([{ locked: true }])).toBeNull();
    expect(evaluateLock([{ locked: false }])).toBe('lock_unavailable');
    for (const bad of [[], [{ locked: 'true' }], [{ locked: null }], [{}], null, [{ locked: true }, { locked: true }]]) expect(evaluateLock(bad)).toBe('lock_unverified');
    expect(evaluateUnlock([{ unlocked: true }])).toBeNull();
    for (const bad of [[{ unlocked: false }], [], [{ unlocked: 1 }], null]) expect(evaluateUnlock(bad)).toBe('unlock_failed');
  });
  it('revert exige las 8 tablas vacías', () => {
    const empty = Object.fromEntries(tables.map(t => [t, true]));
    expect(evaluateEmpty([empty])).toBeNull();
    for (const t of tables) expect(evaluateEmpty([{ ...empty, [t]: false }])).toBe('tables_not_empty');
    expect(evaluateEmpty([{ ...empty, organizations: null }])).toBe('tables_unverified');
    expect(evaluateEmpty([{ ...empty, extra: true }])).toBe('tables_unverified');
    const { posts: _omitted, ...fewer } = empty; void _omitted;
    expect(evaluateEmpty([fewer])).toBe('tables_unverified');
    expect(evaluateEmpty([])).toBe('tables_unverified');
    expect(evaluateEmpty(undefined)).toBe('tables_unverified');
  });
  const closedRow = { no_xid: true, no_backend_xid: true, implicit_transaction: true };
  it('solo es cierre probado cuando todas las señales coinciden', () => {
    expect(evaluateTransactionClosed({ clientStatus: 'I', queryRunnerActive: false, server: [closedRow] })).toBeNull();
  });
  it('un identificador de transacción ausente no basta por sí solo', () => {
    expect(evaluateTransactionClosed({ server: [closedRow] })).toBe('transaction_unverified');
    expect(evaluateTransactionClosed({ clientStatus: 'T', queryRunnerActive: false, server: [closedRow] })).toBe('transaction_open');
    expect(evaluateTransactionClosed({ clientStatus: 'E', queryRunnerActive: false, server: [closedRow] })).toBe('transaction_open');
    expect(evaluateTransactionClosed({ clientStatus: 'I', queryRunnerActive: true, server: [closedRow] })).toBe('transaction_open');
    expect(evaluateTransactionClosed({ clientStatus: 'I', queryRunnerActive: false, server: [{ ...closedRow, implicit_transaction: false }] })).toBe('transaction_open');
    expect(evaluateTransactionClosed({ clientStatus: 'I', queryRunnerActive: false, server: [{ ...closedRow, no_xid: false }] })).toBe('transaction_open');
    expect(evaluateTransactionClosed({ clientStatus: 'I', queryRunnerActive: false, server: [{ ...closedRow, no_backend_xid: false }] })).toBe('transaction_open');
  });
  it('la falta de cualquier evidencia es "no verificado", nunca "cerrada"', () => {
    for (const evidence of [
      {}, { clientStatus: 'I' }, { clientStatus: 'I', queryRunnerActive: false }, { clientStatus: undefined, queryRunnerActive: false, server: [closedRow] },
      { clientStatus: 'I', queryRunnerActive: undefined, server: [closedRow] }, { clientStatus: 'I', queryRunnerActive: false, server: [] },
      { clientStatus: 'I', queryRunnerActive: false, server: [{ ...closedRow, no_xid: null }] }, { clientStatus: 'X', queryRunnerActive: false, server: [closedRow] },
      { clientStatus: 'I', queryRunnerActive: false, server: [{}] },
    ]) expect(evaluateTransactionClosed(evidence)).toBe('transaction_unverified');
  });
});
