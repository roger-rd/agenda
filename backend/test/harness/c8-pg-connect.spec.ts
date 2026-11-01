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
  it('sonda 42809 usa savepoint, rollback a sonda y rollback exterior, conserva cliente y reserva', async () => {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    f.calls.length = 0;
    const marker = await c.query('probe_42809', ['agenda_test_app']);
    expect(marker).toEqual({ expectedSqlstate: '42809' }); expect(Object.isFrozen(marker)).toBe(true);
    expect(f.calls.map(c => c.sql)).toEqual([SYSTEM.begin, SYSTEM.savepoint, lookup('probe_42809').sql, SYSTEM.rollbackProbe, SYSTEM.releaseProbe, SYSTEM.rollback]);
    expect(f.instances[0].destroyed).toBe(false);
    await expect(createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'))).rejects.toEqual({ code: 'budget_exceeded' });
    await expect(c.query('server')).resolves.toBeDefined(); await c.end();
  });
  it.each(['identity', 'role_attrs'])('identidad/poderes inválidos en %s destruyen conexión', async id => {
    const f = pgFake();
    if (id === 'identity') f.set(id, [{ ...identity('owner'), recovery: true }]);
    else f.set(id, roleAttrs().map(r => ({ ...r, rolsuper: true })));
    const c = await createConnector({ pgModule: f.pgModule }).connect('owner', credentials('owner'));
    await expect(c.query(id)).rejects.toEqual({ code: 'identity_invalid' }); await c.end();
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
    const c = await createConnector({ pgModule: f.pgModule }).connect('owner', credentials('owner'));
    await expect(c.query('identity')).rejects.toEqual({ code: 'identity_invalid' }); await c.end();
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

describe('C8 límites estrictos y recuperación de la sonda', () => {
  it.each(['owner', 'app'] as const)('presupuesto acumulado %s no se reinicia tras 42809', async role => {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect(role, credentials(role));
    const limit = role === 'owner' ? 30 : 10;
    await c.query('probe_42809', ['agenda_test_app']);
    for (let i = 1; i < limit; i++) await c.query('server');
    const before = f.calls.length;
    await expect(c.query('server')).rejects.toEqual({ code: 'budget_exceeded' });
    expect(f.calls).toHaveLength(before); expect(f.instances[0].destroyed).toBe(true); await c.end();
  });
  it.each(['42501', '42809\n', 'XX000', ''])('SQLSTATE inesperado %s destruye sin mensajes', async state => {
    const f = pgFake(); f.fail('probe_42809', state);
    const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    await expect(c.query('probe_42809', ['agenda_test_app'])).rejects.toHaveProperty('code', 'query_failed');
    expect(f.instances[0].destroyed).toBe(true); await c.end();
  });
  it.each(['rollbackProbe', 'releaseProbe', 'rollback'] as const)('fallo de recuperación %s cierra', async key => {
    const f = pgFake(); f.errors.set(SYSTEM[key], { code: '42501', message: PASSWORD });
    const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    await expect(c.query('probe_42809', ['agenda_test_app'])).rejects.toEqual({ code: 'query_failed', sqlstate: '42501' });
    expect(f.instances[0].destroyed).toBe(true); await c.end();
  });
  it('sonda con éxito devuelve fallo congelado', async () => {
    const f = pgFake(); f.set('probe_42809', [{ message: PASSWORD }]);
    const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    try { const result = await c.query('probe_42809', ['agenda_test_app']); expect(result).toEqual({ probeFailed: true }); expect(Object.isFrozen(result)).toBe(true); }
    finally { await c.end(); }
  });
  it('42809 fuera de la sonda destruye', async () => {
    const f = pgFake(); f.fail('default_acl_global', '42809');
    const c = await createConnector({ pgModule: f.pgModule }).connect('owner', credentials('owner'));
    await expect(c.query('default_acl_global')).rejects.toEqual({ code: 'query_failed', sqlstate: '42809' });
    expect(f.instances[0].destroyed).toBe(true); await c.end();
  });
});

describe('C8 corrección: processID inválido al conectar', () => {
  it.each([undefined, 0, -1, NaN, '100', 100.5])('processID %# rechaza, cierra fake y libera presupuesto', async processID => {
    const f = pgFake();
    class InvalidPidClient extends f.pgModule.Client {
      constructor(config: Record<string, unknown>) {
        super(config);
        if (processID === undefined) Reflect.deleteProperty(this, 'processID');
        else Object.defineProperty(this, 'processID', { value: processID, writable: true, configurable: true });
      }
    }
    const connector = createConnector({ pgModule: { Client: InvalidPidClient } });
    const attempt = connector.connect('owner', credentials('owner'));
    try {
      await expect(attempt).rejects.toEqual({ code: 'identity_invalid' });
      expect(f.instances).toHaveLength(1); expect(f.instances[0].destroyed || f.instances[0].ended).toBe(true);
      expect(f.calls).toEqual([]);
      // A distinct connector shares the global owner reservation. Success proves release.
      const next = await createConnector({ pgModule: f.pgModule }).connect('owner', credentials('owner'));
      try { expect(next.pid).toBe(101); } finally { await next.end(); }
    } finally {
      // A surviving mutant may return a client; still release its fake reservation.
      await attempt.then(c => c.end(), () => undefined);
    }
  });
});

describe('C8 conector: errores asíncronos de conexión (D-1)', () => {
  const secretError = () => Object.assign(new Error(`${PASSWORD} SELECT 1 postgres://u:${PASSWORD}@h/db`),
    { code: '57P01', stack: `${PASSWORD} at secret` });
  const leaks = (value: unknown) => [JSON.stringify(value), inspect(value), String(value)]
    .some(text => [PASSWORD, 'SELECT 1', 'postgres://', 'at secret'].some(needle => text.includes(needle)));
  async function connected(role: 'owner' | 'app' = 'app') {
    const f = pgFake(); const c = await createConnector({ pgModule: f.pgModule }).connect(role, credentials(role));
    return { f, c, client: f.instances[0] };
  }
  it('error con la conexión inactiva no lanza, invalida el cliente y libera la reserva', async () => {
    const { f, c, client } = await connected();
    expect(() => client.emit('error', secretError())).not.toThrow();
    f.calls.length = 0;
    await expect(c.query('server')).rejects.toEqual({ code: 'connection_lost' });
    expect(f.calls).toEqual([]); expect(client.destroyed).toBe(true);
    const again = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app')); await again.end(); await c.end();
  });
  it('error durante una operación falla de forma segura sin filtrar datos', async () => {
    const { f, c, client } = await connected();
    f.controls.before = async sql => { if (sql === lookup('server').sql) { client.emit('error', secretError()); throw secretError(); } };
    let error: unknown;
    try { await c.query('server'); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'connection_lost' });
    expect(Object.keys(error as object).every(k => ['code', 'sqlstate'].includes(k))).toBe(true);
    expect(leaks(error)).toBe(false); expect(client.destroyed).toBe(true);
    expect(f.calls.map(x => x.sql)).not.toContain('COMMIT');
    await c.end();
  });
  it('una conexión invalidada no vuelve a usarse: ninguna sentencia llega al cliente', async () => {
    const { f, c, client } = await connected('owner');
    client.emit('error', secretError()); f.calls.length = 0;
    for (const id of ['server', 'identity', 'probe_42809']) {
      await expect(c.query(id, id === 'probe_42809' ? ['agenda_test_app'] : [])).rejects.toEqual({ code: 'connection_lost' });
    }
    expect(f.calls).toEqual([]); expect(f.events.filter(e => e.startsWith('owner:'))).toEqual([]);
  });
  it('cierre tras el error: end y destroy no lanzan, se destruye una sola vez y no se llama a end() del driver', async () => {
    const { c, client } = await connected(); const destroy = jest.spyOn(client, 'destroy');
    client.emit('error', secretError());
    await expect(c.end()).resolves.toBeUndefined(); await expect(c.destroy()).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1); expect(client.ended).toBe(false);
  });
  it('un error posterior al cierre no lanza ni libera dos veces la reserva', async () => {
    const { f, c, client } = await connected(); await c.end();
    expect(() => client.emit('error', secretError())).not.toThrow();
    const first = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
    await expect(createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'))).rejects.toEqual({ code: 'budget_exceeded' });
    await first.end();
  });
  it('el listener existe antes de connect(): un error emitido durante connect no es excepción no capturada', async () => {
    const f = pgFake(); const original = f.pgModule.Client.prototype.connect;
    f.pgModule.Client.prototype.connect = async function patched(this: InstanceType<typeof f.pgModule.Client>) {
      this.emit('error', secretError()); return original.call(this);
    };
    try {
      const c = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app'));
      await expect(c.query('server')).rejects.toEqual({ code: 'connection_lost' });
    } finally { f.pgModule.Client.prototype.connect = original; }
  });
  it('un cliente sin emisor de eventos se rechaza cerrado y libera la reserva', async () => {
    const f = pgFake();
    class Bare { processID = 7; async connect() { return undefined; } async query() { return { rows: [] }; } async end() { return undefined; } }
    await expect(createConnector({ pgModule: { Client: Bare as never } }).connect('app', credentials('app'))).rejects.toEqual({ code: 'connect_failed' });
    const ok = await createConnector({ pgModule: f.pgModule }).connect('app', credentials('app')); await ok.end();
  });
  it('los mensajes crudos del error de conexión nunca aparecen en la reserva, la API ni los eventos', async () => {
    const { f, c, client } = await connected();
    client.emit('error', secretError());
    expect(leaks(c)).toBe(false); expect(leaks(f.events)).toBe(false);
    expect(leaks(f.calls)).toBe(false); await c.end();
  });
});
