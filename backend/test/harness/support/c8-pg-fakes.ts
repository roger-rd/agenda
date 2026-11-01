import { lookup, SYSTEM, CATALOG } from '../../../scripts/harness/c8-pg-queries.cjs';
import { L0_KEY, EXPECTED, EMPTY_FIELDS } from '../../../scripts/harness/c8-pg-adapter.cjs';
import { TARGET } from '../../../scripts/harness/c8-target.cjs';
export const NAME = 'uow_2611011200_abc123_1';
export const NOW = Date.UTC(2026, 10, 1, 13);
export const PASSWORD = 'SYNTHETIC-secret-unique-C8-!';
export const identity = (role: 'owner' | 'app', pid = 100) => ({ database: TARGET.database,
  current_user: TARGET[role], session_user: TARGET[role], read_only: 'on', recovery: false, pid });
export const roleAttrs = () => ['owner', 'app'].map((role, i) => ({ oid: 10 + i,
  rolname: TARGET[role as 'owner' | 'app'], rolsuper: false, rolcreatedb: false, rolcreaterole: false,
  rolreplication: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: -1, rolconfig: null }));
export const server = () => ({ version: '160004', max_connections: '100', statement_timeout: '5s',
  lock_timeout: '2s', idle_in_transaction_session_timeout: '15s', idle_session_timeout: '0', search_path: '"$user", public' });
export const identityEvidence = () => ({ version_text: 'PostgreSQL 16.4 on synthetic', server_addr: '10.0.0.2',
  postmaster_epoch: String(NOW / 1000 - 3600), server_now_epoch: String(NOW / 1000) });
export const coverage = () => [{ schema_oid: 20, tables: '1', sequences: '1', routines: '1' }];
export function effective() {
  return Object.entries(EXPECTED).flatMap(([kind, privileges]) => privileges.map(privilege => ({ kind,
    oid: kind === 'schema' ? 20 : ['table', 'column'].includes(kind) ? 21 : kind === 'sequence' ? 22 : 23,
    privilege, effective: false as boolean | null, is_grantable: false as boolean | null })));
}
export const empty = () => [Object.fromEntries(EMPTY_FIELDS.map(k => [k, '0']))];
export const holder = () => ({ key: L0_KEY, locktype: 'advisory', database: 42, objsubid: 1,
  granted: true, usename: TARGET.owner, pid: 102 });
export const credentials = (role: 'owner' | 'app', level: 'A' | 'B' = 'A') => ({ ...TARGET,
  user: TARGET[role], password: PASSWORD, level });
export function seeded(seed = 82901) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
}
export type RecordCall = { sql: string; params: unknown[]; pid: number };
export function pgFake() {
  const calls: RecordCall[] = [];
  const events: string[] = [];
  const logicalCalls: { role: string; id: string; params: unknown[] }[] = [];
  const configs: Record<string, unknown>[] = [];
  const instances: FakeClient[] = [];
  const results = new Map<string, unknown>();
  const errors = new Map<string, unknown>();
  let heldBy = 0;
  const controls = { connectError: undefined as unknown, endError: undefined as unknown,
    before: async (_sql: string) => { void _sql; } };
  class FakeClient {
    processID: number;
    role: 'owner' | 'app';
    destroyed = false;
    ended = false;
    constructor(config: Record<string, unknown>) {
      configs.push(config); instances.push(this); this.processID = 99 + instances.length;
      this.role = config.user === TARGET.owner ? 'owner' : 'app';
    }
    async connect() { events.push(`connect:${this.role}`); if (controls.connectError) throw controls.connectError; }
    async query(sql: string, params: unknown[]) {
      if (this.ended || this.destroyed) throw { code: '08003' };
      const entry = CATALOG.find(q => q.sql === sql);
      if (entry) { events.push(`${this.role}:${entry.id}`); logicalCalls.push({ role: this.role, id: entry.id, params: structuredClone(params) }); }
      calls.push({ sql, params: structuredClone(params), pid: this.processID });
      await controls.before(sql);
      if (errors.has(sql)) throw errors.get(sql);
      if (results.has(sql)) return { rows: structuredClone(results.get(sql)) };
      if (Object.values(SYSTEM).some(value => value === sql)) return { rows: [] };
      if (sql === lookup('identity').sql) return { rows: [identity(this.role, this.processID)] };
      if (sql === lookup('role_attrs').sql) return { rows: roleAttrs() };
      if (sql === lookup('identity_evidence').sql) return { rows: [identityEvidence()] };
      if (sql === lookup('server').sql) return { rows: [server()] };
      if (sql === lookup('probe_42809').sql) throw { code: '42809', message: PASSWORD, stack: PASSWORD };
      if (sql === lookup('role_membership').sql) return { rows: [{ oid: 10, membership: false, set_membership: false }] };
      if (sql === lookup('numbackends').sql) return { rows: [{ numbackends: instances.filter(c => !c.ended && !c.destroyed).length }] };
      if (sql === lookup('database').sql) return { rows: [{ oid: 42 }] };
      if (sql === lookup('key_roundtrip').sql) {
        const k = BigInt(params[0] as string);
        return { rows: [{ key: k.toString(), classid: ((k >> 32n) & 4294967295n).toString(),
          objid: (k & 4294967295n).toString(), reconstructed: k.toString() }] };
      }
      if (sql === lookup('advisory_try_lock').sql) {
        if (heldBy !== 0) return { rows: [{ acquired: false }] };
        heldBy = this.processID; return { rows: [{ acquired: true }] };
      }
      if (sql === lookup('advisory_unlock').sql) {
        const unlocked = heldBy === this.processID; if (unlocked) heldBy = 0;
        return { rows: [{ unlocked }] };
      }
      if (sql === lookup('advisory_holders').sql) return { rows: heldBy ? [{ ...holder(), pid: heldBy }] : [] };
      return { rows: [] };
    }
    async end() { this.ended = true; if (heldBy === this.processID) heldBy = 0; if (controls.endError) throw controls.endError; }
    destroy() { this.destroyed = true; if (heldBy === this.processID) heldBy = 0; }
  }
  return { pgModule: { Client: FakeClient }, calls, events, logicalCalls, configs, instances, results, errors, controls,
    set: (id: string, value: unknown) => results.set(lookup(id).sql, value),
    fail: (id: string, code: string) => errors.set(lookup(id).sql, { code, message: PASSWORD, stack: PASSWORD }),
    nullRows: (id: string) => results.set(lookup(id).sql, null),
    duplicate: (id: string, row: unknown) => results.set(lookup(id).sql, [row, row]),
    truncate: (id: string, rows: unknown[]) => results.set(lookup(id).sql, rows.slice(1)) };
}
