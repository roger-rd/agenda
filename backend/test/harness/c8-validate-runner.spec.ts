import * as fs from 'node:fs';
import * as ts from 'typescript';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { main, AUTHORIZATION, LOCK_AUTHORIZATION, REAL_AUTHORIZATION, sanitizeSummary, EXIT_CODES } from '../../scripts/c8-validate-readonly.cjs';
import { createConnector, AUTHORIZATION as CONNECT_AUTH } from '../../scripts/harness/c8-pg-connect.cjs';
import { lookup, CATALOG } from '../../scripts/harness/c8-pg-queries.cjs';
import { pgFake, credentials, NOW, PASSWORD, effective, coverage, holder, identityEvidence, server, identity, roleAttrs, NAME } from './support/c8-pg-fakes';
import { schema } from './support/c8-fakes';
import { L0_KEY } from '../../scripts/harness/c8-pg-adapter.cjs';
const authorized = ['--real', `--confirm=${AUTHORIZATION}`];
const disabled = `AGENDA_C8_VALIDATE ${JSON.stringify(sanitizeSummary({ code: 'stage_not_authorized', counts: { connectionsOpened: 0, connectionsClosed: 0 } }))}\n`;
function fixture(b = false) {
  const f = pgFake(); const stdout = jest.fn(); const readEnvFiles = jest.fn(async (): Promise<{ owner: Record<string, unknown>; app: Record<string, unknown> }> => ({ owner: credentials('owner'), app: credentials('app') }));
  const connector = createConnector({ pgModule: f.pgModule, ...(b ? { levelB: { enabled: true as const, authorization: CONNECT_AUTH } } : {}) });
  return { f, stdout, readEnvFiles, deps: { connector, stdout, readEnvFiles, now: () => NOW } };
}
describe('C8 ejecutor manual denegado por defecto', () => {
  it.each([[], ['--real']].map(argv => ({ argv })))('proceso SIN confirmación %# bajo net-trap', ({ argv }) => {
    // Never spawn an authorized CLI. Positive paths use main with injected fakes ONLY.
    const child = spawnSync(process.execPath, ['--require', path.resolve(__dirname, 'support/net-trap.preload.cjs'),
      path.resolve(__dirname, '../../scripts/c8-validate-readonly.cjs'), ...argv],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8', env: {} });
    expect(child.status).toBe(2); expect(child.stdout).toBe(disabled); expect(child.stderr).toBe('');
    const audit = JSON.parse(String(child.output[3])) as { opened: string[]; modules: string[] };
    expect(audit.modules).toEqual([]);
    expect(audit.opened.every(name => name.endsWith('/scripts/c8-validate-readonly.cjs'))).toBe(true);
  });
  it.each([[], ['--real'], [`--confirm=${AUTHORIZATION}`], ['--real', '--confirm=wrong'],
    [...authorized, '--real'], [...authorized, '--unknown'], [...authorized, '--level-b'],
    [...authorized, `--confirm-b=${LOCK_AUTHORIZATION}`], [...authorized, '--level-b', '--confirm-b=wrong'],
    ['--real', `--confirm=${AUTHORIZATION}\n`]].map(argv => ({ argv })))('flags incompletos/ambiguos %# no leen ni conectan', async ({ argv }) => {
    const x = fixture(); const now = jest.fn(() => NOW);
    expect(await main(argv, { ...x.deps, now })).toBe(2); expect(x.stdout).toHaveBeenCalledTimes(1);
    expect(x.stdout).toHaveBeenCalledWith(disabled); expect(x.readEnvFiles).not.toHaveBeenCalled(); expect(now).not.toHaveBeenCalled();
    expect(x.f.instances).toHaveLength(0);
  });
  it('A autorizado solo con fakes, jamás B y salida sin datos', async () => {
    const x = fixture(); expect(await main(authorized, x.deps)).toBe(0);
    expect(x.readEnvFiles).toHaveBeenCalledTimes(1); expect(x.stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(x.stdout.mock.calls[0][0].slice('AGENDA_C8_VALIDATE '.length))).toMatchObject({ status: 'ok', code: 'ok', exitCode: 0, level: 'A' });
    expect(x.stdout.mock.calls[0][0]).not.toContain(PASSWORD);
    const b = CATALOG.filter(q => q.level === 'B').map(q => q.sql);
    expect(x.f.calls.some(c => b.includes(c.sql))).toBe(false);
    expect(x.f.instances.every(c => c.ended || c.destroyed)).toBe(true);
  });
  it('B necesita ambos literales, titular/observador/contendiente falsos', async () => {
    const x = fixture(true);
    expect(await main([...authorized, '--level-b', `--confirm-b=${LOCK_AUTHORIZATION}`], x.deps)).toBe(0);
    expect(x.f.instances).toHaveLength(5);
    expect(x.f.calls.filter(c => c.sql === lookup('advisory_try_lock').sql)).toHaveLength(2);
    expect(x.f.calls.filter(c => c.sql === lookup('advisory_holders').sql)).toHaveLength(1);
    expect(x.f.calls.filter(c => c.sql === lookup('advisory_unlock').sql)).toHaveLength(1);
    expect(x.f.instances.every(c => c.ended || c.destroyed)).toBe(true);
  });
  it('CLI autorizado sin proveedores permanece cerrado bajo mocks previos a la importación', async () => {
    await withDefaultMocks(async x => {
      expect(await x.runner.main(authorized, { stdout: x.stdout })).toBe(2);
      expect(x.stdout).toHaveBeenCalledWith(disabled);
      expect(x.envReader).not.toHaveBeenCalled(); expect(x.connectorFactory).not.toHaveBeenCalled();
    });
  });
  it.each(['42809', '42501'])('error en puerta %s nunca se confunde con sonda', async state => {
    const x = fixture(); x.f.fail('default_acl_global', state);
    expect(await main(authorized, x.deps)).toBe(2); expect(x.stdout.mock.calls[0][0]).not.toContain(PASSWORD);
    expect(x.f.instances.every(c => c.ended || c.destroyed)).toBe(true);
  });
  it.each(['no-error', 'other-state', 'missing-code'])('sonda negativa fallida %s', async mode => {
    const x = fixture();
    if (mode === 'no-error') x.f.set('probe_42809', []);
    else if (mode === 'other-state') x.f.fail('probe_42809', '42501');
    else x.f.errors.set(lookup('probe_42809').sql, { message: PASSWORD });
    expect(await main(authorized, x.deps)).toBe(2); expect(x.stdout.mock.calls[0][0]).toContain('"status":"failed"');
  });
  it('ACL global veta aunque no haya efectivos residuales', async () => {
    const x = fixture(); x.f.set('default_acl_global', [{ owner_role: 'agenda_test_owner', object_type: 'r', grantee_public: true, grantee_app: false }]);
    expect(await main(authorized, x.deps)).toBe(2); expect(x.stdout.mock.calls[0][0]).toContain('gate_default_acl');
  });
  it.each(['identity', 'server', 'role_attrs', 'default_acl_global', 'schemas', 'sessions', 'numbackends'])('NULL en %s nunca permite validación', async id => {
    const x = fixture(); x.f.nullRows(id); expect(await main(authorized, x.deps)).toBe(['identity', 'server', 'role_attrs'].includes(id) ? 3 : 2);
  });
  it('errores de env y cierre son redactados y dan una sola salida', async () => {
    const x = fixture(); x.readEnvFiles.mockRejectedValueOnce(new Error(PASSWORD));
    expect(await main(authorized, x.deps)).toBe(2); expect(x.stdout).toHaveBeenCalledTimes(1); expect(x.stdout.mock.calls[0][0]).not.toContain(PASSWORD);
    const y = fixture(); y.f.controls.endError = new Error(PASSWORD);
    expect(await main(authorized, y.deps)).toBe(2); expect(y.stdout).toHaveBeenCalledTimes(1); expect(y.stdout.mock.calls[0][0]).not.toContain(PASSWORD);
  });
});

describe('C8 runner regresiones de cortes y evidencias', () => {
  it.each(['schema', 'table', 'sequence', 'routine', 'column', 'grantable'])('residuo %s corta todas las consultas posteriores', async kind => {
    const x = fixture(); const r = effective();
    if (kind === 'grantable') r[0].is_grantable = true;
    else r.find(row => row.kind === kind)!.effective = true;
    x.f.set('schemas', [schema()]); x.f.set('effective', r); x.f.set('effective_coverage', coverage());
    expect(await main(authorized, x.deps)).toBe(2);
    expect(x.stdout).toHaveBeenCalledTimes(1);
    // grantable, como defaultAcl, actualmente cae en gate_unknown; evaluate() no se modifica.
    const summary = JSON.parse(x.stdout.mock.calls[0][0].slice('AGENDA_C8_VALIDATE '.length));
    expect(summary).toMatchObject({ status: 'failed', code: kind === 'grantable' ? 'gate_unknown' : 'gate_residual', checks: expect.any(Number) });
    expect(Number.isSafeInteger(summary.checks)).toBe(true);
    expect(x.stdout.mock.calls[0][0]).not.toContain(PASSWORD);
    expect(x.stdout.mock.calls[0][0]).not.toContain(schema().name);
    const boundary = x.f.calls.findLastIndex(c => c.sql === lookup('default_acl_schema').sql);
    expect(boundary).toBeGreaterThan(-1);
    expect(x.f.calls.slice(boundary + 1).map(c => c.sql)).toEqual(['ROLLBACK']);
    const later = ['sessions', 'key_roundtrip', 'timeout_probe', 'probe_42809', 'advisory_try_lock'];
    for (const id of later) expect(x.f.calls.some(c => c.sql === lookup(id).sql)).toBe(false);
    expect(x.f.instances.every(c => c.ended || c.destroyed)).toBe(true);
  });
  it.each([false, true])('membresía coherente con setMembership=%s impide continuar', async set => {
    const x = fixture();
    x.f.set('role_membership', [{ oid: 10, membership: true, set_membership: set }]);
    x.f.set('auth_members', [{ roleid: 10, member: 11, inherit_option: true, set_option: set, admin_option: false }]);
    expect(await main(authorized, x.deps)).toBe(2);
    expect(x.stdout.mock.calls[0][0]).toContain('"status":"failed"');
    expect(x.f.calls.some(c => c.sql === lookup('default_acl_global').sql)).toBe(false);
  });
  it.each([29999, 30000, 30001, 300000])('presupuesto total en %i ms con reloj inyectado', async elapsed => {
    const x = fixture(); let time = NOW;
    x.f.controls.before = async sql => { if (sql === lookup('sessions').sql) time = NOW + elapsed; };
    expect(await main(authorized, { ...x.deps, now: () => time })).toBe(elapsed < 30000 ? 0 : 2);
    expect(x.stdout.mock.calls[0][0]).toContain(elapsed < 30000 ? '"status":"ok"' : '"status":"failed"');
    expect(x.f.calls.some(c => c.sql === lookup('key_roundtrip').sql)).toBe(elapsed < 30000);
  });
  it.each(['reconstructed', 'classid', 'objid'])('roundtrip con %s incorrecto falla antes de las sondas', async field => {
    const x = fixture();
    const row = { key: L0_KEY, reconstructed: L0_KEY, classid: (BigInt(L0_KEY) >> 32n).toString(), objid: (BigInt(L0_KEY) & 4294967295n).toString() };
    x.f.set('key_roundtrip', [{ ...row, [field]: (BigInt(row[field as keyof typeof row]) + 1n).toString() }]);
    expect(await main(authorized, x.deps)).toBe(2);
    expect(x.stdout.mock.calls[0][0]).toContain('"status":"failed"');
    expect(x.f.calls.some(c => c.sql === lookup('timeout_probe').sql)).toBe(false);
  });
  it.each(['contender-acquired', 'unlock-false'])('B falla con %s y libera clientes', async mode => {
    const x = fixture(true); let tries = 0;
    x.f.controls.before = async sql => {
      if (sql === lookup('advisory_try_lock').sql) {
        tries++;
        if (tries === 2 && mode === 'contender-acquired') x.f.set('advisory_try_lock', [{ acquired: true }]);
      }
    };
    if (mode === 'unlock-false') x.f.set('advisory_unlock', [{ unlocked: false }]);
    expect(await main([...authorized, '--level-b', `--confirm-b=${LOCK_AUTHORIZATION}`], x.deps)).toBe(2);
    expect(tries).toBe(2); expect(x.stdout.mock.calls[0][0]).toContain('"status":"failed"');
    expect(x.f.calls.some(c => c.sql === lookup('advisory_unlock').sql)).toBe(mode === 'unlock-false');
    expect(x.f.instances.every(c => c.ended || c.destroyed)).toBe(true);
  });
  it('esquema sin comentario no invalida el runner ni dispara inspección efectiva', async () => {
    const x = fixture(); x.f.set('schemas', [{ name: 'ordinary_user_schema', owner: 'someone', comment: null }]);
    expect(await main(authorized, x.deps)).toBe(0);
    expect(x.f.calls.filter(c => c.sql === lookup('effective').sql).map(c => c.params[0])).toEqual(['uow_0000000000_probe0_0']);
  });
  it.each(['null', 'inconsistent'])('roles no evaluables %s cortan antes de las ACL', async mode => {
    const x = fixture();
    x.f.set('role_membership', mode === 'null' ? null : [{ oid: 10, membership: true, set_membership: false }]);
    expect(await main(authorized, x.deps)).toBe(2);
    expect(x.stdout.mock.calls[0][0]).toContain('"status":"failed"');
    expect(x.f.calls.some(c => c.sql === lookup('default_acl_global').sql)).toBe(false);
  });
  it.each([0, 2])('roundtrip con %i filas se rechaza', async length => {
    const x = fixture();
    const row = { key: L0_KEY, reconstructed: L0_KEY, classid: (BigInt(L0_KEY) >> 32n).toString(), objid: (BigInt(L0_KEY) & 4294967295n).toString() };
    x.f.set('key_roundtrip', Array.from({ length }, () => ({ ...row })));
    expect(await main(authorized, x.deps)).toBe(2);
    expect(x.stdout.mock.calls[0][0]).toContain('"status":"failed"');
    expect(x.f.calls.some(c => c.sql === lookup('timeout_probe').sql)).toBe(false);
  });
  it.each([{ usename: 'agenda_test_app' }, { pid: 999 }, { objsubid: 2 }, { database: 99 }])('B con observación L0 incorrecta %# corta antes del contendiente', async override => {
    const x = fixture(true); x.f.set('advisory_holders', [{ ...holder(), ...override }]);
    expect(await main([...authorized, '--level-b', `--confirm-b=${LOCK_AUTHORIZATION}`], x.deps)).toBe(2);
    expect(x.stdout.mock.calls[0][0]).toContain('"status":"failed"');
    expect(x.f.calls.filter(c => c.sql === lookup('advisory_try_lock').sql)).toHaveLength(1);
    expect(x.f.calls.some(c => c.sql === lookup('advisory_unlock').sql)).toBe(false);
    expect(x.f.instances.every(c => c.ended || c.destroyed)).toBe(true);
  });
  it.each([[], ['--level-b'], [`--confirm-b=${LOCK_AUTHORIZATION}`]].map(flags => ({ flags })))('sin ambos flags B, incluso con conector B habilitado, no hay consultas B %#', async ({ flags }) => {
    const x = fixture(true);
    expect(await main([...authorized, ...flags], x.deps)).toBe(flags.length === 0 ? 0 : 2);
    const sqlB = CATALOG.filter(q => q.level === 'B').map(q => q.sql);
    expect(x.f.calls.some(c => sqlB.includes(c.sql))).toBe(false);
    if (flags.length) { expect(x.f.instances).toHaveLength(0); expect(x.readEnvFiles).not.toHaveBeenCalled(); }
  });

});

const summaryOf = (x: ReturnType<typeof fixture>) => JSON.parse(x.stdout.mock.calls[0][0].slice('AGENDA_C8_VALIDATE '.length));
describe('C8.2-B preparación solo con fakes', () => {
  it('defaultProviders devuelve thunks sin fs, pg ni invocaciones', async () => {
    await withDefaultMocks(async x => {
      const providers = x.runner.defaultProviders();
      expect(Object.keys(providers)).toEqual(['connector', 'readEnvFiles']);
      expect(typeof providers.connector).toBe('function'); expect(typeof providers.readEnvFiles).toBe('function');
      expect(Object.isFrozen(providers)).toBe(true);
      expect(x.envReader).not.toHaveBeenCalled(); expect(x.connectorFactory).not.toHaveBeenCalled();
      expect(x.fake.events).toEqual([]);
    });
  });
  it('tercer literal solo en rechazo, jamás invoca proveedores', async () => {
    const x = fixture();
    expect(await main(['--confirm-real=C8_2B_FIRST_REAL_RUN'], x.deps)).toBe(2);
    expect(x.readEnvFiles).not.toHaveBeenCalled(); expect(x.f.instances).toHaveLength(0);
  });
  it('ningún proceso se lanza con confirmación; guardia estática de llamadas y literal real', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    const ast = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true);
    const realFlag = '--confirm-real=' + ['C8', '2B', 'FIRST', 'REAL', 'RUN'].join('_');
    let launches = 0; let literals = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['spawnSync', 'spawn', 'exec', 'execFile', 'execSync', 'execFileSync'].includes(node.expression.text)) {
        launches++; expect(node.expression.text).toBe('spawnSync');
        expect(node.arguments[1].getText(ast)).toContain('...argv');
        expect(node.arguments[1].getText(ast)).not.toContain('confirm');
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isExpressionStatement(parent)) parent = parent.parent;
        expect(parent?.getText(ast)).toContain("it.each([[], ['--real']]");
      }
      if (ts.isStringLiteralLike(node) && node.text === realFlag) {
        literals++; expect(node.parent.getText(ast)).toBe(`[${JSON.stringify(realFlag).replaceAll('"', "'")}]`);
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isExpressionStatement(parent)) parent = parent.parent;
        expect(parent?.getText(ast)).toContain('.toBe(2)');
      }
      ts.forEachChild(node, visit);
    };
    visit(ast); expect(launches).toBe(1); expect(literals).toBe(1);
  });
  it('inventario no fija pid Colima ni puertos del túnel', () => {
    const files = ['scripts/harness/c8-pg-queries.cjs', 'scripts/harness/c8-pg-adapter.cjs', 'scripts/harness/c8-pg-connect.cjs',
      'scripts/c8-validate-readonly.cjs', 'test/harness/c8-pg-queries.spec.ts', 'test/harness/c8-pg-adapter.spec.ts',
      'test/harness/c8-pg-connect.spec.ts', 'test/harness/c8-validate-runner.spec.ts', 'test/harness/support/c8-pg-fakes.ts'];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
      for (const value of [[29, 71], [493, 40], [493, 45]].map(parts => parts.join(''))) expect(source).not.toContain(value);
    }
  });
  it('secuencia exacta A con un esquema reconocido, máximo dos clientes', async () => {
    const x = fixture(); x.f.set('schemas', [schema()]);
    x.f.controls.before = async sql => {
      const call = x.f.calls.at(-1)!;
      if (sql === lookup('effective').sql) x.f.set('effective', call.params[0] === NAME ? effective() : []);
      if (sql === lookup('effective_coverage').sql) x.f.set('effective_coverage', call.params[0] === NAME ? coverage() : []);
      expect(x.f.instances.filter(c => !c.ended && !c.destroyed).length).toBeLessThanOrEqual(2);
    };
    expect(await main(authorized, x.deps)).toBe(0);
    expect(x.f.events).toEqual(['connect:owner', 'owner:identity', 'owner:server', 'owner:identity_evidence', 'owner:role_attrs', 'owner:numbackends',
      'connect:app', 'app:identity', 'app:server', 'app:role_attrs', 'owner:role_membership', 'owner:auth_members', 'owner:default_acl_global',
      'owner:schemas', 'owner:effective', 'owner:effective_coverage', 'owner:default_acl_schema', 'owner:effective', 'owner:effective_coverage',
      'owner:sessions', 'owner:key_roundtrip', 'app:timeout_probe', 'app:probe_42809']);
    expect(x.f.logicalCalls.filter(c => ['effective', 'effective_coverage'].includes(c.id)).slice(-2).map(c => c.params)).toEqual([
      ['uow_0000000000_probe0_0', 'agenda_test_app'], ['uow_0000000000_probe0_0']]);
    const s = summaryOf(x);
    expect(s.steps).toEqual(x.f.logicalCalls.map(c => ({ id: c.id, ok: true })));
    expect(s.counts).toEqual({ schemasTotal: 1, schemasRecognized: 1, sessionsOther: 0, numbackends: 1, maxConnections: 100, connectionsOpened: 2, connectionsClosed: 2 });
    expect(s.identity).toMatchObject({ major: 16, minor: 4, addrClass: 'private', uptimeSeconds: 3600, containerDeltaSeconds: null });
    expect(s.params).toEqual({ owner: { statement: '5s', lock: '2s', idleInTx: '15s' }, app: { statement: '5s', lock: '2s', idleInTx: '15s' } });
    expect(x.f.instances.every(c => c.ended && !c.destroyed)).toBe(true);
  });
  it.each([90, 91, 100, null, -1, 'bad'])('holgura %j antes de app', async numbackends => {
    const x = fixture(); x.f.set('numbackends', [{ numbackends }]);
    const good = numbackends === 90;
    expect(await main(authorized, x.deps)).toBe(good ? 0 : 2);
    expect(summaryOf(x).code).toBe(good ? 'ok' : 'capacity_low'); expect(x.f.instances).toHaveLength(good ? 2 : 1);
  });
  it.each([
    ['identity', { database: 'other' }], ['identity', { current_user: 'other' }], ['identity', { session_user: 'other' }],
    ['identity', { recovery: true }], ['identity', { read_only: 'off' }], ['server', { version: '170001' }],
    ['server', { statement_timeout: 'Error: SELECT ' + PASSWORD }], ['role_attrs', null],
  ])('obligatorio %# falla con salida 3 por cada rol', async (id, override) => {
    for (const role of ['owner', 'app'] as const) {
      const x = fixture();
      x.f.controls.before = async sql => {
        const call = x.f.calls.at(-1)!;
        if (sql !== lookup(id as string).sql || (role === 'owner' ? call.pid !== 100 : call.pid !== 101)) return;
        x.f.set(id as string, id === 'identity' ? [{ ...identity(role, call.pid), ...(override as object) }] :
          id === 'server' ? [{ ...server(), ...(override as object) }] : roleAttrs().map(r => ({ ...r, rolsuper: true })));
      };
      expect(await main(authorized, x.deps)).toBe(3); expect(summaryOf(x).code).toBe('identity_unknown');
      expect(x.f.instances.every(c => c.ended || c.destroyed)).toBe(true);
    }
  });
  it.each([
    [{ version_text: 'PostgreSQL 17.1 on fake' }, 'identity_contradicted'],
    [{ server_addr: '8.8.8.8' }, 'identity_contradicted'], [{ server_addr: 'Error: SELECT ' + PASSWORD }, 'identity_contradicted'],
    [{ postmaster_epoch: String(NOW / 1000 + 1) }, 'identity_contradicted'],
    [{ postmaster_epoch: null }, 'identity_unknown'], [{ version_text: null }, 'identity_unknown'],
    [{ server_addr: undefined }, 'identity_unknown'],
  ])('evidencia %# desconocida o contradictoria', async (override, code) => {
    const x = fixture(); x.f.set('identity_evidence', [{ ...identityEvidence(), ...(override as object) }]);
    expect(await main(authorized, x.deps)).toBe(3); expect(summaryOf(x).code).toBe(code);
    expect(x.f.instances).toHaveLength(1); expect(x.stdout.mock.calls[0][0]).not.toContain(PASSWORD);
  });
  it.each([undefined, -10000, 0, 5, 5.001])('delta %s solo contradice cuando antecede al contenedor más de 5s', async offset => {
    const x = fixture(); const start = Number(identityEvidence().postmaster_epoch);
    const containerStartEpoch = offset === undefined ? undefined : start + offset;
    expect(await main(authorized, { ...x.deps, containerStartEpoch })).toBe(offset !== undefined && offset > 5 ? 3 : 0);
    if (offset === undefined) expect(summaryOf(x).identity.containerDeltaSeconds).toBeNull();
    else expect(summaryOf(x).identity.containerDeltaSeconds).toBeCloseTo(-offset, 5);
  });
  it.each(['2026-11-01T12:00:00Z', '2026-11-01T12:00:00.000Z'])('UTC estricto válido %s con fakes', async date => {
    const x = fixture(); expect(await main([...authorized, `--container-start=${date}`], x.deps)).toBe(0);
  });
  it.each(['2026-02-30T12:00:00Z', '2026-11-01T12:00:00+00:00', '2026-11-01', '2026-11-01T12:00:00.1Z', '2026-11-01T12:00:00Z\n'])('UTC inválido %s no lee env', async date => {
    const x = fixture(); expect(await main([...authorized, `--container-start=${date}`], x.deps)).toBe(2);
    expect(x.readEnvFiles).not.toHaveBeenCalled();
  });
  it('argumentos repetidos por clave, aunque distintos, se rechazan', async () => {
    const x = fixture();
    expect(await main([...authorized, '--container-start=2026-11-01T12:00:00Z', '--container-start=2026-11-01T12:00:01Z'], x.deps)).toBe(2);
    expect(x.readEnvFiles).not.toHaveBeenCalled();
  });
  it.each(['effective', 'effective_coverage'])('sonda inexistente %s exige exactamente cero filas', async id => {
    for (const rows of [null, [{}], [{ sql: 'SELECT ' + PASSWORD }]]) {
      const x = fixture(); x.f.set(id, rows); expect(await main(authorized, x.deps)).toBe(2);
      expect(summaryOf(x).code).toBe('probe_failed'); expect(x.f.events).not.toContain('owner:sessions');
    }
    const x = fixture(); x.f.fail(id, '42809'); expect(await main(authorized, x.deps)).toBe(2); expect(summaryOf(x).code).toBe('query_failed');
  });
  it('sesión ajena y aplicación desconocida fallan cerrado', async () => {
    for (const application_name of ['other', null]) {
      const x = fixture(); x.f.set('sessions', [{ pid: 200, usename: 'agenda_test_app', datname: 'agenda_test', backend_type: 'client backend', application_name }]);
      expect(await main(authorized, x.deps)).toBe(2); expect(summaryOf(x).code).toBe(application_name === null ? 'sessions_unknown' : 'sessions_other');
    }
  });
  it('owner excede 30 consultas al enumerar esquemas; no hay reintento', async () => {
    const x = fixture(); x.f.set('schemas', Array.from({ length: 8 }, (_, i) => ({ ...schema(), name: `uow_2611011200_abc123_${i}` })));
    x.f.set('effective', effective()); x.f.set('effective_coverage', coverage());
    expect(await main(authorized, x.deps)).toBe(2); expect(summaryOf(x).code).toBe('budget_exceeded');
    expect(x.f.logicalCalls.filter(c => c.role === 'owner')).toHaveLength(30);
    expect(x.f.instances).toHaveLength(2); expect(x.f.instances.every(c => c.ended)).toBe(true);
  });
  it.each(Object.entries(EXIT_CODES))('tabla de salida %s = %i', (code, exitCode) => {
    expect(sanitizeSummary({ code })).toMatchObject({ code, exitCode, level: 'A', status: exitCode === 0 ? 'ok' : code === 'stage_not_authorized' ? 'disabled' : 'failed' });
  });
  it.each(['connect', 'query', 'env', 'target'])('fallo %s sin mensajes ni secretos', async point => {
    const x = fixture();
    if (point === 'connect') x.f.controls.connectError = new Error('Error: SELECT ' + PASSWORD);
    if (point === 'query') x.f.fail('server', '42501');
    if (point === 'env') x.readEnvFiles.mockRejectedValueOnce(new Error('Error: SELECT ' + PASSWORD));
    if (point === 'target') x.readEnvFiles.mockResolvedValueOnce({ owner: { ...credentials('owner'), port: 5432 }, app: credentials('app') });
    expect(await main(authorized, x.deps)).toBe(2);
    expect(summaryOf(x).code).toBe(({ connect: 'connect_failed', query: 'query_failed', env: 'environment_invalid', target: 'target_invalid' })[point]);
    for (const value of [PASSWORD, 'Error:', 'SELECT']) expect(x.stdout.mock.calls[0][0]).not.toContain(value);
  });
  it('proyección cerrada descarta valores hostiles, getters y claves arbitrarias', () => {
    const hostile = 'Error: SELECT ' + PASSWORD;
    const value = sanitizeSummary({ status: hostile, code: hostile, exitCode: 0, level: 'B', checks: hostile,
      password: PASSWORD, sql: hostile, steps: [{ id: hostile, ok: true }, { id: 'identity', ok: hostile }, { id: 'server', ok: true, sql: hostile }],
      identity: { major: 16, minor: 4, addrClass: hostile }, params: { owner: { statement: hostile, lock: '1s', idleInTx: '1s' }, unknown: hostile },
      counts: { schemasTotal: 2, sessionsOther: hostile, pid: 123, password: PASSWORD } });
    expect(value).toEqual({ status: 'failed', code: 'validation_failed', exitCode: 2, level: 'A', checks: 0,
      steps: [{ id: 'server', ok: true }], params: {}, counts: { schemasTotal: 2 } });
    const get = jest.fn(() => hostile);
    expect(sanitizeSummary(Object.defineProperty({}, 'code', { get }))).toMatchObject({ code: 'validation_failed' }); expect(get).not.toHaveBeenCalled();
    for (const forbidden of [PASSWORD, 'Error:', 'SELECT', 'password', 'pid', 'sql', 'unknown']) expect(JSON.stringify(value)).not.toContain(forbidden);
  });
  it('filas hostiles con claves adicionales no escapan', async () => {
    const x = fixture(); x.f.set('identity_evidence', [{ ...identityEvidence(), password: PASSWORD, message: 'Error: SELECT ' + PASSWORD }]);
    x.f.set('schemas', [{ name: PASSWORD, owner: 'Error: SELECT', comment: null }]);
    expect(await main(authorized, x.deps)).toBe(0);
    for (const forbidden of [PASSWORD, 'Error:', 'SELECT', 'password', 'message']) expect(x.stdout.mock.calls[0][0]).not.toContain(forbidden);
  });
});

it.each(['read', 'connect', 'query', 'close'])('deadline interrumpe promesa pendiente de %s con fakes', async point => {
  jest.useFakeTimers();
  const x = fixture();
  try {
    const pending = () => new Promise<never>(() => undefined);
    const client = { pid: 100, query: pending, end: jest.fn(async () => undefined) };
    const connector = { connect: jest.fn(async () => client) };
    if (point === 'read') x.readEnvFiles.mockImplementationOnce(pending);
    if (point === 'connect') connector.connect.mockImplementationOnce(pending);
    if (point === 'close') {
      client.query = jest.fn(async () => { throw null; });
      client.end.mockImplementationOnce(pending);
    }
    const run = main(authorized, { ...x.deps, connector, now: Date.now });
    await jest.advanceTimersByTimeAsync(30002);
    expect(await run).toBe(2); expect(summaryOf(x).code).toBe('time_exceeded');
    expect(x.stdout).toHaveBeenCalledTimes(1);
    if (['query', 'close'].includes(point)) expect(client.end).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

// This fake implements only the logical read interface. In particular it has NO
// connector-level budgets or PID checks that could mask a missing runner guard.
function logicalFake(schemaCount = 0) {
  const events: string[] = [];
  const overrides = new Map<string, unknown>();
  const clients: { role: 'owner' | 'app'; pid: number; query: jest.Mock<Promise<unknown>, [string, unknown[]?]>; end: jest.Mock<Promise<void>, []> }[] = [];
  const connect = jest.fn(async (role: 'owner' | 'app', _credentials: unknown) => {
    void _credentials; events.push(`connect:${role}`);
    const pid = role === 'owner' ? 100 : 101;
    const query = jest.fn(async (id: string, params: unknown[] = []): Promise<unknown> => {
      events.push(`${role}:${id}`);
      if (overrides.has(`${role}:${id}`)) return overrides.get(`${role}:${id}`);
      switch (id) {
        case 'identity': return [identity(role, pid)];
        case 'server': return [server()];
        case 'identity_evidence': return [identityEvidence()];
        case 'role_attrs': return roleAttrs();
        case 'numbackends': return [{ numbackends: 1 }];
        case 'role_membership': return [{ oid: 10, membership: false, set_membership: false }];
        case 'schemas': return Array.from({ length: schemaCount }, (_, i) => schema({ name: `uow_2611011200_abc123_${i}` }));
        case 'effective': return params[0] === 'uow_0000000000_probe0_0' ? [] : effective();
        case 'effective_coverage': return params[0] === 'uow_0000000000_probe0_0' ? [] : coverage();
        case 'auth_members': case 'default_acl_global': case 'default_acl_schema': case 'sessions': case 'timeout_probe': return [];
        case 'key_roundtrip': return [{ key: L0_KEY, reconstructed: L0_KEY, classid: (BigInt(L0_KEY) >> 32n).toString(), objid: (BigInt(L0_KEY) & 4294967295n).toString() }];
        case 'probe_42809': return Object.freeze({ expectedSqlstate: '42809' });
        default: throw new Error('unexpected_fake_query');
      }
    });
    const end = jest.fn(async () => { events.push(`end:${role}`); });
    const client = { role, pid, query, end }; clients.push(client); return client;
  });
  return { connector: { connect }, clients, events, overrides };
}

function defaultMockContext() {
  const fake = logicalFake(); const stdout = jest.fn();
  const appSecret = 'SYNTHETIC_APP_C8_CORRECTIVE_!';
  const ownerSecret = 'SYNTHETIC_OWNER_C8_CORRECTIVE_!';
  const app = { host: '127.0.0.1', port: 5433, database: 'agenda_test', user: 'agenda_test_app', poolMax: 7 };
  const owner = { ...app, user: 'agenda_test_owner', poolMax: 3 };
  const envReader = jest.fn((_deps: unknown) => {
    void _deps; fake.events.push('readEnvFiles'); return { app, owner, secrets: [appSecret, ownerSecret] };
  });
  const connectorFactory = jest.fn(() => { fake.events.push('createConnector'); return fake.connector; });
  const credentialsForRoles = {
    owner: { host: owner.host, port: owner.port, database: owner.database, user: owner.user, password: ownerSecret, major: 16 },
    app: { host: app.host, port: app.port, database: app.database, user: app.user, password: appSecret, major: 16 },
  };
  return { fake, stdout, appSecret, ownerSecret, envReader, connectorFactory, credentialsForRoles };
}

// Absolute module mocks are installed BEFORE importing a fresh runner and remain
// installed through its final await. No condition inside main is a safety barrier
// for these tests: even a removed confirmation guard can reach only these fakes.
async function withDefaultMocks(run: (x: ReturnType<typeof defaultMockContext> & { runner: typeof import('../../scripts/c8-validate-readonly.cjs') }) => Promise<void>) {
  const x = defaultMockContext();
  const envPath = path.resolve(__dirname, '../../scripts/harness/env-files.cjs');
  const connectPath = path.resolve(__dirname, '../../scripts/harness/c8-pg-connect.cjs');
  await jest.isolateModulesAsync(async () => {
    jest.doMock(envPath, () => ({ readEnvFiles: x.envReader }));
    jest.doMock(connectPath, () => ({ createConnector: x.connectorFactory }));
    try {
      const runner = await import('../../scripts/c8-validate-readonly.cjs');
      await run({ ...x, runner });
    } finally {
      jest.dontMock(envPath); jest.dontMock(connectPath);
    }
  });
}

const summaryLine = (stdout: jest.Mock) => {
  expect(stdout).toHaveBeenCalledTimes(1);
  return JSON.parse(String(stdout.mock.calls[0][0]).slice('AGENDA_C8_VALIDATE '.length));
};
const confirmedDefaults = [...authorized, `--confirm-real=${REAL_AUTHORIZATION}`];

describe('C8 corrección: proveedores inaccesibles salvo mocks aislados', () => {
  it('confirmación real habilita exclusivamente los proveedores mockeados en orden', async () => {
    await withDefaultMocks(async x => {
      expect(await x.runner.main(confirmedDefaults, { stdout: x.stdout, now: () => NOW })).toBe(0);
      expect(x.connectorFactory).toHaveBeenCalledTimes(1); expect(x.connectorFactory).toHaveBeenCalledWith();
      expect(x.envReader).toHaveBeenCalledTimes(1);
      expect(x.fake.events.slice(0, 3)).toEqual(['createConnector', 'readEnvFiles', 'connect:owner']);
      expect(x.fake.connector.connect.mock.calls).toEqual([
        ['owner', { ...x.credentialsForRoles.owner, level: 'A' }], ['app', { ...x.credentialsForRoles.app, level: 'A' }],
      ]);
      expect(summaryLine(x.stdout)).toMatchObject({ status: 'ok', code: 'ok', exitCode: 0 });
      expect(x.fake.clients).toHaveLength(2); for (const c of x.fake.clients) expect(c.end).toHaveBeenCalledTimes(1);
      expect(x.stdout.mock.calls[0][0]).not.toContain(x.appSecret); expect(x.stdout.mock.calls[0][0]).not.toContain(x.ownerSecret);
    });
  });
  it('Nivel B con todos los literales y defaults se rechaza antes de ambos proveedores', async () => {
    await withDefaultMocks(async x => {
      expect(await x.runner.main([...confirmedDefaults, '--level-b', `--confirm-b=${LOCK_AUTHORIZATION}`], { stdout: x.stdout })).toBe(2);
      expect(summaryLine(x.stdout)).toMatchObject({ status: 'disabled', code: 'stage_not_authorized', exitCode: 2 });
      expect(x.envReader).not.toHaveBeenCalled(); expect(x.connectorFactory).not.toHaveBeenCalled(); expect(x.fake.events).toEqual([]);
    });
  });
  it.each(['connector', 'readEnvFiles'] as const)('inyección parcial de %s exige confirmación real', async kind => {
    await withDefaultMocks(async x => {
      const injected = logicalFake(); const reader = jest.fn(async () => x.credentialsForRoles);
      const deps = { stdout: x.stdout, now: () => NOW, ...(kind === 'connector' ? { connector: injected.connector } : { readEnvFiles: reader }) };
      expect(await x.runner.main(authorized, deps)).toBe(2);
      expect(summaryLine(x.stdout)).toMatchObject({ status: 'disabled', code: 'stage_not_authorized', exitCode: 2 });
      expect(x.envReader).not.toHaveBeenCalled(); expect(x.connectorFactory).not.toHaveBeenCalled();
      expect(injected.connector.connect).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
    });
  });
  it.each(['connector', 'readEnvFiles'] as const)('inyección parcial confirmada de %s utiliza solo el default que falta', async kind => {
    await withDefaultMocks(async x => {
      const injected = logicalFake(); const reader = jest.fn(async () => x.credentialsForRoles);
      const deps = { stdout: x.stdout, now: () => NOW, ...(kind === 'connector' ? { connector: injected.connector } : { readEnvFiles: reader }) };
      expect(await x.runner.main(confirmedDefaults, deps)).toBe(0);
      expect(x.envReader).toHaveBeenCalledTimes(kind === 'connector' ? 1 : 0);
      expect(x.connectorFactory).toHaveBeenCalledTimes(kind === 'readEnvFiles' ? 1 : 0);
      expect(reader).toHaveBeenCalledTimes(kind === 'readEnvFiles' ? 1 : 0);
      expect(injected.connector.connect).toHaveBeenCalledTimes(kind === 'connector' ? 2 : 0);
      expect(x.fake.connector.connect).toHaveBeenCalledTimes(kind === 'readEnvFiles' ? 2 : 0);
      const used = kind === 'connector' ? injected : x.fake;
      expect(used.connector.connect.mock.calls).toEqual([
        ['owner', { ...x.credentialsForRoles.owner, level: 'A' }], ['app', { ...x.credentialsForRoles.app, level: 'A' }],
      ]);
      expect(summaryLine(x.stdout)).toMatchObject({ status: 'ok', code: 'ok', exitCode: 0 });
      for (const secret of [x.appSecret, x.ownerSecret]) expect(x.stdout.mock.calls[0][0]).not.toContain(secret);
    });
  });
  it('thunk adapta roles, secretos distintos, major y raíz backend sin IO', async () => {
    await withDefaultMocks(async x => {
      const providers = x.runner.defaultProviders();
      expect(x.envReader).not.toHaveBeenCalled(); expect(x.connectorFactory).not.toHaveBeenCalled();
      const result = await providers.readEnvFiles();
      expect(result).toEqual(x.credentialsForRoles);
      expect(result.owner.password).not.toBe(result.app.password);
      expect(x.envReader).toHaveBeenCalledTimes(1); expect(x.connectorFactory).not.toHaveBeenCalled();
      const args = x.envReader.mock.calls[0][0] as { root: string; fs: typeof fs; getuid: () => number };
      expect(Object.keys(args).sort()).toEqual(['fs', 'getuid', 'root']);
      expect(args.root).toBe(path.resolve(__dirname, '../..'));
      expect(args.fs.openSync).toBe(fs.openSync); expect(args.fs.readSync).toBe(fs.readSync);
      expect(args.fs.fstatSync).toBe(fs.fstatSync); expect(args.fs.closeSync).toBe(fs.closeSync);
      expect(typeof args.getuid).toBe('function'); expect(args.getuid).toBe(process.getuid);
      // Function identities only: neither filesystem functions nor getuid run.
    });
  });
});

describe('C8 corrección: guardas del runner sin protecciones duplicadas del conector', () => {
  it.each([0, -1, 1])('container-start y deps deben coincidir exactamente: delta %i', async delta => {
    const x = fixture(); const iso = '2026-11-01T12:00:00Z';
    expect(await main([...authorized, `--container-start=${iso}`], { ...x.deps, containerStartEpoch: Date.parse(iso) / 1000 + delta })).toBe(delta === 0 ? 0 : 2);
    expect(summaryOf(x)).toMatchObject(delta === 0 ? { status: 'ok', code: 'ok', exitCode: 0 } : { status: 'disabled', code: 'stage_not_authorized', exitCode: 2 });
    expect(x.readEnvFiles).toHaveBeenCalledTimes(delta === 0 ? 1 : 0);
    if (delta !== 0) expect(x.f.instances).toHaveLength(0);
  });
  it.each([undefined, {}, null])('timeout_probe no array %# es probe_failed', async result => {
    const x = logicalFake(); x.overrides.set('app:timeout_probe', result); const stdout = jest.fn();
    expect(await main(authorized, { connector: x.connector, readEnvFiles: async () => ({ owner: credentials('owner'), app: credentials('app') }), stdout, now: () => NOW })).toBe(2);
    expect(summaryLine(stdout)).toMatchObject({ status: 'failed', code: 'probe_failed', exitCode: 2 });
    expect(x.events).toContain('app:timeout_probe'); expect(x.events).not.toContain('app:probe_42809');
    for (const c of x.clients) expect(c.end).toHaveBeenCalledTimes(1);
  });
  it.each([5, 6])('presupuesto owner independiente: %i esquemas, consulta 30 permitida y 31 vetada', async count => {
    const x = logicalFake(count); const stdout = jest.fn();
    expect(await main(authorized, { connector: x.connector, readEnvFiles: async () => ({ owner: credentials('owner'), app: credentials('app') }), stdout, now: () => NOW })).toBe(count === 5 ? 0 : 2);
    const result = summaryLine(stdout);
    expect(result).toMatchObject({ code: count === 5 ? 'ok' : 'budget_exceeded', exitCode: count === 5 ? 0 : 2 });
    const owner = x.clients.find(c => c.role === 'owner')!;
    expect(owner.query).toHaveBeenCalledTimes(count === 5 ? 28 : 30);
    if (count === 6) {
      expect(owner.query.mock.calls[29]).toEqual(['sessions', []]);
      expect(result.steps.at(-1)).toEqual({ id: 'sessions', ok: true });
      expect(owner.query.mock.calls.some(([id]) => id === 'key_roundtrip')).toBe(false);
    }
    for (const c of x.clients) expect(c.end).toHaveBeenCalledTimes(1);
  });
  it('mutación #23: el runner limita owner a 30 aunque el fake acepte 31 consultas', async () => {
    for (const schemaCount of [5, 6]) {
      // logicalFake has no query budget; its rows reuse c8-pg-fakes fixtures.
      // The positive control and exact trace prevent another guard masking #23.
      const x = logicalFake(schemaCount); const stdout = jest.fn();
      const readEnvFiles = jest.fn(async () => ({ owner: credentials('owner'), app: credentials('app') }));
      const exitCode = await main(authorized, { connector: x.connector, readEnvFiles, stdout, now: () => NOW });
      const completeOwnerTrace = ['identity', 'server', 'identity_evidence', 'role_attrs', 'numbackends',
        'role_membership', 'auth_members', 'default_acl_global', 'schemas',
        ...Array.from({ length: schemaCount }, () => ['effective', 'effective_coverage', 'default_acl_schema']).flat(),
        'effective', 'effective_coverage', 'sessions', 'key_roundtrip'];
      expect(completeOwnerTrace).toHaveLength(13 + 3 * schemaCount);
      const receivedOwnerTrace = x.clients.find(c => c.role === 'owner')!.query.mock.calls.map(([id]) => id);
      expect(receivedOwnerTrace).toEqual(completeOwnerTrace.slice(0, 30));
      expect(x.events.filter(event => event.startsWith('owner:'))).toEqual(receivedOwnerTrace.map(id => `owner:${id}`));
      expect(readEnvFiles).toHaveBeenCalledTimes(1);
      expect(x.connector.connect.mock.calls.map(([role]) => role)).toEqual(['owner', 'app']);
      const result = summaryLine(stdout);
      expect(result.counts).toMatchObject({ schemasRecognized: schemaCount, connectionsOpened: 2, connectionsClosed: 2 });
      if (schemaCount === 5) {
        expect(receivedOwnerTrace).toHaveLength(28); expect(exitCode).toBe(0);
        expect(result).toMatchObject({ status: 'ok', code: 'ok', exitCode: 0 });
      } else {
        expect(receivedOwnerTrace).toHaveLength(30); expect(receivedOwnerTrace[29]).toBe('sessions');
        expect(completeOwnerTrace[30]).toBe('key_roundtrip'); expect(receivedOwnerTrace).not.toContain('key_roundtrip');
        expect(exitCode).toBe(2); expect(result).toMatchObject({ status: 'failed', code: 'budget_exceeded', exitCode: 2 });
        expect(result.steps.at(-1)).toEqual({ id: 'sessions', ok: true });
      }
      for (const client of x.clients) expect(client.end).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['owner', 'app'] as const)('PID inconsistente de %s se detecta en runner sin conector real', async role => {
    const x = logicalFake(); x.overrides.set(`${role}:identity`, [identity(role, 999)]); const stdout = jest.fn();
    expect(await main(authorized, { connector: x.connector, readEnvFiles: async () => ({ owner: credentials('owner'), app: credentials('app') }), stdout, now: () => NOW })).toBe(3);
    expect(summaryLine(stdout)).toMatchObject({ status: 'failed', code: 'identity_unknown', exitCode: 3 });
    expect(x.clients.find(c => c.role === role)?.pid).not.toBe(999);
    expect(x.events).not.toContain(`${role}:server`);
    for (const c of x.clients) expect(c.end).toHaveBeenCalledTimes(1);
  });
});

function validSummaryInput(): Record<string, unknown> {
  return { code: 'ok', checks: 2, steps: [{ id: 'identity', ok: true }],
    identity: { major: 16, minor: 4, addrClass: 'private', postmasterStartUtc: '2026-11-01T12:00:00.000Z', uptimeSeconds: 3600, containerDeltaSeconds: null },
    params: { owner: { statement: '10s', lock: '2s', idleInTx: '15s' }, app: { statement: '5s', lock: '2s', idleInTx: '15s' } },
    counts: { numbackends: 1, maxConnections: 100 } };
}
const summaryLocations = ['input', 'steps', 'step', 'identity', 'params', 'ownerParams', 'counts'] as const;
type SummaryLocation = typeof summaryLocations[number];
function replaceSummaryPart(input: Record<string, unknown>, location: SummaryLocation, replace: (value: object) => object): unknown {
  if (location === 'input') return replace(input);
  if (location === 'step') {
    const steps = input.steps as object[]; steps[0] = replace(steps[0]);
  } else if (location === 'ownerParams') {
    const params = input.params as Record<string, object>; params.owner = replace(params.owner);
  } else input[location] = replace(input[location] as object);
  return input;
}
function expectSummaryPartDiscarded(result: Record<string, unknown>, location: SummaryLocation) {
  if (location === 'input') expect(result).toMatchObject({ code: 'validation_failed', exitCode: 2, steps: [], params: {}, counts: {} });
  else if (location === 'steps' || location === 'step') expect(result.steps).toEqual([]);
  else if (location === 'identity') expect(result).not.toHaveProperty('identity');
  else if (location === 'params') expect(result.params).toEqual({});
  else if (location === 'ownerParams') expect(result.params).toEqual({ app: { statement: '5s', lock: '2s', idleInTx: '15s' } });
  else expect(result.counts).toEqual({});
}

describe('C8 corrección: sanitización sin evaluación de código externo', () => {
  it.each(['weird', 123, {}, null, undefined])('addrClass inválido %# descarta identidad aunque los demás campos sean válidos', addrClass => {
    const input = validSummaryInput();
    expect(sanitizeSummary(input)).toHaveProperty('identity');
    (input.identity as Record<string, unknown>).addrClass = addrClass;
    expect(sanitizeSummary(input)).not.toHaveProperty('identity');
  });
  it.each(summaryLocations)('accessor extra en %s descarta todo ese campo sin invocarlo', location => {
    const accessor = jest.fn(() => { throw new Error(PASSWORD); });
    const input = replaceSummaryPart(validSummaryInput(), location, value => Object.defineProperty(value, 'extra', { get: accessor, enumerable: true }));
    const result = sanitizeSummary(input);
    expect(accessor).not.toHaveBeenCalled(); expectSummaryPartDiscarded(result, location);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });
  it.each(summaryLocations)('proxy en %s no ejecuta ni get ni trampas de reflexión', location => {
    const trap = jest.fn(() => { throw new Error(PASSWORD); });
    const input = replaceSummaryPart(validSummaryInput(), location, value => new Proxy(value, {
      get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap,
    }));
    const result = sanitizeSummary(input);
    expect(trap).not.toHaveBeenCalled(); expectSummaryPartDiscarded(result, location);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });
  it.each(summaryLocations)('proxy revocado en %s falla cerrado', location => {
    const input = replaceSummaryPart(validSummaryInput(), location, value => {
      const { proxy, revoke } = Proxy.revocable(value, {}); revoke(); return proxy;
    });
    expectSummaryPartDiscarded(sanitizeSummary(input), location);
  });
  it.each(['0', 'flatMap', Symbol.iterator])('steps con accessor %s no ejecuta getters', key => {
    const input = validSummaryInput(); const get = jest.fn(() => { throw new Error(PASSWORD); });
    Object.defineProperty(input.steps, key, { get, configurable: true });
    const result = sanitizeSummary(input);
    expect(get).not.toHaveBeenCalled(); expect(result.steps).toEqual([]);
  });
  it('steps heredados no se evalúan y elementos normales conservan solo id/ok', () => {
    const get = jest.fn(() => { throw new Error(PASSWORD); });
    const inherited = Object.create(Array.prototype);
    Object.defineProperty(inherited, '0', { get });
    const steps = new Array(1); Object.setPrototypeOf(steps, inherited);
    expect(sanitizeSummary({ code: 'ok', steps }).steps).toEqual([]); expect(get).not.toHaveBeenCalled();
    expect(sanitizeSummary({ code: 'ok', steps: [{ id: 'identity', ok: true, password: PASSWORD }] }).steps).toEqual([{ id: 'identity', ok: true }]);
  });
});
