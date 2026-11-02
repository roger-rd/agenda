'use strict';
const { valid, parseMark } = require('./c8-names.cjs');
/** @typedef {{name:string,comment:string,owner:string,ageMs:number,lease:'free'|'live'|'unknown',
 * leaseOwned:boolean,empty:boolean}} Schema */
/** @typedef {{complete:boolean,evaluable:boolean,membership:boolean,setMembership:boolean,
 * grantable:boolean,defaultAcl:boolean,objects:readonly {kind:string,evaluable:boolean,
 * direct:boolean,inherited:boolean,public:boolean,column:boolean}[]}} Privileges */
/** Plantillas exclusivamente de lectura, nunca ejecutadas aquí. $1 = esquema
 * validado, $2 = agenda_test_app. MATERIALIZED separa clases antes de invocar
 * has_*_privilege y evita 42809; validar contra PG16 en C8.2/C8.3.
 * has_* evalúa PUBLIC y herencia; aclexplode solo sirve como diagnóstico.
 * El adaptador debe conservar todas las filas, verificar cobertura y convertir
 * NULL/errores en evidencia no evaluable. No deducir origen a partir de ACL. */
const EFFECTIVE_QUERY = `WITH
  scope AS MATERIALIZED (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1),
  relations AS MATERIALIZED (
    SELECT c.oid FROM pg_catalog.pg_class c JOIN scope s ON s.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')),
  sequences AS MATERIALIZED (
    SELECT c.oid FROM pg_catalog.pg_class c JOIN scope s ON s.oid = c.relnamespace WHERE c.relkind = 'S'),
  routines AS MATERIALIZED (
    SELECT p.oid FROM pg_catalog.pg_proc p JOIN scope s ON s.oid = p.pronamespace)
SELECT 'schema' AS kind, s.oid, p.privilege,
  pg_catalog.has_schema_privilege($2::name, s.oid, p.privilege) AS effective,
  pg_catalog.has_schema_privilege($2::name, s.oid, p.privilege || ' WITH GRANT OPTION') AS is_grantable
FROM scope s CROSS JOIN (VALUES ('USAGE'), ('CREATE')) p(privilege)
UNION ALL
SELECT 'table', r.oid, p.privilege,
  pg_catalog.has_table_privilege($2::name, r.oid, p.privilege),
  pg_catalog.has_table_privilege($2::name, r.oid, p.privilege || ' WITH GRANT OPTION')
FROM relations r CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(privilege)
UNION ALL
SELECT 'column', r.oid, p.privilege,
  pg_catalog.has_any_column_privilege($2::name, r.oid, p.privilege),
  pg_catalog.has_any_column_privilege($2::name, r.oid, p.privilege || ' WITH GRANT OPTION')
FROM relations r CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
UNION ALL
SELECT 'sequence', s.oid, p.privilege,
  pg_catalog.has_sequence_privilege($2::name, s.oid, p.privilege),
  pg_catalog.has_sequence_privilege($2::name, s.oid, p.privilege || ' WITH GRANT OPTION')
FROM sequences s CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) p(privilege)
UNION ALL
SELECT 'routine', r.oid, 'EXECUTE',
  pg_catalog.has_function_privilege($2::name, r.oid, 'EXECUTE'),
  pg_catalog.has_function_privilege($2::name, r.oid, 'EXECUTE WITH GRANT OPTION')
FROM routines r`;
const ROLE_QUERY = `SELECT oid,
  pg_catalog.pg_has_role($1::name, oid, 'MEMBER') AS membership,
  pg_catalog.pg_has_role($1::name, oid, 'SET') AS set_membership
FROM pg_catalog.pg_roles WHERE rolname <> $1`;
const DEFAULT_QUERY = `SELECT d.oid FROM pg_catalog.pg_default_acl d
JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = $1`;
const GLOBAL_DEFAULT_QUERY = `SELECT r.rolname AS owner_role, d.defaclobjtype AS object_type,
  COALESCE(a.grantee = 0, false) AS grantee_public,
  COALESCE(g.rolname = 'agenda_test_app', false) AS grantee_app
FROM pg_catalog.pg_default_acl d
JOIN pg_catalog.pg_roles r ON r.oid = d.defaclrole
LEFT JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a ON true
LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
WHERE d.defaclnamespace = 0`;
const QUERY_CONTRACT = Object.freeze({ materialized: EFFECTIVE_QUERY, roles: ROLE_QUERY, defaultsQuery: DEFAULT_QUERY, globalDefaultsQuery: GLOBAL_DEFAULT_QUERY,
  effective: Object.freeze(['has_schema_privilege', 'has_table_privilege', 'has_any_column_privilege',
    'has_sequence_privilege', 'has_function_privilege', 'pg_has_role']),
  diagnostic: 'aclexplode', defaults: 'pg_default_acl' });
/** @param {Schema} schema */
function recognized(schema) { return valid(schema.name) && parseMark(schema.comment) !== null && schema.owner === 'agenda_test_owner'; }
/** @param {Schema} schema @param {string} runId */
function writable(schema, runId) { return recognized(schema) && parseMark(schema.comment) === runId && schema.leaseOwned === true; }
/** Todos los esquemas R se inspeccionan también en P6a. W siempre vacío.
 * complete es evidencia de enumeración exhaustiva del catálogo inyectado,
 * incluyendo esquema, tablas, vistas, secuencias, funciones y procedimientos.
 * @param {readonly Schema[]} schemas @param {(schema:Schema)=>Privileges} inspect
 * @param {'P6a'|'P6b'|'P6c'} phase
 * @param {{evaluable:boolean,membership:boolean,setMembership:boolean}} roles */
function evaluate(schemas, inspect, phase, roles) {
  const unknown = Object.freeze({ ok: false, code: 'gate_unknown', exitCode: 2 });
  const residual = Object.freeze({ ok: false, code: 'gate_residual', exitCode: 2 });
  if (!['P6a', 'P6b', 'P6c'].includes(phase)) return unknown;
  try {
    // unknown = evidence missing or malformed; residual = evidence evaluated and a privilege or
    // membership is present. Both close with exit 2, but they are different facts.
    if (roles.evaluable !== true || typeof roles.membership !== 'boolean' || typeof roles.setMembership !== 'boolean') return unknown;
    if (roles.membership || roles.setMembership) return residual;
    for (const schema of schemas.filter(recognized)) {
      const p = inspect(schema);
      if (p.complete !== true || p.evaluable !== true || !Array.isArray(p.objects) ||
        !p.objects.some(o => o.kind === 'schema')) throw new Error('gate_unknown');
      const structure = [p.membership, p.setMembership, p.grantable, p.defaultAcl];
      if (structure.some(v => typeof v !== 'boolean')) throw new Error('gate_unknown');
      if (structure.some(v => v)) return residual;
      for (const object of p.objects) {
        if (object.evaluable !== true || !['schema', 'table', 'view', 'sequence', 'function', 'procedure'].includes(object.kind)) throw new Error('gate_unknown');
        const flags = [object.direct, object.inherited, object.public, object.column];
        if (flags.some(v => typeof v !== 'boolean')) throw new Error('gate_unknown');
        // P6a permite privilegios revocables; las barreras estructurales se aplican arriba.
        if (phase !== 'P6a' && flags.some(v => v !== false)) return Object.freeze({ ok: false, code: 'gate_residual', exitCode: 2 });
      }
    }
    return Object.freeze({ ok: true, code: 'ok', exitCode: 0 });
  } catch { return Object.freeze({ ok: false, code: 'gate_unknown', exitCode: 2 }); }
}
/** Global defaults affect NEW objects, independently of effective/schema ACLs.
 * C8.6 must integrate this gate: the existing preflight does not invoke it.
 * @param {unknown} info */
function evaluateGlobalDefaultAcl(info) {
  const unknown = Object.freeze({ ok: false, code: 'gate_unknown', exitCode: 2 });
  try {
    if (!info || typeof info !== 'object') return unknown;
    const value = /** @type {{evaluable?:unknown,entries?:unknown}} */ (info);
    if (value.evaluable !== true || !Array.isArray(value.entries)) return unknown;
    let veto = false;
    for (const entry of value.entries) {
      if (!entry || typeof entry.ownerRole !== 'string' || !entry.ownerRole ||
          !['r', 'S', 'f', 'T', 'n'].includes(entry.objectType) ||
          typeof entry.granteePublic !== 'boolean' || typeof entry.granteeApp !== 'boolean') return unknown;
      if (['agenda_test_owner', 'agenda_test_app'].includes(entry.ownerRole) &&
          (entry.granteePublic || entry.granteeApp)) veto = true;
    }
    return Object.freeze({ ok: !veto, code: veto ? 'gate_default_acl' : 'ok', exitCode: veto ? 2 : 0 });
  } catch { return unknown; }
}
module.exports = Object.freeze({ QUERY_CONTRACT, recognized, writable, evaluate, evaluateGlobalDefaultAcl });
