/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { createProvenance, CODES, LIMITS, PENDING_DEPENDENCIES } from '../../scripts/harness/c8-provenance.cjs';
import * as realPolicy from '../../scripts/harness/c8-drop-policy.cjs';
import { mark } from '../../scripts/harness/c8-names.cjs';

function randomSource() {
  let counter = 0;
  return (n: number) => { const bytes = Buffer.alloc(n); bytes.writeUInt32BE(++counter); return bytes; };
}
function fakePolicy() {
  return {
    authorize: jest.fn((e: any) => ({ ok: true, code: 'ok', exitCode: 0, plan: { id: e.transaction.id, step: 1, nested: { n: 1 } } })),
    revalidate: jest.fn((p: any, _e: any) => { void _e; return { ok: true, code: 'ok', exitCode: 0, plan: { ...p, step: 2 } }; }),
    verifyOutcome: jest.fn((_p: any, _e: any) => { void _p; void _e; return { ok: true, code: 'ok', exitCode: 0 }; }),
  };
}
function setup(mode = 'acting', policy: any = fakePolicy()) {
  const provenance = createProvenance({ random: randomSource(), policy });
  const connection = provenance.openConnection({ pid: 4242 });
  const txn = connection.beginTransaction({ mode });
  return { provenance, connection, txn, policy };
}
function reject(result: any, code: keyof typeof CODES) {
  expect(result).toEqual({ ok: false, code, exitCode: 3 });
  expect(Object.isFrozen(result)).toBe(true);
}
function poisoned(txn: any) {
  expect(txn.state()).toBe('failed');
  for (const method of ['stamp', 'authorize', 'revalidate', 'verifyOutcome']) reject(txn[method]({}), 'provenance_context_lost');
}
const extraKeys = ['id', 'sequence', 'transaction', 'connection', 'transactionId'];
const name = 'uow_2611011200_abc123_1';
const run = '0123456789abcdef0123456789abcdef';
const outside = { complete: true, fingerprint: 'f'.repeat(64) };
function body() {
  return { mode: 'own', runId: run, target: true, l0: true, l1: true,
    schema: { name, comment: mark(run), owner: 'agenda_test_owner', leaseOwned: true },
    inventory: { complete: true, coverage: [...realPolicy.REQUIRED_COVERAGE], total: 1,
      objects: [{ kind: 'table', oid: 101, owner: 'agenda_test_owner', schema: name, extensionMember: false }] },
    dependents: { complete: true, inbound: [], outbound: [] }, extensions: { complete: true, members: 0 },
    eventTriggers: { complete: true, count: 0 }, defaults: { complete: true, count: 0 }, outside,
    quiescence: { runSessions: 0, otherRolePids: [], foreignLocks: false } };
}
function observation() {
  return { schema: name, schemaAbsent: true, remaining: { complete: true, total: 0 }, outside, noticeCount: 1, l0: true, l1: true };
}

describe('C8 procedencia: construcción e identidades', () => {
  it.each([undefined, null, {}, { policy: null }, { policy: {} },
    ...['authorize', 'revalidate', 'verifyOutcome'].map(key => ({ policy: { ...fakePolicy(), [key]: 3 } })),
    { random: 4, policy: fakePolicy() }])('falla cerrado con dependencias ausentes/incompletas %#', options => {
    expect(() => createProvenance(options as any)).toThrow();
  });
  it('genera internamente ids opacos únicos y acepta el generador predeterminado', () => {
    const p = createProvenance({ policy: fakePolicy() });
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const c = p.openConnection({ pid: 9 });
      const t = c.beginTransaction({ mode: 'acting' });
      const e = t.stamp({});
      for (const id of [e.connection.id, e.transaction.id]) {
        expect(id).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
        expect(id).toMatch(/^(conn|txn)-[a-f0-9]{32}$/);
        expect(ids.has(id)).toBe(false); ids.add(id);
      }
      c.close();
    }
  });
  it.each(extraKeys)('impide inyectar %s al abrir o iniciar', key => {
    const { provenance, connection } = setup();
    expect(() => provenance.openConnection({ pid: 1, [key]: 1 })).toThrow();
    const c = provenance.openConnection({ pid: 2 });
    expect(() => c.beginTransaction({ mode: 'acting', [key]: 1 })).toThrow();
    connection.close();
  });
  it.each([0, -1, 1.5, NaN, Infinity, '1', undefined, Number.MAX_SAFE_INTEGER + 1])('rechaza pid inválido %s', pid => {
    expect(() => setup().provenance.openConnection({ pid })).toThrow();
  });
  it('acepta pid entero seguro como afirmación, sin comprobar un backend', () => {
    const c = setup().provenance.openConnection({ pid: Number.MAX_SAFE_INTEGER });
    expect(c.beginTransaction({ mode: 'acting' }).stamp({}).connection.pid).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each(['other', null, undefined, 1])('rechaza modo inválido %s', mode => {
    const c = setup().provenance.openConnection({ pid: 1 });
    expect(() => c.beginTransaction({ mode })).toThrow();
  });
  it('rechaza getters sin invocarlos, proxies y prototipos exóticos en argumentos', () => {
    const getter = jest.fn(() => 1);
    const hostile = [Object.defineProperty({}, 'pid', { get: getter }), new Proxy({ pid: 1 }, {}),
      Object.assign(Object.create({}), { pid: 1 }), { pid: 1, [Symbol('extra')]: 1 }];
    const p = setup().provenance;
    for (const arg of hostile) expect(() => p.openConnection(arg)).toThrow();
    const c = p.openConnection({ pid: 1 });
    for (const arg of [Object.defineProperty({}, 'mode', { get: getter }), new Proxy({ mode: 'acting' }, {}),
      Object.assign(Object.create({}), { mode: 'acting' }), { mode: 'acting', [Symbol('extra')]: 1 }]) {
      expect(() => c.beginTransaction(arg)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([() => Buffer.alloc(15), () => Buffer.alloc(17), () => [1, 2], () => 'bad',
    () => new Uint16Array(16), () => new Proxy(new Uint8Array(16), {}), () => { throw new Error('random'); }])(
    'random defectuoso cierra la fábrica %#', random => {
      const p = createProvenance({ random: random as any, policy: fakePolicy() });
      expect(() => p.openConnection({ pid: 1 })).toThrow();
      expect(() => p.openConnection({ pid: 2 })).toThrow();
    });
  it('acepta Uint8Array de longitud exacta e ignora iterator/length falsificados', () => {
    const bytes = new Uint8Array(16);
    Object.defineProperty(bytes, 'length', { value: 1 });
    const p = createProvenance({ random: () => bytes, policy: fakePolicy() });
    expect(p.openConnection({ pid: 1 }).isLive()).toBe(true);
  });
  it.each([false, true])('detecta colisiones de conexiones vivas/retiradas: %s', retired => {
    const p = createProvenance({ random: n => Buffer.alloc(n), policy: fakePolicy() });
    const c = p.openConnection({ pid: 1 });
    const t = c.beginTransaction({ mode: 'acting' });
    if (retired) c.close();
    expect(() => p.openConnection({ pid: 2 })).toThrow();
    expect(c.isLive()).toBe(false); poisoned(t);
  });
  it('detecta colisión transaccional retirada y conserva contador entre transacciones', () => {
    const p = createProvenance({ random: n => Buffer.alloc(n), policy: fakePolicy() });
    const c = p.openConnection({ pid: 1 });
    c.beginTransaction({ mode: 'acting' }).end();
    expect(() => c.beginTransaction({ mode: 'acting' })).toThrow();
    expect(c.isLive()).toBe(false);
  });
  it('rechaza segunda transacción simultánea', () => {
    const { connection, txn } = setup();
    expect(() => connection.beginTransaction({ mode: 'assessment' })).toThrow();
    expect(txn.state()).toBe('idle');
    txn.end(); expect(connection.beginTransaction({ mode: 'acting' }).state()).toBe('idle');
  });
  it('falla cerrado al alcanzar el tope transaccional', () => {
    const { connection, txn } = setup(); txn.end();
    for (let i = 1; i < LIMITS.transactionsPerConnection; i++) connection.beginTransaction({ mode: 'acting' }).end();
    expect(() => connection.beginTransaction({ mode: 'acting' })).toThrow();
    expect(connection.isLive()).toBe(false);
  });
  it('acota también conexiones e identificadores globales sin evicción', () => {
    const p = createProvenance({ random: randomSource(), policy: fakePolicy() });
    for (let i = 0; i < LIMITS.connections; i++) p.openConnection({ pid: 1 }).close();
    expect(() => p.openConnection({ pid: 1 })).toThrow();
    const q = createProvenance({ random: randomSource(), policy: fakePolicy() });
    let issued = 0;
    while (issued < LIMITS.identifiers) {
      const c = q.openConnection({ pid: 1 }); issued++;
      for (let j = 0; j < LIMITS.transactionsPerConnection && issued < LIMITS.identifiers; j++, issued++) {
        c.beginTransaction({ mode: 'acting' }).end();
      }
      c.close();
    }
    expect(() => q.openConnection({ pid: 1 })).toThrow();
  });
});

describe('C8 procedencia: sellado y un solo uso', () => {
  it('secuencia contigua por conexión, incluso entre transacciones, y copia profunda congelada', () => {
    const { connection, txn } = setup();
    const source = { nested: { items: [1, 2] } };
    const e = txn.stamp(source); source.nested.items.push(3);
    expect(e.nested.items).toEqual([1, 2]);
    for (const item of [e, e.nested, e.nested.items, e.connection, e.transaction]) expect(Object.isFrozen(item)).toBe(true);
    expect(e.sequence).toBe(1); expect(txn.stamp({}).sequence).toBe(2);
    txn.end();
    const next = connection.beginTransaction({ mode: 'acting' }).stamp({});
    expect(next.sequence).toBe(3); expect(next.connection.id).toBe(e.connection.id);
    expect(next.transaction.id).not.toBe(e.transaction.id);
    expect(next.transaction).toMatchObject({ open: true, readOnly: false, lockTimeoutMs: 2000 });
  });
  it.each(['connection', 'transaction', 'sequence'])('no admite %s en body', key => {
    const { txn } = setup(); reject(txn.stamp({ [key]: 1 }), 'provenance_invalid'); poisoned(txn);
  });
  it('sellado fallido no introduce saltos ni reutilización en la secuencia de conexión', () => {
    const { connection, txn } = setup(); expect(txn.stamp({}).sequence).toBe(1);
    reject(txn.stamp({ sequence: 7 }), 'provenance_invalid');
    const next = connection.beginTransaction({ mode: 'acting' });
    expect(next.stamp({}).sequence).toBe(2); expect(next.stamp({}).sequence).toBe(3);
  });
  it('rechaza cuerpos hostiles, revocados, ciclos, arrays dispersos y accessors sin invocarlos', () => {
    const getter = jest.fn(() => 1);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const cycle: any = {}; cycle.self = cycle;
    const values = [null, undefined, 1, [], new Proxy({}, {}), revoked.proxy, Object.create({}),
      Object.defineProperty({}, 'x', { get: getter }), { nested: Object.defineProperty({}, 'x', { get: getter }) },
      { nested: new Proxy({}, {}) }, Object.defineProperty({}, 'hidden', { value: new Proxy({}, {}) }),
      { x: new Map() }, { x: () => 1 }, { x: Infinity }, { x: new Array(2) }, { [Symbol('s')]: 1 }, cycle];
    for (const value of values) { const { txn } = setup(); reject(txn.stamp(value), 'provenance_invalid'); poisoned(txn); }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['clone', 'spread', 'json', 'proxy', 'forged', 'revoked'])('rechaza evidencia %s', kind => {
    const { txn, policy } = setup(); const e = txn.stamp({});
    const revoked = Proxy.revocable(e, {}); revoked.revoke();
    const variants: Record<string, any> = { clone: structuredClone(e), spread: { ...e }, json: JSON.parse(JSON.stringify(e)),
      proxy: new Proxy(e, {}), forged: { connection: e.connection, transaction: e.transaction, sequence: e.sequence }, revoked: revoked.proxy };
    reject(txn.authorize(variants[kind]), 'provenance_not_issued');
    expect(policy.authorize).not.toHaveBeenCalled(); poisoned(txn);
  });
  it.each(['authorize', 'revalidate', 'verifyOutcome'])('doble %s nunca tiene éxito', method => {
    const { txn } = setup(); const t: any = txn;
    if (method !== 'authorize') expect(t.authorize(t.stamp({})).ok).toBe(true);
    if (method === 'verifyOutcome') expect(t.revalidate(t.stamp({})).ok).toBe(true);
    const e = t.stamp({}); expect(t[method](e).ok).toBe(true);
    reject(t[method](e), method === 'verifyOutcome' ? 'provenance_context_lost' : 'provenance_replayed');
    expect(t.state()).toBe(method === 'verifyOutcome' ? 'verified' : 'failed');
  });
  it('replay entre etapas se consume y envenena', () => {
    const { txn } = setup(); const e = txn.stamp({}); txn.authorize(e);
    reject(txn.revalidate(e), 'provenance_replayed'); poisoned(txn);
  });
  it.each(['transaction', 'connection'])('rechaza otra %s y consume evidencia incluso al fallar', kind => {
    const { txn, connection, provenance } = setup(); const e = txn.stamp({});
    if (kind === 'transaction') txn.end();
    const other = (kind === 'transaction' ? connection : provenance.openConnection({ pid: 4242 })).beginTransaction({ mode: 'acting' });
    reject(other.authorize(e), 'provenance_cross_context'); poisoned(other);
    if (kind === 'connection') { reject(txn.authorize(e), 'provenance_replayed'); poisoned(txn); }
  });
  it('otra fábrica con ids iguales no comparte registro; ids intercambiados no autentican', () => {
    const a = setup(); const b = setup();
    const e = a.txn.stamp({}); const f = b.txn.stamp({});
    expect(e.connection).toEqual(f.connection); expect(e.transaction).toEqual(f.transaction);
    reject(a.txn.authorize(f), 'provenance_not_issued');
    reject(b.txn.authorize({ ...e, connection: f.connection, transaction: f.transaction }), 'provenance_not_issued');
  });
  it.each(['revalidate', 'verifyOutcome'])('rechaza %s antes de authorize', method => {
    const { txn } = setup(); reject((txn as any)[method](txn.stamp({})), 'provenance_state'); poisoned(txn);
  });
  it.each(['authorize', 'verifyOutcome'])('rechaza %s desde authorized', method => {
    const { txn } = setup(); txn.authorize(txn.stamp({}));
    reject((txn as any)[method](txn.stamp({})), 'provenance_state'); poisoned(txn);
  });
  it('rechaza evidencia obsoleta emitida antes de la consumida', () => {
    const { txn } = setup(); const old = txn.stamp({}); const fresh = txn.stamp({});
    expect(txn.authorize(fresh).ok).toBe(true);
    reject(txn.revalidate(old), 'provenance_out_of_order'); poisoned(txn);
  });
  it('assessment nunca llama authorize, incluso con una política permisiva', () => {
    const { txn, policy } = setup('assessment'); const e = txn.stamp({});
    expect(e.transaction.readOnly).toBe(true);
    reject(txn.authorize(e), 'provenance_state'); expect(policy.authorize).not.toHaveBeenCalled(); poisoned(txn);
  });
});

describe('C8 procedencia: decisiones, contexto y encapsulación', () => {
  it.each(['authorize', 'revalidate', 'verifyOutcome'])('denegación/excepción en %s es terminal', method => {
    for (const throws of [false, true]) {
      const { txn, policy } = setup();
      if (method !== 'authorize') txn.authorize(txn.stamp({}));
      if (method === 'verifyOutcome') txn.revalidate(txn.stamp({}));
      policy[method].mockImplementation(() => {
        if (throws) throw new Error('private exception');
        return { ok: false, code: 'policy_denied', exitCode: 2, next: 'abort' };
      });
      const d = (txn as any)[method](txn.stamp({}));
      if (throws) reject(d, 'provenance_invalid');
      else { expect(d).toEqual({ ok: false, code: 'policy_denied', exitCode: 2, next: 'abort' }); expect(Object.isFrozen(d)).toBe(true); }
      poisoned(txn);
    }
  });
  it.each([null, {}, { ok: true, code: 'ok', exitCode: 0 }, { ok: 'true', code: 'ok', exitCode: 0 },
    { ok: false, code: 'bad', exitCode: 0 }, Promise.resolve({ ok: true })])('resultado inválido falla cerrado %#', result => {
    const { txn, policy } = setup(); policy.authorize.mockReturnValue(result);
    reject(txn.authorize(txn.stamp({})), 'provenance_invalid'); poisoned(txn);
  });
  it('plan privado separado del informativo; argumentos extra ignorados sin leerlos', () => {
    const { txn, policy } = setup(); const t: any = txn;
    const a = t.authorize(t.stamp({}));
    expect(() => { a.plan.nested.n = 9; }).toThrow();
    const hostile = new Proxy({}, { get: () => { throw new Error('unused'); } });
    const fresh = t.stamp({}); const r = t.revalidate(fresh, hostile);
    expect(r.ok).toBe(true);
    expect(policy.revalidate.mock.calls[0][0]).toEqual(a.plan);
    expect(policy.revalidate.mock.calls[0][0]).not.toBe(a.plan);
    expect(policy.revalidate.mock.calls[0][1]).toBe(fresh);
    expect(t.verifyOutcome(t.stamp({}), hostile).ok).toBe(true);
    expect(policy.verifyOutcome.mock.calls[0][0]).toEqual(r.plan);
    expect(policy.verifyOutcome.mock.calls[0][0]).not.toBe(r.plan);
    expect(t.state()).toBe('verified');
    for (const method of ['stamp', 'authorize', 'revalidate', 'verifyOutcome']) reject(t[method]({}), 'provenance_context_lost');
    t.end(); expect(t.state()).toBe('verified');
  });
  it.each(['close', 'markLost', 'end'])('%s invalida evidencias y handles derivados', method => {
    const { connection, txn } = setup(); const e = txn.stamp({});
    if (method === 'end') txn.end(); else (connection as any)[method]();
    reject(txn.authorize(e), 'provenance_context_lost'); poisoned(txn);
    if (method !== 'end') {
      expect(connection.isLive()).toBe(false);
      expect(() => connection.beginTransaction({ mode: 'acting' })).toThrow();
    } else expect(connection.beginTransaction({ mode: 'acting' }).state()).toBe('idle');
  });
  it('retirar un handle viejo no invalida la siguiente transacción', () => {
    const { connection, txn } = setup(); txn.end();
    const next = connection.beginTransaction({ mode: 'acting' });
    txn.end(); reject(txn.stamp({}), 'provenance_context_lost');
    expect(next.authorize(next.stamp({})).ok).toBe(true);
    connection.close(); poisoned(next);
  });
  it('éxito terminal permite otra transacción y no recicla ids ni secuencias', () => {
    const { connection, txn } = setup(); const e = txn.stamp({});
    txn.authorize(e); txn.revalidate(txn.stamp({})); txn.verifyOutcome(txn.stamp({}));
    const next = connection.beginTransaction({ mode: 'acting' }).stamp({});
    expect(next.sequence).toBe(4); expect(next.transaction.id).not.toBe(e.transaction.id);
  });
  it('handles congelados, sin propiedades de estado, plan, registros ni símbolos', () => {
    const { provenance, connection, txn } = setup(); txn.authorize(txn.stamp({}));
    const handles: [any, string[]][] = [[provenance, ['openConnection']],
      [connection, ['beginTransaction', 'close', 'markLost', 'isLive']],
      [txn, ['stamp', 'authorize', 'revalidate', 'verifyOutcome', 'end', 'state']]];
    for (const [handle, keys] of handles) {
      expect(Object.isFrozen(handle)).toBe(true); expect(Reflect.ownKeys(handle).sort()).toEqual(keys.sort());
      expect(Object.values(Object.getOwnPropertyDescriptors(handle)).every((d: any) => typeof d.value === 'function' && !d.writable)).toBe(true);
      expect(() => { handle.plan = {}; }).toThrow();
    }
  });
  it('cierre o reentrada durante una decisión no puede resucitar el contexto', () => {
    for (const action of ['close', 'end', 'authorize', 'stamp']) {
      const { txn, connection, policy } = setup(); const e = txn.stamp({});
      policy.authorize.mockImplementation(() => {
        if (action === 'close') connection.close();
        else if (action === 'end') txn.end();
        else (txn as any)[action](e);
        return { ok: true, code: 'ok', exitCode: 0, plan: { id: 'fake' } };
      });
      reject(txn.authorize(e), 'provenance_context_lost'); poisoned(txn);
    }
  });
  it('reentrada en random cierra la fábrica', () => {
    const p: ReturnType<typeof createProvenance> = createProvenance({ policy: fakePolicy(), random: n => {
      expect(() => p.openConnection({ pid: 2 })).toThrow(); return Buffer.alloc(n);
    } });
    expect(() => p.openConnection({ pid: 1 })).toThrow();
  });
  it('camino completo con política real, sin resultados ejecutables', () => {
    const { txn } = setup('acting', realPolicy);
    const a = txn.authorize(txn.stamp(body())); expect(a.ok).toBe(true);
    const r = txn.revalidate(txn.stamp(body())); expect(r.ok).toBe(true);
    const v = txn.verifyOutcome(txn.stamp(observation())); expect(v).toMatchObject({ ok: true, code: 'ok', exitCode: 0, next: 'commit' });
    expect(txn.state()).toBe('verified');
    for (const result of [a, r, v]) expect(JSON.stringify(result)).not.toMatch(/\b(DROP|CASCADE|SELECT|ALTER|CREATE|REVOKE|GRANT|DELETE|INSERT|UPDATE|TRUNCATE)\b/i);
  });
  it('conserva códigos de incertidumbre de la política real', () => {
    const { txn } = setup('acting', realPolicy);
    expect(txn.authorize(txn.stamp({}))).toMatchObject({ ok: false, code: 'drop_lock_lost', exitCode: 3 }); poisoned(txn);
  });
});

describe('C8 procedencia: reentrada adversarial de la política', () => {
  const operations = ['authorize', 'revalidate', 'verifyOutcome'] as const;
  const attempts = ['stamp', ...operations, 'end', 'beginTransaction'] as const;

  describe.each(operations)('durante %s', operation => {
    it.each(attempts)('retira el contexto al reentrar mediante %s', attempt => {
      const { txn, connection, policy } = setup();
      const stage = operations.indexOf(operation);
      for (const previous of operations.slice(0, stage)) expect(txn[previous](txn.stamp(body())).ok).toBe(true);

      // Ambas evidencias preceden al callback: la segunda es auténtica, fresca y sin consumir.
      const current = txn.stamp(operation === 'verifyOutcome' ? observation() : body());
      const later = txn.stamp(attempt === 'verifyOutcome' ? observation() : body());
      expect(later.sequence).toBe(current.sequence + 1);
      expect(later.connection).toEqual(current.connection);
      expect(later.transaction).toEqual(current.transaction);
      const successful = policy[operation].getMockImplementation();
      let nestedResult: any;
      let nestedError: unknown;
      let stateAfterReentry: string | undefined;
      // Solo la primera invocación reentra. Sin la guarda, la segunda puede completar realmente
      // la misma operación; no usamos recursión infinita ni un replay que falle por otro motivo.
      policy[operation].mockImplementationOnce((...args: any[]) => {
        try {
          if (attempt === 'beginTransaction') nestedResult = connection.beginTransaction({ mode: 'acting' });
          else if (attempt === 'end') nestedResult = txn.end();
          else if (attempt === 'stamp') nestedResult = txn.stamp(body());
          else nestedResult = txn[attempt](later);
        } catch (error) {
          // Un callback hostil puede capturar el rechazo de begin y aun devolver un éxito.
          nestedError = error;
        }
        stateAfterReentry = txn.state();
        return successful(...args);
      });

      let outerResult: any;
      expect(() => { outerResult = txn[operation](current); }).not.toThrow();
      // Aserciones fuera del callback: decide captura excepciones, incluidas las de Jest.
      if (attempt === 'beginTransaction') {
        expect(nestedError).toBeInstanceOf(Error);
        expect((nestedError as Error).message).toBe('provenance_invalid');
        expect(nestedResult).toBeUndefined();
      } else {
        expect(nestedError).toBeUndefined();
        if (attempt === 'end') expect(nestedResult).toBeUndefined();
        else reject(nestedResult, 'provenance_state');
      }
      expect(stateAfterReentry).toBe('failed');
      reject(outerResult, 'provenance_context_lost');
      poisoned(txn);
      for (const method of operations) reject(txn[method](later), 'provenance_context_lost');
      // Cada etapa alcanzada se invocó exactamente una vez; ninguna etapa posterior se ejecutó.
      for (const [index, method] of operations.entries()) {
        expect(policy[method]).toHaveBeenCalledTimes(index <= stage ? 1 : 0);
      }
    });
  });
});

describe('C8 procedencia: invariantes y superficie estática', () => {
  it('secuencias pseudoaleatorias nunca autorizan dos veces un mismo plan', () => {
    let seed = 0xc8c1;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 16; };
    const p = createProvenance({ random: randomSource(), policy: fakePolicy() });
    const c = p.openConnection({ pid: 1 });
    const plans = new Set<string>(); const operations = new Set<string>(); let sequence = 0;
    for (let trial = 0; trial < 400; trial++) {
      const t: any = c.beginTransaction({ mode: 'acting' }); const evidence: any[] = [];
      for (let step = 0; step < 20; step++) {
        const e = t.stamp({});
        if (e.sequence !== undefined) { expect(e.sequence).toBe(++sequence); evidence.push(e); }
        const method = ['authorize', 'revalidate', 'verifyOutcome', 'end'][next() % 4];
        operations.add(method);
        const selected = evidence[next() % (evidence.length || 1)];
        const result = t[method](selected);
        if (method === 'authorize' && result.ok) {
          expect(plans.has(result.plan.id)).toBe(false); plans.add(result.plan.id);
        }
        if (['failed', 'verified'].includes(t.state())) {
          const terminal = t.state(); expect(t.authorize(selected).ok).toBe(false); expect(t.state()).toBe(terminal);
        }
      }
      t.end();
    }
    expect(plans.size).toBeGreaterThan(0);
    expect([...operations].sort()).toEqual(['authorize', 'end', 'revalidate', 'verifyOutcome']);
  });
  it('exportaciones y dependencias pendientes son explícitas e inmutables', () => {
    for (const value of [CODES, LIMITS, PENDING_DEPENDENCIES]) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(CODES).every(key => key.startsWith('provenance_'))).toBe(true);
    expect(Object.values(CODES).every(code => code === 3)).toBe(true);
    const text = PENDING_DEPENDENCIES.join(' ');
    expect(text).toMatch(/pid\/backend_start.*pg_stat_activity/);
    expect(text).toMatch(/transaction identity.*not implemented/);
    expect(text).toMatch(/l0\/l1.*unverified caller/);
  });
  it('solo importa crypto y no contiene rutas ejecutables prohibidas', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/harness/c8-provenance.cjs'), 'utf8');
    const ast = ts.createSourceFile('provenance.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = []; const violations: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        expect(node.arguments.length).toBe(1); expect(ts.isStringLiteral(node.arguments[0])).toBe(true);
        imports.push((node.arguments[0] as ts.StringLiteral).text);
      }
      if (ts.isIdentifier(node) && /^(Date|eval|Function|console|process|fetch|pg_current_xact_id|xid)$/.test(node.text)) violations.push(node.text);
      if (ts.isPropertyAccessExpression(node) && node.getText(ast) === 'Math.random') violations.push(node.getText(ast));
      if (ts.isStringLiteralLike(node) && /\b(SELECT|DROP|CASCADE|ALTER|CREATE|DELETE|INSERT|UPDATE|TRUNCATE|GRANT|REVOKE)\b/i.test(node.text)) violations.push(node.text);
      ts.forEachChild(node, visit);
    }
    visit(ast); expect(imports).toEqual(['node:crypto']); expect(violations).toEqual([]);
    expect(source.startsWith("'use strict';")).toBe(true);
    expect(source).not.toMatch(/c8-drop-policy|pg_current_xact_id|\bCASCADE\b/);
  });
});
