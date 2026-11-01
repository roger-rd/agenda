import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { main, AUTHORIZATION, LOCK_AUTHORIZATION } from '../../scripts/c8-validate-readonly.cjs';
import { createConnector, AUTHORIZATION as CONNECT_AUTH } from '../../scripts/harness/c8-pg-connect.cjs';
import { lookup, CATALOG } from '../../scripts/harness/c8-pg-queries.cjs';
import { pgFake, credentials, NOW, PASSWORD, effective, coverage, holder } from './support/c8-pg-fakes';
import { schema } from './support/c8-fakes';
import { L0_KEY } from '../../scripts/harness/c8-pg-adapter.cjs';
const authorized = ['--real', `--confirm=${AUTHORIZATION}`];
const disabled = 'AGENDA_C8_VALIDATE {"status":"disabled","code":"stage_not_authorized"}\n';
function fixture(b = false) {
  const f = pgFake(); const stdout = jest.fn(); const readEnvFiles = jest.fn(async () => ({ owner: credentials('owner'), app: credentials('app') }));
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
    expect(x.stdout.mock.calls[0][0]).toMatch(/^AGENDA_C8_VALIDATE \{"status":"ok","code":"ok","checks":\d+\}\n$/);
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
  it('CLI autorizado sin proveedores permanece cerrado (solo llamada inyectada)', async () => {
    const stdout = jest.fn(); expect(await main(authorized, { stdout })).toBe(2); expect(stdout).toHaveBeenCalledWith(disabled);
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
    const x = fixture(); x.f.nullRows(id); expect(await main(authorized, x.deps)).toBe(2);
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
    expect(summary).toEqual({ status: 'failed', code: kind === 'grantable' ? 'gate_unknown' : 'gate_residual', checks: expect.any(Number) });
    expect(Number.isSafeInteger(summary.checks)).toBe(true);
    expect(x.stdout.mock.calls[0][0]).not.toContain(PASSWORD);
    expect(x.stdout.mock.calls[0][0]).not.toContain(schema().name);
    const boundary = x.f.calls.findLastIndex(c => c.sql === lookup('default_acl_schema').sql);
    expect(boundary).toBeGreaterThan(-1);
    expect(x.f.calls.slice(boundary + 1).map(c => c.sql)).toEqual(['ROLLBACK']);
    const later = ['sessions', 'numbackends', 'key_roundtrip', 'timeout_probe', 'probe_42809', 'advisory_try_lock'];
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
    expect(x.f.calls.some(c => c.sql === lookup('effective').sql)).toBe(false);
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
