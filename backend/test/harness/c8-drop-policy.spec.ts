/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import { authorize, revalidate, verifyOutcome, CODES, ALLOWED_KINDS, REQUIRED_COVERAGE, MAX_OBJECTS, MAX } from '../../scripts/harness/c8-drop-policy.cjs';
import { mark } from '../../scripts/harness/c8-names.cjs';
import { allows } from '../../scripts/harness/c8-ddl-filter.cjs';
import { templates } from '../../scripts/harness/c8-ddl-templates.cjs';

const NAME = 'uow_2611011200_abc123_1';
const RUN_ID = '0123456789abcdef0123456789abcdef';
const OUT = 'f'.repeat(64);
const OWNER = 'agenda_test_owner';
const CONN = 'conn-0001-abcdef';
const TXN = 'txn-0001-abcdef';
const obj = (kind: string, oid: number, over: Record<string, unknown> = {}) => ({ kind, oid, owner: OWNER, schema: NAME, extensionMember: false, ...over });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function evidence(): any {
  return {
    mode: 'own', runId: RUN_ID, target: true, l0: true, l1: true, sequence: 1,
    connection: { id: CONN, pid: 4242 }, transaction: { id: TXN, open: true, readOnly: false, lockTimeoutMs: 2000 },
    schema: { name: NAME, comment: mark(RUN_ID), owner: OWNER, ageMs: 10, lease: 'free', leaseOwned: true },
    inventory: { complete: true, coverage: [...REQUIRED_COVERAGE], total: 3, objects: [obj('table', 101), obj('sequence', 102), obj('index', 103)] },
    dependents: { complete: true, inbound: [], outbound: [{ source: 101, targetSchema: 'pg_catalog', extension: false }] },
    extensions: { complete: true, members: 0 }, eventTriggers: { complete: true, count: 0 }, defaults: { complete: true, count: 0 },
    outside: { complete: true, fingerprint: OUT }, quiescence: { runSessions: 0, otherRolePids: [], foreignLocks: false },
  };
}
const make = (fn: (e: any) => void): any => { const e = evidence(); fn(e); return e; };
/** Evidence observed after the authorization (sequence 2) in the same context. */
const later = (fn: (e: any) => void = () => undefined, seq = 2): any => make(e => { e.sequence = seq; fn(e); });
const sweep = (fn: (e: any) => void = () => undefined): any => make(e => {
  e.mode = 'sweep'; delete e.runId; e.schema.ageMs = 3600000; e.schema.lease = 'free'; fn(e);
});
const observation = (over: Record<string, unknown> = {}): any => ({ schema: NAME, connection: { id: CONN, pid: 4242 }, transaction: { id: TXN, open: true },
  sequence: 3, l0: true, l1: true, schemaAbsent: true, remaining: { complete: true, total: 0 }, outside: { complete: true, fingerprint: OUT }, ...over });
const authorized = (e: any = evidence()): any => { const d: any = authorize(e); if (!d.ok) throw new Error(`setup ${d.code}`); return d.plan; };
/** authorize (seq 1) -> revalidate (seq 2): the only way to obtain a plan verifyOutcome accepts. */
const revalidated = (e: any = evidence(), fresh: any = later()): any => { const d: any = revalidate(authorized(e), fresh); if (!d.ok) throw new Error(`setup ${d.code}`); return d.plan; };
const fail = (d: any, code: string) => { expect(d.ok).toBe(false); expect(d.code).toBe(code); expect(d.exitCode).toBe((CODES as any)[code]); expect(Object.isFrozen(d)).toBe(true); expect(d.plan).toBeUndefined(); };
/** Recomputes the plan checksum the way the module does, to build "coherent but forged" plans for the limitation test. */
const redigest = (p: any) => {
  const { digest: _digest, ...body } = p; void _digest;
  const kinds = Object.fromEntries(ALLOWED_KINDS.map(k => [k, body.kinds[k]]));
  const ordered = { action: body.action, schema: body.schema, mode: body.mode, objectCount: body.objectCount, kinds, pid: body.pid,
    connectionId: body.connectionId, transactionId: body.transactionId, stage: body.stage, authorizedSequence: body.authorizedSequence,
    sequence: body.sequence, fingerprint: body.fingerprint, outsideFingerprint: body.outsideFingerprint };
  return { ...body, digest: createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex') };
};

describe('C8 política de borrado controlado: autorización', () => {
  it('modo propio completo autoriza y describe QUÉ hacer, nunca SQL', () => {
    const d: any = authorize(evidence());
    expect(d).toMatchObject({ ok: true, code: 'ok', exitCode: 0, next: 'proceed' });
    expect(d.plan).toMatchObject({ action: 'drop_controlled', schema: NAME, mode: 'own', objectCount: 3, pid: 4242, connectionId: CONN,
      transactionId: TXN, stage: 'authorized', authorizedSequence: 1, sequence: 1, outsideFingerprint: OUT });
    expect(d.plan.kinds).toMatchObject({ table: 1, sequence: 1, index: 1, view: 0 });
    expect(d.plan.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(d.plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(d)).toBe(true); expect(Object.isFrozen(d.plan)).toBe(true); expect(Object.isFrozen(d.plan.kinds)).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/\b(DROP|CASCADE|SELECT|ALTER|CREATE|REVOKE|GRANT)\b|SCHEMA "/i);
  });
  it('esquema sin objetos produce el plan simple, sin acción controlada', () => {
    const e = make(x => { x.inventory.objects = []; x.inventory.total = 0; x.dependents.outbound = []; });
    expect((authorize(e) as any).plan).toMatchObject({ action: 'drop_plain', objectCount: 0 });
  });
  it('modo barrido: antigüedad exacta de 1 h, lease libre y obtenido', () => {
    expect(authorize(sweep())).toMatchObject({ ok: true });
    fail(authorize(sweep(e => { e.schema.ageMs = 3599999; })), 'drop_age_denied');
    fail(authorize(sweep(e => { e.schema.lease = 'live'; })), 'drop_lease_denied');
    fail(authorize(sweep(e => { e.schema.lease = 'unknown'; })), 'drop_lease_denied');
    fail(authorize(sweep(e => { e.schema.leaseOwned = false; })), 'drop_lease_denied');
    for (const bad of ['3600000', null, -1, 1.5]) fail(authorize(sweep(e => { e.schema.ageMs = bad; })), 'drop_age_denied');
    expect(authorize(sweep(e => { e.runId = RUN_ID; }))).toMatchObject({ ok: true });
    fail(authorize(sweep(e => { e.runId = 'short'; })), 'drop_identity_denied');
  });
  it.each([undefined, null, 'OWN', 'both', '', 7, {}])('modo inválido %j', mode => fail(authorize(make(e => { e.mode = mode; })), 'drop_mode_invalid'));

  describe('identidad inequívoca del arnés', () => {
    it.each(['public', 'pg_catalog', 'information_schema', 'pg_temp_1', 'pg_toast', 'uow_BAD', '', 'uow_2611011200_ABC123_1',
      'uow_2611011200_abc123_1000', 'uow_261101120_abc123_1', `${NAME}\n`, `"${NAME}"`, ` ${NAME}`, 'agenda_test'])('esquema no reconocido %j', name => {
      fail(authorize(make(e => { e.schema.name = name; e.inventory.objects.forEach((o: any) => { o.schema = name; }); })), 'drop_identity_denied');
    });
    it.each([['sin marca', 'x'], ['vacío', ''], ['marca de otro run', mark('b'.repeat(32))], ['marca con salto', `${mark(RUN_ID)}\n`],
      ['marca truncada', mark(RUN_ID).slice(0, -1)], ['marca en mayúsculas', mark(RUN_ID).toUpperCase()]])('comentario %s', (_n, comment) => {
      fail(authorize(make(e => { e.schema.comment = comment; })), 'drop_identity_denied');
    });
    it('propietario del esquema distinto, ausente o con otra capitalización', () => {
      for (const owner of ['agenda_test_app', 'postgres', 'AGENDA_TEST_OWNER', '', 'agenda_dev_owner']) fail(authorize(make(e => { e.schema.owner = owner; })), 'drop_identity_denied');
    });
    it('modo propio exige runId válido y coincidente con la marca', () => {
      for (const runId of [undefined, null, 'b'.repeat(32), RUN_ID.toUpperCase(), 7]) fail(authorize(make(e => { e.runId = runId; })), 'drop_identity_denied');
    });
    it('el lease debe haberse obtenido de forma explícita', () => {
      for (const v of [false, undefined, 'true', 1, null]) fail(authorize(make(e => { e.schema.leaseOwned = v; })), 'drop_lease_denied');
    });
    it('campos de identidad mal tipados son evidencia incompleta, no identidad denegada', () => {
      for (const key of ['name', 'comment', 'owner']) for (const v of [undefined, null, 5]) fail(authorize(make(e => { e.schema[key] = v; })), 'drop_evidence_incomplete');
    });
  });

  describe('conexión, transacción, secuencia y destino', () => {
    it.each(['l0', 'l1'])('pérdida de %s siempre es fallo 3 aunque lo demás sea válido', key => {
      for (const v of [false, undefined, null, 'true', 1, 0]) fail(authorize(make(e => { e[key] = v; })), 'drop_lock_lost');
    });
    it('la pérdida de bloqueo tiene prioridad sobre cualquier otra denegación', () => {
      fail(authorize(make(e => { e.l0 = false; e.schema.owner = 'x'; e.inventory = undefined; })), 'drop_lock_lost');
    });
    it('destino sin verificar', () => { for (const v of [false, undefined, 'true', 1]) fail(authorize(make(e => { e.target = v; })), 'drop_target_unverified'); });
    it('pid de conexión inválido o ausente', () => {
      for (const pid of [0, -1, 1.5, '4242', null, undefined, 2 ** 33]) fail(authorize(make(e => { e.connection.pid = pid; })), 'drop_evidence_incomplete');
      fail(authorize(make(e => { delete e.connection; })), 'drop_evidence_incomplete');
    });
    it.each([['connection'], ['transaction']])('identificador opaco de %s: forma y longitud', key => {
      const bad = ['', 'short', 'a'.repeat(7), 'a'.repeat(65), 'has space1234', 'con\nsalto12', 'ñandú-12345', 5, null, undefined, {}, ['x']];
      for (const id of bad) fail(authorize(make(e => { e[key].id = id; })), 'drop_evidence_incomplete');
      for (const id of ['a'.repeat(8), 'a'.repeat(64), 'AbC.12_-xyz']) expect(authorize(make(e => { e[key].id = id; }))).toMatchObject({ ok: true });
    });
    it('el identificador de la transacción es obligatorio', () => {
      fail(authorize(make(e => { delete e.transaction.id; })), 'drop_evidence_incomplete');
    });
    it('la transacción debe estar abierta, de escritura y con lock_timeout aprobado', () => {
      for (const [k, v] of [['open', false], ['open', undefined], ['readOnly', true], ['readOnly', undefined], ['lockTimeoutMs', 5000], ['lockTimeoutMs', 0], ['lockTimeoutMs', '2000'], ['lockTimeoutMs', undefined]]) {
        fail(authorize(make(e => { e.transaction[k as string] = v; })), 'drop_excluded_transaction');
      }
      fail(authorize(make(e => { delete e.transaction; })), 'drop_evidence_incomplete');
    });
    it('la secuencia de observación es obligatoria, entera y positiva', () => {
      for (const v of [0, -1, 1.5, '1', null, undefined, NaN, 2 ** 53, {}]) {
        const d: any = authorize(make(e => { e.sequence = v; })); expect(d.ok).toBe(false); expect(d.exitCode).toBe(3);
      }
      expect(authorize(make(e => { e.sequence = 9007199254740991; }))).toMatchObject({ ok: true });
    });
  });

  describe('evidencia incompleta, ausente o desconocida (fallo 3)', () => {
    it.each(['inventory', 'dependents', 'extensions', 'eventTriggers', 'defaults', 'outside', 'quiescence', 'schema'])('falta la sección %s', key => {
      fail(authorize(make(e => { delete e[key]; })), 'drop_evidence_incomplete');
      for (const bad of [null, 5, 'x', []]) fail(authorize(make(e => { e[key] = bad; })), 'drop_evidence_incomplete');
    });
    it.each(['inventory', 'dependents', 'extensions', 'eventTriggers', 'defaults', 'outside'])('%s.complete distinto de true', key => {
      for (const v of [false, undefined, 'true', 1, null]) fail(authorize(make(e => { e[key].complete = v; })), 'drop_evidence_incomplete');
    });
    it.each(REQUIRED_COVERAGE.map(c => [c]))('cobertura sin %s', name => {
      fail(authorize(make(e => { e.inventory.coverage = e.inventory.coverage.filter((c: string) => c !== name); })), 'drop_evidence_incomplete');
    });
    it('cobertura vacía o no listada', () => {
      for (const v of [[], undefined, 'relations', null]) fail(authorize(make(e => { e.inventory.coverage = v; })), 'drop_evidence_incomplete');
    });
    it('huella exterior mal formada', () => {
      for (const v of ['', 'F'.repeat(64), 'f'.repeat(63), 'f'.repeat(65), `${'f'.repeat(64)}\n`, 5, undefined]) fail(authorize(make(e => { e.outside.fingerprint = v; })), 'drop_evidence_incomplete');
    });
    it.each([['inventory', 'total'], ['extensions', 'members'], ['eventTriggers', 'count'], ['defaults', 'count']])('%s.%s no es un entero no negativo', (section, key) => {
      for (const v of [-1, 1.5, '0', null, undefined, NaN]) {
        const d: any = authorize(make(e => { e[section][key] = v; }));
        expect(d.ok).toBe(false); expect([3]).toContain(d.exitCode);
      }
    });
    it('objetos con campos mal tipados', () => {
      for (const [k, v] of [['kind', 5], ['owner', undefined], ['extensionMember', 'false'], ['schema', null], ['oid', 0], ['oid', -3], ['oid', 1.5], ['oid', '101'], ['oid', 2 ** 33]]) {
        fail(authorize(make(e => { e.inventory.objects[0][k as string] = v; })), 'drop_evidence_incomplete');
      }
      fail(authorize(make(e => { e.inventory.objects[0] = null; })), 'drop_evidence_incomplete');
    });
    it('dependencias con campos mal tipados', () => {
      fail(authorize(make(e => { e.dependents.outbound[0].source = '101'; })), 'drop_evidence_incomplete');
      fail(authorize(make(e => { e.dependents.outbound[0].extension = undefined; })), 'drop_evidence_incomplete');
      fail(authorize(make(e => { e.dependents.outbound[0].targetSchema = null; })), 'drop_evidence_incomplete');
      fail(authorize(make(e => { e.dependents.inbound = [{ target: 101 }]; })), 'drop_evidence_incomplete');
    });
    it('concurrencia desconocida (null o mal tipada) no es "sin concurrencia"', () => {
      for (const [k, v] of [['runSessions', null], ['runSessions', undefined], ['runSessions', '0'], ['otherRolePids', null], ['otherRolePids', undefined], ['otherRolePids', [0]],
        ['otherRolePids', ['7']], ['foreignLocks', null], ['foreignLocks', 'false'], ['foreignLocks', 0], ['foreignLocks', undefined]]) {
        fail(authorize(make(e => { e.quiescence[k as string] = v; })), 'drop_evidence_incomplete');
      }
    });
  });

  describe('longitudes de cadenas según el significado de cada campo', () => {
    const long = (n: number) => 'a'.repeat(n);
    it('cualquier cadena por encima del techo general es evidencia no segura', () => {
      for (const set of [(e: any) => { e.schema.comment = long(MAX.string + 1); }, (e: any) => { e.runId = long(MAX.string + 1); },
        (e: any) => { e.inventory.objects[0].kind = long(MAX.string + 1); }, (e: any) => { e.connection.id = long(MAX.string + 1); },
        (e: any) => { e.inventory.coverage.push(long(MAX.string + 1)); }, (e: any) => { e.outside.fingerprint = long(100000); }]) {
        fail(authorize(make(set)), 'drop_evidence_unsafe');
      }
    });
    it('claves de objeto demasiado largas son evidencia no segura', () => {
      const e = evidence(); e.schema[long(MAX.name + 1)] = 1; fail(authorize(e), 'drop_evidence_unsafe');
    });
    it.each([
      ['nombre de esquema', (e: any, n: number) => { e.schema.name = long(n); }, MAX.name, 'drop_evidence_incomplete', 'drop_identity_denied'],
      ['propietario del esquema', (e: any, n: number) => { e.schema.owner = long(n); }, MAX.owner, 'drop_evidence_incomplete', 'drop_identity_denied'],
      ['comentario', (e: any, n: number) => { e.schema.comment = long(n); }, MAX.comment, 'drop_evidence_incomplete', 'drop_identity_denied'],
      ['tipo de objeto', (e: any, n: number) => { e.inventory.objects[0].kind = long(n); }, MAX.kind, 'drop_evidence_incomplete', 'drop_excluded_kind'],
      ['propietario de objeto', (e: any, n: number) => { e.inventory.objects[0].owner = long(n); }, MAX.owner, 'drop_evidence_incomplete', 'drop_excluded_owner'],
      ['esquema de objeto', (e: any, n: number) => { e.inventory.objects[0].schema = long(n); }, MAX.name, 'drop_evidence_incomplete', 'drop_evidence_contradictory'],
      ['esquema destino saliente', (e: any, n: number) => { e.dependents.outbound[0].targetSchema = long(n); }, MAX.name, 'drop_evidence_incomplete', 'drop_excluded_outbound'],
      ['elemento de cobertura', (e: any, n: number) => { e.inventory.coverage[0] = long(n); }, MAX.coverage, 'drop_evidence_incomplete', null],
    ])('%s: por encima del límite es incompleto; en el límite se evalúa por su significado', (_n, set, max, over, atLimit) => {
      fail(authorize(make(e => (set as any)(e, (max as number) + 1))), over as string);
      const d: any = authorize(make(e => (set as any)(e, max as number)));
      if (atLimit === null) expect(d.ok).toBe(false); else fail(d, atLimit as string);
    });
    it('un elemento de cobertura demasiado largo invalida la evidencia aunque estén todos los obligatorios', () => {
      fail(authorize(make(e => { e.inventory.coverage = [...REQUIRED_COVERAGE, long(MAX.coverage + 1)]; })), 'drop_evidence_incomplete');
      expect(authorize(make(e => { e.inventory.coverage = [...REQUIRED_COVERAGE, long(MAX.coverage)]; }))).toMatchObject({ ok: true });
    });
    it('demasiados elementos de cobertura', () => {
      fail(authorize(make(e => { e.inventory.coverage = [...REQUIRED_COVERAGE, ...Array.from({ length: MAX.coverageItems }, (_, i) => `extra${i}`)]; })), 'drop_evidence_incomplete');
    });
  });

  describe('evidencia contradictoria (fallo 3)', () => {
    it('el total no coincide con los objetos', () => {
      for (const total of [0, 2, 4, 99]) fail(authorize(make(e => { e.inventory.total = total; })), 'drop_evidence_contradictory');
    });
    it('un inventario vacío que dice tener objetos, y uno con objetos que dice estar vacío', () => {
      fail(authorize(make(e => { e.inventory.objects = []; })), 'drop_evidence_contradictory');
      fail(authorize(make(e => { e.inventory.total = 0; })), 'drop_evidence_contradictory');
    });
    it('oid duplicado en el inventario', () => { fail(authorize(make(e => { e.inventory.objects[1].oid = 101; })), 'drop_evidence_contradictory'); });
    it('un objeto del inventario pertenece a otro esquema', () => {
      for (const s of ['public', 'uow_2611011200_abc123_2', 'pg_catalog']) fail(authorize(make(e => { e.inventory.objects[2].schema = s; })), 'drop_evidence_contradictory');
    });
    it('dependencias que apuntan a objetos que el inventario no contiene', () => {
      fail(authorize(make(e => { e.dependents.outbound[0].source = 999; })), 'drop_evidence_contradictory');
      fail(authorize(make(e => { e.dependents.inbound = [{ target: 999, source: 5 }]; })), 'drop_evidence_contradictory');
    });
  });

  describe('condiciones de exclusión (fallo 2)', () => {
    it.each(['foreign_table', 'aggregate', 'operator', 'collation', 'conversion', 'extension', 'publication', 'subscription', 'event_trigger', 'language', 'TABLE', '', 'schema'])('tipo de objeto %j', kind => {
      fail(authorize(make(e => { e.inventory.objects[1].kind = kind; })), 'drop_excluded_kind');
    });
    it.each(ALLOWED_KINDS.map(k => [k]))('tipo permitido %s', kind => {
      expect(authorize(make(e => { e.inventory.objects[1].kind = kind; }))).toMatchObject({ ok: true });
    });
    it('propiedad inesperada de cualquier objeto', () => {
      for (const owner of ['agenda_test_app', 'postgres', 'agenda_admin', '']) fail(authorize(make(e => { e.inventory.objects[2].owner = owner; })), 'drop_excluded_owner');
    });
    it('extensiones involucradas', () => {
      fail(authorize(make(e => { e.inventory.objects[0].extensionMember = true; })), 'drop_excluded_extension');
      fail(authorize(make(e => { e.extensions.members = 1; })), 'drop_excluded_extension');
    });
    it('dependientes externos (otro esquema, vistas, claves foráneas)', () => {
      fail(authorize(make(e => { e.dependents.inbound = [{ target: 101, source: 9001 }]; })), 'drop_excluded_external_dependents');
    });
    it('dependencias salientes a esquemas no del sistema o a extensiones', () => {
      for (const [schema, extension] of [['public', false], ['uow_2611011200_abc123_2', false], ['extensions', false], ['pg_catalog', true], ['', false]] as const) {
        fail(authorize(make(e => { e.dependents.outbound = [{ source: 101, targetSchema: schema, extension }]; })), 'drop_excluded_outbound');
      }
      expect(authorize(make(e => { e.dependents.outbound = [{ source: 101, targetSchema: 'information_schema', extension: false }]; }))).toMatchObject({ ok: true });
    });
    it('disparadores de evento y ACL por defecto', () => {
      fail(authorize(make(e => { e.eventTriggers.count = 1; })), 'drop_excluded_event_trigger');
      fail(authorize(make(e => { e.defaults.count = 2; })), 'drop_excluded_default_acl');
    });
    it('demasiados objetos', () => {
      const many = (n: number) => make(e => {
        e.inventory.objects = Array.from({ length: n }, (_, i) => obj('table', 1000 + i)); e.inventory.total = n; e.dependents.outbound = [];
      });
      expect(authorize(many(MAX_OBJECTS))).toMatchObject({ ok: true });
      fail(authorize(many(MAX_OBJECTS + 1)), 'drop_excluded_size');
    });
    it.each([['runSessions', 1], ['runSessions', 5], ['otherRolePids', [7]], ['otherRolePids', [7, 8]], ['foreignLocks', true]])('concurrencia %s=%j', (key, value) => {
      fail(authorize(make(e => { e.quiescence[key as string] = value; })), 'drop_excluded_concurrency');
    });
  });

  describe('entradas hostiles: nunca se ejecuta código del llamador', () => {
    it('getters, proxies, prototipos, símbolos, valores no finitos y funciones', () => {
      const getter = jest.fn(() => true);
      const withGetter = evidence(); Object.defineProperty(withGetter, 'l0', { get: getter, enumerable: true });
      fail(authorize(withGetter), 'drop_evidence_unsafe'); expect(getter).not.toHaveBeenCalled();
      fail(authorize(new Proxy(evidence(), {})), 'drop_evidence_unsafe');
      const nested = evidence(); nested.schema = new Proxy(nested.schema, {}); fail(authorize(nested), 'drop_evidence_unsafe');
      class Evil { l0 = true; } fail(authorize(Object.assign(new Evil(), evidence())), 'drop_evidence_unsafe');
      fail(authorize(Object.assign(Object.create({ inherited: 1 }), evidence())), 'drop_evidence_unsafe');
      const sym = evidence(); sym[Symbol('x')] = 1; fail(authorize(sym), 'drop_evidence_unsafe');
      for (const v of [NaN, Infinity, -Infinity, () => 1, Symbol('s'), 10n]) {
        const bad = evidence(); bad.schema.ageMs = v;
        const d: any = authorize(bad); expect(d.ok).toBe(false);
      }
    });
    it('arreglos dispersos, con propiedades extra, con getters, demasiado grandes o con nombre __proto__', () => {
      const sparse = evidence(); sparse.inventory.objects = new Array(3); fail(authorize(sparse), 'drop_evidence_unsafe');
      const extra = evidence(); (extra.inventory.coverage as any).extra = 1; fail(authorize(extra), 'drop_evidence_unsafe');
      const arrGetter = evidence(); const g = jest.fn(() => 'x'); Object.defineProperty(arrGetter.inventory.coverage, '0', { get: g, enumerable: true });
      fail(authorize(arrGetter), 'drop_evidence_unsafe'); expect(g).not.toHaveBeenCalled();
      const big = evidence(); big.quiescence.otherRolePids = Array.from({ length: 2001 }, (_, i) => i + 1); fail(authorize(big), 'drop_evidence_unsafe');
      fail(authorize(JSON.parse('{"__proto__": {"l0": true}, "mode": "own"}')), 'drop_evidence_unsafe');
      const odd = evidence(); Object.setPrototypeOf(odd.inventory.coverage, Object.create(Array.prototype)); fail(authorize(odd), 'drop_evidence_unsafe');
      const notArray = evidence(); notArray.inventory.coverage = Object.assign(Object.create(Array.prototype), { ...notArray.inventory.coverage, length: 14 });
      expect((authorize(notArray) as any).ok).toBe(false);
    });
    it('anidamiento excesivo', () => {
      const deep = evidence(); let cursor: any = deep; for (let i = 0; i < 12; i++) { cursor.x = {}; cursor = cursor.x; }
      fail(authorize(deep), 'drop_evidence_unsafe');
    });
    it.each([undefined, null, 5, 'x', [], () => 1])('evidencia raíz %j', raw => {
      const d: any = authorize(raw); expect(d.ok).toBe(false); expect(d.exitCode).toBe(3);
    });
    it('el plan es una copia: mutar la evidencia después no cambia nada', () => {
      const e = evidence(); const p: any = (authorize(e) as any).plan;
      e.schema.name = 'public'; e.inventory.objects.length = 0; e.connection.pid = 1; e.connection.id = 'zzzzzzzz'; e.sequence = 99;
      expect(p).toMatchObject({ schema: NAME, objectCount: 3, pid: 4242, connectionId: CONN, sequence: 1 });
      expect(() => { (p as any).schema = 'public'; }).toThrow();
    });
    it('la evidencia de entrada nunca se modifica', () => {
      const e = evidence(); const before = JSON.stringify(e);
      authorize(e); revalidate(authorized(e), later()); expect(JSON.stringify(e)).toBe(before);
    });
  });
});

describe('C8 política de borrado controlado: revalidación previa al borrado', () => {
  it('evidencia posterior idéntica reproduce la decisión y avanza el plan a "revalidated"', () => {
    const d: any = revalidate(authorized(), later());
    expect(d).toMatchObject({ ok: true, next: 'proceed' });
    expect(d.plan).toMatchObject({ stage: 'revalidated', authorizedSequence: 1, sequence: 2, connectionId: CONN, transactionId: TXN, pid: 4242, schema: NAME });
    expect(Object.isFrozen(d.plan)).toBe(true); expect(d.plan.digest).not.toBe(authorized().digest);
  });
  it.each([
    ['aparece un objeto nuevo', (e: any) => { e.inventory.objects.push(obj('table', 104)); e.inventory.total = 4; }],
    ['desaparece un objeto', (e: any) => { e.inventory.objects.pop(); e.inventory.total = 2; }],
    ['un oid cambia', (e: any) => { e.inventory.objects[0].oid = 555; e.dependents.outbound[0].source = 555; }],
    ['cambia el tipo de un objeto', (e: any) => { e.inventory.objects[1].kind = 'view'; }],
    ['cambia el exterior', (e: any) => { e.outside.fingerprint = 'e'.repeat(64); }],
    ['cambian las dependencias salientes', (e: any) => { e.dependents.outbound = []; }],
  ])('deriva del contenido: %s', (_n, change) => {
    fail(revalidate(authorized(), later(change)), 'drop_revalidation_mismatch');
  });
  it.each([
    ['otra conexión (pid distinto)', (e: any) => { e.connection.pid = 4243; }],
    ['otra conexión (id distinto)', (e: any) => { e.connection.id = 'conn-0002-abcdef'; }],
    ['PID igual pero connection.id distinto', (e: any) => { e.connection.id = 'conn-9999-zzzzzz'; }],
    ['otra transacción sobre la misma conexión', (e: any) => { e.transaction.id = 'txn-0002-abcdef'; }],
    ['otro esquema', (e: any) => { const n = 'uow_2611011200_abc123_2'; e.schema.name = n; e.inventory.objects.forEach((o: any) => { o.schema = n; }); }],
    ['otro modo', (e: any) => { Object.assign(e, { mode: 'sweep', runId: undefined }); e.schema.ageMs = 3600000; }],
  ])('contexto distinto: %s', (_n, change) => {
    fail(revalidate(authorized(), later(change)), 'drop_context_mismatch');
  });
  it.each([['repetida', 1], ['retrocedida', 0], ['mucho menor', -5]])('secuencia %s respecto a la autorización', (_n, seq) => {
    const d: any = revalidate(authorized(make(e => { e.sequence = 10; })), later(() => undefined, seq));
    expect(d.ok).toBe(false); expect(d.exitCode).toBe(3);
    expect(['drop_order_violation', 'drop_evidence_incomplete']).toContain(d.code);
  });
  it('la misma evidencia reutilizada no es posterior a la autorización', () => {
    fail(revalidate(authorized(), evidence()), 'drop_order_violation');
    fail(revalidate(authorized(make(e => { e.sequence = 7; })), later(() => undefined, 7)), 'drop_order_violation');
    fail(revalidate(authorized(make(e => { e.sequence = 7; })), later(() => undefined, 6)), 'drop_order_violation');
    expect(revalidate(authorized(make(e => { e.sequence = 7; })), later(() => undefined, 8))).toMatchObject({ ok: true });
  });
  it('una secuencia mayor no compensa un contexto distinto ni un contenido distinto', () => {
    fail(revalidate(authorized(), later(e => { e.connection.id = 'conn-0002-abcdef'; }, 50)), 'drop_context_mismatch');
    fail(revalidate(authorized(), later(e => { e.outside.fingerprint = 'e'.repeat(64); }, 50)), 'drop_revalidation_mismatch');
  });
  it('si la nueva evidencia ya no autoriza, se devuelve la denegación real', () => {
    const p = authorized();
    fail(revalidate(p, later(e => { e.l0 = false; })), 'drop_lock_lost');
    fail(revalidate(p, later(e => { e.l1 = false; })), 'drop_lock_lost');
    fail(revalidate(p, later(e => { e.target = false; })), 'drop_target_unverified');
    fail(revalidate(p, later(e => { e.inventory.objects[0].owner = 'postgres'; })), 'drop_excluded_owner');
    fail(revalidate(p, later(e => { e.dependents.inbound = [{ target: 101, source: 77 }]; })), 'drop_excluded_external_dependents');
    fail(revalidate(p, later(e => { e.quiescence.foreignLocks = true; })), 'drop_excluded_concurrency');
    fail(revalidate(p, later(e => { delete e.inventory; })), 'drop_evidence_incomplete');
    fail(revalidate(p, later(e => { e.transaction.lockTimeoutMs = 5000; })), 'drop_excluded_transaction');
    fail(revalidate(p, later(e => { delete e.sequence; })), 'drop_evidence_incomplete');
  });
  it('solo un plan "authorized" puede revalidarse: no se revalida dos veces ni se salta', () => {
    const r = revalidated();
    fail(revalidate(r, later(() => undefined, 5)), 'drop_order_violation');
  });
  describe('plan alterado o estructuralmente inválido', () => {
    const fresh = () => later();
    it.each([
      ['acción', (p: any) => { p.action = 'drop_plain'; }], ['conteo', (p: any) => { p.objectCount = 2; }], ['pid', (p: any) => { p.pid = 1; }],
      ['esquema', (p: any) => { p.schema = 'uow_2611011200_abc123_2'; }], ['huella', (p: any) => { p.fingerprint = 'a'.repeat(64); }],
      ['exterior', (p: any) => { p.outsideFingerprint = 'a'.repeat(64); }], ['conexión', (p: any) => { p.connectionId = 'conn-0002-abcdef'; }],
      ['transacción', (p: any) => { p.transactionId = 'txn-0002-abcdef'; }], ['etapa', (p: any) => { p.stage = p.stage === 'authorized' ? 'revalidated' : 'authorized'; }],
      ['secuencia', (p: any) => { p.sequence = 0; }], ['secuencia de autorización', (p: any) => { p.authorizedSequence = 9; }],
      ['modo', (p: any) => { p.mode = 'sweep'; }], ['conteo por tipo', (p: any) => { p.kinds = { ...p.kinds, table: 5 }; }],
      ['digest', (p: any) => { p.digest = 'b'.repeat(64); }],
    ])('campo %s modificado sin recalcular el checksum', (_n, change) => {
      const p: any = clone(authorized()); change(p); fail(revalidate(p, fresh()), 'drop_plan_invalid');
      const r: any = clone(revalidated()); change(r); fail(verifyOutcome(r, observation()), 'drop_plan_invalid');
    });
    it.each([
      ['falta un campo', (p: any) => { delete p.digest; }], ['campo extra', (p: any) => { p.extra = 1; }], ['sin kinds', (p: any) => { delete p.kinds; }],
      ['kinds con clave extra', (p: any) => { p.kinds.aggregate = 0; }], ['kinds incompleto', (p: any) => { delete p.kinds.view; }],
      ['acción desconocida', (p: any) => { p.action = 'drop_cascade'; }], ['modo desconocido', (p: any) => { p.mode = 'x'; }],
      ['esquema inválido', (p: any) => { p.schema = 'public'; }], ['pid inválido', (p: any) => { p.pid = 0; }],
      ['conexión mal formada', (p: any) => { p.connectionId = 'x'; }], ['huella mal formada', (p: any) => { p.fingerprint = 'xyz'; }],
      ['conteo negativo', (p: any) => { p.objectCount = -1; }], ['conteo excesivo', (p: any) => { p.objectCount = MAX_OBJECTS + 1; }],
      ['etapa desconocida', (p: any) => { p.stage = 'committed'; }], ['secuencia no entera', (p: any) => { p.sequence = 1.5; }],
    ])('estructura inválida: %s', (_n, change) => {
      const p: any = clone(authorized()); change(p); fail(revalidate(p, fresh()), 'drop_plan_invalid');
    });
    it.each([undefined, null, 5, 'x', [], () => 1, {}])('valor no plan %j', bad => {
      const d: any = revalidate(bad, fresh()); expect(d.ok).toBe(false); expect(d.exitCode).toBe(3);
      const v: any = verifyOutcome(bad, observation()); expect(v.ok).toBe(false); expect(v.next).toBe('rollback');
    });
    it('getters y proxies en el plan no se ejecutan', () => {
      const getter = jest.fn(() => 'drop_plain'); const tricky: any = { ...authorized() };
      Object.defineProperty(tricky, 'action', { get: getter, enumerable: true });
      fail(revalidate(tricky, fresh()), 'drop_evidence_unsafe'); expect(getter).not.toHaveBeenCalled();
      fail(revalidate(new Proxy({ ...authorized() }, {}), fresh()), 'drop_evidence_unsafe');
    });
    it('cadenas excesivas dentro del plan', () => {
      const p: any = clone(authorized()); p.connectionId = 'a'.repeat(MAX.string + 1); fail(revalidate(p, fresh()), 'drop_evidence_unsafe');
      const q: any = clone(authorized()); q.connectionId = 'a'.repeat(65); fail(revalidate(q, fresh()), 'drop_plan_invalid');
      const r: any = clone(authorized()); r.schema = 'a'.repeat(MAX.name + 1); fail(revalidate(r, fresh()), 'drop_plan_invalid');
    });
    describe('estructura inválida aunque el checksum se recalcule (la validación estructural es independiente del digest)', () => {
      const zeroKinds = () => Object.fromEntries(ALLOWED_KINDS.map(k => [k, 0]));
      it.each([
        ['acción desconocida', (p: any) => { p.action = 'drop_cascade'; }],
        ['acción plana con objetos', (p: any) => { p.action = p.action === 'drop_plain' ? 'drop_controlled' : 'drop_plain'; }],
        ['acción controlada sin objetos', (p: any) => { p.objectCount = 0; p.kinds = zeroKinds(); p.action = 'drop_controlled'; }],
        ['suma por tipo distinta del conteo', (p: any) => { p.kinds = { ...p.kinds, table: p.kinds.table + 1 }; }],
        ['conteo por encima del máximo', (p: any) => { p.objectCount = MAX_OBJECTS + 1; p.kinds = { ...zeroKinds(), table: MAX_OBJECTS + 1 }; p.action = 'drop_controlled'; }],
        ['conteo negativo', (p: any) => { p.objectCount = -1; }],
        ['clave extra en kinds', (p: any) => { p.kinds = { ...p.kinds, aggregate: 0 }; }],
        ['esquema fuera de patrón', (p: any) => { p.schema = 'public'; }],
        ['modo desconocido', (p: any) => { p.mode = 'x'; }],
        ['pid cero', (p: any) => { p.pid = 0; }],
        ['id de conexión mal formado', (p: any) => { p.connectionId = 'x'; }],
        ['id de transacción mal formado', (p: any) => { p.transactionId = 'x y z w'; }],
        ['huella mal formada', (p: any) => { p.fingerprint = 'xyz'; }],
        ['huella exterior mal formada', (p: any) => { p.outsideFingerprint = 'F'.repeat(64); }],
        ['etapa desconocida', (p: any) => { p.stage = 'committed'; }],
        ['secuencias incoherentes con la etapa', (p: any) => { p.sequence = p.stage === 'authorized' ? p.sequence + 4 : p.authorizedSequence; }],
        ['secuencia de autorización cero', (p: any) => { p.authorizedSequence = 0; if (p.stage === 'authorized') p.sequence = 0; }],
        ['secuencia no entera', (p: any) => { p.sequence = p.sequence + 0.5; if (p.stage === 'authorized') p.authorizedSequence = p.sequence; }],
      ])('%s', (_n, change) => {
        const a: any = clone(authorized()); change(a); fail(revalidate(redigest(a), later()), 'drop_plan_invalid');
        const r: any = clone(revalidated()); change(r); fail(verifyOutcome(redigest(r), observation()), 'drop_plan_invalid');
      });
      it('digest mal formado aunque lo demás sea coherente', () => {
        fail(revalidate({ ...redigest(clone(authorized())), digest: 'Z'.repeat(64) }, later()), 'drop_plan_invalid');
        fail(revalidate({ ...redigest(clone(authorized())), digest: 'a'.repeat(63) }, later()), 'drop_plan_invalid');
      });
    });
    it('LIMITACIÓN DOCUMENTADA: un plan reconstruido con el checksum recalculado es coherente; su procedencia no la prueba este módulo', () => {
      const forged = redigest({ ...clone(authorized()), objectCount: 3 });
      expect(revalidate(forged, fresh())).toMatchObject({ ok: true });
      const bumped = redigest({ ...clone(authorized()), stage: 'revalidated', sequence: 2 });
      expect(verifyOutcome(bumped, observation())).toMatchObject({ ok: true });
    });
  });
});

describe('C8 política de borrado controlado: verificación del resultado antes de COMMIT', () => {
  const rollback = (d: any, code: string) => { fail(d, code); expect(d.next).toBe('rollback'); };
  it('resultado limpio, en el mismo contexto y posterior a la revalidación, permite COMMIT', () => {
    expect(verifyOutcome(revalidated(), observation())).toMatchObject({ ok: true, code: 'ok', next: 'commit' });
    expect(Object.isFrozen(verifyOutcome(revalidated(), observation()))).toBe(true);
  });
  it.each([
    ['el esquema sigue existiendo', { schemaAbsent: false }],
    ['quedan objetos dentro', { remaining: { complete: true, total: 1 } }],
    ['el exterior cambió (daño colateral)', { outside: { complete: true, fingerprint: 'e'.repeat(64) } }],
  ])('%s: ROLLBACK', (_n, over) => rollback(verifyOutcome(revalidated(), observation(over)), 'drop_outcome_mismatch'));

  describe('vinculación de la observación al plan', () => {
    it('observación de otro esquema', () => {
      for (const schema of ['uow_2611011200_abc123_2', 'public', '', 'pg_catalog', `${NAME} `]) rollback(verifyOutcome(revalidated(), observation({ schema })), 'drop_context_mismatch');
    });
    it('observación de otra conexión', () => {
      rollback(verifyOutcome(revalidated(), observation({ connection: { id: 'conn-0002-abcdef', pid: 4242 } })), 'drop_context_mismatch');
      rollback(verifyOutcome(revalidated(), observation({ connection: { id: CONN, pid: 4243 } })), 'drop_context_mismatch');
    });
    it('PID igual pero connection.id distinto', () => {
      rollback(verifyOutcome(revalidated(), observation({ connection: { id: 'conn-7777-qqqqqq', pid: 4242 } })), 'drop_context_mismatch');
    });
    it('observación de otra transacción, también sobre la misma conexión', () => {
      rollback(verifyOutcome(revalidated(), observation({ transaction: { id: 'txn-0002-abcdef', open: true } })), 'drop_context_mismatch');
    });
    it('la transacción ya no está abierta', () => {
      rollback(verifyOutcome(revalidated(), observation({ transaction: { id: TXN, open: false } })), 'drop_context_mismatch');
    });
    it.each([['igual a la revalidación', 2], ['anterior a la revalidación', 1], ['cero', 0], ['negativa', -1]])('secuencia %s', (_n, seq) => {
      const d: any = verifyOutcome(revalidated(), observation({ sequence: seq }));
      expect(d.ok).toBe(false); expect(d.next).toBe('rollback'); expect(d.exitCode).toBe(3);
      expect(['drop_order_violation', 'drop_evidence_incomplete']).toContain(d.code);
    });
    it('evidencia antigua reutilizada: la observación de la autorización no sirve después de revalidar', () => {
      rollback(verifyOutcome(revalidated(), observation({ sequence: 1 })), 'drop_order_violation');
      rollback(verifyOutcome(revalidated(make(e => { e.sequence = 5; }), later(() => undefined, 6)), observation({ sequence: 6 })), 'drop_order_violation');
      expect(verifyOutcome(revalidated(make(e => { e.sequence = 5; }), later(() => undefined, 6)), observation({ sequence: 7 }))).toMatchObject({ ok: true });
    });
    it('una secuencia mayor no compensa un contexto distinto', () => {
      rollback(verifyOutcome(revalidated(), observation({ sequence: 99, schema: 'uow_2611011200_abc123_2' })), 'drop_context_mismatch');
      rollback(verifyOutcome(revalidated(), observation({ sequence: 99, connection: { id: 'conn-0002-abcdef', pid: 4242 } })), 'drop_context_mismatch');
    });
    it.each([
      ['sin esquema', { schema: undefined }], ['sin conexión', { connection: undefined }], ['sin transacción', { transaction: undefined }],
      ['sin secuencia', { sequence: undefined }], ['id de conexión mal formado', { connection: { id: 'x', pid: 4242 } }],
      ['id de transacción mal formado', { transaction: { id: 'x y', open: true } }], ['pid inválido', { connection: { id: CONN, pid: 0 } }],
      ['open no booleano', { transaction: { id: TXN, open: 'true' } }], ['secuencia no entera', { sequence: 3.5 }],
    ])('observación mal formada: %s', (_n, over) => rollback(verifyOutcome(revalidated(), observation(over)), 'drop_evidence_incomplete'));
    it('cadenas excesivas en la observación', () => {
      rollback(verifyOutcome(revalidated(), observation({ schema: 'a'.repeat(MAX.string + 1) })), 'drop_evidence_unsafe');
      rollback(verifyOutcome(revalidated(), observation({ schema: 'a'.repeat(MAX.name + 1) })), 'drop_evidence_incomplete');
      rollback(verifyOutcome(revalidated(), observation({ connection: { id: 'a'.repeat(65), pid: 4242 } })), 'drop_evidence_incomplete');
    });
  });

  describe('orden lógico authorize -> revalidate -> verifyOutcome', () => {
    it('la cadena completa con secuencias crecientes funciona', () => {
      const a: any = authorize(make(e => { e.sequence = 10; })); const r: any = revalidate(a.plan, later(() => undefined, 11));
      expect(a.plan.stage).toBe('authorized'); expect(r.plan.stage).toBe('revalidated');
      expect(verifyOutcome(r.plan, observation({ sequence: 12 }))).toMatchObject({ ok: true, next: 'commit' });
    });
    it('no se puede verificar un resultado sin haber revalidado', () => {
      rollback(verifyOutcome(authorized(), observation()), 'drop_order_violation');
      rollback(verifyOutcome(authorized(), observation({ sequence: 99 })), 'drop_order_violation');
    });
    it('no se puede revalidar con un plan ya revalidado', () => {
      fail(revalidate(revalidated(), later(() => undefined, 9)), 'drop_order_violation');
    });
    it('una observación no es una revalidación: sus secuencias no sustituyen a las de la evidencia', () => {
      const d: any = revalidate(authorized(), observation() as any); expect(d.ok).toBe(false);
    });
    it('las funciones son puras y sin estado: repetir la misma llamada da el mismo resultado', () => {
      const p = revalidated();
      expect(verifyOutcome(p, observation())).toEqual(verifyOutcome(p, observation()));
    });
  });

  it('pérdida de L0 o L1 al terminar: ROLLBACK con fallo 3', () => {
    rollback(verifyOutcome(revalidated(), observation({ l0: false })), 'drop_lock_lost');
    rollback(verifyOutcome(revalidated(), observation({ l1: false })), 'drop_lock_lost');
  });
  it('evidencia posterior incompleta o mal formada: ROLLBACK', () => {
    for (const over of [{ remaining: { complete: false, total: 0 } }, { remaining: undefined }, { remaining: { complete: true, total: '0' } },
      { outside: { complete: false, fingerprint: OUT } }, { outside: undefined }, { outside: { complete: true, fingerprint: 5 } },
      { outside: { complete: true, fingerprint: 'F'.repeat(64) } }]) {
      rollback(verifyOutcome(revalidated(), observation(over)), 'drop_evidence_incomplete');
    }
    for (const v of [undefined, null, 'true', 1]) rollback(verifyOutcome(revalidated(), observation({ schemaAbsent: v })), 'drop_outcome_mismatch');
  });
  it('el recuento de avisos es solo una cota superior, nunca la garantía', () => {
    for (const n of [0, 1, 3, undefined, null]) expect(verifyOutcome(revalidated(), observation({ noticeCount: n }))).toMatchObject({ ok: true, next: 'commit' });
    for (const n of [4, 99]) rollback(verifyOutcome(revalidated(), observation({ noticeCount: n })), 'drop_outcome_mismatch');
    for (const n of [-1, 1.5, '3', NaN]) expect((verifyOutcome(revalidated(), observation({ noticeCount: n })) as any).ok).toBe(false);
    // Un recuento perfecto no compensa un exterior alterado ni un esquema residual ni un contexto ajeno.
    rollback(verifyOutcome(revalidated(), observation({ noticeCount: 3, outside: { complete: true, fingerprint: 'd'.repeat(64) } })), 'drop_outcome_mismatch');
    rollback(verifyOutcome(revalidated(), observation({ noticeCount: 3, schemaAbsent: false })), 'drop_outcome_mismatch');
    rollback(verifyOutcome(revalidated(), observation({ noticeCount: 3, remaining: { complete: true, total: 2 } })), 'drop_outcome_mismatch');
    rollback(verifyOutcome(revalidated(), observation({ noticeCount: 3, schema: 'uow_2611011200_abc123_2' })), 'drop_context_mismatch');
  });
  it('el plan simple no admite avisos de cascada', () => {
    const emptyOnce = (x: any) => { x.inventory.objects = []; x.inventory.total = 0; x.dependents.outbound = []; };
    const p = revalidated(make(emptyOnce), later(emptyOnce));
    expect(verifyOutcome(p, observation({ noticeCount: 0 }))).toMatchObject({ ok: true });
    rollback(verifyOutcome(p, observation({ noticeCount: 1 })), 'drop_outcome_mismatch');
  });
  it('observación hostil: getters, proxies y tipos raros terminan en ROLLBACK', () => {
    const getter = jest.fn(() => true);
    const obs = observation(); Object.defineProperty(obs, 'schemaAbsent', { get: getter, enumerable: true });
    rollback(verifyOutcome(revalidated(), obs), 'drop_evidence_unsafe'); expect(getter).not.toHaveBeenCalled();
    rollback(verifyOutcome(revalidated(), new Proxy(observation(), {})), 'drop_evidence_unsafe');
    for (const bad of [undefined, null, 5, 'x', []]) expect((verifyOutcome(revalidated(), bad) as any).next).toBe('rollback');
  });
  it('la observación de entrada nunca se modifica', () => {
    const o = observation(); const before = JSON.stringify(o); verifyOutcome(revalidated(), o); expect(JSON.stringify(o)).toBe(before);
  });
});

describe('C8 política de borrado controlado: propiedades con semilla fija', () => {
  function rng(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
  const random = rng(0xc8d0);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  function valid(): any {
    const n = Math.floor(random() * 60); const oids = new Set<number>();
    while (oids.size < n) oids.add(1 + Math.floor(random() * 1e6));
    const objects = [...oids].map(oid => obj(pick(ALLOWED_KINDS), oid));
    const e = evidence(); e.inventory.objects = objects; e.inventory.total = n;
    e.dependents.outbound = objects.slice(0, 3).map(o => ({ source: o.oid, targetSchema: pick(['pg_catalog', 'information_schema']), extension: false }));
    e.outside.fingerprint = Array.from({ length: 64 }, () => pick([...'0123456789abcdef'])).join('');
    return e;
  }
  const corruptions: [string, (e: any) => void][] = [
    ['l0', e => { e.l0 = false; }], ['l1', e => { e.l1 = false; }], ['target', e => { e.target = false; }],
    ['owner del esquema', e => { e.schema.owner = 'postgres'; }], ['nombre', e => { e.schema.name = 'public'; }],
    ['comentario', e => { e.schema.comment = 'x'; }], ['lease', e => { e.schema.leaseOwned = false; }],
    ['incompleto', e => { e.inventory.complete = false; }], ['cobertura', e => { e.inventory.coverage.pop(); }],
    ['total', e => { e.inventory.total += 1; }], ['tipo', e => { e.inventory.objects.push(obj('aggregate', 7e6)); e.inventory.total += 1; }],
    ['dueño', e => { e.inventory.objects.push(obj('table', 7e6 + 1, { owner: 'postgres' })); e.inventory.total += 1; }],
    ['extensión', e => { e.extensions.members = 1; }], ['inbound', e => { e.dependents.inbound = [{ target: e.inventory.objects[0]?.oid ?? 1, source: 9 }]; }],
    ['evento', e => { e.eventTriggers.count = 1; }], ['defaults', e => { e.defaults.count = 1; }],
    ['sesiones', e => { e.quiescence.otherRolePids = [5]; }], ['locks', e => { e.quiescence.foreignLocks = true; }],
    ['fuera', e => { delete e.outside; }], ['transacción', e => { e.transaction.readOnly = true; }],
    ['id de conexión', e => { e.connection.id = 'x'; }], ['id de transacción', e => { delete e.transaction.id; }], ['secuencia', e => { e.sequence = 0; }],
    ['cadena larga', e => { e.schema.comment = 'a'.repeat(300); }],
  ];
  it('300 evidencias válidas aleatorias se autorizan y son estables', () => {
    for (let i = 0; i < 300; i++) {
      const e = valid(); const a: any = authorize(e); const b: any = authorize(clone(e));
      expect(a.ok).toBe(true); expect(a.plan.fingerprint).toBe(b.plan.fingerprint); expect(a.plan.digest).toBe(b.plan.digest);
      expect(a.plan.action).toBe(e.inventory.objects.length ? 'drop_controlled' : 'drop_plain');
    }
  });
  it('cualquier corrupción individual de una evidencia válida se rechaza', () => {
    for (let i = 0; i < 300; i++) {
      const e = valid(); const [name, corrupt] = pick(corruptions); corrupt(e);
      const d: any = authorize(e); if (d.ok) throw new Error(`autorizó con ${name}`);
      expect([2, 3]).toContain(d.exitCode); expect(d.next).toBe('abort');
    }
  });
  it('la cadena completa funciona con inventarios aleatorios y falla ante cualquier cambio entre pasos', () => {
    const drifts: ((x: any) => void)[] = [x => { x.connection.id = 'conn-zzzz-zzzzzz'; }, x => { x.transaction.id = 'txn-zzzz-zzzzzz'; },
      x => { x.connection.pid += 1; }, x => { x.outside.fingerprint = 'c'.repeat(64); }, x => { x.sequence = 1; }];
    for (let i = 0; i < 150; i++) {
      const e = valid(); const a: any = authorize(e); expect(a.ok).toBe(true);
      const fresh = clone(e); fresh.sequence = 2;
      const r: any = revalidate(a.plan, fresh); expect(r.ok).toBe(true);
      expect(verifyOutcome(r.plan, observation({ outside: { complete: true, fingerprint: e.outside.fingerprint } }))).toMatchObject({ ok: true });
      const drift = clone(fresh); pick(drifts)(drift); expect((revalidate(a.plan, drift) as any).ok).toBe(false);
    }
  });
  it('la huella depende de cada objeto y del exterior, y no del orden', () => {
    for (let i = 0; i < 100; i++) {
      const e = valid(); if (e.inventory.objects.length < 2) continue;
      const base: any = (authorize(e) as any).plan.fingerprint;
      const shuffled = clone(e); shuffled.inventory.objects.reverse();
      expect((authorize(shuffled) as any).plan.fingerprint).toBe(base);
      const changed = clone(e); changed.inventory.objects[0].oid += 10_000_000;
      changed.dependents.outbound = []; // evita inconsistencias; el cambio de oid debe alterar la huella
      expect((authorize(changed) as any).plan.fingerprint).not.toBe(base);
      const outside = clone(e); outside.outside.fingerprint = outside.outside.fingerprint.replace(/./, (c: string) => (c === '0' ? '1' : '0'));
      expect((authorize(outside) as any).plan.fingerprint).not.toBe(base);
    }
  });
  it('quitar cualquier campo de la evidencia nunca autoriza, salvo los opcionales declarados', () => {
    const optionalOwn = new Set(['schema.lease', 'schema.ageMs']);
    const paths: string[][] = [];
    const walk = (value: any, trail: string[]) => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) return; // el contenido de los arreglos se cubre en otras pruebas
      for (const key of Object.keys(value)) { paths.push([...trail, key]); walk(value[key], [...trail, key]); }
    };
    walk(evidence(), []);
    for (const trail of paths) {
      const e = evidence(); let cursor = e; for (const key of trail.slice(0, -1)) cursor = cursor[key]; delete cursor[trail[trail.length - 1]];
      const d: any = authorize(e);
      if (optionalOwn.has(trail.join('.'))) expect(d.ok).toBe(true); else expect({ path: trail.join('.'), ok: d.ok }).toEqual({ path: trail.join('.'), ok: false });
    }
  });
});

describe('C8 política de borrado controlado: no existe ruta ejecutable', () => {
  const root = path.resolve(__dirname, '../..');
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(p) : /\.(cjs|js|mjs)$/.test(entry.name) ? [p] : [];
  });
  it('ningún literal ejecutable de scripts/ combina DROP y CASCADE', () => {
    const offenders: string[] = [];
    for (const file of sources(path.join(root, 'scripts'))) {
      const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const text = node.text; if (/drop/i.test(text) && /cascade/i.test(text)) offenders.push(`${path.basename(file)}: ${text.slice(0, 40)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(offenders).toEqual([]);
  });
  it('las plantillas y el filtro de DDL siguen sin admitir CASCADE', () => {
    const t = templates(NAME, RUN_ID);
    const everything = [t.create, t.comment, ...t.grants, ...t.revokes, t.drop];
    expect(everything.some(sql => /cascade/i.test(sql))).toBe(false);
    for (const sql of [`DROP SCHEMA "${NAME}" CASCADE`, `DROP SCHEMA "${NAME}" cascade`, `DROP SCHEMA IF EXISTS "${NAME}" CASCADE`, `${t.drop} CASCADE`]) {
      expect(allows(sql, NAME, RUN_ID)).toBe(false);
    }
    expect(allows(t.drop, NAME, RUN_ID)).toBe(true);
  });
  it('la política no está integrada en ningún módulo que ejecute o decida DDL', () => {
    const dir = path.join(root, 'scripts');
    const users = sources(dir).filter(f => !f.endsWith('c8-drop-policy.cjs') && /c8-drop-policy/.test(fs.readFileSync(f, 'utf8')));
    expect(users).toEqual([]);
  });
  it('el módulo no importa nada de E/S ni del ejecutor', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/harness/c8-drop-policy.cjs'), 'utf8');
    const required = [...source.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]).sort();
    expect(required).toEqual(['./c8-gate.cjs', './c8-names.cjs', './c8-target.cjs', './c8-timeouts.cjs', 'node:crypto', 'node:util']);
    expect(source).not.toMatch(/\bprocess\b|\bconsole\b|\bsetTimeout\b|\bsetInterval\b|\bfetch\b|\bimport\(/);
  });
  it('los resultados no contienen texto SQL en ninguna ruta', () => {
    const p = revalidated();
    for (const d of [authorize(evidence()), revalidate(authorized(), later()), verifyOutcome(p, observation()), authorize(null), verifyOutcome(null, null)]) {
      expect(JSON.stringify(d)).not.toMatch(/\b(DROP|CASCADE|ALTER|CREATE|REVOKE|GRANT|DELETE|INSERT|UPDATE|TRUNCATE)\b/i);
    }
  });
  it('exportaciones y códigos están congelados y cerrados', () => {
    expect(Object.isFrozen(CODES)).toBe(true); expect(Object.isFrozen(ALLOWED_KINDS)).toBe(true); expect(Object.isFrozen(REQUIRED_COVERAGE)).toBe(true);
    expect(Object.isFrozen(MAX)).toBe(true);
    expect(Object.values(CODES).every(v => [0, 2, 3].includes(v))).toBe(true);
    expect(Object.keys(CODES).filter(k => k !== 'ok').every(k => k.startsWith('drop_'))).toBe(true);
    for (const k of ['drop_plan_invalid', 'drop_context_mismatch', 'drop_order_violation']) expect((CODES as any)[k]).toBe(3);
  });
});
