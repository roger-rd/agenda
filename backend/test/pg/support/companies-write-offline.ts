import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCompanyName } from '../../../src/companies/company-input';
import { companiesCleanupSQL, companiesMarkers } from './companies-fixture';
import { companiesWriteMarkers, companiesWriteCleanupTargets, companiesWriteCleanupSQL, duplicateNames,
  collisionNames, alphabetNames, ligatureNames, raceRounds, identicalRace, companiesWriteTimeline,
  firstPartWriteLimit, sameCompanyError } from './companies-write-fixture';
import { markers, DeleteGate, authMarkers, httpMarkers } from './markers';
import { parsePhase, phaseEnvironment } from './phase';
import { DAY, ControlledClock } from './auth-controls';
import { formatAuthFailure } from './auth-failure';
import { assertReadonlyQuery } from './readonly';

export function registerCompaniesWriteOfflineTests(): void {
  describe('companies-write offline', () => {
    test('fase admitida sin PGOPTIONS y cleanup reservada', () => {
      expect(parsePhase('companies-write', 'test')).toBe('companies-write');
      expect(() => parsePhase('cleanup', 'test')).toThrow('requiere autorización');
      const env = { PGOPTIONS: 'unsafe' };
      expect(phaseEnvironment('companies-write', env)).not.toHaveProperty('PGOPTIONS');
      expect(env.PGOPTIONS).toBe('unsafe');
    });
    test.each(['identity', 'schema', 'baseline'] as const)('gate exige %s', missing => {
      const gate = new DeleteGate('companies-write');
      for (const check of ['identity', 'schema', 'baseline'] as const) if (check !== missing) gate.mark(check);
      expect(() => gate.arm()).toThrow(); expect(() => gate.assertArmed()).toThrow();
      gate.mark(missing); gate.arm(); expect(() => gate.assertArmed()).not.toThrow();
    });
    test('reservas válidas separadas de otras fases y marcador ajeno excluido', () => {
      const id = 'abcdef012345', m = companiesWriteMarkers(id), targets = companiesWriteCleanupTargets(id);
      expect(m.reserved).toHaveLength(4);
      expect(new Set(m.reserved.map(r => r.email)).size).toBe(4);
      expect(new Set(m.reserved.map(r => r.organizationName)).size).toBe(4);
      expect(targets.emails).toEqual(m.reserved.map(r => r.email));
      expect(targets.organizationNames).toEqual([m.byActor.cmA.organizationName, m.byActor.cmB.organizationName]);
      for (const r of m.reserved) {
        expect(r.email.length <= 120 && [...r.organizationName].length <= 80).toBe(true);
        expect(r.email).toMatch(/^b2b-[0-9a-f]{12}-4[0-3]@agenda-b2b\.test$/);
        expect(r.email + r.organizationName).not.toMatch(/[%_'"\\]/);
      }
      for (const foreign of [markers(id, 99, 'foreign'), ...companiesMarkers(id).reserved, ...Object.values(authMarkers(id)), ...httpMarkers(id).reserved]) {
        expect(targets.emails.includes(foreign.email) || targets.organizationNames.includes(foreign.organizationName)).toBe(false);
      }
      expect(() => companiesWriteMarkers('bad')).toThrow('runId');
    });
    test('SQL pinned: ocho tablas de limpieza, invitaciones primero, parámetros exactos', () => {
      // companies has independent literal pinned expectations in its preserved offline tests.
      expect(companiesWriteCleanupSQL).toEqual(companiesCleanupSQL);
      expect(Object.values(companiesWriteCleanupSQL).map(sql => sql.match(/^DELETE FROM public\.(\w+) WHERE/)?.[1]))
        .toEqual(['invitation_companies', 'invitations', 'user_sessions', 'company_accesses', 'companies', 'organization_memberships', 'users', 'organizations']);
      const id = 'abcdef012345', targets = companiesWriteCleanupTargets(id);
      for (const sql of Object.values(companiesWriteCleanupSQL)) {
        expect(sql).toContain('$1'); expect(sql).not.toMatch(/LIKE|~|TRUNCATE/i);
        for (const value of [id, ...targets.emails, ...targets.organizationNames]) expect(sql).not.toContain(value);
        expect(() => assertReadonlyQuery(sql)).toThrow('readonly');
      }
    });
    test.each([{ names: duplicateNames }, { names: collisionNames }])('grupo de colisión $names', ({ names }) => {
      const normalized = names.map(normalizeCompanyName);
      expect(normalized.every(Boolean)).toBe(true);
      expect(new Set(normalized.map(n => n!.nameKey)).size).toBe(1);
    });
    test('ligatura NFKD: nombres distintos con clave oficina', () => {
      const [a, b] = ligatureNames.map(normalizeCompanyName);
      expect(a!.name).not.toBe(b!.name);
      expect(a!.nameKey).toBe(b!.nameKey); expect(a!.nameKey).toBe('oficina');
      expect(ligatureNames[1]).toContain('\uFB01');
    });
    test('otros alfabetos válidos y distintos', () => {
      const values = alphabetNames.map(normalizeCompanyName);
      expect(values.every(Boolean)).toBe(true); expect(new Set(values.map(v => v!.nameKey)).size).toBe(3);
    });
    test.each(raceRounds)('concurrencia efectiva $initial.name', round => {
      const [name, color] = round.changes;
      expect(name.version === 1 && color.version === 1).toBe(true);
      expect(normalizeCompanyName(name.name)!.name).not.toBe(round.initial.name);
      expect(color.color).not.toBe(round.initial.color);
      expect(name).not.toHaveProperty('color'); expect(color).not.toHaveProperty('name');
      expect(name).not.toEqual(color);
    });
    test('carrera idéntica propone cambio efectivo', () => {
      expect(identicalRace.change.version).toBe(1);
      expect(normalizeCompanyName(identicalRace.change.name)!.name).not.toBe(identicalRace.initial.name);
    });
    test('línea de tiempo monótona, primera parte acotada y tope absoluto', () => {
      const t0 = 1795000000123, clock = new ControlledClock(t0), timeline = companiesWriteTimeline(t0);
      expect(firstPartWriteLimit * 1000).toBeLessThan(240000);
      clock.advance(firstPartWriteLimit * 1000);
      expect(timeline.map(p => p.now - t0)).toEqual([360000, 6 * DAY, 12 * DAY, 18 * DAY, 24 * DAY, 29 * DAY]);
      let previous = t0, expires = t0 + 7 * DAY;
      for (const point of timeline) {
        expect(point.now - previous).toBeLessThan(7 * DAY); expect(point.now).toBeLessThan(expires);
        clock.set(point.now);
        expect(point.expires).toBe(Math.min(t0 + 30 * DAY, point.now + 7 * DAY));
        expect(point.maxAge).toBe(Math.floor((point.expires - point.now) / 1000));
        previous = point.now; expires = point.expires;
      }
      expect(timeline[0].maxAge).toBe(604800);
      expect(timeline.at(-1)!.expires).toBe(t0 + 30 * DAY); expect(timeline.at(-1)!.maxAge).toBe(86400);
      expect(() => clock.set(t0)).toThrow();
    });
    test('comparación 404 ignora solo requestId', () => {
      const a = { status: 404, body: { error: { code: 'not_found', message: 'No encontrado.', requestId: 'one' } } };
      const b = { ...a, body: { error: { ...a.body.error, requestId: 'two' } } };
      expect(sameCompanyError(a, b)).toBe(true);
      expect(sameCompanyError(a, { ...b, status: 403 })).toBe(false);
      expect(sameCompanyError(a, { ...b, body: { ...b.body, error: { ...b.body.error, code: 'forbidden' } } })).toBe(false);
      expect(sameCompanyError(a, { ...b, body: { ...b.body, error: { ...b.body.error, message: 'Diferente' } } })).toBe(false);
    });
    test('integración exclusiva, Clock después de preflight y diez tablas', () => {
      const source = readFileSync(join(__dirname, 'connected.ts'), 'utf8');
      const tables = source.match(/const tables = \[([^\]]+)\] as const/)![1].match(/'[^']+'/g)!.map(s => s.slice(1, -1));
      expect(tables).toEqual(['organizations', 'users', 'organization_memberships', 'companies', 'company_accesses', 'user_sessions', 'posts', 'post_comments', 'invitations', 'invitation_companies']);
      expect(source).toContain("if (phase === 'companies-write') registerCompaniesWriteTest(");
      expect(source).toContain("if (phase === 'companies-write') {\n          moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(clock).compile();");
      expect(source.indexOf('clock = new ControlledClock()')).toBeGreaterThan(source.indexOf("await empty(); gate.mark('baseline');"));
      expect(source).toContain("if (phase === 'auth' || phase === 'companies-write') assertAuthOrigin");
      expect(source).toContain("} else if (phase === 'companies-write') {\n      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });");
      const cleanup = source.slice(source.indexOf('async function cleanupCompaniesWrite('), source.indexOf('async function register('));
      expect(cleanup).toContain('await empty();');
      const order = ['invitationCompanies', 'invitations', 'sessions', 'accesses', 'companies', 'memberships', 'users', 'organizations'].map(key => cleanup.indexOf(`companiesWriteCleanupSQL.${key},`));
      expect(order.every((p, i) => p >= 0 && (i === 0 || p > order[i - 1]))).toBe(true);
      const readonly = new DeleteGate('readonly');
      for (const check of ['identity', 'schema', 'baseline'] as const) readonly.mark(check);
      expect(() => readonly.arm()).toThrow(); expect(() => readonly.assertArmed()).toThrow();
      const testSource = readFileSync(join(__dirname, 'http-companies-write.ts'), 'utf8');
      expect(testSource.indexOf('gate.arm()')).toBeLessThan(testSource.indexOf(".post('/api/v1/auth/register')"));
      expect(testSource).toContain('writes <= firstPartWriteLimit');
      expect(testSource).toContain("formatAuthFailure(step, error, 'companies-write')");
      expect(readFileSync(join(__dirname, 'load-connected.cjs'), 'utf8')).toContain("| 'companies-write'");
    });
    test('diagnóstico por paso oculta mensaje original', () => {
      const secret = 'password-token-csrf-hash-cursor-privado';
      expect(formatAuthFailure('ediciones parciales', new Error(secret), 'companies-write'))
        .toBe('companies-write: escenario fallido en "ediciones parciales" (Error)');
    });
  });
}
