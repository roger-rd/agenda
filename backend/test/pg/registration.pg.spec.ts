import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerConnectedSuite, loadedDatabaseModules } from './support/load-connected.cjs';
import { assertFingerprint, businessFingerprint, migrationFingerprint, fingerprintSQL } from './support/schema-fingerprint';
import { classifyMigrationHistory } from './support/migration-history';
import { parsePhase, phaseEnvironment } from './support/phase';
import { assertReadonlyQuery, guardedQuery } from './support/readonly';
import { DeleteGate, httpCleanupSQL, httpCleanupTargets, httpMarkers, markers, runId, validateRunId } from './support/markers';
import { normalizerRejected, checkRejected, columnTypeRejected, collisions, distinct } from './support/unicode-cases';
import { normalizePersonName, organizationNameKey } from '../../src/identity/person-name';

const phase = parsePhase(process.env.AGENDA_B2B_PHASE, process.env.NODE_ENV);
if (phase === 'offline') {
  describe('B2B offline (sin DATABASE_* ni conexiones)', () => {
    test('no importa pg/typeorm ni necesita DATABASE_*', () => {
      expect(loadedDatabaseModules()).toEqual([]);
    });
    test('connected exige exactamente las cuatro entidades de identidad', () => {
      const source = readFileSync(join(__dirname, 'support/connected.ts'), 'utf8');
      expect(source).toContain("import { UserSession } from '../../../src/persistence/entities/user-session.entity';");
      expect(source).toContain('expect(new Set(source.entityMetadatas.map(m => m.target))).toEqual(new Set([User, Organization, OrganizationMembership, UserSession]));');
    });
    test('huellas: referencias exactas de negocio y schema_migrations', () => {
      expect(businessFingerprint).toEqual({ columns: 68, constraints: 64, indexes: 26 });
      expect(migrationFingerprint).toEqual({ columns: 3, constraints: 1, indexes: 1 });
    });
    test('huella: cuenta columnas desde pg_catalog sin filtrar por privilegios', () => {
      expect(fingerprintSQL).toContain('FROM pg_catalog.pg_attribute a');
      expect(fingerprintSQL).toContain('JOIN pg_catalog.pg_class t ON t.oid = a.attrelid');
      expect(fingerprintSQL).toContain('JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace');
      expect(fingerprintSQL).toContain("WHERE n.nspname = 'public' AND t.relname = ANY($1) AND t.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped) AS columns");
      expect(fingerprintSQL).not.toMatch(/information_schema/i);
      expect(() => assertReadonlyQuery(fingerprintSQL)).not.toThrow();
    });
    test.each([
      ['negocio', businessFingerprint],
      ['schema_migrations', migrationFingerprint],
    ] as const)('huella %s: coincidencia, discrepancias y consulta readonly', (label, expected) => {
      expect(() => assertFingerprint(label, { ...expected }, expected)).not.toThrow();
      for (const field of ['columns', 'constraints', 'indexes'] as const) {
        const received = { ...expected, [field]: expected[field] + 1 };
        expect(() => assertFingerprint(label, received, expected)).toThrow(
          `[b2b] huella ${label} difiere: esperados=${JSON.stringify(expected)}; recibidos=${JSON.stringify(received)}`,
        );
      }
      expect(() => assertReadonlyQuery(fingerprintSQL)).not.toThrow();
      expect(() => assertReadonlyQuery({ text: fingerprintSQL, values: [[label === 'negocio' ? 'organizations' : 'schema_migrations']] })).not.toThrow();
    });
    test('historial: exactamente una fila verifica; cero o varias fallan', () => {
      expect(classifyMigrationHistory({ rows: [{ name: 'InitialSchema1794009600000' }] })).toBe('verified');
      for (const rows of [[], [{}, {}]]) expect(() => classifyMigrationHistory({ rows })).toThrow('exactamente 1 fila');
    });
    test('historial: 42501 de pg directo o del observer queda sin verificar', () => {
      const driverError = Object.assign(new Error('permission denied'), { code: '42501', severity: 'ERROR', routine: 'aclcheck_error' });
      const wrapped = Object.assign(new Error('query failed'), { name: 'QueryFailedError', driverError });
      for (const error of [driverError, wrapped]) expect(classifyMigrationHistory({ error })).toBe('unverified');
    });
    test('historial: propaga otros errores y no basta con code=42501', () => {
      const driverError = Object.assign(new Error('missing table'), { code: '42P01', severity: 'ERROR', routine: 'parserOpenTable' });
      const wrapped = Object.assign(new Error('query failed'), { name: 'QueryFailedError', driverError });
      for (const error of [driverError, wrapped, Object.assign(new Error('unrelated'), { code: '42501' }), { code: '42501' }]) {
        try { classifyMigrationHistory({ error }); throw new Error('debió propagar'); }
        catch (caught) { expect(caught).toBe(error); }
      }
    });
    test.each([undefined, '', 'foo', 'DML'])('rechaza fase %s', value => {
      expect(() => parsePhase(value, 'test')).toThrow('AGENDA_B2B_PHASE');
    });
    test('cleanup reservada y NODE_ENV obligatorio', () => {
      expect(() => parsePhase('cleanup', 'test')).toThrow('fase cleanup requiere autorización específica');
      expect(() => parsePhase('offline', 'development')).toThrow('NODE_ENV');
    });
    test.each(['offline', 'readonly', 'dml', 'http'])('fase válida %s', value => expect(parsePhase(value, 'test')).toBe(value));
    test.each(['SELECT 1', 'SHOW server_version', 'BEGIN', 'BEGIN READ ONLY', 'START TRANSACTION READ ONLY',
      'SELECT name FROM public.schema_migrations WHERE name = $1', 'SELECT to_regclass($1) AS relation',
      'ROLLBACK', 'COMMIT;', 'SELECT version()', 'SELECT * FROM current_schema()', 'SELECT * FROM current_database()',
      "SELECT current_setting('server_version') AS version, pg_is_in_recovery() AS recovery, current_setting('server_encoding') AS encoding, d.datctype AS ctype, d.datcollate AS collate FROM pg_catalog.pg_database d WHERE d.datname = current_database()"])('admite %s', sql => {
      expect(() => assertReadonlyQuery(sql)).not.toThrow();
      expect(() => assertReadonlyQuery({ text: sql, values: [] })).not.toThrow();
    });
    test.each(['INSERT INTO users VALUES (1)', 'UPDATE users SET name=1', 'DELETE FROM users', 'CREATE TABLE x (a int)',
      'DROP TABLE users', 'TRUNCATE users', 'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
      'SELECT 1; SELECT 2', "SELECT set_config('transaction_read_only','off',false)", 'SELECT pg_terminate_backend(1)',
      'SELECT pg_cancel_backend(1)', "SELECT nextval('x')", "SELECT setval('x',1)", 'SELECT lo_unlink(1)',
      'SELECT pg_advisory_lock(1)', 'SELECT 全()', 'SET default_transaction_read_only=off', 'SELECT unknown_function()', 'SELECT 1 INTO x', 'BEGIN READ WRITE'])('bloquea %s', sql => {
      const original = jest.fn();
      for (const input of [sql, { text: sql, values: [1] }, Object.assign(Object.create({ submit() {} }) as object, { text: sql })]) {
        expect(() => guardedQuery(original)(input, [], jest.fn())).toThrow('readonly');
      }
      expect(original).not.toHaveBeenCalled();
    });
    test('reenvía Query, values y callbacks intactos', () => {
      const query = { text: 'SELECT $1', values: [1], submit() {} }, cb = jest.fn(), original = jest.fn();
      guardedQuery(original)(query, cb);
      expect(original).toHaveBeenCalledWith(query, cb);
      expect(() => assertReadonlyQuery({})).toThrow();
    });
    test('runId y límites de marcadores', () => {
      const id = runId(); expect(id).toMatch(/^[0-9a-f]{12}$/);
      const m = markers(id, 123, 'a'.repeat(63));
      expect([...m.organizationName]).toHaveLength(80);
      expect(m.email.length).toBeLessThanOrEqual(120);
      expect(m.email + m.organizationName).not.toMatch(/[%_'"\\]/);
      expect(() => markers(id, 0, 'a'.repeat(64))).toThrow();
      for (const bad of ['abc', '%'.repeat(12), '_'.repeat(12), "'".repeat(12), id + '\n']) expect(() => validateRunId(bad)).toThrow();
    });
    test('HTTP comparte limpieza y cierre garantizado, separado de DML y readonly', () => {
      const source = readFileSync(join(__dirname, 'support/connected.ts'), 'utf8');
      expect(source).toContain("if (phase === 'dml' || phase === 'http') {\n      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });");
      expect(source).toContain("if (phase === 'http') registerHttpTest(");
      expect(source).toContain("if (phase === 'dml') {\n      test('registro, rollback, concurrencia y equivalencia Unicode'");
      expect(source).toContain('finally { await observer.destroy(); }');
      expect(source).toContain('if (app) await app.close(); else if (moduleRef) await moduleRef.close();');
    });
    test('HTTP: reservas y cobertura de limpieza incluso sin respuesta ni IDs guardados', () => {
      const id = runId(), attempts = httpMarkers(id), targets = httpCleanupTargets(id);
      expect(() => validateRunId(id)).not.toThrow();
      expect(targets.emails).toEqual(attempts.reserved.map(m => m.email));
      expect(targets.organizationNames).toEqual(attempts.reserved.map(m => m.organizationName));
      expect(new Set(targets.emails).size).toBe(3);
      expect(new Set(targets.organizationNames).size).toBe(3);
      for (const marker of [...attempts.reserved, attempts.success, attempts.emailConflict, attempts.organizationConflict]) {
        expect(marker.email.length).toBeLessThanOrEqual(120);
        expect([...marker.organizationName].length).toBeLessThanOrEqual(80);
        expect(targets.emails.includes(marker.email)).toBe(true);
        expect(targets.organizationNames.includes(marker.organizationName)).toBe(true);
      }
      for (const foreign of [markers(id, 3, 'foreign'), markers(id, 99, 'http')]) {
        expect(targets.emails.includes(foreign.email)).toBe(false);
        // The second marker deliberately shares the exact reserved organization name.
        expect(targets.organizationNames.includes(foreign.organizationName)).toBe(foreign.organizationName === attempts.success.organizationName);
      }
      expect(() => httpCleanupTargets('invalid')).toThrow('runId');
      expect(attempts.emailConflict.email).toBe(attempts.success.email);
      expect(attempts.organizationConflict.organizationName).toBe(attempts.success.organizationName);
    });
    test('HTTP: SQL exacto y parametrizado sin marcadores interpolados', () => {
      const id = runId(), targets = httpCleanupTargets(id);
      expect(httpCleanupSQL.memberships).toBe('DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[]))');
      expect(httpCleanupSQL.users).toBe('DELETE FROM public.users WHERE email = ANY($1::text[])');
      expect(httpCleanupSQL.organizations).toBe('DELETE FROM public.organizations WHERE name = ANY($1::text[])');
      for (const sql of Object.values(httpCleanupSQL)) {
        expect(sql).toMatch(/\$1/);
        expect(sql).not.toMatch(/LIKE|~|name_key/i);
        for (const value of [id, ...targets.emails, ...targets.organizationNames]) expect(sql).not.toContain(value);
      }
      const source = readFileSync(join(__dirname, 'support/connected.ts'), 'utf8');
      expect(source).toContain("const httpTargets = phase === 'http' ? httpCleanupTargets(id) : undefined;");
      expect(source).toContain('observer!.query(httpCleanupSQL.memberships, [httpTargets.emails, httpTargets.organizationNames])');
      expect(source).toContain('observer!.query(httpCleanupSQL.users, [httpTargets.emails])');
      expect(source).toContain('observer!.query(httpCleanupSQL.organizations, [httpTargets.organizationNames])');
    });
    test('DML conserva patrones de limpieza por runId', () => {
      const source = readFileSync(join(__dirname, 'support/connected.ts'), 'utf8');
      const fallback = source.slice(source.indexOf('      if (httpTargets) {'), source.indexOf('      await empty();'));
      expect(fallback).toContain('} else {');
      expect(fallback).toContain('const emailPattern = `^b2b-${id}-[0-9]+@agenda-b2b[.]test$`, orgPattern = `B2B-${id}-%`;');
      expect(fallback).toContain("observer!.query('DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email ~ $1) OR organization_id IN (SELECT id FROM public.organizations WHERE name LIKE $2)', [emailPattern, orgPattern])");
      expect(fallback).toContain("observer!.query('DELETE FROM public.users WHERE email ~ $1', [emailPattern])");
      expect(fallback).toContain("observer!.query('DELETE FROM public.organizations WHERE name LIKE $1', [orgPattern])");
    });
    test('DeleteGate falla cerrado', () => {
      for (const p of ['offline', 'readonly', 'dml', 'http'] as const) {
        const gate = new DeleteGate(p);
        expect(() => gate.assertArmed()).toThrow(); expect(() => gate.arm()).toThrow();
        gate.mark('identity'); gate.mark('schema'); expect(() => gate.arm()).toThrow(); gate.mark('baseline');
        if (p === 'dml' || p === 'http') { gate.arm(); expect(() => gate.assertArmed()).not.toThrow(); }
        else { expect(() => gate.arm()).toThrow(); expect(() => gate.assertArmed()).toThrow(); }
      }
    });
    test.each(normalizerRejected)('clase 1 $id', c => {
      if (c.field === 'name') expect(normalizePersonName(c.input)).toBeNull();
      else { expect(normalizePersonName(c.input)).not.toBeNull(); expect(organizationNameKey(c.input)).toBeNull(); }
    });
    test.each(checkRejected)('CHECK real sin desbordamiento de columna: $id', c => {
      expect(c.expected).toBe('23514');
      expect(c.constraint).toMatch(/^CK_/);
      const length = [...c.input].length;
      expect([81, 121]).not.toContain(length);
      if (c.column !== 'password_hash') expect(length).toBeLessThanOrEqual(c.column === 'email' ? 120 : 80);
    });
    test.each(columnTypeRejected)('tipo de columna, sin constraint: $id', c => {
      const limit = c.column === 'email' ? 120 : 80;
      expect(c.limit).toBe(limit);
      expect([...c.input]).toHaveLength(limit + 1);
      expect(c.expected).toBe('22001');
      expect(c).not.toHaveProperty('constraint');
    });
    test('clase de tipo cubre name, name_key y email', () => {
      expect(columnTypeRejected.map(c => c.column).sort()).toEqual(['email', 'name', 'name_key']);
    });
    test.each(collisions)('colisión $id', c => {
      expect(c.first).not.toBe(c.second); expect(organizationNameKey(c.first)).toBe(organizationNameKey(c.second));
    });
    test.each(distinct)('sin colisión $id', c => expect(organizationNameKey(c.first)).not.toBe(organizationNameKey(c.second)));
    test('sigma explícita', () => {
      expect(organizationNameKey('ΑΣ')).toBe('ας'); expect(organizationNameKey('Ασ')).toBe('ασ');
    });
    test('PGOPTIONS se sobrescribe/elimina sin mutar entrada', () => {
      const env = { PGOPTIONS: '-c something=off' };
      expect(phaseEnvironment('readonly', env).PGOPTIONS).toBe('-c default_transaction_read_only=on');
      expect(phaseEnvironment('offline', env)).not.toHaveProperty('PGOPTIONS');
      expect(phaseEnvironment('dml', env)).not.toHaveProperty('PGOPTIONS');
      expect(phaseEnvironment('http', env)).not.toHaveProperty('PGOPTIONS');
      expect(env.PGOPTIONS).toBe('-c something=off');
    });
  });
} else {
  // No runtime import of pg, TypeORM, Nest or DATABASE_* access in the offline branch.
  registerConnectedSuite(phase);
}
