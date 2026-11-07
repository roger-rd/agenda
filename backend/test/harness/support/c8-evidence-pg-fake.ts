import { get } from '../../../scripts/harness/c8-evidence-queries.cjs';
import { lookup } from '../../../scripts/harness/c8-pg-queries.cjs';
import { mark } from '../../../scripts/harness/c8-names.cjs';
import { PLAN, BEGIN_SQL, ROLLBACK_SQL } from '../../../scripts/c8-validate-evidence.cjs';
import { roleAttrs, coverage, effective, PASSWORD } from './c8-pg-fakes';

export const SCHEMA = 'uow_2611011200_abc123_1';
export const RUN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const PID = 4242;
export { PASSWORD };
export type Rows = Record<string, unknown>[];
export type World = Record<string, Rows>;

/** Text of every planned statement, keyed by step id. */
export const TEXT: Record<string, string> = Object.fromEntries(PLAN.map(s => [s.id, s.source === 'evidence' ? get(s.id).sql : lookup(s.id).sql]));
export const ID_OF = new Map(Object.entries(TEXT).map(([id, text]) => [text, id]));

/** A valid, empty target schema: every gate passes and the offline chain runs on 22 valid results. */
export function world(): World {
  const counts = Object.fromEntries(get('ev_namespace_catalog_counts').columns.map(c => [c.name, '0']));
  const census = ['namespace', 'class', 'proc', 'type', 'constraint', 'trigger', 'policy', 'extension', 'event_trigger', 'default_acl']
    .map(catalog => ({ catalog, n: catalog === 'namespace' ? '3' : '0', digest: 'f'.repeat(64) }));
  return {
    ev_context: [{ pid: PID, backend_start: '2026-11-06 10:00:00+00', database: 'agenda_test', current_user: 'agenda_test_app', session_user: 'agenda_test_app',
      transaction_read_only: 'on', transaction_isolation: 'repeatable read', lock_timeout: '2s', statement_timeout: '5s',
      idle_in_transaction_session_timeout: '15s', server_version_num: '160015', in_recovery: false }],
    ev_namespace: [{ oid: 20, name: SCHEMA, owner: 'agenda_test_owner', comment: mark(RUN), acl: null }],
    effective_coverage: [{ schema_oid: 20, tables: '0', sequences: '0', routines: '0' }],
    role_attrs: roleAttrs() as Rows,
    auth_members: [],
    database: [{ oid: 42, datname: 'agenda_test', datdba: 10, can_connect: true, can_create: false, can_temporary: false }],
    ev_role_membership: [{ oid: 10, membership: false, set_membership: false }, { oid: 12, membership: false, set_membership: false }],
    ev_default_acl_schema: [], ev_default_acl_global: [],
    effective: [{ kind: 'schema', oid: 20, privilege: 'USAGE', effective: false, is_grantable: false },
      { kind: 'schema', oid: 20, privilege: 'CREATE', effective: false, is_grantable: false }],
    ev_relations: [], ev_routines: [], ev_types: [], ev_namespace_catalog_counts: [counts], ev_companions: [], ev_closure: [],
    ev_external_dependents: [], ev_extension_members: [], ev_event_triggers: [], ev_outside_census: census, ev_sessions: [],
    ev_target_relation_locks: [], ev_advisory_holders: [], ev_prepared_xacts: [], ev_outbound_references: [], ev_companion_items: [],
    ev_internal_edges: [],
  };
}
/** The same world with one table, one sequence and one routine so that every privilege class is observable by the gate. */
export function richWorld(): World {
  const w = world();
  w.effective_coverage = coverage() as Rows;
  w.effective = effective() as unknown as Rows;
  return w;
}

/** Same-realm deep copy: structuredClone would hand the C3 readers objects with a foreign Object.prototype, which they reject by design. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export type Time = ReturnType<typeof fakeTime>;
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
/** Deterministic monotonic clock and timers: nothing runs until advance() is called. */
export function fakeTime() {
  let now = 1000; let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const time = {
    clock: () => now,
    timers: { set: (fn: () => void, ms: number): unknown => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
      clear: (handle: unknown) => { timers.delete(handle as number); } },
    pending: () => timers.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].fn(); await flush();
      }
      now = target; await flush();
    },
    /** Runs the promise to completion, advancing fake time in small steps. */
    async drive<T>(promise: Promise<T>, step = 250, limit = 200000): Promise<T> {
      let done = false;
      promise.then(() => { done = true; }, () => { done = true; });
      for (let t = 0; !done && t < limit; t += step) await time.advance(step);
      return promise;
    },
  };
  return time;
}
export function fakeSignals() {
  const handlers = new Map<string, Set<() => void>>();
  return { on: (name: string, fn: () => void) => { handlers.set(name, (handlers.get(name) ?? new Set()).add(fn)); },
    off: (name: string, fn: () => void) => { handlers.get(name)?.delete(fn); },
    emit: (name: string) => { for (const fn of [...(handlers.get(name) ?? [])]) fn(); },
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) };
}

export type Mode = 'ok' | 'fail' | 'hang';
export type Scripted = { rows?: unknown; raw?: unknown; error?: unknown; hang?: boolean; delayMs?: number; after?: () => void };
export const sqlError = (code: string) => ({ code, message: PASSWORD, stack: PASSWORD });

/** pg.Client stand-in. It models what was read in pg 8.23.1: SQL errors leave the transaction in 'E', where only ROLLBACK works. */
export function evidenceFake(initial: World = world(), time?: ReturnType<typeof fakeTime>) {
  const log: { text: string; values: unknown[] }[] = [];
  const events: string[] = [];
  const configs: Record<string, unknown>[] = [];
  const instances: FakeClient[] = [];
  const data: World = initial;
  const script = new Map<string, Scripted>();
  const control = { connect: 'ok' as Mode, begin: 'ok' as Mode, rollback: 'ok' as Mode, end: 'ok' as Mode, rollbackStatus: undefined as string | undefined,
    pid: PID, rollbackDelayMs: 0 };
  const sleep = (ms: number) => new Promise<void>(resolve => { if (!time) throw new Error('fake time required'); time.timers.set(resolve, ms); });
  class FakeClient {
    processID: number = control.pid;
    txState = 'I';
    ended = false;
    listeners = new Map<string, ((e: unknown) => void)[]>();
    connection = { stream: { destroy: jest.fn() } };
    constructor(config: Record<string, unknown>) { configs.push(config); instances.push(this); }
    on(event: string, fn: (e: unknown) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]); return this; }
    emit(event: string, arg?: unknown) { for (const fn of this.listeners.get(event) ?? []) fn(arg); }
    async connect() {
      events.push('connect');
      if (control.connect === 'hang') return new Promise<void>(() => undefined);
      if (control.connect === 'fail') throw Object.assign(new Error(PASSWORD), { stack: PASSWORD });
    }
    getTransactionStatus() { return this.txState; }
    async query(text: string, values: unknown[] = []) {
      log.push({ text, values: copy(values) });
      const id = ID_OF.get(text);
      events.push(text === BEGIN_SQL ? 'BEGIN' : text === ROLLBACK_SQL ? 'ROLLBACK' : id ?? `UNKNOWN:${text.slice(0, 40)}`);
      if (this.ended) throw new Error('Client was closed and is not queryable');
      if (this.txState === 'E' && text !== ROLLBACK_SQL) throw sqlError('25P02');
      if (text === BEGIN_SQL) {
        if (control.begin === 'hang') return new Promise(() => undefined);
        if (control.begin === 'fail') throw sqlError('XX000');
        this.txState = 'T'; return { rows: [] };
      }
      if (text === ROLLBACK_SQL) {
        if (control.rollbackDelayMs) await sleep(control.rollbackDelayMs);
        if (control.rollback === 'hang') return new Promise(() => undefined);
        if (control.rollback === 'fail') throw sqlError('XX000');
        this.txState = control.rollbackStatus ?? 'I'; return { rows: [] };
      }
      const s = id ? script.get(id) : undefined;
      if (s?.delayMs) await sleep(s.delayMs);
      if (s?.hang) return new Promise(() => undefined);
      if (s?.error) { this.txState = 'E'; throw s.error; }
      s?.after?.();
      if (!id) throw sqlError('42601');
      if (s && 'raw' in s) return s.raw;
      return { rows: copy(s?.rows ?? data[id]) };
    }
    async end() {
      events.push('end'); this.ended = true;
      if (control.end === 'hang') return new Promise<void>(() => undefined);
      if (control.end === 'fail') throw new Error(PASSWORD);
    }
  }
  return { pgModule: { Client: FakeClient }, log, events, configs, instances, data, script, control,
    texts: () => log.map(l => l.text), ids: () => events.filter(e => e !== 'connect' && e !== 'end') };
}
