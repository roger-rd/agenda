/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { CATALOG, LIMITATIONS, PENDING, LITERALS, ALLOWED_FUNCTIONS, ALLOWED_RELATIONS,
  get, build, validateSql, auditSql, checkRows } from '../../scripts/harness/c8-evidence-queries.cjs';
import { QUERY_CONTRACT } from '../../scripts/harness/c8-gate.cjs';
import { NAME, seeded } from './support/c8-pg-fakes';
const ids = ['ev_context', 'ev_namespace', 'ev_relations', 'ev_routines', 'ev_types',
  'ev_namespace_catalog_counts', 'ev_companions', 'ev_closure', 'ev_external_dependents',
  'ev_extension_members', 'ev_event_triggers', 'ev_role_membership', 'ev_default_acl_schema',
  'ev_default_acl_global', 'ev_outside_census', 'ev_sessions', 'ev_target_relation_locks',
  'ev_advisory_holders', 'ev_prepared_xacts',
  'ev_outbound_references', 'ev_companion_items', 'ev_internal_edges'];
const params: Record<string, unknown> = { schema: NAME, key: '4095698742242691401', app: 'agenda_test_app' };
const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/harness/c8-evidence-queries.cjs'), 'utf8');
const input = (q: typeof CATALOG[number]) => Object.fromEntries(q.params.map(t => [t, params[t]]));
const row = (q: typeof CATALOG[number]) => Object.fromEntries(q.columns.map(c => [c.name,
  c.type === 'string' ? 'value' : c.type === 'number' ? (q.incompleteWhen.some(r => r.column === c.name) ? 1 : 42) : true]));
// A complete, legitimate result set for q: required keys get their own value, count meets the minimum.
const rowFor = (q: typeof CATALOG[number], i: number) => ({ ...row(q), ...(q.requiredKeys ? { [q.requiredKeys.column]: q.requiredKeys.values[i] } : {}) });
const goodRows = (q: typeof CATALOG[number], n = Math.max(1, q.cardinality.min)) => Array.from({ length: n }, (_, i) => rowFor(q, i));
const OK = { ok: true, truncated: false, code: 'ok', serverValidated: false };
const INVALID = { ok: false, truncated: false, code: 'evidence_query_invalid', serverValidated: false };
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('C8 evidence: catálogo cerrado offline', () => {
  it('fija exactamente 22 ids y congela metadatos y vocabularios', () => {
    const evidence = jest.requireActual<typeof import('../../scripts/harness/c8-evidence-queries.cjs')>('../../scripts/harness/c8-evidence-queries.cjs');
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.keys(evidence).sort()).toEqual(['CATALOG', 'LIMITATIONS', 'PENDING', 'LITERALS',
      'ALLOWED_FUNCTIONS', 'ALLOWED_RELATIONS', 'get', 'build', 'validateSql', 'auditSql', 'checkRows'].sort());
    expect(CATALOG.map(q => q.id)).toEqual(ids); expect(CATALOG).toHaveLength(22);
    expect(new Set(CATALOG.map(q => q.id)).size).toBe(22);
    for (const v of [CATALOG, LIMITATIONS, PENDING, LITERALS, ALLOWED_FUNCTIONS, ALLOWED_RELATIONS]) expect(Object.isFrozen(v)).toBe(true);
    for (const q of CATALOG) {
      for (const v of [q, q.params, q.columns, q.limits, q.cardinality, q.incompleteWhen, ...q.columns, ...q.incompleteWhen,
        ...(q.requiredKeys ? [q.requiredKeys, q.requiredKeys.values] : [])]) expect(Object.isFrozen(v)).toBe(true);
      expect(q.serverValidated).toBe(false); expect(q.sqlSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(q.purpose.length).toBeGreaterThan(0); expect(Number.isSafeInteger(q.maxRows)).toBe(true);
      expect(q.maxRows).toBeGreaterThan(0); expect(q.limits.length).toBeGreaterThan(0);
      expect(['identity', 'inventory', 'dependency', 'extension', 'event', 'privilege', 'census', 'concurrency']).toContain(q.class);
      expect(new Set(q.columns.map(c => c.name)).size).toBe(q.columns.length);
      for (const c of q.columns) expect(typeof c.nullable).toBe('boolean');
    }
  });
  it.each(CATALOG)('$id valida SQL constante, parámetros, orden y límite', q => {
    expect(validateSql(q.sql)).toBe(true); expect(validateSql(q.sql, q)).toBe(true); expect(get(q.id)).toBe(q);
    expect(q.sql).not.toMatch(/\$\{|uow_|;|--|\/\*|\*\//); expect(q.sql).toMatch(/^(SELECT|WITH)\b/);
    expect(q.sql).toContain('ORDER BY'); expect(q.sql.endsWith(` LIMIT ${q.maxRows + 1}`)).toBe(true);
    const stripped = q.sql.replace(/'(?:[^']|'')*'/g, literal => {
      expect(LITERALS).toContain(literal.slice(1, -1).replace(/''/g, "'")); return ' ';
    });
    const binds = [...new Set([...stripped.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
    expect(binds).toEqual(q.params.map((_, i) => i + 1));
    // (16) revalidar dentro de build es defensa redundante: get solo devuelve este catálogo congelado.
    const result = build(q.id, input(q));
    expect(result).toEqual({ id: q.id, text: q.sql, values: q.params.map(t => params[t]), serverValidated: false });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.values)).toBe(true);
    expect(() => build(q.id, { ...input(q), extra: 1 })).toThrow('evidence_query_params');
    if (q.params.length) expect(() => build(q.id, {})).toThrow('evidence_query_params');
    expect(() => validateSql(q.sql, { ...q })).toThrow('evidence_query_invalid');
    for (const bad of [q.sql + ' ', q.sql.replace(/ LIMIT \d+$/, ' LIMIT 9999'), q.sql.replace(/ORDER BY/g, '')]) {
      expect(() => validateSql(bad)).toThrow('evidence_query_invalid');
    }
  });
  it('AST: imports exactos, util solo isProxy, SQL literal sin interpolación ni texto prohibido', () => {
    const ast = ts.createSourceFile('evidence.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = []; const util: string[] = [];
    function visit(node: ts.Node) {
      expect(ts.isTemplateExpression(node)).toBe(false);
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'require') {
        const arg = node.arguments[0]; expect(ts.isStringLiteral(arg)).toBe(true);
        if (ts.isStringLiteral(arg)) {
          imports.push(arg.text); if (arg.text === 'node:util') util.push(node.parent.getText(ast));
        }
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === '"sql"') expect(ts.isStringLiteral(node.initializer)).toBe(true);
      ts.forEachChild(node, visit);
    }
    visit(ast); expect(imports).toEqual(['node:util', 'node:crypto', './c8-names.cjs']);
    expect(util).toEqual(["{ types: { isProxy } } = require('node:util')"]);
    expect(source).not.toMatch(/\b(?:DROP|CASCADE|INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|REVOKE|TRUNCATE)\b|c8-drop-policy|c8-provenance|pg_current_xact_id/i);
    expect(source).not.toContain('${');
  });
  it('equivalencia documentada: solo añade ORDER BY/LIMIT a tres contratos', () => {
    // Proyecciones, joins y predicados idénticos tras normalizar espacios.
    // El cap es la única diferencia semántica; la fila centinela invalida evidencia.
    for (const [id, sql] of [['ev_role_membership', QUERY_CONTRACT.roles],
      ['ev_default_acl_schema', QUERY_CONTRACT.defaultsQuery], ['ev_default_acl_global', QUERY_CONTRACT.globalDefaultsQuery]]) {
      expect(normalize(get(id).sql.replace(/ ORDER BY[\s\S]+$/, ''))).toBe(normalize(sql));
    }
    expect(ids).not.toContain('ev_effective_privileges');
    expect(PENDING.join(' ')).toMatch(/ev_effective_privileges.*cross product.*fixed row cap/);
  });
  it.each(['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CASCADE', 'CREATE', 'ALTER', 'GRANT', 'REVOKE', 'TRUNCATE',
    'COPY', 'DO', 'CALL', 'LOCK', 'SET', 'RESET', 'NOTIFY', 'LISTEN', 'UNLISTEN', 'INTO', ';', '--', '/* comment */'])('SQL adversarial %s', token => {
    expect(() => validateSql(`SELECT ${token} 1 ORDER BY 1 LIMIT 2`)).toThrow('evidence_query_invalid');
    expect(() => validateSql(get('ev_namespace').sql.replace(' ORDER BY', ` ${token} ORDER BY`))).toThrow('evidence_query_invalid');
  });
  it.each(['pg_sleep', 'set_config', 'nextval', 'lo_import', 'lo_export', 'pg_read_file', 'dblink',
    'pg_advisory_lock', 'pg_advisory_xact_lock', 'pg_terminate_backend', 'pg_cancel_backend'])('función no autorizada %s', name => {
    expect(ALLOWED_FUNCTIONS).not.toContain(name);
    expect(() => validateSql(`SELECT pg_catalog.${name}(1) ORDER BY 1 LIMIT 2`)).toThrow('evidence_query_invalid');
  });
  it('rechaza relaciones, literales, casts y placeholders fuera de contrato', () => {
    const sql = get('ev_namespace').sql;
    for (const mutated of [sql.replace('pg_catalog.pg_namespace', 'pg_namespace'),
      sql.replace('pg_catalog.pg_namespace', 'public.pg_namespace'), sql.replace('pg_catalog.pg_namespace', 'pg_catalog.pg_authid'),
      sql.replace("'pg_namespace'", "'unlisted'"), sql.replace("'pg_namespace'", "'unterminated"),
      sql.replace('$1', '$2'), sql.replace('$1', '$0'), sql.replace('$1', '$01'), sql.replace('$1', '1'),
      sql.replace('$1', '$1 + $2'), sql.replace('::name', '::unknown'), sql.toLowerCase(), null, {}, [], 1]) {
      expect(() => validateSql(mutated)).toThrow('evidence_query_invalid');
    }
    expect(ALLOWED_RELATIONS).not.toContain('pg_authid');
  });
  it('rechaza ids, prototipos, símbolos, proxies y getters sin invocarlos', () => {
    expect(() => get('unknown')).toThrow('evidence_query_unknown');
    expect(() => build('unknown', {})).toThrow('evidence_query_unknown');
    expect(() => checkRows('unknown', [])).toThrow('evidence_query_unknown');
    const trap = jest.fn(() => { throw new Error('called'); });
    const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const accessor = Object.defineProperty({}, 'schema', { get: trap });
    for (const bad of [null, [], NAME, Object.create({ schema: NAME }), proxy, revoked.proxy, accessor,
      { schema: NAME, [Symbol('extra')]: 1 }, { schema: NAME, extra: 1 }]) expect(() => build('ev_namespace', bad)).toThrow('evidence_query_params');
    for (const schema of ['x"; DROP', NAME.toUpperCase(), NAME + '\n', null, [], {}, proxy]) {
      expect(() => build('ev_namespace', { schema })).toThrow('evidence_query_params');
    }
    expect(trap).not.toHaveBeenCalled();
    expect(build('ev_namespace', Object.assign(Object.create(null), { schema: NAME })).values).toEqual([NAME]);
  });
  // (25) length <= 20 limita trabajo: formato canónico + rango int64 ya rechazan cadenas más largas.
  it('key canónica, rango exacto y app fijo', () => {
    for (const key of ['01', '-0', '+1', '1\n', '9223372036854775808', '-9223372036854775809', 1, null, {}, []]) expect(() => build('ev_advisory_holders', { key })).toThrow('evidence_query_params');
    for (const key of ['0', '-1', '9223372036854775807', '-9223372036854775808']) expect(build('ev_advisory_holders', { key }).values).toEqual([key]);
    expect(() => build('ev_role_membership', { app: 'agenda_test_owner' })).toThrow('evidence_query_params');
  });
  it.each(CATALOG)('$id filas exactas, null explícito, cardinalidad y truncamiento', q => {
    const good = rowFor(q, 0); const base = goodRows(q);
    expect(checkRows(q.id, base)).toEqual(OK);
    expect(Object.isFrozen(checkRows(q.id, []))).toBe(true);
    expect(checkRows(q.id, goodRows(q, q.cardinality.max)).ok).toBe(!q.requiredKeys || q.cardinality.max === q.requiredKeys.values.length);
    expect(checkRows(q.id, Array.from({ length: q.maxRows + 1 }, () => good))).toEqual({ ok: false, truncated: true, code: 'evidence_query_truncated', serverValidated: false });
    expect(checkRows(q.id, Array.from({ length: q.maxRows + 2 }, () => good))).toEqual(INVALID);
    const patch = (extra: Record<string, unknown>, del?: string) => { const r = [...base]; const next: any = { ...r[0], ...extra }; if (del) delete next[del]; r[0] = next; return r; };
    expect(checkRows(q.id, patch({ extra: true })).ok).toBe(false);
    for (const c of q.columns) {
      expect(checkRows(q.id, patch({}, c.name)).ok).toBe(false);
      expect(checkRows(q.id, patch({ [c.name]: {} })).ok).toBe(false);
      const nullIncomplete = q.incompleteWhen.some(r => r.column === c.name && r.op === 'isNull');
      expect(checkRows(q.id, patch({ [c.name]: null })).ok).toBe(c.nullable && !nullIncomplete && c.name !== q.requiredKeys?.column);
      if (c.type === 'number') for (const v of [NaN, Infinity]) expect(checkRows(q.id, patch({ [c.name]: v })).ok).toBe(false);
    }
  });
  it('filas y arrays hostiles no ejecutan getters', () => {
    const q = get('ev_namespace'); const good = row(q); const trap = jest.fn();
    const accessor = Object.defineProperty({ ...good }, 'oid', { get: trap });
    const arrayAccessor = Object.defineProperty([], '0', { get: trap });
    for (const bad of [null, {}, new Array(1), arrayAccessor, new Proxy([], {}), [accessor],
      [new Proxy(good, {})], [Object.create(good)], [{ ...good, [Symbol('x')]: 1 }], Object.assign([good], { extra: 1 })]) expect(checkRows(q.id, bad).ok).toBe(false);
    expect(trap).not.toHaveBeenCalled();
  });
  it('documenta límites y pendientes mínimos', () => {
    const limitations = LIMITATIONS.join(' ');
    for (const re of [/function bodies.*string literals.*dynamic SQL/, /Application references.*external configuration/,
      /role\/database search_path.*cached plans/, /Cluster-level roles, databases and tablespaces/, /other databases/,
      /row data, sequence values, statistics or function bodies/, /Pinned system objects/, /storage.*index validity/,
      /statistics privileges/, /snapshot.*subsequent changes.*double collection.*collector/, /No query.*real PostgreSQL server/]) expect(limitations).toMatch(re);
    const pending = PENDING.join(' ');
    for (const re of [/Physical backend identity.*server transaction identity/, /Companion classes.*justification and validation/,
      /Functions, procedures, types, domains, materialized views and partitioned tables/, /Publications, subscriptions, FDW and large objects/, /S2-bis/]) expect(pending).toMatch(re);
    expect(get('ev_routines').class).toBe('inventory'); expect(get('ev_routines').limits.join(' ')).toMatch(/DETECTION for exclusion/);
  });
  it('profundidad, ámbitos y censo quedan auditables en SQL', () => {
    for (const id of ['ev_closure', 'ev_external_dependents']) {
      expect(get(id).sql).toContain('w.depth < 17'); expect(get(id).sql).not.toContain('w.depth < 16'); expect(get(id).sql).toContain('pg_catalog.strpos(w.path');
      expect(get(id).sql).toContain("d.deptype IN ('n', 'a', 'i', 'P', 'S')"); expect(get(id).maxRows).toBe(500);
    }
    const census = get('ev_outside_census'); expect(census.maxRows).toBe(16);
    expect(census.sql.match(/pg_catalog.sha256/g)).toHaveLength(10);
    expect(census.sql).toContain('pg_catalog.json_build_array'); expect(census.sql).toContain('ORDER BY x.oid');
    expect(census.sql).toContain('AND x.typrelid = 0'); expect(census.sql).toContain('AND NOT x.tgisinternal');
    expect(census.sql).toContain("'^pg_(temp_|toast_temp_)'");
    expect(get('ev_advisory_holders').sql).toContain('l.objsubid = 1'); expect(get('ev_advisory_holders').sql).toContain('AND l.granted');
    expect(get('ev_target_relation_locks').sql).toContain('l.pid IS NULL');
    expect(get('ev_sessions').limits.join(' ')).toMatch(/statistics privileges.*state\/query/);
  });
  it('propiedades pseudoaleatorias con semilla fija', () => {
    const random = seeded();
    for (let i = 0; i < 150; i++) {
      const key = BigInt.asIntN(64, (BigInt(random()) << 32n) | BigInt(random())).toString();
      expect(build('ev_advisory_holders', { key }).values).toEqual([key]);
      const schema = `uow_2611011200_abc123_${random() % 1000}`;
      expect(build('ev_namespace', { schema }).text).toBe(get('ev_namespace').sql);
      expect(() => build('ev_namespace', { schema: schema + String.fromCharCode(random() % 32) })).toThrow('evidence_query_params');
      const q = CATALOG[random() % CATALOG.length];
      expect(() => validateSql(q.sql + random())).toThrow('evidence_query_invalid');
      expect(() => validateSql(`SELECT 'unexpected_${random()}' ORDER BY 1 LIMIT 2`)).toThrow('evidence_query_invalid');
    }
  });
});

describe('auditSql: reglas léxicas independientes del catálogo', () => {
  const options = { maxRows: 1, paramCount: 0 };
  const validSql = 'SELECT 1 ORDER BY 1 LIMIT 2';
  it('acepta SQL no catálogo, CTE propio y referencias repetidas a parámetros', () => {
    expect(CATALOG.some(q => q.sql === validSql)).toBe(false);
    expect(auditSql(validSql, options)).toBe(true);
    expect(() => validateSql(validSql)).toThrow('evidence_query_invalid');
    expect(auditSql('WITH own AS (SELECT 1 AS n) SELECT n FROM own ORDER BY n LIMIT 2', options)).toBe(true);
    expect(auditSql('SELECT $1::oid, $1::oid ORDER BY 1 LIMIT 2', { ...options, paramCount: 1 })).toBe(true);
    expect(auditSql('SELECT pg_catalog.count(*) FROM pg_catalog.pg_class ORDER BY 1 LIMIT 2', options)).toBe(true);
  });
  it.each([';', '--', '/* */'])('rechaza delimitador/comentario %j sin otra regla que lo oculte', token => {
    expect(() => auditSql(`SELECT 1 ${token} ORDER BY 1 LIMIT 2`, options)).toThrow('evidence_query_invalid');
  });
  it('rechaza literal fuera de LITERALS', () => {
    expect(() => auditSql("SELECT 'unlisted' ORDER BY 1 LIMIT 2", options)).toThrow('evidence_query_invalid');
    expect(auditSql("SELECT 'MEMBER' ORDER BY 1 LIMIT 2", options)).toBe(true);
  });
  it.each(['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CASCADE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'TRUNCATE',
    'COPY', 'DO', 'CALL', 'LOCK', 'SET', 'RESET', 'NOTIFY', 'LISTEN', 'UNLISTEN', 'VACUUM', 'ANALYZE',
    'REINDEX', 'CLUSTER', 'REFRESH', 'DISCARD', 'INTO', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
    'RELEASE', 'PREPARE', 'EXECUTE'])('rechaza palabra FORBIDDEN %s fuera de literales', token => {
    expect(() => auditSql(`SELECT 1 ${token} ORDER BY 1 LIMIT 2`, options)).toThrow('evidence_query_invalid');
  });
  it('exige inicio SELECT/WITH sin depender de FORBIDDEN', () => {
    expect(() => auditSql('VALUES 1 ORDER BY 1 LIMIT 2', options)).toThrow('evidence_query_invalid');
  });
  it('rechaza cast fuera de CASTS', () => {
    expect(() => auditSql('SELECT 1::unknown ORDER BY 1 LIMIT 2', options)).toThrow('evidence_query_invalid');
  });
  it.each(['pg_catalog.pg_sleep', 'pg_sleep'])('rechaza función fuera de lista %s', name => {
    expect(() => auditSql(`SELECT ${name}(1) ORDER BY 1 LIMIT 2`, options)).toThrow('evidence_query_invalid');
  });
  it.each(['count', 'public.count'])('exige pg_catalog para función permitida %s', name => {
    expect(() => auditSql(`SELECT ${name}(1) ORDER BY 1 LIMIT 2`, options)).toThrow('evidence_query_invalid');
  });
  it.each(['FROM', 'JOIN'])('rechaza relación fuera de lista después de %s', keyword => {
    const from = keyword === 'JOIN' ? 'FROM pg_catalog.pg_class c ' : '';
    expect(() => auditSql(`SELECT 1 ${from}${keyword} pg_catalog.pg_authid ORDER BY 1 LIMIT 2`, options)).toThrow('evidence_query_invalid');
  });
  it.each(['pg_class', 'public.pg_class', 'missing_cte'])('rechaza relación sin calificar o externa %s', relation => {
    expect(() => auditSql(`SELECT 1 FROM ${relation} ORDER BY 1 LIMIT 2`, options)).toThrow('evidence_query_invalid');
  });
  it('rechaza función FROM fuera de lista', () => {
    expect(() => auditSql('SELECT 1 FROM pg_catalog.pg_sleep(1) ORDER BY 1 LIMIT 2', options)).toThrow('evidence_query_invalid');
  });
  it.each([
    ['saltado', '$1, $3', 2], ['duplicado no sustituye al segundo parámetro', '$1, $1', 2],
    ['extra', '$1, $2', 1], ['faltante', '$1', 2], ['ninguno', '1', 1], ['posición cero', '$0', 1],
  ])('rechaza placeholders: %s', (_, projection, paramCount) => {
    expect(() => auditSql(`SELECT ${projection} ORDER BY 1 LIMIT 2`, { ...options, paramCount })).toThrow('evidence_query_invalid');
  });
  it('exige ORDER BY', () => {
    expect(() => auditSql('SELECT 1 LIMIT 2', options)).toThrow('evidence_query_invalid');
  });
  it.each(['SELECT 1 ORDER BY 1', 'SELECT 1 ORDER BY 1 LIMIT 3'])('exige LIMIT final coherente: %s', sql => {
    expect(() => auditSql(sql, options)).toThrow('evidence_query_invalid');
  });
  it('valida el maxRows suministrado, sin consultar el catálogo', () => {
    expect(() => auditSql(validSql, { ...options, maxRows: 2 })).toThrow('evidence_query_invalid');
  });
  it('rechaza límites inválidos y parámetros de auditoría ambiguos', () => {
    for (const maxRows of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => auditSql(validSql, { ...options, maxRows })).toThrow('evidence_query_invalid');
    for (const paramCount of [-1, 1.5, Infinity]) expect(() => auditSql(validSql, { ...options, paramCount })).toThrow('evidence_query_invalid');
    const getter = jest.fn(() => { throw new Error('getter invoked'); });
    const accessor = Object.defineProperty({ ...options }, 'maxRows', { get: getter });
    expect(() => auditSql(validSql, accessor)).toThrow('evidence_query_invalid');
    expect(() => auditSql(validSql, new Proxy(options, {}))).toThrow('evidence_query_invalid');
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('descriptores y prototipos con claves propias válidas', () => {
  it('rechaza un prototipo de clase aunque todas las claves sean propias y válidas (18)', () => {
    class Parameters { schema = NAME; }
    expect(() => build('ev_namespace', new Parameters())).toThrow('evidence_query_params');
    const q = get('ev_namespace');
    const exoticRow = Object.assign(Object.create(Parameters.prototype), row(q));
    expect(checkRows(q.id, [exoticRow])).toEqual(INVALID);
  });
  it('rechaza accessor con claves exactas sin invocar getter (20; defensa redundante)', () => {
    // Sin hasOwn(value), descriptor.value es undefined: parameter/column type lo rechaza igualmente.
    const getter = jest.fn(() => { throw new Error('getter invoked'); });
    const parameters = Object.defineProperty({}, 'schema', { get: getter });
    expect(Reflect.ownKeys(parameters)).toEqual(['schema']);
    expect(() => build('ev_namespace', parameters)).toThrow('evidence_query_params');
    const q = get('ev_namespace');
    const accessor = Object.defineProperty(row(q), 'oid', { get: getter });
    expect(checkRows(q.id, [accessor]).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('rechaza accessor de índice con longitud y claves correctas (29; defensa redundante)', () => {
    // Sin hasOwn(value), record(undefined) también rechaza sin acceder al getter original.
    const getter = jest.fn(() => { throw new Error('getter invoked'); });
    const rows = Object.defineProperty([], '0', { get: getter });
    expect(Reflect.ownKeys(rows)).toEqual(['0', 'length']); expect(rows.length).toBe(1);
    expect(checkRows('ev_namespace', rows)).toEqual(INVALID);
    expect(getter).not.toHaveBeenCalled();
  });
  it('rechaza subclase Array con filas y claves válidas (33)', () => {
    class Rows extends Array<Record<string, unknown>> {}
    const rows = new Rows(row(get('ev_namespace')));
    expect(Reflect.ownKeys(rows)).toEqual(['0', 'length']);
    expect(checkRows('ev_namespace', rows)).toEqual(INVALID);
  });
});

/** Huellas del commit C2 (79571fc), antes de C2.x: solo dos cambian y tres consultas se añaden. */
const DIGESTS_C2: Record<string, string> = {
  ev_context: '1e75233fc91705188f7a38893ad432c65c04ddf2f8a81bec3f183009962fbc6a',
  ev_namespace: '10b1ad773b716e94ce8eed6357b0acbea33b5a0e176eb9ef5f2c18658a3e8db7',
  ev_relations: 'c7030dd955267ff7bc25989461991a87250696582f0454fca61e750337d392e7',
  ev_routines: 'df1496cb040d4169a4d168cf4a5b51b38a32a89d5d23f92d3989ab7304195716',
  ev_types: '4a8f460d23eb16be0e9495259962b54f73db0b5dd27adf3f7ab439d2b8d48de3',
  ev_namespace_catalog_counts: 'dde8d36c90e27dc3ee4f459a6bdd78e993160ebb6fbfefbc2509665e55803014',
  ev_companions: '75c67807a5de6b6042de7ec46c3612fd52badf82e2542731693562df0f4e2612',
  ev_closure: 'fea30caa2dfa087d4ec07761d324cc1e5c8498a0697e2338a06ec82ca56ab4c9',
  ev_external_dependents: '0ef646cd26641105159576657813c69e1794b35fd36d0cea7e1adf067e0d84be',
  ev_extension_members: '9e4988d0aa52ba740d62e27ad09d83b2df626844a436cf5a7f3d0d0a2a4f1d5b',
  ev_event_triggers: '7b5ac81c4a9c0e3b0cceb61d515678daf3524e2eace81271bf0ddf31fc24a6bb',
  ev_role_membership: 'cd50e9ae7364e593c10eee9f599fd814cf43856bf654d56d9fb6b288bccaac5d',
  ev_default_acl_schema: '629589df14b53c240b029f763924de81757109efd384d8dddfbb52dfd457ef74',
  ev_default_acl_global: '88ad3cea66d71a13ab6ead109e15eae2fbefd6c37e8d8d6d6af9f02f50291461',
  ev_outside_census: '6007b6594445f679bc7df705075b713f9033f9df838faac75daa26afb78797ff',
  ev_sessions: '3aeaf29935e7f6767e0419de3c2c1228a3304b918319f67f940512f11909405d',
  ev_target_relation_locks: '0985bc2b3111e0f0115b484c3c33d49d00ae1ed140f0e16acf09108d49ed7a3c',
  ev_advisory_holders: '9f54dac3f55cc778e0da295c273e23ef3e1012f57bd95c96d812ae344d5fe1c4',
  ev_prepared_xacts: '19f45520fcf502b330cd6ccf9246cbeff940de8343ce12287ea89dce41aa1a26',
};
const DIGESTS: Record<string, string> = {
  ev_context: '1e75233fc91705188f7a38893ad432c65c04ddf2f8a81bec3f183009962fbc6a',
  ev_namespace: '10b1ad773b716e94ce8eed6357b0acbea33b5a0e176eb9ef5f2c18658a3e8db7',
  ev_relations: 'c7030dd955267ff7bc25989461991a87250696582f0454fca61e750337d392e7',
  ev_routines: 'df1496cb040d4169a4d168cf4a5b51b38a32a89d5d23f92d3989ab7304195716',
  ev_types: '4a8f460d23eb16be0e9495259962b54f73db0b5dd27adf3f7ab439d2b8d48de3',
  ev_namespace_catalog_counts: 'dde8d36c90e27dc3ee4f459a6bdd78e993160ebb6fbfefbc2509665e55803014',
  ev_companions: '75c67807a5de6b6042de7ec46c3612fd52badf82e2542731693562df0f4e2612',
  ev_closure: 'fea30caa2dfa087d4ec07761d324cc1e5c8498a0697e2338a06ec82ca56ab4c9',
  ev_external_dependents: '907d266d9a95a753e5e878f0c9528761db1a65572b7016a88ce1e184a7855dcb',
  ev_extension_members: 'c0c5d41697c7514f246352ffacb861dd3c6a5fbaac132f34990ad4a73ff255ba',
  ev_event_triggers: '7b5ac81c4a9c0e3b0cceb61d515678daf3524e2eace81271bf0ddf31fc24a6bb',
  ev_role_membership: 'cd50e9ae7364e593c10eee9f599fd814cf43856bf654d56d9fb6b288bccaac5d',
  ev_default_acl_schema: '629589df14b53c240b029f763924de81757109efd384d8dddfbb52dfd457ef74',
  ev_default_acl_global: '88ad3cea66d71a13ab6ead109e15eae2fbefd6c37e8d8d6d6af9f02f50291461',
  ev_outside_census: '6007b6594445f679bc7df705075b713f9033f9df838faac75daa26afb78797ff',
  ev_sessions: '3aeaf29935e7f6767e0419de3c2c1228a3304b918319f67f940512f11909405d',
  ev_target_relation_locks: '0985bc2b3111e0f0115b484c3c33d49d00ae1ed140f0e16acf09108d49ed7a3c',
  ev_advisory_holders: '9f54dac3f55cc778e0da295c273e23ef3e1012f57bd95c96d812ae344d5fe1c4',
  ev_prepared_xacts: '19f45520fcf502b330cd6ccf9246cbeff940de8343ce12287ea89dce41aa1a26',
  ev_outbound_references: 'a0ee78043ef70af8b87d435a584437319e6d1abdf156f2a990acc0a0fcf21e9e',
  ev_companion_items: '5debce8398b432617b4549143a2c46e1461e2200c39d8cc63fb599fa76cb3e37',
  ev_internal_edges: 'e61115ac919f95038d882bfe187eac1697bd0db275bdd6d54c63d951941310fa',
};
const CENSUS = ['namespace', 'class', 'proc', 'type', 'constraint', 'trigger', 'policy', 'extension', 'event_trigger', 'default_acl'];
const censusRows = (names: string[]) => names.map(catalog => ({ catalog, n: '1', digest: 'f'.repeat(64) }));
const closureRow = (depth: number, objid = 1) => ({ depth, classid: 'pg_class', objid, objsubid: 0, deptype: 'n' });
const externalRow = (namespace: string | null, extra: Record<string, unknown> = {}) => ({ depth: 1, classid: 'pg_class', objid: 7, objsubid: 0,
  deptype: 'n', refclassid: 'pg_class', refobjid: 5, namespace, ...extra });

describe('S1-C/C2 corrección 1: frontera explícita de profundidad en ev_closure', () => {
  it('declara el centinela 17 en SQL y metadatos legibles por máquina', () => {
    for (const id of ['ev_closure', 'ev_external_dependents']) {
      expect(get(id).sql).toContain('w.depth < 17');
      expect(get(id).incompleteWhen).toContainEqual({ column: 'depth', op: 'gte', value: 17 });
    }
    expect(get('ev_closure').limits.join(' ')).toMatch(/Maximum evaluable depth is 16.*depth 17 is a sentinel|Depth 17 is a sentinel/i);
  });
  it('profundidad 16 es evaluable; cualquier fila 17 es evidencia incompleta aunque haya menos de maxRows filas', () => {
    expect(checkRows('ev_closure', [closureRow(1), closureRow(16, 2)])).toEqual(OK);
    expect(checkRows('ev_closure', [closureRow(1), closureRow(16, 2), closureRow(17, 3)]))
      .toEqual({ ok: false, truncated: false, code: 'evidence_query_incomplete', serverValidated: false });
    expect(checkRows('ev_closure', [closureRow(17)]).code).toBe('evidence_query_incomplete');
    expect(checkRows('ev_closure', [closureRow(18)]).ok).toBe(false);
    expect(checkRows('ev_closure', [closureRow(1), closureRow(17, 9)]).ok).toBe(false);
  });
  it('un grafo truncado por filas sigue siendo truncado y no se confunde con completo', () => {
    const many = Array.from({ length: 501 }, (_, i) => closureRow(1, i + 1));
    expect(checkRows('ev_closure', many)).toEqual({ ok: false, truncated: true, code: 'evidence_query_truncated', serverValidated: false });
    const full = Array.from({ length: 500 }, (_, i) => closureRow(1, i + 1));
    expect(checkRows('ev_closure', full).ok).toBe(true);
    expect(checkRows('ev_closure', [...full.slice(1), closureRow(17, 9999)]).code).toBe('evidence_query_incomplete');
  });
  it('la profundidad es numérica: no se acepta como texto ni se omite', () => {
    expect(checkRows('ev_closure', [{ ...closureRow(17), depth: '17' }])).toEqual(INVALID);
    const { depth, ...missing } = closureRow(17); void depth;
    expect(checkRows('ev_closure', [missing])).toEqual(INVALID);
  });
});

describe('S1-C/C2 corrección 2: ev_external_dependents conserva lo no resoluble', () => {
  const sql = get('ev_external_dependents').sql;
  it('usa LEFT JOIN y conserva filas sin dirección o sin namespace', () => {
    expect(sql).toContain('LEFT JOIN addresses a ON a.classid = w.classid AND a.objid = w.objid');
    expect(sql).toContain('LEFT JOIN pg_catalog.pg_namespace n ON n.oid = a.namespace');
    expect(sql).toContain('WHERE a.objid IS NULL OR n.nspname IS NULL OR n.nspname <> $1::name');
    expect(sql).not.toMatch(/(?<!LEFT )JOIN addresses/);
    expect(sql).not.toMatch(/(?<!LEFT )JOIN pg_catalog\.pg_namespace n ON n\.oid = a\.namespace/);
  });
  it('expone la arista de dependencia comprobable y namespace anulable', () => {
    const columns = Object.fromEntries(get('ev_external_dependents').columns.map(c => [c.name, c]));
    expect(columns.refclassid).toMatchObject({ type: 'string', nullable: false });
    expect(columns.refobjid).toMatchObject({ type: 'number', nullable: false });
    expect(columns.namespace).toMatchObject({ type: 'string', nullable: true });
    expect(get('ev_external_dependents').incompleteWhen).toContainEqual({ column: 'namespace', op: 'isNull' });
  });
  it('una clase desconocida o namespace nulo hace la evidencia incompleta, no vacía ni completa', () => {
    expect(checkRows('ev_external_dependents', [externalRow('other_schema')])).toEqual(OK);
    for (const rows of [[externalRow(null)], [externalRow('other_schema'), externalRow(null, { objid: 8 })],
      [externalRow('a'), externalRow('b', { objid: 9 }), externalRow(null, { classid: 'pg_policy', objid: 10 })]]) {
      expect(checkRows('ev_external_dependents', rows)).toEqual({ ok: false, truncated: false, code: 'evidence_query_incomplete', serverValidated: false });
    }
    expect(checkRows('ev_external_dependents', [externalRow('other_schema', { depth: 17 })]).code).toBe('evidence_query_incomplete');
    expect(checkRows('ev_external_dependents', [{ ...externalRow('x'), namespace: undefined }])).toEqual(INVALID);
  });
  it('no clasifica pg_toast como compañero seguro: la decisión exige la arista interna que el consumidor verifique', () => {
    expect(sql).not.toMatch(/pg_toast/);
    const toast = externalRow('pg_toast', { deptype: 'i', refclassid: 'pg_class', refobjid: 5 });
    const result = checkRows('ev_external_dependents', [toast]);
    // El catálogo solo informa forma y completitud; ningún campo del resultado declara seguridad ni compañerismo.
    expect(Object.keys(result).sort()).toEqual(['code', 'ok', 'serverValidated', 'truncated']);
    expect(get('ev_external_dependents').limits.join(' ')).toMatch(/pg_toast are not classified as safe companions.*verifiable internal \('i'\) edge.*allowed class/s);
    expect(Object.keys(get('ev_external_dependents'))).not.toEqual(expect.arrayContaining(['companions', 'safe', 'allowToast']));
  });
});

describe('S1-C/C2 corrección 3: cardinalidad, claves obligatorias y consulta fallida', () => {
  it('los metadatos son enteros coherentes y ligan el censo a su SQL', () => {
    for (const q of CATALOG) {
      expect(Number.isSafeInteger(q.cardinality.min) && Number.isSafeInteger(q.cardinality.max)).toBe(true);
      expect(q.cardinality.min).toBeGreaterThanOrEqual(0); expect(q.cardinality.min).toBeLessThanOrEqual(q.cardinality.max);
      expect(q.cardinality.max).toBeLessThanOrEqual(q.maxRows);
    }
    expect(get('ev_context').cardinality).toEqual({ min: 1, max: 1 });
    expect(get('ev_outside_census').cardinality).toEqual({ min: 10, max: 10 });
    const census = get('ev_outside_census');
    expect(census.requiredKeys).toEqual({ column: 'catalog', values: CENSUS });
    const inSql = [...census.sql.matchAll(/SELECT '(\w+)'::text AS catalog/g)].map(m => m[1]);
    expect(inSql).toEqual(CENSUS); expect(census.sql.match(/pg_catalog\.sha256/g)).toHaveLength(CENSUS.length);
  });
  it('el censo exige exactamente las 10 clases, sin ausencias, duplicados ni extras, en cualquier orden', () => {
    expect(checkRows('ev_outside_census', censusRows(CENSUS))).toEqual(OK);
    expect(checkRows('ev_outside_census', censusRows([...CENSUS].reverse())).ok).toBe(true);
    const cardinality = { ok: false, truncated: false, code: 'evidence_query_cardinality', serverValidated: false };
    expect(checkRows('ev_outside_census', censusRows(CENSUS.slice(1)))).toEqual(cardinality);
    expect(checkRows('ev_outside_census', censusRows([...CENSUS, 'extra']))).toEqual(cardinality);
    expect(checkRows('ev_outside_census', censusRows([...CENSUS.slice(0, 9), 'class']))).toEqual(cardinality);
    expect(checkRows('ev_outside_census', censusRows([...CENSUS.slice(0, 9), 'unknown_class']))).toEqual(cardinality);
    expect(checkRows('ev_outside_census', censusRows([...CENSUS.slice(0, 9), 'CLASS']))).toEqual(cardinality);
    expect(checkRows('ev_outside_census', [])).toEqual(cardinality);
    expect(checkRows('ev_outside_census', censusRows(CENSUS.slice(0, 5))).ok).toBe(false);
  });
  it('las consultas de una fila rechazan resultado vacío; vacío solo es válido donde significa ausencia', () => {
    expect(checkRows('ev_context', [])).toEqual({ ok: false, truncated: false, code: 'evidence_query_cardinality', serverValidated: false });
    expect(checkRows('ev_context', goodRows(get('ev_context'))).ok).toBe(true);
    expect(checkRows('ev_context', goodRows(get('ev_context'), 2)).truncated).toBe(true);
    for (const id of ['ev_namespace', 'ev_relations', 'ev_closure', 'ev_sessions', 'ev_prepared_xacts']) expect(checkRows(id, [])).toEqual(OK);
  });
  it.each([undefined, null, 'error', new Error('connection lost'), { rows: [] }, { error: 'x' }, 0, false, Promise.resolve([])])(
    'una consulta fallida o ausente nunca es una lista vacía válida: %#', failed => {
      for (const q of CATALOG) expect(checkRows(q.id, failed)).toEqual(INVALID);
    });
});

describe('S1-C/C2 corrección 3 (cont.): objetos que imitan un array vacío no son una lista vacía válida', () => {
  it('rechaza array-likes con prototipo Array, aunque su length sea 0', () => {
    const arrayLike = Object.setPrototypeOf({ length: 0 }, Array.prototype);
    expect(Array.isArray(arrayLike)).toBe(false);
    for (const id of ['ev_context', 'ev_namespace', 'ev_outside_census']) {
      expect(checkRows(id, arrayLike)).toEqual(INVALID);
      expect(checkRows(id, Object.create(Array.prototype))).toEqual(INVALID);
      expect(checkRows(id, { length: 0 })).toEqual(INVALID);
    }
  });
});

describe('S1-C/C2 corrección 4: la identidad de la base nunca la aporta el llamador', () => {
  const q = get('ev_target_relation_locks');
  it('solo recibe el esquema y deriva la base dentro del SQL', () => {
    expect(q.params).toEqual(['schema']);
    expect(q.sql).not.toMatch(/\$2/); expect(q.sql).not.toMatch(/::oid\b/);
    expect(q.sql).toContain('l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())');
    for (const entry of CATALOG) expect(entry.params.every(p => ['schema', 'key', 'app'].includes(p))).toBe(true);
    expect(build(q.id, { schema: NAME }).values).toEqual([NAME]);
  });
  it.each([1, 42, 4294967295, 0, -1, '42', null, {}])('rechaza una identidad de base aportada por el llamador %#', oid => {
    expect(() => build(q.id, { schema: NAME, oid })).toThrow('evidence_query_params');
    expect(() => build(q.id, { oid })).toThrow('evidence_query_params');
  });
  it('un resultado vacío solo es interpretable junto a un contexto verificado, y esa condición está declarada', () => {
    expect(q.limits.join(' ')).toMatch(/identity is derived inside the query/);
    expect(q.limits.join(' ')).toMatch(/empty result is only meaningful together with a successful ev_context/);
    expect(checkRows(q.id, [])).toEqual(OK);
    expect(checkRows(q.id, undefined)).toEqual(INVALID);
  });
});

describe('S1-C/C2 corrección 5: estado de validación en servidor', () => {
  it('todas las consultas declaran serverValidated=false y el estado no es modificable', () => {
    expect(CATALOG.every(q => q.serverValidated === false)).toBe(true);
    expect(JSON.stringify(CATALOG)).not.toMatch(/"serverValidated":true/);
    for (const q of CATALOG) {
      expect(() => { (q as any).serverValidated = true; }).toThrow(TypeError);
      expect(() => { (q as any).sqlSha256 = 'x'; }).toThrow(TypeError);
      expect(() => { (q.cardinality as any).max = 99; }).toThrow(TypeError);
      expect(() => { (q.incompleteWhen as any).push({}); }).toThrow(TypeError);
      expect(q.serverValidated).toBe(false);
    }
    expect(() => { (CATALOG as any).push({}); }).toThrow(TypeError);
  });
  it('el llamador no puede declarar validación en build, auditSql ni checkRows', () => {
    expect(() => build('ev_namespace', { schema: NAME, serverValidated: true })).toThrow('evidence_query_params');
    const built = build('ev_namespace', { schema: NAME });
    expect(built.serverValidated).toBe(false); expect(Object.isFrozen(built)).toBe(true);
    expect(() => { (built as any).serverValidated = true; }).toThrow(TypeError);
    const checked = checkRows('ev_namespace', [{ ...row(get('ev_namespace')), serverValidated: true }]);
    expect(checked).toEqual(INVALID);
    const ok = checkRows('ev_namespace', goodRows(get('ev_namespace')));
    expect(ok.serverValidated).toBe(false); expect(Object.isFrozen(ok)).toBe(true);
    expect(() => { (ok as any).serverValidated = true; }).toThrow(TypeError);
    expect(() => auditSql(get('ev_namespace').sql, { maxRows: 1, paramCount: 1, serverValidated: true } as any)).toThrow('evidence_query_invalid');
  });
  it('fija el texto exacto de cada SQL: sqlSha256 coincide y cualquier cambio exige revisarlo', () => {
    const { createHash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    for (const q of CATALOG) expect(q.sqlSha256).toBe(createHash('sha256').update(q.sql).digest('hex'));
    expect(Object.fromEntries(CATALOG.map(q => [q.id, q.sqlSha256]))).toEqual(DIGESTS);
  });
  it('documenta que S2-bis debe verificar SQL exacto y resultados antes de tratarlos como evidencia demostrada', () => {
    expect(PENDING.join(' ')).toMatch(/S2-bis must verify the exact SQL text \(sqlSha256\).*result shapes.*before C3 may treat any row as demonstrated evidence.*serverValidated stays false/);
    expect(LIMITATIONS.join(' ')).toMatch(/No query has been validated against a real PostgreSQL server/);
  });
});

const NEW_IDS = ['ev_outbound_references', 'ev_companion_items', 'ev_internal_edges'];
const POLICY_BRANCH = " UNION ALL SELECT 'pg_catalog.pg_policy'::regclass, y.oid, c.relnamespace FROM pg_catalog.pg_policy y JOIN pg_catalog.pg_class c ON c.oid = y.polrelid";
const sha = (text: string) => jest.requireActual<typeof import('node:crypto')>('node:crypto').createHash('sha256').update(text).digest('hex');
const outboundRow = (extra: Record<string, unknown> = {}) => ({ source_classid: 'pg_class', source_objid: 10, source_subid: 0, group_classid: 'pg_class',
  group_oid: 10, deptype: 'n', ref_classid: 'pg_class', ref_objid: 20, ref_subid: 0, target_schema: 'public', ...extra });
const companionRow = (extra: Record<string, unknown> = {}) => ({ item_kind: 'sequence_owner', item_classid: 'pg_class', item_oid: 30, item_namespace_oid: 2200,
  group_classid: 'pg_class', group_oid: 10, related_classid: '', related_oid: 0, subtype: 'S', name: 't_id_seq', edge_deptype: 'a', edge_ref_subid: '1',
  extension_edges: '0', ...extra });
const internalRow = (extra: Record<string, unknown> = {}) => ({ source_classid: 'pg_constraint', source_objid: 40, source_subid: 0,
  source_group_classid: 'pg_class', source_group_oid: 10, deptype: 'a', ref_classid: 'pg_class', ref_objid: 10, ref_subid: 1,
  ref_group_classid: 'pg_class', ref_group_oid: 10, ...extra });
const builders: Record<string, (extra?: Record<string, unknown>) => Record<string, unknown>> = {
  ev_outbound_references: outboundRow, ev_companion_items: companionRow, ev_internal_edges: internalRow };
const incomplete = { ok: false, truncated: false, code: 'evidence_query_incomplete', serverValidated: false };

describe('S1-C/C2.x: catálogo ampliado de 19 a 22 consultas', () => {
  it('solo cambian las huellas de ev_external_dependents y ev_extension_members; las otras 17 siguen idénticas', () => {
    expect(Object.keys(DIGESTS)).toHaveLength(22); expect(Object.keys(DIGESTS_C2)).toHaveLength(19);
    const changed = Object.keys(DIGESTS_C2).filter(id => DIGESTS[id] !== DIGESTS_C2[id]).sort();
    expect(changed).toEqual(['ev_extension_members', 'ev_external_dependents']);
    for (const id of NEW_IDS) expect(DIGESTS_C2[id]).toBeUndefined();
    expect(Object.keys(DIGESTS).filter(id => !(id in DIGESTS_C2))).toEqual(NEW_IDS);
  });
  it('la única diferencia SQL de las dos consultas modificadas es la rama de pg_policy', () => {
    for (const id of ['ev_external_dependents', 'ev_extension_members']) {
      const q = get(id);
      expect(q.sql.split(POLICY_BRANCH)).toHaveLength(2);
      expect(sha(q.sql.replace(POLICY_BRANCH, ''))).toBe(DIGESTS_C2[id]);
      expect(sha(q.sql)).toBe(DIGESTS[id]); expect(q.sqlSha256).toBe(DIGESTS[id]);
    }
    expect(get('ev_external_dependents').limits.join(' ')).toMatch(/attrdef\/policy only/);
    expect(get('ev_extension_members').limits.join(' ')).toMatch(/policies/);
  });
  it('pg_policy figura una vez, con su relación y namespace indirecto, en los mapas de ambas consultas modificadas', () => {
    for (const id of ['ev_external_dependents', 'ev_extension_members']) {
      const sql = get(id).sql;
      expect(sql.split("'pg_catalog.pg_policy'::regclass, y.oid, c.relnamespace FROM pg_catalog.pg_policy y JOIN pg_catalog.pg_class c ON c.oid = y.polrelid")).toHaveLength(2);
      expect(sql.indexOf('pg_catalog.pg_policy')).toBeGreaterThan(sql.indexOf('pg_catalog.pg_attrdef'));
    }
  });
  it('los cinco contratos afectados tienen exactamente los cambios esperados', () => {
    const shape = (id: string) => get(id).columns.map(c => `${c.name}:${c.type}${c.nullable ? '?' : ''}`);
    expect(shape('ev_outbound_references')).toEqual(['source_classid:string', 'source_objid:number', 'source_subid:number', 'group_classid:string',
      'group_oid:number', 'deptype:string', 'ref_classid:string', 'ref_objid:number', 'ref_subid:number', 'target_schema:string?']);
    expect(shape('ev_companion_items')).toEqual(['item_kind:string', 'item_classid:string', 'item_oid:number', 'item_namespace_oid:number',
      'group_classid:string', 'group_oid:number', 'related_classid:string', 'related_oid:number', 'subtype:string', 'name:string',
      'edge_deptype:string?', 'edge_ref_subid:string?', 'extension_edges:string']);
    expect(shape('ev_internal_edges')).toEqual(['source_classid:string', 'source_objid:number', 'source_subid:number', 'source_group_classid:string',
      'source_group_oid:number', 'deptype:string', 'ref_classid:string', 'ref_objid:number', 'ref_subid:number', 'ref_group_classid:string', 'ref_group_oid:number']);
    for (const [id, maxRows, cls] of [['ev_outbound_references', 500, 'dependency'], ['ev_companion_items', 1000, 'inventory'], ['ev_internal_edges', 2000, 'dependency']] as const) {
      const q = get(id);
      expect(q.params).toEqual(['schema']); expect(q.maxRows).toBe(maxRows); expect(q.cardinality).toEqual({ min: 0, max: maxRows });
      expect(q.class).toBe(cls); expect(q.requiredKeys).toBeNull(); expect(q.serverValidated).toBe(false);
      expect(q.sql.endsWith(` LIMIT ${maxRows + 1}`)).toBe(true); expect(q.sql).toContain('ORDER BY');
    }
    expect(get('ev_outbound_references').incompleteWhen).toEqual([{ column: 'target_schema', op: 'isNull' }]);
    expect(get('ev_companion_items').incompleteWhen).toEqual([]); expect(get('ev_internal_edges').incompleteWhen).toEqual([]);
  });
  it('el vocabulario cerrado incorpora solo los literales necesarios, ordenado y sin duplicados', () => {
    for (const l of ['pg_catalog.pg_policy', 'sequence_owner', 'toast_candidate', 'toast_index_candidate', 'x']) expect(LITERALS).toContain(l);
    expect([...LITERALS]).toEqual([...LITERALS].sort()); expect(new Set(LITERALS).size).toBe(LITERALS.length);
    expect(ALLOWED_RELATIONS).toContain('pg_policy'); expect(ALLOWED_RELATIONS).toContain('pg_index');
    for (const id of NEW_IDS) expect(auditSql(get(id).sql, { maxRows: get(id).maxRows, paramCount: 1 })).toBe(true);
  });
});

describe('S1-C/C2.x: identidades, aristas y partición', () => {
  const [outbound, companions, internal] = NEW_IDS.map(id => get(id).sql);
  const addresses = (sql: string) => sql.slice(sql.indexOf('addresses AS ('), sql.indexOf(') SELECT DISTINCT'));
  it('toda comparación de objid/refobjid va emparejada con su classid/refclassid, nunca un oid desnudo', () => {
    for (const sql of [outbound, internal, companions]) {
      for (const m of sql.matchAll(/\b(\w+)\.(objid|refobjid) = /g)) {
        const before = sql.slice(Math.max(0, (m.index ?? 0) - 160), m.index);
        const classColumn = m[2] === 'objid' ? 'classid' : 'refclassid';
        expect(before).toMatch(new RegExp(`${m[1]}\\.${classColumn} = [^ ]+ AND $`));
      }
    }
    expect(outbound).toContain('t.classid = d.refclassid AND t.objid = d.refobjid');
    expect(internal).toContain('t.classid = d.refclassid AND t.objid = d.refobjid AND t.namespace = sc.oid');
    expect(companions).toContain("d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i') AND q.relkind = 'S'");
    expect(companions).toContain("e.classid = i.item_classid AND e.objid = i.item_oid AND e.refclassid = 'pg_catalog.pg_extension'::regclass");
  });
  it('el mapa addresses es idéntico en outbound e internal, con grupo auxiliar por catálogo y namespace indirecto', () => {
    expect(addresses(outbound)).toBe(addresses(internal)); expect(addresses(outbound).length).toBeGreaterThan(2000);
    const map = addresses(outbound);
    for (const fragment of [
      "CASE WHEN t.typrelid <> 0 THEN 'pg_catalog.pg_class'::regclass ELSE 'pg_catalog.pg_type'::regclass END, CASE WHEN t.typrelid <> 0 THEN t.typrelid ELSE t.oid END",
      "CASE WHEN k.conrelid <> 0 THEN 'pg_catalog.pg_class'::regclass ELSE 'pg_catalog.pg_type'::regclass END, CASE WHEN k.conrelid <> 0 THEN k.conrelid ELSE k.contypid END",
      "'pg_catalog.pg_trigger'::regclass, g.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, g.tgrelid FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid",
      "'pg_catalog.pg_rewrite'::regclass, r.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, r.ev_class FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class",
      "'pg_catalog.pg_attrdef'::regclass, a.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, a.adrelid FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid = a.adrelid",
      "'pg_catalog.pg_policy'::regclass, y.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, y.polrelid FROM pg_catalog.pg_policy y JOIN pg_catalog.pg_class c ON c.oid = y.polrelid",
      "'pg_catalog.pg_extension'::regclass, x.oid, x.extnamespace, 'pg_catalog.pg_extension'::regclass, x.oid",
    ]) expect(map).toContain(fragment);
  });
  it('outbound e internal son predicados complementarios sobre el mismo origen y excluyen solo la arista al namespace', () => {
    expect(outbound).toContain('LEFT JOIN addresses t ON t.classid = d.refclassid AND t.objid = d.refobjid');
    expect(outbound).toContain('LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = t.namespace');
    expect(outbound).toContain("WHERE NOT (d.refclassid = 'pg_catalog.pg_namespace'::regclass AND d.refobjid = sc.oid) AND (t.objid IS NULL OR tn.nspname IS NULL OR tn.nspname <> $1::name)");
    expect(internal).toContain('JOIN addresses t ON t.classid = d.refclassid AND t.objid = d.refobjid AND t.namespace = sc.oid');
    expect(internal.slice(internal.indexOf(') SELECT DISTINCT'))).not.toMatch(/LEFT JOIN|pg_namespace'::regclass|WHERE/);
    const source = 'FROM addresses s JOIN scope sc ON sc.oid = s.namespace JOIN pg_catalog.pg_depend d ON d.classid = s.classid AND d.objid = s.objid';
    expect(outbound).toContain(source); expect(internal).toContain(source);
    expect(addresses(outbound)).not.toContain("'pg_catalog.pg_namespace'::regclass");
  });
  it('conserva cada arista con su deptype y subcolumnas: DISTINCT solo sobre columnas de identidad y tipo', () => {
    for (const sql of [outbound, internal]) {
      for (const c of ['d.objsubid AS source_subid', 'd.deptype::text AS deptype', 'd.refobjsubid AS ref_subid']) expect(sql).toContain(c);
      expect(sql).toContain('SELECT DISTINCT'); expect(sql).not.toMatch(/string_agg|\bcount\(/);
    }
    expect(companions).not.toMatch(/string_agg|dep_to_owner|dep_to_related/);
    expect(companions).toContain("q.relname::text, d.deptype::text, d.refobjsubid::text FROM pg_catalog.pg_depend d JOIN rels r ON r.oid = d.refobjid");
  });
  it('TOAST: se listan candidatos con la arista como dato, sin clasificarlos como seguros', () => {
    for (const kind of ['toast_candidate', 'toast_index_candidate']) expect(companions).toContain(`'${kind}'`);
    expect(companions).not.toMatch(/pg_toast|safe|companion_ok/i);
    expect(companions).toContain('LEFT JOIN pg_catalog.pg_depend d ON d.classid = \'pg_catalog.pg_class\'::regclass AND d.objid = t.oid AND d.refclassid = \'pg_catalog.pg_class\'::regclass AND d.refobjid = r.oid');
    expect(companions).toContain('LEFT JOIN pg_catalog.pg_depend d ON d.classid = \'pg_catalog.pg_class\'::regclass AND d.objid = ix.indexrelid AND d.refclassid = \'pg_catalog.pg_class\'::regclass AND d.refobjid = t.oid');
    const limits = get('ev_companion_items').limits.join(' ');
    expect(limits).toMatch(/TOAST objects are NOT classified as safe.*pg_toast namespace.*internal \('i'\) edge.*reltoastrelid correspondence.*allowed class/s);
    expect(limits).toMatch(/serial sequences use 'a', identity sequences use 'i'.*no edge folding/s);
    expect(limits).toMatch(/NULL edge_deptype on an edge-defined kind is an anomaly.*never evidence of safety/s);
  });
  it('documenta la partición, el bucket del namespace, los orígenes sin mapa y la colisión de oids', () => {
    const l = LIMITATIONS.join(' ');
    expect(l).toMatch(/edge to the target namespace itself is observed by no query.*within one snapshot/s);
    expect(l).toMatch(/Sources of unmapped classes, TOAST objects, domain constraints.*unresolved closure rows or NULL destinations/s);
    expect(l).toMatch(/classid \+ objid \(\+ subid\).*oids of different catalogs can coincide.*reject cross-catalog oid collisions/s);
    expect(PENDING.join(' ')).toMatch(/TOAST acceptance, cycle and joint-statement analysis.*belong to C3\/C4/);
    expect(get('ev_internal_edges').limits.join(' ')).toMatch(/do not by themselves define a linear removal order/);
    expect(get('ev_outbound_references').limits.join(' ')).toMatch(/KEPT with a NULL target_schema.*never silently dropped/s);
  });
});

describe('S1-C/C2.x: checkRows adversarial sobre las consultas nuevas', () => {
  it.each(NEW_IDS)('%s: forma válida, truncamiento, columnas y tipos', id => {
    const q = get(id); const one = builders[id]();
    expect(checkRows(id, [])).toEqual(OK); expect(checkRows(id, [one])).toEqual(OK);
    expect(checkRows(id, Array.from({ length: q.maxRows }, () => one))).toEqual(OK);
    expect(checkRows(id, Array.from({ length: q.maxRows + 1 }, () => one))).toEqual({ ok: false, truncated: true, code: 'evidence_query_truncated', serverValidated: false });
    expect(checkRows(id, Array.from({ length: q.maxRows + 2 }, () => one))).toEqual(INVALID);
    expect(checkRows(id, [{ ...one, extra: 1 }])).toEqual(INVALID);
    for (const c of q.columns) {
      const { [c.name]: removed, ...missing } = one; void removed;
      expect(checkRows(id, [missing])).toEqual(INVALID);
      const wrong = c.type === 'number' ? 'x' : c.type === 'string' ? 1 : 'x';
      expect(checkRows(id, [{ ...one, [c.name]: wrong }])).toEqual(INVALID);
      const result = checkRows(id, [{ ...one, [c.name]: null }]);
      if (c.nullable && c.name !== 'target_schema') expect(result).toEqual(OK);
      else if (c.name === 'target_schema') expect(result).toEqual(incomplete);
      else expect(result).toEqual(INVALID);
    }
  });
  it.each([undefined, null, 'error', new Error('boom'), { rows: [] }, Promise.resolve([])])('una consulta fallida nunca es lista vacía válida %#', failed => {
    for (const id of NEW_IDS) expect(checkRows(id, failed)).toEqual(INVALID);
  });
  it('destinos desconocidos o no resueltos hacen la evidencia incompleta, aunque haya menos de maxRows filas', () => {
    expect(checkRows('ev_outbound_references', [outboundRow()])).toEqual(OK);
    expect(checkRows('ev_outbound_references', [outboundRow({ target_schema: null })])).toEqual(incomplete);
    expect(checkRows('ev_outbound_references', [outboundRow(), outboundRow({ ref_classid: 'pg_language', ref_objid: 12, target_schema: null })])).toEqual(incomplete);
    expect(checkRows('ev_outbound_references', [outboundRow({ deptype: 'e', ref_classid: 'pg_extension', target_schema: 'public' })])).toEqual(OK);
    expect(checkRows('ev_outbound_references', [{ ...outboundRow(), target_schema: undefined }])).toEqual(INVALID);
  });
  it('no mezcla catálogos: el mismo oid con distinto classid son aristas distintas y la identidad exige classid', () => {
    const rows = [internalRow({ source_classid: 'pg_constraint', source_objid: 7 }), internalRow({ source_classid: 'pg_class', source_objid: 7 })];
    expect(checkRows('ev_internal_edges', rows)).toEqual(OK);
    expect(new Set(rows.map(r => `${r.source_classid}:${r.source_objid}`)).size).toBe(2);
    const { source_classid: removed, ...withoutClass } = internalRow(); void removed;
    expect(checkRows('ev_internal_edges', [withoutClass])).toEqual(INVALID);
    const { group_classid: removedGroup, ...withoutGroupClass } = outboundRow(); void removedGroup;
    expect(checkRows('ev_outbound_references', [withoutGroupClass])).toEqual(INVALID);
  });
  it('serial e identity: filas por arista con deptype a/i y la columna propietaria como texto; sin plegar', () => {
    const serial = companionRow({ edge_deptype: 'a', edge_ref_subid: '1' });
    const identity = companionRow({ item_oid: 31, name: 't_gen_seq', edge_deptype: 'i', edge_ref_subid: '2' });
    const twoColumns = companionRow({ edge_deptype: 'a', edge_ref_subid: '2' });
    expect(checkRows('ev_companion_items', [serial, identity, twoColumns])).toEqual(OK);
    expect(checkRows('ev_companion_items', [companionRow({ edge_ref_subid: 2 })])).toEqual(INVALID);
    expect(checkRows('ev_companion_items', [companionRow({ item_kind: 'toast_candidate', edge_deptype: null, edge_ref_subid: null })])).toEqual(OK);
  });
  it('las filas de TOAST sin arista son válidas en forma y no llevan ningún campo de seguridad: la decisión es de C3', () => {
    const result = checkRows('ev_companion_items', [companionRow({ item_kind: 'toast_candidate', item_namespace_oid: 99, edge_deptype: null, edge_ref_subid: null })]);
    expect(Object.keys(result).sort()).toEqual(['code', 'ok', 'serverValidated', 'truncated']);
    expect(get('ev_companion_items').columns.map(c => c.name)).not.toEqual(expect.arrayContaining(['safe', 'verified', 'accepted']));
  });
  it.each(NEW_IDS)('%s: build solo acepta el esquema y rechaza parámetros extra o inválidos', id => {
    expect(build(id, { schema: NAME }).values).toEqual([NAME]);
    expect(build(id, { schema: NAME }).serverValidated).toBe(false);
    for (const bad of [{}, { schema: NAME, oid: 1 }, { schema: NAME, serverValidated: true }, { schema: NAME + '\n' }, { schema: 'x"; DROP' },
      { schema: NAME.toUpperCase() }, { schema: null }, { schema: [NAME] }, [NAME], null]) expect(() => build(id, bad)).toThrow('evidence_query_params');
  });
});
