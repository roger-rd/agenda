import { inspect } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { createConnector, AUTHORIZATION, BUDGETS, APPLICATION_NAME } from '../../scripts/harness/c8-pg-connect.cjs';
import { CATALOG, SYSTEM, lookup } from '../../scripts/harness/c8-pg-queries.cjs';
import { pgFake, credentials, PASSWORD, identity, roleAttrs } from './support/c8-pg-fakes';
const enabled = { enabled: true as const, authorization: AUTHORIZATION };
describe('C8 conector solo con pg falso inyectado', () => {
  it('carga VM sin acceso a pg/process/fs', () => {
    const filename = path.resolve(__dirname, '../../scripts/harness/c8-pg-connect.cjs');
    const source = fs.readFileSync(filename, 'utf8'); const realRequire = createRequire(filename);
    const io = jest.fn(() => { throw new Error('forbidden'); }); const module = { exports: {} };
    vm.runInNewContext(source, { module, process: new Proxy({}, { get: io }), require: (id: string) =>
      ['pg', 'fs', 'node:fs'].includes(id) ? io() : realRequire(id) });
    expect(io).not.toHaveBeenCalled(); expect(Object.isFrozen(module.exports)).toBe(true);
  });
  it.each(['owner', 'app'] as const)('configuración %s y transacciones ordenadas', async role => {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect(role, credentials(role));
    try {
      expect(Object.keys(c).sort()).toEqual(['destroy', 'end', 'pid', 'query']); expect(Object.isFrozen(c)).toBe(true);
      expect(f.configs[0]).toEqual({ host: '127.0.0.1', port: 5433, database: 'agenda_test', user: `agenda_test_${role}`,
        password: PASSWORD, connectionTimeoutMillis: 5000, statement_timeout: role === 'app' ? 5000 : 10000,
        lock_timeout: 2000, idle_in_transaction_session_timeout: 15000,
        options: '-c default_transaction_read_only=on', application_name: APPLICATION_NAME, ssl: false });
      f.calls.length = 0; await c.query('server');
      expect(f.calls.map(c => c.sql)).toEqual([SYSTEM.begin, lookup('server').sql, SYSTEM.rollback]);
      expect(f.calls.map(c => c.params)).toEqual([[], [], []]);
      for (const value of [JSON.stringify(c), inspect(c), String(c), ...Object.values(c).map(String)]) expect(value).not.toContain(PASSWORD);
    } finally { await c.end(); }
  });
  it.each([{ port: 5432 }, { host: 'localhost' }, { database: 'other' }, { user: 'postgres' }, { major: 17 }, { password: null }])('rechaza configuración antes de constructor %#', override => {
    const f = pgFake(); return expect(createConnector({ pgModule: f.pgModule }).connect('app', { ...credentials('app'), ...override })).rejects.toHaveProperty('code')
      .then(() => { expect(f.configs).toHaveLength(0); });
  });
  it('no invoca getters en credenciales', async () => {
    const f = pgFake(); const get = jest.fn(() => PASSWORD);
    const input = Object.defineProperty(credentials('owner'), 'password', { get });
    await expect(createConnector({ pgModule: f.pgModule }).connect('owner', input)).rejects.toEqual({ code: 'credentials_invalid' });
    expect(get).not.toHaveBeenCalled(); expect(f.configs).toHaveLength(0);
  });
  it.each(['anything', 'advisory_try_lock'])('rechaza %s sin sentencia y destruye', async id => {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    f.calls.length = 0;
    await expect(c.query(id, ['4095698742242691401'])).rejects.toEqual({ code: 'query_failed' });
    expect(f.calls).toHaveLength(0); expect(f.instances[0].destroyed).toBe(true);
    await expect(c.query('server')).rejects.toEqual({ code: 'client_closed' }); await c.end();
  });
  it('parámetros inválidos no llegan al cliente', async () => {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    f.calls.length = 0; await expect(c.query('timeout_probe', [4])).rejects.toEqual({ code: 'query_failed' });
    expect(f.calls).toEqual([]); expect(f.instances[0].destroyed).toBe(true);
  });
  it.each(['begin', 'statement', 'rollback'])('fallo %s siempre intenta ROLLBACK y destruye', async point => {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    f.calls.length = 0; const sql = point === 'begin' ? SYSTEM.begin : point === 'rollback' ? SYSTEM.rollback : lookup('server').sql;
    f.errors.set(sql, { code: '42501', message: PASSWORD, stack: PASSWORD });
    let error: unknown;
    try { await c.query('server'); } catch (e) { error = e; }
    expect(error).toEqual({ code: 'query_failed', sqlstate: '42501' });
    for (const value of [JSON.stringify(error), inspect(error), String(error)]) expect(value).not.toContain(PASSWORD);
    expect(f.calls.at(-1)?.sql).toBe(SYSTEM.rollback); expect(f.instances[0].destroyed).toBe(true);
    expect(f.calls.map(c => c.sql)).not.toContain('COMMIT');
  });
  it('sonda 42809 usa savepoint, rollback a sonda y rollback exterior, luego destruye', async () => {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    f.calls.length = 0;
    await expect(c.query('probe_42809', ['agenda_test_app'])).rejects.toEqual({ code: 'query_failed', sqlstate: '42809' });
    expect(f.calls.map(c => c.sql)).toEqual([SYSTEM.begin, SYSTEM.savepoint, lookup('probe_42809').sql, SYSTEM.rollbackProbe, SYSTEM.rollback]);
    expect(f.instances[0].destroyed).toBe(true);
  });
  it.each(['identity', 'role_attrs'])('identidad/poderes inválidos en %s destruyen conexión', async id => {
    const f = pgFake();
    if (id === 'identity') f.set(id, [{ ...identity('owner'), recovery: true }]);
    else f.set(id, roleAttrs().map(r => ({ ...r, rolsuper: true })));
    await expect(createConnector({ pgModule: f.pgModule }).connect('owner', credentials('owner'))).rejects.toEqual({ code: 'identity_invalid' });
    expect(f.instances[0].destroyed).toBe(true);
  });
  it('fallo de conexión no expone secretos y libera reserva', async () => {
    const f = pgFake(); f.controls.connectError = { code: '28P01', message: PASSWORD, stack: PASSWORD };
    const connector = createConnector({ pgModule: f.pgModule });
    await expect(connector.connect('owner', credentials('owner'))).rejects.toEqual({ code: 'connect_failed', sqlstate: '28P01' });
    expect(f.instances[0].destroyed).toBe(true); f.controls.connectError = undefined;
    const c = await connector.connect('owner', credentials('owner')); await c.end();
  });
  it('consultas concurrentes no entrelazan transacciones; solo catálogo llega al fake', async () => {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect('owner', credentials('owner'));
    try {
      f.calls.length = 0; await Promise.all([c.query('server'), c.query('sessions'), c.query('key_roundtrip', ['123'])]);
      expect(f.calls.map(c => c.sql)).toEqual(['server', 'sessions', 'key_roundtrip'].flatMap(id => [SYSTEM.begin, lookup(id).sql, SYSTEM.rollback]));
      const allowed = [...CATALOG.map(q => q.sql), ...Object.values(SYSTEM)];
      expect(f.calls.every(c => allowed.includes(c.sql))).toBe(true); expect(f.calls[7].params).toEqual(['123']);
    } finally { await c.end(); }
  });
  it('A y B separados, combinados máximo 2 owner + 3 app y reservas compartidas', async () => {
    expect(BUDGETS).toEqual({ A: { owner: 1, app: 1 }, B: { owner: 1, app: 2 } });
    const f = pgFake(); const a = createConnector({ pgModule: f.pgModule }); const b = createConnector({ pgModule: f.pgModule, levelB: enabled });
    const clients = [];
    try {
      clients.push(await a.connect('owner', credentials('owner')), await a.connect('app', credentials('app')));
      for (const role of ['owner', 'app'] as const) await expect(a.connect(role, credentials(role))).rejects.toEqual({ code: 'budget_exceeded' });
      clients.push(await b.connect('owner', credentials('owner', 'B')), await b.connect('app', credentials('app', 'B')), await b.connect('app', credentials('app', 'B')));
      expect(f.instances).toHaveLength(5);
      for (const level of ['A', 'B'] as const) for (const role of ['owner', 'app'] as const) {
        await expect(b.connect(role, credentials(role, level))).rejects.toEqual({ code: 'budget_exceeded' });
      }
      expect(f.instances).toHaveLength(5);
      await expect(createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'))).rejects.toEqual({ code: 'budget_exceeded' });
      await clients[2].query('advisory_try_lock', ['4095698742242691401']);
      expect(f.calls.some(c => c.sql === lookup('advisory_try_lock').sql)).toBe(true);
    } finally { for (const c of clients) await c.end(); }
    const after = await a.connect('owner', credentials('owner')); await after.destroy(); await after.destroy();
  });
  it.each([undefined, { enabled: true as const, authorization: 'incorrect' }])('B rechazada sin autorización exacta %#', levelB => {
    const f = pgFake(); return expect(createConnector({ pgModule: f.pgModule, levelB }).connect('owner', credentials('owner', 'B'))).rejects.toEqual({ code: 'query_disabled' })
      .then(() => { expect(f.instances).toHaveLength(0); });
  });
  it('B sola aplica sus límites sin consumir cupos A', async () => {
    const f = pgFake(); const b = createConnector({ pgModule: f.pgModule, levelB: enabled }); const clients = [];
    try {
      clients.push(await b.connect('owner', credentials('owner', 'B')), await b.connect('app', credentials('app', 'B')), await b.connect('app', credentials('app', 'B')));
      for (const role of ['owner', 'app'] as const) await expect(b.connect(role, credentials(role, 'B'))).rejects.toEqual({ code: 'budget_exceeded' });
      expect(f.instances).toHaveLength(3);
    } finally { for (const c of clients) await c.end(); }
  });
});

describe('C8 identidad de transporte', () => {
  it('processID distinto de identity.pid rechaza y destruye', async () => {
    const f = pgFake(); f.set('identity', [identity('owner', 999)]);
    await expect(createConnector({ pgModule: f.pgModule }).connect('owner', credentials('owner')))
      .rejects.toEqual({ code: 'identity_invalid' });
    expect(f.instances).toHaveLength(1); expect(f.instances[0].processID).not.toBe(999);
    expect(f.instances[0].destroyed).toBe(true);
    expect(f.calls.at(-1)?.sql).toBe(SYSTEM.rollback);
  });
  it('los cupos A/B hacen redundantes los topes combinados', () => {
    // Exhaustive reachable occupancy states: another connection must first fit its A/B cup.
    for (let ao = 0; ao <= 1; ao++) for (let aa = 0; aa <= 1; aa++)
      for (let bo = 0; bo <= 1; bo++) for (let ba = 0; ba <= 2; ba++) {
        const used = { A: { owner: ao, app: aa }, B: { owner: bo, app: ba } };
        for (const level of ['A', 'B'] as const) for (const role of ['owner', 'app'] as const) {
          if (used[level][role] >= BUDGETS[level][role]) continue;
          expect(ao + bo + (role === 'owner' ? 1 : 0)).toBeLessThanOrEqual(2);
          expect(aa + ba + (role === 'app' ? 1 : 0)).toBeLessThanOrEqual(3);
          expect(ao + aa + bo + ba + 1).toBeLessThanOrEqual(5);
          expect(ao + aa + bo + ba + 1).toBeLessThanOrEqual(6);
        }
      }
    // Config-from-TARGET is equivalent to validated target data: validate() requires exact own values.
    // The existing config/invalid-target tests assert both the emitted constants and pre-construction rejection.
  });
});
