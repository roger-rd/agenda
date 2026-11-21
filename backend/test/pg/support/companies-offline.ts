import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actors, companiesFixture, companiesMarkers, companiesCleanupTargets, companiesCleanupSQL } from './companies-fixture';
import { DeleteGate, markers } from './markers';
import { parsePhase, phaseEnvironment } from './phase';
import { formatAuthFailure } from './auth-failure';
import { normalizePersonName, organizationNameKey } from '../../../src/identity/person-name';
import { assertReadonlyQuery } from './readonly';

export function registerCompaniesOfflineTests(): void {
  describe('companies offline', () => {
    test('fase y PGOPTIONS, cleanup sigue reservada', () => {
      expect(parsePhase('companies', 'test')).toBe('companies');
      expect(() => parsePhase('cleanup', 'test')).toThrow('requiere autorización');
      const env = { PGOPTIONS: 'unsafe' };
      expect(phaseEnvironment('companies', env)).not.toHaveProperty('PGOPTIONS');
      expect(env.PGOPTIONS).toBe('unsafe');
    });
    test('gate exige los tres requisitos y readonly nunca se arma', () => {
      for (const missing of ['identity', 'schema', 'baseline'] as const) {
        const gate = new DeleteGate('companies');
        for (const check of ['identity', 'schema', 'baseline'] as const) if (check !== missing) gate.mark(check);
        expect(() => gate.arm()).toThrow(); expect(() => gate.assertArmed()).toThrow();
        gate.mark(missing); gate.arm(); expect(() => gate.assertArmed()).not.toThrow();
      }
      const readonly = new DeleteGate('readonly');
      for (const check of ['identity', 'schema', 'baseline'] as const) readonly.mark(check);
      expect(() => readonly.arm()).toThrow();
    });
    test.each(['A', 'B'] as const)('nombres y claves válidos y únicos en %s', org => {
      const companies = companiesFixture().companies.filter(c => c.org === org);
      expect(companies.length).toBe(org === 'A' ? 8 : 4);
      expect(new Set(companies.map(c => c.nameKey)).size).toBe(companies.length);
      for (const c of companies) {
        expect(normalizePersonName(c.name)).toBe(c.name);
        expect(organizationNameKey(c.name)).toBe(c.nameKey);
        expect([...c.nameKey].length).toBeGreaterThanOrEqual(2);
        expect(c.nameKey.toLowerCase().trim()).toBe(c.nameKey);
        expect(c.name + c.nameKey).not.toMatch(/\p{C}| {2}/u);
        expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
    test('claves repetidas entre organizaciones', () => {
      const { companies } = companiesFixture();
      expect(companies.some(a => a.org === 'A' && companies.some(b => b.org === 'B' && b.nameKey === a.nameKey))).toBe(true);
    });
    test.each([
      ['cmA', 'A', 8], ['cmB', 'B', 4], ['wA1', 'A', 4], ['cA1', 'A', 2],
      ['wA0', 'A', 0], ['cA0', 'A', 0], ['wB', 'B', 3], ['cB', 'B', 2], ['multi', 'A', 1], ['multi', 'B', 1],
    ] as const)('conjunto sembrado %s en %s tiene %i', (actor, org, count) => {
      const f = companiesFixture(), expected = f.expected(actor, org);
      expect(expected.length).toBe(count); expect(new Set(expected).size).toBe(count);
      expect(expected.every(key => f.companies.some(c => c.key === key && c.org === org))).toBe(true);
    });
    test('accesos explícitos y rol coincidente, nunca para community managers', () => {
      const f = companiesFixture();
      for (const a of f.accesses) {
        const m = f.memberships.find(m => m.actor === a.actor && m.org === a.org)!;
        expect(a.role).toBe(m.role); expect(a.role).not.toBe('community_manager');
        expect(f.companies.find(c => c.key === a.company)?.org).toBe(m.org);
      }
      expect(f.memberships.filter(m => m.role === 'community_manager').every(m => m.access.length === 0)).toBe(true);
      const worker = f.expected('wB', 'B'), client = f.expected('cB', 'B');
      expect(client.some(key => worker.includes(key)) && client.some(key => !worker.includes(key))).toBe(true);
      expect(f.expected('wA1', 'A').every(key => !f.expected('cA1', 'A').includes(key))).toBe(true);
      expect(f.memberships.filter(m => m.actor === 'multi')).toHaveLength(2);
    });
    test('reservas exactas distintas y marcador ajeno excluido', () => {
      const id = 'abcdef012345', { reserved, byActor } = companiesMarkers(id), targets = companiesCleanupTargets(id);
      expect(reserved).toHaveLength(9); expect(Object.keys(byActor)).toEqual([...actors]);
      expect(new Set(targets.emails).size).toBe(9); expect(new Set(targets.organizationNames).size).toBe(9);
      expect(targets.emails).toEqual(reserved.map(m => m.email));
      expect(targets.organizationNames).toEqual(reserved.map(m => m.organizationName));
      for (const m of reserved) {
        expect(m.email).toMatch(/^b2b-[0-9a-f]{12}-[0-9]+@agenda-b2b\.test$/);
        expect(m.email.length <= 120 && [...m.organizationName].length <= 80).toBe(true);
        expect(normalizePersonName(m.organizationName)).toBe(m.organizationName);
        expect(m.email + m.organizationName).not.toMatch(/[%_'"\\]/);
      }
      const foreign = markers(id, 99, 'foreign');
      expect(targets.emails.includes(foreign.email) || targets.organizationNames.includes(foreign.organizationName)).toBe(false);
      expect(() => companiesMarkers('bad')).toThrow('runId');
    });
    test('limpieza pinned parametrizada en orden fijo de ocho tablas', () => {
      const id = 'abcdef012345', targets = companiesCleanupTargets(id);
      expect(Object.values(companiesCleanupSQL)).toEqual([
        'DELETE FROM public.invitation_companies WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
        'DELETE FROM public.invitations WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
        'DELETE FROM public.user_sessions WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[]))',
        'DELETE FROM public.company_accesses WHERE membership_id IN (SELECT id FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[])))',
        'DELETE FROM public.companies WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
        'DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[]))',
        'DELETE FROM public.users WHERE email = ANY($1::text[])',
        'DELETE FROM public.organizations WHERE name = ANY($1::text[])',
      ]);
      expect(Object.values(companiesCleanupSQL).map(sql => sql.match(/^DELETE FROM public\.(\w+) WHERE/)?.[1]))
        .toEqual(['invitation_companies', 'invitations', 'user_sessions', 'company_accesses', 'companies', 'organization_memberships', 'users', 'organizations']);
      for (const sql of Object.values(companiesCleanupSQL)) {
        expect(sql).toContain('$1'); expect(sql).not.toMatch(/LIKE|~|TRUNCATE/i);
        for (const value of [id, ...targets.emails, ...targets.organizationNames]) expect(sql).not.toContain(value);
        expect(() => assertReadonlyQuery(sql)).toThrow('readonly');
      }
    });
    test('registro exclusivo, diez tablas, reloj real y cierre garantizado', () => {
      const source = readFileSync(join(__dirname, 'connected.ts'), 'utf8');
      expect(source).toContain("if (phase === 'companies') registerCompaniesTest(");
      expect(source).toContain("const companiesReservations = phase === 'companies' ? companiesMarkers(id) : undefined;");
      expect(source).toContain("moduleRef = phase === 'auth'\n          ? await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(clock).compile()\n          : await Test.createTestingModule({ imports: [AppModule] }).compile();");
      expect(source).toContain("} else if (phase === 'auth' || phase === 'companies') {\n      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });");
      expect(source).toContain("const tables = ['organizations', 'users', 'organization_memberships', 'companies', 'company_accesses', 'user_sessions', 'posts', 'post_comments', 'invitations', 'invitation_companies'] as const;");
      const cleanup = source.slice(source.indexOf('async function cleanupCompanies('), source.indexOf('async function register('));
      expect(cleanup).toContain('await empty();');
      const order = ['invitationCompanies', 'invitations', 'sessions', 'accesses', 'companies', 'memberships', 'users', 'organizations'].map(key => cleanup.indexOf(`companiesCleanupSQL.${key},`));
      expect(order.every((position, i) => position >= 0 && (i === 0 || position > order[i - 1]))).toBe(true);
      expect(readFileSync(join(__dirname, 'load-connected.cjs'), 'utf8')).toContain("| 'companies'");
    });
    test('diagnóstico por paso nunca incluye el mensaje original', () => {
      const secret = 'password-token-csrf-hash-cursor-privado';
      expect(formatAuthFailure('paginación', new Error(secret), 'companies')).toBe('companies: escenario fallido en "paginación" (Error)');
      expect(formatAuthFailure('paginación', new Error(secret), 'companies')).not.toContain(secret);
      expect(formatAuthFailure('login', new Error(secret))).toBe('auth: escenario fallido en "login" (Error)');
    });
  });
}
