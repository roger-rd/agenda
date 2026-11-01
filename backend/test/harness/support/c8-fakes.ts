import { mark } from '../../../scripts/harness/c8-names.cjs';
import { authorization } from '../../../scripts/harness/c8-preflight.cjs';
import type { Schema, Privileges } from '../../../scripts/harness/c8-gate.cjs';
import type { Evidence } from '../../../scripts/harness/c8-cleanup-policy.cjs';

export const RUN = 'a'.repeat(32);
export const NAME = 'uow_2611011200_abc123_1';
export function schema(overrides: Partial<Schema> = {}): Schema {
  return { name: NAME, comment: mark(RUN), owner: 'agenda_test_owner', ageMs: 0,
    lease: 'free', leaseOwned: false, empty: true, ...overrides };
}
export function privileges(): Privileges {
  return { complete: true, evaluable: true, membership: false, setMembership: false,
    grantable: false, defaultAcl: false, objects: [{ kind: 'schema', evaluable: true,
      direct: false, inherited: false, public: false, column: false }] };
}
export function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { schema: schema({ leaseOwned: true }), runId: RUN, runSessions: 0, otherRolePids: [],
    foreignLocks: false, numbackends: 1, baseline: 0, ownBackends: 1, baselineClean: true,
    error: false, target: true, ...overrides };
}
export function fake(items: Schema[] = [schema()]) {
  let catalog = structuredClone(items); let snapshot: Schema[] | undefined;
  let grants = new Map(catalog.map(s => [s.name, privileges()]));
  let grantSnapshot: Map<string, Privileges> | undefined;
  let held = true; let terminated = 0; let elapsed = 0;
  const statements: string[] = []; const phases: string[] = [];
  const controls = { before: (sql: string) => { void sql; }, phase: (phase: string) => { void phase; },
    revokeWorks: true, validTarget: true, canAcquire: true };
  const auth = authorization({ pid: 100, observe: () => ({ held, pid: 100 }), terminate: () => { terminated++; } });
  const client = {
    roles: () => ({ evaluable: true, membership: false, setMembership: false }),
    target: () => controls.validTarget,
    acquire: (s: Schema) => {
      if (!controls.canAcquire) return false;
      const found = catalog.find(item => item.name === s.name);
      if (!found || found.lease !== 'free') return false;
      found.leaseOwned = true; return true;
    },
    refresh: (s: Schema) => structuredClone(catalog.find(item => item.name === s.name) ?? s),
    inspect: (s: Schema) => structuredClone(grants.get(s.name)!),
    record: (sql: string) => {
      statements.push(sql); controls.before(sql);
      if (sql === 'BEGIN') { snapshot = structuredClone(catalog); grantSnapshot = structuredClone(grants); }
      else if (sql === 'ROLLBACK') {
        if (snapshot) catalog = snapshot;
        if (grantSnapshot) grants = grantSnapshot;
        snapshot = undefined; grantSnapshot = undefined;
      } else if (sql === 'COMMIT') { snapshot = undefined; grantSnapshot = undefined; }
      else if (sql.startsWith('REVOKE') && controls.revokeWorks) {
        const name = catalog.find(s => sql.includes(`"${s.name}"`))?.name;
        if (!name) throw new Error('fake_unknown_schema');
        const p = grants.get(name)!;
        grants.set(name, { ...p, objects: p.objects.map(o => ({ ...o, direct: false,
          public: sql.endsWith('FROM PUBLIC') ? false : o.public })) });
      } else if (sql.startsWith('DROP SCHEMA')) {
        catalog = catalog.filter(s => sql !== `DROP SCHEMA "${s.name}"`);
      }
    },
  };
  const target = { database: 'agenda_test', host: '127.0.0.1', port: 5433, major: 16, user: 'agenda_test_owner' };
  return { auth, client, controls, statements, phases, target, appTarget: { ...target, user: 'agenda_test_app' },
    budget: { wrapper: 1, child: 1, app: 20, preflight: 6 },
    now: () => elapsed, advance: (ms: number) => { elapsed += ms; },
    schemas: () => structuredClone(catalog),
    phase: (phase: string) => { phases.push(phase); controls.phase(phase); return true; },
    tryL0: () => true,
    baseline: () => ({ otherRolePids: [] as number[], foreignLease: false }),
    lose: () => { held = false; auth.held(); }, regain: () => { held = true; },
    terminated: () => terminated,
    setPrivileges: (p: Privileges, name = NAME) => { grants.set(name, structuredClone(p)); },
  };
}
export function seeded(seed = 123456789) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
}
