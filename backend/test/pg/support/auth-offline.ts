import { formatAuthFailure } from './auth-failure';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePhase, phaseEnvironment } from './phase';
import { authMarkers, authCleanupTargets, authCleanupSQL, markers, DeleteGate } from './markers';
import { assertAuthOrigin, ControlledClock, DAY, expiry, renewalDays } from './auth-controls';
import { ROLES } from '../../../src/persistence/constants';
import { assertReadonlyQuery } from './readonly';

export function registerAuthOfflineTests(): void {
  describe('auth offline', () => {
    test('diagnóstico conserva paso y clase sin revelar datos sensibles', () => {
      const secret = 'password-token-csrf-hash-secreto';
      const error = Object.assign(new TypeError(secret), { parameters: [secret], code: secret });
      expect(formatAuthFailure('login T0', error)).toBe('auth: escenario fallido en "login T0" (TypeError)');
      const driver = Object.assign(new Error(secret), { code: '23505', severity: 'ERROR', routine: secret });
      class QueryFailedError extends Error {
        driverError = driver;
        constructor() { super(secret); this.name = 'QueryFailedError'; }
      }
      for (const original of [driver, new QueryFailedError()]) {
        const message = formatAuthFailure('rollback real', original);
        expect(message).toContain('SQLSTATE 23505');
        expect(message).not.toContain(secret);
      }
      driver.code = secret;
      expect(formatAuthFailure('rollback real', new QueryFailedError()))
        .toBe('auth: escenario fallido en "rollback real" (QueryFailedError)');
      expect(formatAuthFailure('negativos', secret)).toBe('auth: escenario fallido en "negativos" (UnknownError)');
    });
    test.each(['cleanup', undefined])('setup rechaza %s antes de importar pg/typeorm', phase => {
      const env = { ...process.env };
      if (phase === undefined) delete env.AGENDA_B2B_PHASE; else env.AGENDA_B2B_PHASE = phase;
      const script = `
        const ts = require('typescript'), fs = require('node:fs'), Module = require('node:module');
        require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
        const original = Module._load; let imported = false;
        Module._load = function(name, ...args) {
          if (/^(pg|typeorm)(\\/|$)/.test(name)) { imported = true; throw new Error('driver import'); }
          return original.call(this, name, ...args);
        };
        try { require('./test/pg/support/pg-setup.cjs'); process.exitCode = 2; }
        catch (error) { process.stdout.write(JSON.stringify({ imported, message: error.message })); process.exitCode = 1; }
      `;
      const result = spawnSync(process.execPath, ['-e', script], { cwd: join(__dirname, '../../..'), env, encoding: 'utf8' });
      expect(result.status).toBe(1);
      const output = JSON.parse(result.stdout) as { imported: boolean; message: string };
      expect(output.imported).toBe(false);
      expect(output.message).toContain(phase === 'cleanup' ? 'fase cleanup requiere autorización específica' : 'AGENDA_B2B_PHASE obligatoria');
    });
    test('fase y gate con los tres requisitos', () => {
      expect(parsePhase('auth', 'test')).toBe('auth');
      expect(() => parsePhase('cleanup', 'test')).toThrow('requiere autorización');
      expect(phaseEnvironment('auth', { PGOPTIONS: 'anything' })).not.toHaveProperty('PGOPTIONS');
      const gate = new DeleteGate('auth');
      for (const check of ['identity', 'schema', 'baseline'] as const) {
        expect(() => gate.arm()).toThrow(); expect(() => gate.assertArmed()).toThrow(); gate.mark(check);
      }
      gate.arm(); expect(() => gate.assertArmed()).not.toThrow();
    });
    test('reservas distintas, válidas y limpieza exacta', () => {
      const id = 'abcdef012345', all = authMarkers(id), targets = authCleanupTargets(id);
      expect(new Set(Object.values(all).map(m => m.email)).size).toBe(3);
      expect(new Set(Object.values(all).map(m => m.organizationName)).size).toBe(3);
      for (const m of Object.values(all)) { expect(m.email.length <= 120 && [...m.organizationName].length <= 80).toBe(true); }
      expect(targets.emails).toEqual([all.a.email, all.b.email]);
      expect(targets.organizationNames).toEqual([all.a.organizationName, all.b.organizationName]);
      for (const m of [all.unknown, markers(id, 99, 'foreign')]) {
        expect(targets.emails.includes(m.email) || targets.organizationNames.includes(m.organizationName)).toBe(false);
      }
      expect(Object.keys(authCleanupSQL)).toEqual(['sessions', 'memberships', 'users', 'organizations']);
      expect(Object.values(authCleanupSQL).map(sql => sql.match(/^DELETE FROM public\.(\w+) WHERE/)?.[1]))
        .toEqual(['user_sessions', 'organization_memberships', 'users', 'organizations']);
      for (const sql of Object.values(authCleanupSQL)) {
        expect(sql).toContain('ANY($1::text[])'); expect(sql).not.toMatch(/LIKE|~|TRUNCATE/i);
        for (const value of [id, ...targets.emails, ...targets.organizationNames]) expect(sql).not.toContain(value);
      }
    });
    test('reloj monótono y renovaciones antes del vencimiento hasta el tope', () => {
      const clock = new ControlledClock(0); clock.advance(6 * 60000);
      let previous = +clock.now(), expires = expiry(0, previous);
      expect(renewalDays).toEqual([6, 12, 18, 24, 29]);
      for (const day of renewalDays) {
        clock.set(day * DAY);
        expect(+clock.now() - previous).toBeLessThan(7 * DAY);
        expect(+clock.now()).toBeLessThan(expires);
        expires = expiry(0, +clock.now()); previous = +clock.now();
      }
      expect(expires).toBe(30 * DAY); clock.set(30 * DAY);
      expect(+clock.now() >= expires).toBe(true);
      expect(() => clock.set(0)).toThrow();
    });
    test('origen exacto y worker', () => {
      expect(() => assertAuthOrigin('https://app.agenda.test')).not.toThrow();
      for (const value of [undefined, '', 'null', 'https://otro.test', 'https://app.agenda.test/', ' https://app.agenda.test', 'https://app.agenda.test,https://otro.test']) {
        expect(() => assertAuthOrigin(value)).toThrow('APP_ALLOWED_ORIGINS');
      }
      expect(ROLES.includes('worker')).toBe(true);
    });
    test('ocho tablas exactas, mismo empty y auth aislada de readonly', () => {
      const source = readFileSync(join(__dirname, 'connected.ts'), 'utf8');
      const tables = source.match(/const tables = \[([^\]]+)\] as const/)![1].match(/'[^']+'/g)!.map(s => s.slice(1, -1));
      expect(tables).toEqual(['organizations', 'users', 'organization_memberships', 'companies', 'company_accesses', 'posts', 'post_comments', 'user_sessions']);
      expect(source).toContain('tables.map(async table =>');
      expect(source).toContain("await empty(); gate.mark('baseline');");
      expect(source.slice(source.indexOf('async function cleanup()'), source.indexOf('async function register('))).toContain('await empty();');
      expect(source).toContain("if (phase === 'auth') registerAuthTest(");
      expect(source.indexOf('assertAuthOrigin(process.env.APP_ALLOWED_ORIGINS)')).toBeLessThan(source.indexOf('await observer.initialize()'));
      expect(() => assertReadonlyQuery("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'CK_organization_memberships_role'")).toThrow('readonly');
    });
  });
}
