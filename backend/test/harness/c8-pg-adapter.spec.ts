import { mapIdentityEvidence, evaluateIdentityEvidence, mapIdentity, mapServer, mapRoleAttrs, mapSchemas, mapPrivileges, mapRoles, mapDefaultAclSchema,
  mapGlobalDefaultAcl, mapSessions, mapBaseline, mapNumbackends, mapRelationLocks, observeL0, classifyPgError,
  collectIdentity, collectPrivileges, collectL0, L0_KEY, EMPTY_FIELDS } from '../../scripts/harness/c8-pg-adapter.cjs';
import { evaluate, evaluateGlobalDefaultAcl, recognized } from '../../scripts/harness/c8-gate.cjs';
import { authorization } from '../../scripts/harness/c8-preflight.cjs';
import { decide } from '../../scripts/harness/c8-sweep-policy.cjs';
import { schema } from './support/c8-fakes';
import { NAME, NOW, identityEvidence, identity, server, roleAttrs, effective, coverage, empty, holder, seeded } from './support/c8-pg-fakes';
const roles = { evaluable: true, membership: false, setMembership: false };
describe('C8 mappers puros', () => {
  it('identidad, servidor PG16 y roles sin poderes', () => {
    expect(mapIdentity([identity('owner')], 'owner')?.pid).toBe(100);
    expect(mapIdentity([identity('app')], 'app')?.user).toBe('agenda_test_app');
    expect(mapServer([server()])?.major).toBe(16); expect(mapRoleAttrs(roleAttrs())?.appOid).toBe(11);
  });
  it.each([{ database: 'other' }, { current_user: 'agenda_test_app' }, { session_user: 'other' },
    { read_only: 'off' }, { recovery: true }, { recovery: null }, { pid: 1.5 }, { pid: null }])('identidad fail closed %#', override => {
    expect(mapIdentity([{ ...identity('owner'), ...override }], 'owner')).toBeNull();
  });
  it.each([null, [], [null], [identity('owner'), identity('owner')]].map(input => ({ input })))('estructura identidad %#', ({ input }) => {
    expect(mapIdentity(input, 'owner')).toBeNull();
  });
  it.each(['150001', '170001', '16', null, '160000\n'])('version exacta %#', version => {
    expect(mapServer([{ ...server(), version }])).toBeNull();
  });
  it.each(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'rolcanlogin', 'rolconnlimit'])('rol malformado/poderoso %s', key => {
    const r = roleAttrs(); expect(mapRoleAttrs(r.map(x => ({ ...x, [key]: null })))).toBeNull();
    if (key.startsWith('rol') && !['rolcanlogin', 'rolconnlimit', 'rolconfig'].includes(key)) expect(mapRoleAttrs(r.map(x => ({ ...x, [key]: true })))).toBeNull();
  });
  it('roles duplicados, ausentes y config inesperada no son evidencia', () => {
    const r = roleAttrs(); expect(mapRoleAttrs([r[0], r[0]])).toBeNull(); expect(mapRoleAttrs(r.slice(1))).toBeNull();
    expect(mapRoleAttrs(r.map(x => ({ ...x, rolconfig: ['search_path=other'] })))).toBeNull();
  });
  it.each([null, []].map(rolconfig => ({ rolconfig })))('rolconfig sin configuración %# es válida para ambos roles', ({ rolconfig }) => {
    expect(mapRoleAttrs(roleAttrs().map(r => ({ ...r, rolconfig })))?.evaluable).toBe(true);
  });
  it('app acepta todos los subconjuntos y órdenes de los tres valores exactos', () => {
    const allowed = ['statement_timeout=30s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s'];
    const permutations = (values: string[]): string[][] => values.length === 0 ? [[]] :
      values.flatMap((v, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [v, ...rest]));
    for (let mask = 0; mask < 8; mask++) for (const rolconfig of permutations(allowed.filter((_, i) => mask & (1 << i)))) {
      expect(mapRoleAttrs(roleAttrs().map(r => r.rolname === 'agenda_test_app' ? { ...r, rolconfig } : r))?.evaluable).toBe(true);
    }
  });
  it.each(['statement_timeout=30s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s'])('owner rechaza incluso el valor permitido de app: %s', entry => {
    expect(mapRoleAttrs(roleAttrs().map(r => r.rolname === 'agenda_test_owner' ? { ...r, rolconfig: [entry] } : r))).toBeNull();
  });
  it.each([true, 'statement_timeout=30s', {}, undefined, [null], [42], [true], [{}],
    ['statement_timeout=30s', 'statement_timeout=30s'], ['statement_timeout=0'], ['statement_timeout=30000'],
    ['statement_timeout=30S'], ['STATEMENT_TIMEOUT=30s'], ['statement_timeout =30s'], ['statement_timeout=30s '],
    ['statement_timeout=30s\n'], ['statement_timeout=30s', 'search_path=public'], ['role=agenda_test_owner'],
    ['session_replication_role=replica'], ['default_transaction_read_only=off'], ['lock_timeout=0'],
    ['idle_in_transaction_session_timeout=0']].map(rolconfig => ({ rolconfig })))('app rechaza tipo/valor/entrada/duplicado no autorizado %#', ({ rolconfig }) => {
    expect(mapRoleAttrs(roleAttrs().map(r => r.rolname === 'agenda_test_app' ? { ...r, rolconfig } : r))).toBeNull();
  });
  it('edad UTC, lease desconocido por defecto, vacío solo demostrado', () => {
    const raw = [{ name: NAME, owner: 'agenda_test_owner', comment: schema().comment }];
    const mapped = mapSchemas(raw, NOW)!;
    expect(mapped[0]).toEqual({ ...schema(), ageMs: 3600000, lease: 'unknown', leaseOwned: false, empty: false });
    expect(decide(mapped[0])).toBe('recovery_failed');
    const proven = mapSchemas(raw, NOW, { [NAME]: { lease: 'free', leaseOwned: true, emptyRows: empty() } })!;
    expect(proven[0]).toMatchObject({ empty: true, lease: 'free', leaseOwned: true }); expect(decide(proven[0])).toBe('drop');
    expect(mapSchemas(raw, NOW, { [NAME]: { emptyRows: [{}], leaseOwned: true } })![0]).toMatchObject({ empty: false, leaseOwned: false });
  });
  it.each(['uow_2602301200_abc123_1', 'uow_2611012460_abc123_1', 'uow_9911011200_abc123_1'])('edad imposible/futura %s', name => {
    const s = mapSchemas([{ name, owner: 'agenda_test_owner', comment: schema().comment }], NOW, { [name]: { lease: 'free' } })![0];
    expect(s.ageMs).toBeNaN(); expect(decide(s)).toBe('recovery_failed');
  });
  it('NULL, duplicados y campos ausentes de esquema son desconocidos', () => {
    expect(mapSchemas(null, NOW)).toBeNull(); expect(mapSchemas([{ name: NAME, owner: null, comment: null }], NOW)).toBeNull();
    expect(mapSchemas([schema(), schema()], NOW)).toBeNull();
  });
  it('cobertura exacta conserva todas las filas sin inventar residuo de columna', () => {
    const r = effective(); const p = mapPrivileges(r, coverage());
    expect(p.objects).toHaveLength(17); expect(p.complete).toBe(true); expect(p.evaluable).toBe(true);
    expect(p.objects.every(o => !o.column && !o.direct)).toBe(true);
    expect(evaluate([schema()], () => p, 'P6b', roles).ok).toBe(true);
    r.find(x => x.kind === 'column')!.effective = true;
    const residual = mapPrivileges(r, coverage());
    expect(residual.objects.filter(o => o.column)).toHaveLength(1);
    expect(evaluate([schema()], () => residual, 'P6b', roles).code).toBe('gate_residual');
  });
  it.each(['schema', 'table', 'column', 'sequence', 'routine'])('retirar/corromper/duplicar cualquier fila de %s invalida cobertura', kind => {
    const r = effective(); const i = r.findIndex(x => x.kind === kind);
    expect(mapPrivileges(r.filter((_, j) => j !== i), coverage()).complete).toBe(false);
    expect(mapPrivileges([...r, r[i]], coverage()).complete).toBe(false);
    expect(mapPrivileges(r.map((x, j) => j === i ? { ...x, privilege: 'UNKNOWN' } : x), coverage()).complete).toBe(false);
    for (const field of ['effective', 'is_grantable']) {
      const bad = mapPrivileges(r.map((x, j) => j === i ? { ...x, [field]: null } : x), coverage());
      expect(bad.evaluable).toBe(false); expect(bad.objects).toHaveLength(r.length);
    }
    r[i].is_grantable = true; expect(mapPrivileges(r, coverage()).grantable).toBe(true);
  });
  it.each([{ tables: '0' }, { tables: null }, { sequences: '2' }, { routines: '0' }, { schema_oid: 999 }])('conteos incompatibles %#', override => {
    expect(mapPrivileges(effective(), [{ ...coverage()[0], ...override }]).complete).toBe(false);
  });
  it('oid de columna diferente, cobertura NULL y filas NULL fallan', () => {
    expect(mapPrivileges(effective().map(x => x.kind === 'column' ? { ...x, oid: 99 } : x), coverage()).complete).toBe(false);
    expect(mapPrivileges(effective(), null).evaluable).toBe(false); expect(mapPrivileges(null, coverage()).evaluable).toBe(false);
    expect(mapPrivileges(effective(), coverage(), null).evaluable).toBe(false);
  });
  it('permutaciones y truncaciones con semilla fija', () => {
    const random = seeded();
    for (let i = 0; i < 100; i++) {
      const r = effective(); for (let j = r.length - 1; j > 0; j--) { const k = random() % (j + 1); [r[j], r[k]] = [r[k], r[j]]; }
      expect(mapPrivileges(r, coverage()).complete).toBe(true);
      r.splice(random() % r.length, 1); expect(mapPrivileges(r, coverage()).complete).toBe(false);
    }
  });
  it('MEMBER y SET usan cierres transitivos distintos y deben coincidir con ROLE_QUERY', () => {
    const edges = [{ roleid: 12, member: 11, inherit_option: false, set_option: true, admin_option: false },
      { roleid: 10, member: 12, inherit_option: true, set_option: false, admin_option: true }];
    const r = [{ oid: 12, membership: true, set_membership: true }, { oid: 10, membership: true, set_membership: false }];
    expect(mapRoles(r, edges, 11)).toEqual({ evaluable: true, membership: true, setMembership: true });
    expect(mapRoles(r.map(x => ({ ...x, set_membership: true })), edges, 11).evaluable).toBe(false);
    expect(mapRoles(r, edges.slice(1), 11).evaluable).toBe(false);
    expect(mapRoles([...r, r[0]], edges, 11).evaluable).toBe(false);
    expect(mapRoles(r, [...edges, edges[0]], 11).evaluable).toBe(false);
    expect(mapRoles(r, edges.map(e => ({ ...e, inherit_option: null })), 11).evaluable).toBe(false);
    expect(mapRoles(null, [], 11).evaluable).toBe(false);
    expect(mapRoles([{ oid: 10, membership: false, set_membership: false }], [], 11)).toEqual(roles);
  });
  it('ACL de esquema/global se mantienen independientes y NULL nunca significa vacío', () => {
    expect(mapDefaultAclSchema([])).toBe(false); expect(mapDefaultAclSchema([{ oid: 1 }])).toBe(true);
    expect(mapDefaultAclSchema(null)).toBeNull(); expect(mapDefaultAclSchema([{ oid: null }])).toBeNull();
    const g = mapGlobalDefaultAcl([{ owner_role: 'agenda_test_owner', object_type: 'r', grantee_public: true, grantee_app: false }]);
    expect(evaluateGlobalDefaultAcl(g).code).toBe('gate_default_acl');
    expect(mapGlobalDefaultAcl(null).evaluable).toBe(false);
    expect(mapGlobalDefaultAcl([{ owner_role: 'agenda_test_owner', object_type: 'r', grantee_public: null, grantee_app: false }]).evaluable).toBe(false);
  });
  it('sesiones enmascaradas: NULL usename invalida E4b, NULL application_name solo E4a', () => {
    const row = { pid: 3, usename: 'agenda_test_app', application_name: null, datname: 'agenda_test', backend_type: 'client backend' };
    expect(mapSessions([row])).toEqual({ otherRolePids: [3], runSessions: null });
    expect(mapSessions([{ ...row, usename: null }])).toEqual({ otherRolePids: null, runSessions: null });
    expect(mapSessions([{ ...row, application_name: 'agenda-c8-validate' }])).toEqual({ otherRolePids: [3], runSessions: 1 });
    expect(mapSessions([row], [3]).otherRolePids).toEqual([]);
    expect(mapSessions([row, row]).otherRolePids).toBeNull(); expect(mapSessions(null).otherRolePids).toBeNull();
    expect(mapBaseline([])).toEqual({ otherRolePids: [], runSessions: 0, foreignLease: null });
  });
  it.each([null, [], [{ numbackends: null }], [{ numbackends: -1 }], [{ numbackends: '1.5' }], [{ numbackends: 1 }, { numbackends: 1 }]].map(input => ({ input })))('numbackends fail closed %#', ({ input }) => {
    expect(mapNumbackends(input)).toBeNull();
  });
  it('counts y locks validan oid/base/esquema/identidad', () => {
    expect(mapNumbackends([{ numbackends: '12' }])).toBe(12);
    const r = { pid: 100, database: 42, relation: 21, granted: true, name: NAME };
    expect(mapRelationLocks([r], 42, [NAME])).toBe(true); expect(mapRelationLocks([r], 42, [NAME], [100])).toBe(false);
    for (const override of [{ database: 43 }, { name: 'public' }, { pid: null }, { granted: null }]) expect(mapRelationLocks([{ ...r, ...override }], 42, [NAME])).toBeNull();
    expect(mapRelationLocks(null, 42, [NAME])).toBeNull();
  });
  it.each([
    ['42809', 'probe-42809', 'expected'], ['42809', 'gate', 'unexpected'],
    ['42501', 'probe-42809', 'unexpected'], [undefined, 'probe-42809', 'unexpected'],
    ['', 'probe-42809', 'unexpected'], ['42809\n', 'probe-42809', 'unexpected'],
  ] as const)('SQLSTATE %s contexto %s', (code, expectation, kind) => {
    const result = classifyPgError(code === undefined ? undefined : { code, message: 'secret', stack: 'secret' }, expectation);
    expect(result.kind).toBe(kind); expect(result.exitCode).toBe(kind === 'expected' ? 0 : 2);
    expect(result.code).toBe(kind === 'expected' ? 'ok' : 'gate_unknown'); expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('no lee getters SQLSTATE ni mensajes', () => {
    const get = jest.fn(() => { throw new Error('secret'); });
    expect(classifyPgError(Object.defineProperty({}, 'code', { get }), 'gate').kind).toBe('unexpected'); expect(get).not.toHaveBeenCalled();
    expect(classifyPgError({ message: '42809' }, 'probe-42809').kind).toBe('unexpected');
  });
  it.each([{ usename: 'agenda_test_app' }, { usename: null }, { objsubid: 2 }, { database: 43 }, { granted: false },
    { pid: 1.5 }, { pid: 0 }, { key: (BigInt(L0_KEY) + 1n).toString() }, { key: Number(L0_KEY) }, { locktype: 'relation' }])('L0 ambiguo/ajeno %#', override => {
    expect(observeL0([{ ...holder(), ...override }], { databaseOid: 42 })).toBeNull();
  });
  it('L0 exige clave completa, unicidad y pid esperado; autorización pierde irreversiblemente', () => {
    expect(observeL0([], { databaseOid: 42 })).toEqual({ held: false, pid: 0 });
    expect(observeL0([holder(), holder()], { databaseOid: 42 })).toBeNull();
    expect(observeL0([holder()], { databaseOid: 42, expectedPid: 100 })).toBeNull();
    expect(observeL0([holder()], { databaseOid: 42, child: true, ownPid: 102 })).toBeNull();
    expect(observeL0([holder()], { databaseOid: 42, child: true, ownPid: 101 })).toEqual({ held: true, pid: 102 });
    for (const input of [[holder()], [{ ...holder(), usename: 'agenda_test_app' }], null]) {
      const terminate = jest.fn(); const auth = authorization({ pid: 102,
        observe: () => observeL0(input, { databaseOid: 42, expectedPid: 102 }), terminate });
      const good = input?.[0].usename === 'agenda_test_owner';
      expect(auth.acquire(true)).toBe(good); expect(auth.held()).toBe(good); expect(terminate).toHaveBeenCalledTimes(good ? 0 : 1);
    }
  });
  it('recolectores usan ids y evidencia inyectada sin modificar políticas síncronas', async () => {
    const data: Record<string, unknown> = { identity: [identity('owner')], server: [server()], role_attrs: roleAttrs(),
      effective: effective(), effective_coverage: coverage(), default_acl_schema: [], advisory_holders: [holder()] };
    const run = jest.fn(async (id: string, _params: unknown[]) => { void _params; return data[id]; });
    expect((await collectIdentity(run, 'owner')).identity?.pid).toBe(100);
    expect((await collectPrivileges(run, NAME)).complete).toBe(true);
    expect(await collectL0(run, { databaseOid: 42 })).toEqual({ held: true, pid: 102 });
    expect(run).toHaveBeenCalledWith('advisory_holders', [L0_KEY]); expect(run).toHaveBeenCalledWith('effective', [NAME, 'agenda_test_app']);
  });
});

describe('C8 regresiones D1/D2 y cobertura adversarial', () => {
  it('comment NULL se convierte en vacío sin invalidar otros esquemas reconocidos', () => {
    const good = schema();
    const result = mapSchemas([{ name: 'user_schema', owner: 'someone', comment: null }, good], NOW)!;
    expect(result).toHaveLength(2); expect(result[0].comment).toBe('');
    expect(recognized(result[0])).toBe(false); expect(recognized(result[1])).toBe(true);
    expect(mapSchemas([{ ...good, comment: null }], NOW)![0].comment).toBe('');
    expect(recognized(mapSchemas([{ ...good, comment: null }], NOW)![0])).toBe(false);
  });
  it.each([false, 1, {}, [], undefined])('comment inválido %# no se convierte silenciosamente', comment => {
    expect(mapSchemas([{ ...schema(), comment }], NOW)).toBeNull();
  });
  it.each([null, 1, {}, undefined])('owner inválido %# sigue desconocido', owner => {
    expect(mapSchemas([{ ...schema(), owner, comment: null }], NOW)).toBeNull();
  });
  it.each(EMPTY_FIELDS)('emptyHint exige cero en %s, no solo un conteo válido', field => {
    for (const value of [0, '0', 1, '1', 100, '100', null, -1, '-1']) {
      const hint = [{ ...empty()[0], [field]: value }];
      const result = mapSchemas([schema()], NOW, { [NAME]: { emptyRows: hint } })!;
      expect(result[0].empty).toBe(value === 0 || value === '0');
    }
  });
  it.each(['schema', 'table', 'sequence', 'routine', 'column'])('effective true en %s llega a la puerta como residuo', kind => {
    const rows = effective();
    const clean = mapPrivileges(rows, coverage());
    expect(evaluate([schema()], () => clean, 'P6b', roles)).toEqual({ ok: true, code: 'ok', exitCode: 0 });
    rows.find(r => r.kind === kind)!.effective = true;
    const p = mapPrivileges(rows, coverage());
    expect(p.complete).toBe(true); expect(p.evaluable).toBe(true);
    expect(p.objects.some(o => kind === 'column' ? o.column : o.direct)).toBe(true);
    expect(evaluate([schema()], () => p, 'P6b', roles)).toEqual({ ok: false, code: 'gate_residual', exitCode: 2 });
  });
  it('defaultAcl de esquema se propaga y cierra la puerta con su código actual', () => {
    const p = mapPrivileges(effective(), coverage(), [{ oid: 99 }]);
    expect(p.defaultAcl).toBe(true); expect(p.complete).toBe(true); expect(p.evaluable).toBe(true);
    // comportamiento actual; el código gate_residual requiere cambio autorizado de evaluate() en 8.6
    expect(evaluate([schema()], () => p, 'P6b', roles)).toEqual({ ok: false, code: 'gate_unknown', exitCode: 2 });
  });
  it('dos oids de esquema completos no constituyen cobertura aunque uno coincida', () => {
    const r = effective();
    const extra = r.filter(x => x.kind === 'schema').map(x => ({ ...x, oid: 999 }));
    expect(mapPrivileges([...r, ...extra], coverage()).complete).toBe(false);
    expect(mapPrivileges([...r, ...extra], coverage()).evaluable).toBe(false);
  });
  it.each([
    { membership: true, set_membership: false, edge: false, setOption: false },
    { membership: false, set_membership: false, edge: true, setOption: false },
    { membership: false, set_membership: true, edge: false, setOption: false },
    { membership: true, set_membership: false, edge: true, setOption: true },
    { membership: true, set_membership: true, edge: true, setOption: false },
  ])('ROLE_QUERY contradice el cierre en ambos sentidos %#', v => {
    const edges = v.edge ? [{ member: 11, roleid: 10, inherit_option: true, set_option: v.setOption, admin_option: false }] : [];
    expect(mapRoles([{ oid: 10, membership: v.membership, set_membership: v.set_membership }], edges, 11).evaluable).toBe(false);
  });
  it('ROLE_QUERY no puede incluir appOid, incluso con autoperte­nencia consistente', () => {
    expect(mapRoles([{ oid: 11, membership: true, set_membership: true }], [], 11).evaluable).toBe(false);
  });
  it.each([{ backend_type: 'autovacuum worker' }, { backend_type: null }, { backend_type: undefined },
    { usename: null }, { usename: 'other_role' }, { datname: 'other_database' }])('sesión ajena/malformada %# es desconocida', override => {
    const row = { pid: 100, usename: 'agenda_test_app', application_name: 'agenda-c8-validate',
      datname: 'agenda_test', backend_type: 'client backend' };
    expect(mapSessions([row])).toEqual({ otherRolePids: [100], runSessions: 1 });
    expect(mapSessions([{ ...row, ...override }])).toEqual({ otherRolePids: null, runSessions: null });
  });
});

describe('C8 evidencia complementaria de identidad', () => {
  it.each([
    ['10.0.0.1', 'private'], ['172.16.0.1/12', 'private'], ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'], ['100.64.0.1', 'private'], ['100.127.255.255/32', 'private'],
    ['127.255.0.1/8', 'loopback'], ['169.254.0.1', 'linklocal'], ['fc00::1', 'private'],
    ['fdff:ffff::1/128', 'private'], ['::1', 'loopback'], ['0:0:0:0:0:0:0:1/128', 'loopback'],
    ['fe80::1/64', 'linklocal'], ['febf::1', 'linklocal'], ['::ffff:10.1.2.3', 'private'],
    ['::ffff:7f00:1', 'loopback'], [null, 'null'], ['8.8.8.8', 'public'], ['172.15.0.1', 'public'],
    ['172.32.0.1', 'public'], ['100.63.0.1', 'public'], ['100.128.0.1', 'public'],
    ['2001:db8::1', 'public'], ['::', 'public'], ['fec0::1', 'public'], ['fbff::1', 'public'],
    ['::ffff:8.8.8.8', 'public'], ['', 'invalid'], ['1.2.3', 'invalid'], ['256.1.2.3', 'invalid'],
    ['01.2.3.4', 'invalid'], ['10.0.0.1/33', 'invalid'], ['10.0.0.1/-1', 'invalid'],
    ['10.0.0.1/01', 'invalid'], ['10.0.0.1/8/8', 'invalid'], ['::1/129', 'invalid'],
    ['fe80::1%eth0', 'invalid'], [':::1', 'invalid'], ['1::2::3', 'invalid'],
    ['1:2:3:4:5:6:7', 'invalid'], ['1:2:3:4:5:6:7:8:9', 'invalid'], ['::gg', 'invalid'],
    ['10.0.0.1\n', 'invalid'], ['::1\n', 'invalid'], ['::ffff:999.1.2.3', 'invalid'],
  ])('inet %# se clasifica sin conexión', (server_addr, expected) => {
    const evidence = mapIdentityEvidence([{ ...identityEvidence(), server_addr }]);
    expect(evidence?.addrClass).toBe(expected);
    expect(evaluateIdentityEvidence(evidence).code).toBe(['public', 'invalid'].includes(expected!) ? 'identity_contradicted' : 'ok');
  });
  it.each(['version_text', 'postmaster_epoch', 'server_now_epoch'])('%s desconocido falla cerrado', key => {
    for (const value of [null, undefined, '', 'Error: SELECT secret', NaN, Infinity, {}, '1e3', ' 1', '1\n']) {
      expect(evaluateIdentityEvidence(mapIdentityEvidence([{ ...identityEvidence(), [key]: value }]))).toEqual({ ok: false, code: 'identity_unknown', exitCode: 3 });
    }
  });
  it.each([undefined, [], null, [{}], [identityEvidence(), identityEvidence()]].map(input => ({ input })))('forma desconocida %#', ({ input }) => {
    expect(evaluateIdentityEvidence(mapIdentityEvidence(input)).code).toBe('identity_unknown');
  });
  it.each(['PostgreSQL 15.9 on fake', 'PostgreSQL 17.0 on fake'])('versión contradictoria %s', version_text => {
    expect(evaluateIdentityEvidence(mapIdentityEvidence([{ ...identityEvidence(), version_text }])).code).toBe('identity_contradicted');
  });
  it('major/minor, uptime y tolerancia sin coincidencia temporal rígida', () => {
    const e = mapIdentityEvidence([identityEvidence()])!;
    expect(e).toMatchObject({ major: 16, minor: 4, uptimeSeconds: 3600 });
    for (const start of [undefined, e.postmasterStartEpoch - 100000, e.postmasterStartEpoch, e.postmasterStartEpoch + 5]) {
      expect(evaluateIdentityEvidence(e, start)).toEqual({ ok: true, code: 'ok', exitCode: 0 });
    }
    expect(evaluateIdentityEvidence(e, e.postmasterStartEpoch + 5.001).code).toBe('identity_contradicted');
    expect(evaluateIdentityEvidence(e, NaN).code).toBe('identity_unknown');
    expect(evaluateIdentityEvidence(mapIdentityEvidence([{ ...identityEvidence(), postmaster_epoch: String(NOW / 1000 + 1) }])).code).toBe('identity_contradicted');
  });
  it('propiedad IPv4 con semilla fija, prefijos privados y máscaras', () => {
    const next = seeded(82102);
    for (let i = 0; i < 150; i++) {
      const server_addr = `10.${next() % 256}.${next() % 256}.${next() % 256}/${next() % 33}`;
      expect(mapIdentityEvidence([{ ...identityEvidence(), server_addr }])?.addrClass).toBe('private');
    }
  });
  it('getters y campos ausentes no son evidencia', () => {
    const get = jest.fn(() => 'secret');
    expect(mapIdentityEvidence([Object.defineProperty(identityEvidence(), 'version_text', { get })])).toBeNull();
    const { server_addr: _address, ...row } = identityEvidence(); void _address;
    expect(mapIdentityEvidence([row])).toBeNull(); expect(get).not.toHaveBeenCalled();
  });
});

it.each([{}, { major: 16 }, { addrClass: 'private' }, null, undefined])('evaluador no acepta evidencia fabricada incompleta %#', value => {
  expect(evaluateIdentityEvidence(value)).toEqual({ ok: false, code: 'identity_unknown', exitCode: 3 });
});
it('versión no canónica no pasa como PG16', () => {
  expect(evaluateIdentityEvidence(mapIdentityEvidence([{ ...identityEvidence(), version_text: 'PostgreSQL 016.4 on fake' }])).ok).toBe(false);
});

it.each([-1, 1, 0.25])('uptime manipulado por %s invalida evidencia completa', delta => {
  const evidence = mapIdentityEvidence([identityEvidence()])!;
  expect(evaluateIdentityEvidence(evidence)).toEqual({ ok: true, code: 'ok', exitCode: 0 });
  expect(evaluateIdentityEvidence({ ...evidence, uptimeSeconds: evidence.uptimeSeconds + delta }))
    .toEqual({ ok: false, code: 'identity_unknown', exitCode: 3 });
});
