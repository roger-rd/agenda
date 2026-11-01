import { CATALOG, LITERALS, SYSTEM, lookup, getQuery, assertAllowed, validateSql } from '../../scripts/harness/c8-pg-queries.cjs';
import { QUERY_CONTRACT } from '../../scripts/harness/c8-gate.cjs';
import { NAME, seeded } from './support/c8-pg-fakes';
const params: Record<string, unknown> = { schema: NAME, schemas: [NAME], app: 'agenda_test_app', oid: 42, key: '4095698742242691401', sleep: 3 };
describe('C8 PostgreSQL catálogo cerrado', () => {
  it('reutiliza las fuentes exactas y congela todo', () => {
    expect(lookup('effective').sql).toBe(QUERY_CONTRACT.materialized);
    expect(lookup('role_membership').sql).toBe(QUERY_CONTRACT.roles);
    expect(lookup('default_acl_schema').sql).toBe(QUERY_CONTRACT.defaultsQuery);
    expect(lookup('default_acl_global').sql).toBe(QUERY_CONTRACT.globalDefaultsQuery);
    expect(CATALOG).toHaveLength(23); expect(new Set(CATALOG.map(q => q.id)).size).toBe(23);
    expect(Object.isFrozen(CATALOG)).toBe(true);
    expect(SYSTEM).toEqual({ begin: 'BEGIN READ ONLY', rollback: 'ROLLBACK', savepoint: 'SAVEPOINT c8_probe', rollbackProbe: 'ROLLBACK TO SAVEPOINT c8_probe', releaseProbe: 'RELEASE SAVEPOINT c8_probe' });
  });
  it.each(CATALOG)('$id valida SQL y parámetros, nunca normaliza', q => {
    expect(Object.isFrozen(q)).toBe(true); expect(Object.isFrozen(q.paramTypes)).toBe(true); expect(Object.isFrozen(q.roles)).toBe(true);
    expect(validateSql(q.sql)).toBe(true);
    expect(q.sql).not.toMatch(/;|--|\/\*|\*\//);
    const stripped = q.sql.replace(/'(?:[^']|'')*'/g, s => {
      expect(LITERALS).toContain(s.slice(1, -1).replace(/''/g, "'")); return ' ';
    });
    expect(stripped).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COPY|pg_terminate_backend|pg_cancel_backend|set_config|pg_advisory_lock|pg_advisory_xact\w*|nextval|setval|lo_\w*|pg_read_file|dblink\w*)\b/i);
    const p = q.paramTypes.map(t => params[t]);
    expect(assertAllowed(q.sql, p, { levelB: true })).toBe(q);
    expect(() => assertAllowed(q.sql + ' ', p, { levelB: true })).toThrow('query_unknown');
    expect(() => assertAllowed(q.sql, [...p, 1], { levelB: true })).toThrow('query_params');
    if (p.length) expect(() => assertAllowed(q.sql, p.slice(1), { levelB: true })).toThrow('query_params');
    if (q.level === 'B') {
      expect(() => getQuery(q.id)).toThrow('query_disabled');
      expect(() => assertAllowed(q.sql, p)).toThrow('query_disabled');
    }
    expect([...q.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])).sort()).toEqual(expect.arrayContaining(q.paramTypes.map((_, i) => i + 1)));
  });
  it.each(["INSERT INTO x VALUES (1)", "SELECT 1 GRANT x", "SELECT 'unlisted'", "SELECT 'USAGE;SELECT'",
    "SELECT 'USAGE--'", "SELECT 'USAGE/* */'", "SELECT 'USAGE''evil'", "SELECT 'unterminated",
    'SELECT pg_catalog.pg_advisory_lock(1)', 'SELECT pg_catalog.pg_advisory_xact_lock(1)',
    'SELECT pg_catalog.pg_terminate_backend(1)', 'SELECT pg_catalog.pg_cancel_backend(1)',
    'SELECT pg_catalog.set_config(1)', 'SELECT pg_catalog.nextval(1)', 'SELECT pg_catalog.setval(1)',
    'SELECT pg_catalog.lo_import(1)', 'SELECT pg_catalog.pg_read_file(1)', 'SELECT dblink(1)',
    'SELECT pg_catalog.pg_sleep(999)', 'select 1;'])('rechaza SQL adversarial %#', sql => {
    expect(() => validateSql(sql)).toThrow('query_invalid'); expect(() => assertAllowed(sql)).toThrow('query_unknown');
  });
  it.each([0, -1, 3.001, NaN, Infinity, '3', null])('pg_sleep acotado %#', v => {
    expect(() => assertAllowed(lookup('timeout_probe').sql, [v])).toThrow('query_params');
  });
  it.each(['01', '-0', '+1', '1\n', '9223372036854775808', '-9223372036854775809', Number('4095698742242691401'), null])('bigint exacto %#', v => {
    expect(() => assertAllowed(lookup('key_roundtrip').sql, [v])).toThrow('query_params');
  });
  it('propiedades aleatorias de claves y texto con semilla fija', () => {
    const random = seeded();
    for (let i = 0; i < 150; i++) {
      const k = BigInt.asIntN(64, (BigInt(random()) << 32n) | BigInt(random())).toString();
      expect(assertAllowed(lookup('key_roundtrip').sql, [k]).id).toBe('key_roundtrip');
      expect(() => assertAllowed(lookup('key_roundtrip').sql + random(), [k])).toThrow();
      expect(() => validateSql(`SELECT 'unexpected_${random()}'`)).toThrow();
    }
  });
  it('rechaza roles, esquemas, oids e ids fuera de dominio', () => {
    for (const p of [[NAME, 'agenda_test_owner'], [NAME + '\n', 'agenda_test_app'], [null, 'agenda_test_app']]) expect(() => assertAllowed(lookup('effective').sql, p)).toThrow();
    for (const p of [[0, [NAME]], [42, [NAME, NAME]], [42, ['public']], [4294967296, []]]) expect(() => assertAllowed(lookup('relation_locks').sql, p)).toThrow();
    expect(() => lookup('anything')).toThrow('query_unknown');
    expect(() => assertAllowed(SYSTEM.begin)).toThrow();
  });
});

describe('C8 SQL límites y procesos de fondo', () => {
  it('sessions selecciona y filtra exclusivamente client backend; conserva NULL usename', () => {
    const sql = lookup('sessions').sql;
    expect(sql).toContain('SELECT pid, usename, application_name, datname, backend_type FROM');
    expect(sql).toContain("WHERE datname = 'agenda_test' AND backend_type = 'client backend' AND (");
    expect(sql).toContain('OR usename IS NULL)');
    expect(LITERALS).toContain('client backend'); expect(validateSql(sql)).toBe(true);
  });
  it.each([';', '--', '/*', '*/'])('rechaza %s en todas las posiciones, incluso literales', token => {
    const sql = "SELECT 'USAGE'";
    for (let position = 0; position <= sql.length; position++) {
      expect(() => validateSql(sql.slice(0, position) + token + sql.slice(position))).toThrow('query_invalid');
    }
  });
  it.each(['VALUES (1)', 'SHOW x', ' SELECT 1', '\nSELECT 1', 'select 1', 'with x AS (SELECT 1) SELECT 1'])('inicio no autorizado: %j', sql => {
    expect(() => validateSql(sql)).toThrow('query_invalid');
  });
  it('schemas acepta 10 únicos y rechaza 11', () => {
    const names = Array.from({ length: 11 }, (_, i) => `uow_2611011200_abc123_${i}`);
    const sql = lookup('relation_locks').sql;
    expect(assertAllowed(sql, [42, names.slice(0, 10)]).id).toBe('relation_locks');
    expect(() => assertAllowed(sql, [42, names])).toThrow('query_params');
  });
});
