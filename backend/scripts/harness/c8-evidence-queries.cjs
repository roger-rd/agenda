'use strict';
const { types: { isProxy } } = require('node:util');
const { hash } = require('node:crypto');
const { valid } = require('./c8-names.cjs');
/** Offline data only. SQL targets PostgreSQL 16 but has never been server-validated.
 * Text timestamps and int64 counts avoid driver-dependent Date/bigint coercion.
 * Input is a plain record keyed by parameter type; no arrays or implicit coercion.
 */
/** @typedef {'schema'|'key'|'app'} Param */
/** @typedef {{name:string,type:'string'|'number'|'boolean',nullable:boolean}} Column */
/** @typedef {{column:string,op:'gte',value:number}|{column:string,op:'isNull'}} Rule */
/** @typedef {{id:string,purpose:string,sql:string,params:readonly Param[],maxRows:number,columns:readonly Readonly<Column>[],class:string,limits:readonly string[],
 * cardinality?:{min:number,max:number},requiredKeys?:{column:string,values:readonly string[]},incompleteWhen?:readonly Rule[]}} EntryInput */
/** @typedef {Readonly<Omit<EntryInput,'cardinality'|'requiredKeys'|'incompleteWhen'> & {cardinality:Readonly<{min:number,max:number}>,
 * requiredKeys:null|Readonly<{column:string,values:readonly string[]}>,incompleteWhen:readonly Readonly<Rule>[],
 * serverValidated:false,sqlSha256:string}>} Entry */
/** serverValidated is fixed here and can never come from the entry data: no query has been run
 * against a real server. sqlSha256 pins the exact SQL text that S2-bis must validate.
 * @param {EntryInput} value @returns {Entry} */
function entry(value) {
  const { min, max } = value.cardinality ?? { min: 0, max: value.maxRows };
  const keys = value.requiredKeys;
  return Object.freeze({ ...value, params: Object.freeze(value.params),
    columns: Object.freeze(value.columns.map(c => Object.freeze(c))), limits: Object.freeze(value.limits),
    cardinality: Object.freeze({ min, max }),
    requiredKeys: keys ? Object.freeze({ column: keys.column, values: Object.freeze([...keys.values]) }) : null,
    incompleteWhen: Object.freeze((value.incompleteWhen ?? []).map(rule => Object.freeze({ ...rule }))),
    serverValidated: false, sqlSha256: hash('sha256', value.sql, 'hex') });
}
const LIMITATIONS = Object.freeze([
  'Dependencies inside function bodies containing string literals and dynamic SQL are invisible.',
  'Application references and external configuration, role/database search_path settings and cached plans are invisible.',
  'Cluster-level roles, databases and tablespaces are not comprehensively inventoried; other databases are excluded.',
  'No row data, sequence values, statistics or function bodies are collected.',
  'Pinned system objects are not covered by dependency traversal.',
  'Identity signatures miss storage changes and index validity changes.',
  'Other roles sessions have restricted visibility without statistics privileges.',
  'A snapshot does not follow subsequent changes; double collection belongs to the collector, not this module.',
  'The edge to the target namespace itself is observed by no query; ev_internal_edges and ev_outbound_references partition the other edges of mapped-class sources only within one snapshot.',
  'Sources of unmapped classes, TOAST objects, domain constraints and destinations of unmapped classes are never enumerated: they surface only as unresolved closure rows or NULL destinations.',
  'Object identity is classid + objid (+ subid); oids of different catalogs can coincide, so group_oid and bare oids are auxiliary and a consumer must reject cross-catalog oid collisions.',
  'No query has been validated against a real PostgreSQL server.',
]);
const PENDING = Object.freeze([
  'Physical backend identity binding and server transaction identity remain pending.',
  'Companion classes require individual justification and validation before policy expansion.',
  'TOAST acceptance, cycle and joint-statement analysis, and per-kind companion validation belong to C3/C4; none is decided by these queries.',
  'Functions, procedures, types, domains, materialized views and partitioned tables remain pending as removal candidates.',
  'Publications, subscriptions, FDW and large objects require specific analysis.',
  'Real PostgreSQL 16 validation: S2-bis must verify the exact SQL text (sqlSha256) and the result shapes before C3 may treat any row as demonstrated evidence; serverValidated stays false until then.',
  'ev_effective_privileges: the object/privilege cross product cannot preserve complete semantics under a fixed row cap; the existing effective query remains authoritative for that purpose.',
]);
const CATALOG = Object.freeze([
  entry({
    "id": "ev_context",
    "cardinality": { "min": 1, "max": 1 },
    "purpose": "context",
    "sql": "SELECT a.pid, a.backend_start::text AS backend_start, pg_catalog.current_database()::text AS database, current_user::text AS current_user, session_user::text AS session_user, pg_catalog.current_setting('transaction_read_only') AS transaction_read_only, pg_catalog.current_setting('transaction_isolation') AS transaction_isolation, pg_catalog.current_setting('lock_timeout') AS lock_timeout, pg_catalog.current_setting('statement_timeout') AS statement_timeout, pg_catalog.current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout, pg_catalog.current_setting('server_version_num') AS server_version_num, pg_catalog.pg_is_in_recovery() AS in_recovery FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_catalog.pg_backend_pid() ORDER BY a.pid LIMIT 2",
    "params": [],
    "maxRows": 1,
    "columns": [
        {
            "name": "pid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "backend_start",
            "type": "string",
            "nullable": true
        },
        {
            "name": "database",
            "type": "string",
            "nullable": false
        },
        {
            "name": "current_user",
            "type": "string",
            "nullable": false
        },
        {
            "name": "session_user",
            "type": "string",
            "nullable": false
        },
        {
            "name": "transaction_read_only",
            "type": "string",
            "nullable": false
        },
        {
            "name": "transaction_isolation",
            "type": "string",
            "nullable": false
        },
        {
            "name": "lock_timeout",
            "type": "string",
            "nullable": false
        },
        {
            "name": "statement_timeout",
            "type": "string",
            "nullable": false
        },
        {
            "name": "idle_in_transaction_session_timeout",
            "type": "string",
            "nullable": false
        },
        {
            "name": "server_version_num",
            "type": "string",
            "nullable": false
        },
        {
            "name": "in_recovery",
            "type": "boolean",
            "nullable": false
        }
    ],
    "limits": [
        "Does not bind physical backend identity or server transaction identity."
    ],
    "class": "identity"
}),
  entry({
    "id": "ev_namespace",
    "purpose": "namespace",
    "sql": "SELECT n.oid, n.nspname::text AS name, pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner, pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment, n.nspacl::text AS acl FROM pg_catalog.pg_namespace n WHERE n.nspname = $1::name ORDER BY n.oid LIMIT 2",
    "params": [
        "schema"
    ],
    "maxRows": 1,
    "columns": [
        {
            "name": "oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "name",
            "type": "string",
            "nullable": false
        },
        {
            "name": "owner",
            "type": "string",
            "nullable": false
        },
        {
            "name": "comment",
            "type": "string",
            "nullable": true
        },
        {
            "name": "acl",
            "type": "string",
            "nullable": true
        }
    ],
    "limits": [
        "Snapshot only; bounded rows do not establish completeness across time."
    ],
    "class": "inventory"
}),
  entry({
    "id": "ev_relations",
    "purpose": "relations",
    "sql": "SELECT c.oid, c.relname::text AS relname, c.relkind::text AS relkind, pg_catalog.pg_get_userbyid(c.relowner)::text AS owner, c.relispartition, c.relpersistence::text AS relpersistence, c.reltoastrelid, c.relhasrules, c.relhastriggers, c.relrowsecurity, c.relacl::text AS acl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1::name ORDER BY c.oid LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "relname",
            "type": "string",
            "nullable": false
        },
        {
            "name": "relkind",
            "type": "string",
            "nullable": false
        },
        {
            "name": "owner",
            "type": "string",
            "nullable": false
        },
        {
            "name": "relispartition",
            "type": "boolean",
            "nullable": false
        },
        {
            "name": "relpersistence",
            "type": "string",
            "nullable": false
        },
        {
            "name": "reltoastrelid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "relhasrules",
            "type": "boolean",
            "nullable": false
        },
        {
            "name": "relhastriggers",
            "type": "boolean",
            "nullable": false
        },
        {
            "name": "relrowsecurity",
            "type": "boolean",
            "nullable": false
        },
        {
            "name": "acl",
            "type": "string",
            "nullable": true
        }
    ],
    "limits": [
        "Snapshot only; bounded rows do not establish completeness across time."
    ],
    "class": "inventory"
}),
  entry({
    "id": "ev_routines",
    "purpose": "routines",
    "sql": "SELECT p.oid, p.proname::text AS proname, p.prokind::text AS prokind, pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.proacl::text AS acl FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1::name ORDER BY p.oid LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "proname",
            "type": "string",
            "nullable": false
        },
        {
            "name": "prokind",
            "type": "string",
            "nullable": false
        },
        {
            "name": "owner",
            "type": "string",
            "nullable": false
        },
        {
            "name": "acl",
            "type": "string",
            "nullable": true
        }
    ],
    "limits": [
        "DETECTION for exclusion only: functions and procedures require specific analysis; bodies are not inspected."
    ],
    "class": "inventory"
}),
  entry({
    "id": "ev_types",
    "purpose": "types",
    "sql": "SELECT t.oid, t.typname::text AS typname, t.typtype::text AS typtype, t.typrelid, t.typarray, pg_catalog.pg_get_userbyid(t.typowner)::text AS owner FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1::name ORDER BY t.oid LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "typname",
            "type": "string",
            "nullable": false
        },
        {
            "name": "typtype",
            "type": "string",
            "nullable": false
        },
        {
            "name": "typrelid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "typarray",
            "type": "number",
            "nullable": false
        },
        {
            "name": "owner",
            "type": "string",
            "nullable": false
        }
    ],
    "limits": [
        "Snapshot only; bounded rows do not establish completeness across time."
    ],
    "class": "inventory"
}),
  entry({
    "id": "ev_namespace_catalog_counts",
    "purpose": "namespace catalog counts",
    "sql": "SELECT (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_class x WHERE x.relnamespace = n.oid) AS class, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_proc x WHERE x.pronamespace = n.oid) AS proc, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_type x WHERE x.typnamespace = n.oid) AS type, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_operator x WHERE x.oprnamespace = n.oid) AS operator, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_collation x WHERE x.collnamespace = n.oid) AS collation, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_conversion x WHERE x.connamespace = n.oid) AS conversion, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_opclass x WHERE x.opcnamespace = n.oid) AS opclass, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_opfamily x WHERE x.opfnamespace = n.oid) AS opfamily, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_ts_config x WHERE x.cfgnamespace = n.oid) AS ts_config, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_ts_dict x WHERE x.dictnamespace = n.oid) AS ts_dict, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_ts_parser x WHERE x.prsnamespace = n.oid) AS ts_parser, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_ts_template x WHERE x.tmplnamespace = n.oid) AS ts_template, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_statistic_ext x WHERE x.stxnamespace = n.oid) AS statistic_ext, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_default_acl x WHERE x.defaclnamespace = n.oid) AS default_acl, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_extension x WHERE x.extnamespace = n.oid) AS extension FROM pg_catalog.pg_namespace n WHERE n.nspname = $1::name ORDER BY n.oid LIMIT 2",
    "params": [
        "schema"
    ],
    "maxRows": 1,
    "columns": [
        {
            "name": "class",
            "type": "string",
            "nullable": false
        },
        {
            "name": "proc",
            "type": "string",
            "nullable": false
        },
        {
            "name": "type",
            "type": "string",
            "nullable": false
        },
        {
            "name": "operator",
            "type": "string",
            "nullable": false
        },
        {
            "name": "collation",
            "type": "string",
            "nullable": false
        },
        {
            "name": "conversion",
            "type": "string",
            "nullable": false
        },
        {
            "name": "opclass",
            "type": "string",
            "nullable": false
        },
        {
            "name": "opfamily",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ts_config",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ts_dict",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ts_parser",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ts_template",
            "type": "string",
            "nullable": false
        },
        {
            "name": "statistic_ext",
            "type": "string",
            "nullable": false
        },
        {
            "name": "default_acl",
            "type": "string",
            "nullable": false
        },
        {
            "name": "extension",
            "type": "string",
            "nullable": false
        }
    ],
    "limits": [
        "Counts are decimal strings to preserve int64 precision; no object eligibility is inferred."
    ],
    "class": "inventory"
}),
  entry({
    "id": "ev_companions",
    "purpose": "companions",
    "sql": "WITH scope AS (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1::name), items AS (\nSELECT 'constraint'::text AS kind, c.contype::text AS subtype, c.oid FROM pg_catalog.pg_constraint c JOIN scope s ON s.oid = c.conrelid\nUNION ALL SELECT 'trigger', t.tgisinternal::text, t.oid FROM pg_catalog.pg_trigger t JOIN scope s ON s.oid = t.tgrelid\nUNION ALL SELECT 'rule', '', r.oid FROM pg_catalog.pg_rewrite r JOIN scope s ON s.oid = r.ev_class\nUNION ALL SELECT 'attrdef', '', a.oid FROM pg_catalog.pg_attrdef a JOIN scope s ON s.oid = a.adrelid\nUNION ALL SELECT 'policy', '', p.oid FROM pg_catalog.pg_policy p JOIN scope s ON s.oid = p.polrelid\nUNION ALL SELECT 'index', '', i.indexrelid FROM pg_catalog.pg_index i JOIN scope s ON s.oid = i.indrelid\nUNION ALL SELECT 'sequence', d.deptype::text, c.oid FROM pg_catalog.pg_depend d JOIN scope s ON s.oid = d.refobjid JOIN pg_catalog.pg_class c ON c.oid = d.objid WHERE d.refclassid = 'pg_catalog.pg_class'::regclass AND d.classid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i') AND c.relkind = 'S')\nSELECT kind, subtype, pg_catalog.count(*)::text AS n FROM items GROUP BY kind, subtype ORDER BY kind, subtype LIMIT 65",
    "params": [
        "schema"
    ],
    "maxRows": 64,
    "columns": [
        {
            "name": "kind",
            "type": "string",
            "nullable": false
        },
        {
            "name": "subtype",
            "type": "string",
            "nullable": false
        },
        {
            "name": "n",
            "type": "string",
            "nullable": false
        }
    ],
    "limits": [
        "Counts only; companion classes each require justification and validation. Sequences can reside outside the target namespace."
    ],
    "class": "inventory"
}),
  entry({
    "id": "ev_closure",
    "incompleteWhen": [{ "column": "depth", "op": "gte", "value": 17 }],
    "purpose": "closure",
    "sql": "WITH RECURSIVE scope AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1::name), walk AS (\nSELECT 1 AS depth, d.classid, d.objid, d.objsubid, d.deptype, '/' || d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text || '/' AS path FROM pg_catalog.pg_depend d JOIN scope s ON s.oid = d.refobjid WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass AND d.deptype IN ('n', 'a', 'i', 'P', 'S')\nUNION ALL\nSELECT w.depth + 1, d.classid, d.objid, d.objsubid, d.deptype, w.path || d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text || '/' FROM pg_catalog.pg_depend d JOIN walk w ON d.refclassid = w.classid AND d.refobjid = w.objid AND (w.objsubid = 0 OR d.refobjsubid = w.objsubid) WHERE w.depth < 17 AND pg_catalog.strpos(w.path, '/' || d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text || '/') = 0 AND d.deptype IN ('n', 'a', 'i', 'P', 'S'))\nSELECT DISTINCT depth, classid::regclass::text AS classid, objid, objsubid, deptype::text AS deptype FROM walk ORDER BY depth, classid, objid, objsubid, deptype LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "depth",
            "type": "number",
            "nullable": false
        },
        {
            "name": "classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "objid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "objsubid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "deptype",
            "type": "string",
            "nullable": false
        }
    ],
    "limits": [

                "Maximum evaluable depth is 16. Depth 17 is a sentinel: the recursion emits but never expands it, so any depth 17 row proves the graph exceeds the evaluable depth and the evidence is incomplete (machine-readable via incompleteWhen). Absence of depth 17 rows proves every depth 16 object was expanded. Path membership prevents revisiting object addresses on each branch; cycles are not reported separately. Fan-out may be expensive despite output limit; a failed or timed-out query is not an empty result. Only n/a/i/P/S edges, not pinned objects or function-body references."
    ],
    "class": "dependency"
}),
  entry({
    "id": "ev_external_dependents",
    "incompleteWhen": [{ "column": "depth", "op": "gte", "value": 17 }, { "column": "namespace", "op": "isNull" }],
    "purpose": "external dependents",
    "sql": "WITH RECURSIVE scope AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1::name), walk AS (\nSELECT 1 AS depth, d.classid, d.objid, d.objsubid, d.deptype, d.refclassid, d.refobjid, '/' || d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text || '/' AS path FROM pg_catalog.pg_depend d JOIN scope s ON s.oid = d.refobjid WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass AND d.deptype IN ('n', 'a', 'i', 'P', 'S')\nUNION ALL\nSELECT w.depth + 1, d.classid, d.objid, d.objsubid, d.deptype, d.refclassid, d.refobjid, w.path || d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text || '/' FROM pg_catalog.pg_depend d JOIN walk w ON d.refclassid = w.classid AND d.refobjid = w.objid AND (w.objsubid = 0 OR d.refobjsubid = w.objsubid) WHERE w.depth < 17 AND pg_catalog.strpos(w.path, '/' || d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text || '/') = 0 AND d.deptype IN ('n', 'a', 'i', 'P', 'S')), addresses AS (SELECT 'pg_catalog.pg_class'::regclass AS classid, c.oid AS objid, c.relnamespace AS namespace FROM pg_catalog.pg_class c\nUNION ALL SELECT 'pg_catalog.pg_proc'::regclass, p.oid, p.pronamespace FROM pg_catalog.pg_proc p\nUNION ALL SELECT 'pg_catalog.pg_type'::regclass, t.oid, t.typnamespace FROM pg_catalog.pg_type t\nUNION ALL SELECT 'pg_catalog.pg_constraint'::regclass, c.oid, c.connamespace FROM pg_catalog.pg_constraint c\nUNION ALL SELECT 'pg_catalog.pg_trigger'::regclass, t.oid, c.relnamespace FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid\nUNION ALL SELECT 'pg_catalog.pg_rewrite'::regclass, r.oid, c.relnamespace FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class\nUNION ALL SELECT 'pg_catalog.pg_attrdef'::regclass, a.oid, c.relnamespace FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid = a.adrelid UNION ALL SELECT 'pg_catalog.pg_policy'::regclass, y.oid, c.relnamespace FROM pg_catalog.pg_policy y JOIN pg_catalog.pg_class c ON c.oid = y.polrelid) SELECT DISTINCT w.depth, w.classid::regclass::text AS classid, w.objid, w.objsubid, w.deptype::text AS deptype, w.refclassid::regclass::text AS refclassid, w.refobjid, n.nspname::text AS namespace FROM walk w LEFT JOIN addresses a ON a.classid = w.classid AND a.objid = w.objid LEFT JOIN pg_catalog.pg_namespace n ON n.oid = a.namespace WHERE a.objid IS NULL OR n.nspname IS NULL OR n.nspname <> $1::name ORDER BY depth, classid, objid, objsubid, deptype, refclassid, refobjid, namespace LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "columns": [
        { "name": "depth", "type": "number", "nullable": false },
        { "name": "classid", "type": "string", "nullable": false },
        { "name": "objid", "type": "number", "nullable": false },
        { "name": "objsubid", "type": "number", "nullable": false },
        { "name": "deptype", "type": "string", "nullable": false },
        { "name": "refclassid", "type": "string", "nullable": false },
        { "name": "refobjid", "type": "number", "nullable": false },
        { "name": "namespace", "type": "string", "nullable": true }
    ],
    "limits": [
        "Maximum evaluable depth is 16; a depth 17 row is a sentinel and makes the evidence incomplete, but absence of sentinels here cannot prove traversal completeness (compare with ev_closure). Class mapping is best-effort for class/proc/type/constraint/trigger/rewrite/attrdef/policy only: rows whose class or namespace cannot be resolved are KEPT with a NULL namespace and make the evidence incomplete or unresolved (never silently dropped). Objects in pg_toast are not classified as safe companions here: a consumer may only accept one with a verifiable internal ('i') edge (refclassid/refobjid) to an in-schema relation and an allowed class. A failed or timed-out query is not an empty result."
    ],
    "class": "dependency"
}),
  entry({
    "id": "ev_extension_members",
    "purpose": "extension members",
    "sql": "WITH addresses AS (SELECT 'pg_catalog.pg_class'::regclass AS classid, c.oid AS objid, c.relnamespace AS namespace FROM pg_catalog.pg_class c\nUNION ALL SELECT 'pg_catalog.pg_proc'::regclass, p.oid, p.pronamespace FROM pg_catalog.pg_proc p\nUNION ALL SELECT 'pg_catalog.pg_type'::regclass, t.oid, t.typnamespace FROM pg_catalog.pg_type t\nUNION ALL SELECT 'pg_catalog.pg_constraint'::regclass, c.oid, c.connamespace FROM pg_catalog.pg_constraint c\nUNION ALL SELECT 'pg_catalog.pg_trigger'::regclass, t.oid, c.relnamespace FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid\nUNION ALL SELECT 'pg_catalog.pg_rewrite'::regclass, r.oid, c.relnamespace FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class\nUNION ALL SELECT 'pg_catalog.pg_attrdef'::regclass, a.oid, c.relnamespace FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid = a.adrelid UNION ALL SELECT 'pg_catalog.pg_policy'::regclass, y.oid, c.relnamespace FROM pg_catalog.pg_policy y JOIN pg_catalog.pg_class c ON c.oid = y.polrelid UNION ALL SELECT 'pg_catalog.pg_namespace'::regclass, x.oid, x.oid FROM pg_catalog.pg_namespace x UNION ALL SELECT 'pg_catalog.pg_operator'::regclass, x.oid, x.oprnamespace FROM pg_catalog.pg_operator x UNION ALL SELECT 'pg_catalog.pg_collation'::regclass, x.oid, x.collnamespace FROM pg_catalog.pg_collation x UNION ALL SELECT 'pg_catalog.pg_conversion'::regclass, x.oid, x.connamespace FROM pg_catalog.pg_conversion x UNION ALL SELECT 'pg_catalog.pg_opclass'::regclass, x.oid, x.opcnamespace FROM pg_catalog.pg_opclass x UNION ALL SELECT 'pg_catalog.pg_opfamily'::regclass, x.oid, x.opfnamespace FROM pg_catalog.pg_opfamily x UNION ALL SELECT 'pg_catalog.pg_ts_config'::regclass, x.oid, x.cfgnamespace FROM pg_catalog.pg_ts_config x UNION ALL SELECT 'pg_catalog.pg_ts_dict'::regclass, x.oid, x.dictnamespace FROM pg_catalog.pg_ts_dict x UNION ALL SELECT 'pg_catalog.pg_ts_parser'::regclass, x.oid, x.prsnamespace FROM pg_catalog.pg_ts_parser x UNION ALL SELECT 'pg_catalog.pg_ts_template'::regclass, x.oid, x.tmplnamespace FROM pg_catalog.pg_ts_template x UNION ALL SELECT 'pg_catalog.pg_statistic_ext'::regclass, x.oid, x.stxnamespace FROM pg_catalog.pg_statistic_ext x), members AS (SELECT e.oid AS extension_oid, e.extname::text AS extension_name, d.classid::regclass::text AS classid, d.objid, d.objsubid FROM pg_catalog.pg_depend d JOIN addresses a ON a.classid = d.classid AND a.objid = d.objid JOIN pg_catalog.pg_namespace n ON n.oid = a.namespace JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid WHERE d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.deptype = 'e' AND n.nspname = $1::name UNION SELECT e.oid, e.extname::text, 'pg_catalog.pg_extension', e.oid, 0 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = $1::name) SELECT extension_oid, extension_name, classid, objid, objsubid FROM members ORDER BY extension_oid, classid, objid, objsubid LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "extension_oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "extension_name",
            "type": "string",
            "nullable": false
        },
        {
            "name": "classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "objid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "objsubid",
            "type": "number",
            "nullable": false
        }
    ],
    "limits": [
        "Namespace-address mapping includes relations, routines, types, companions (constraints, triggers, rules, defaults, policies), operators, collations, conversions, operator classes/families, text search and extended statistics; database-wide or unmapped classes remain outside coverage. Extension namespace entries are also included."
    ],
    "class": "extension"
}),
  entry({
    "id": "ev_event_triggers",
    "purpose": "event triggers",
    "sql": "SELECT e.oid, e.evtname::text AS evtname, e.evtevent::text AS evtevent, e.evtenabled::text AS evtenabled, pg_catalog.pg_get_userbyid(e.evtowner)::text AS owner FROM pg_catalog.pg_event_trigger e ORDER BY e.oid LIMIT 501",
    "params": [],
    "maxRows": 500,
    "columns": [
        {
            "name": "oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "evtname",
            "type": "string",
            "nullable": false
        },
        {
            "name": "evtevent",
            "type": "string",
            "nullable": false
        },
        {
            "name": "evtenabled",
            "type": "string",
            "nullable": false
        },
        {
            "name": "owner",
            "type": "string",
            "nullable": false
        }
    ],
    "limits": [
        "Snapshot only; bounded rows do not establish completeness across time."
    ],
    "class": "event"
}),
  entry({
    "id": "ev_role_membership",
    "purpose": "role membership",
    "sql": "SELECT oid, pg_catalog.pg_has_role($1::name, oid, 'MEMBER') AS membership, pg_catalog.pg_has_role($1::name, oid, 'SET') AS set_membership FROM pg_catalog.pg_roles WHERE rolname <> $1 ORDER BY oid LIMIT 501",
    "params": [
        "app"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "membership",
            "type": "boolean",
            "nullable": true
        },
        {
            "name": "set_membership",
            "type": "boolean",
            "nullable": true
        }
    ],
    "limits": [
        "Same membership predicates as the existing contract; bounded output, no effective object privileges."
    ],
    "class": "privilege"
}),
  entry({
    "id": "ev_default_acl_schema",
    "purpose": "default acl schema",
    "sql": "SELECT d.oid FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = $1 ORDER BY d.oid LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "oid",
            "type": "number",
            "nullable": false
        }
    ],
    "limits": [
        "Snapshot only; bounded rows do not establish completeness across time."
    ],
    "class": "privilege"
}),
  entry({
    "id": "ev_default_acl_global",
    "purpose": "default acl global",
    "sql": "SELECT r.rolname AS owner_role, d.defaclobjtype AS object_type, COALESCE(a.grantee = 0, false) AS grantee_public, COALESCE(g.rolname = 'agenda_test_app', false) AS grantee_app FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles r ON r.oid = d.defaclrole LEFT JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a ON true LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee WHERE d.defaclnamespace = 0 ORDER BY d.oid, a.grantee, a.grantor, a.privilege_type, a.is_grantable LIMIT 501",
    "params": [],
    "maxRows": 500,
    "columns": [
        {
            "name": "owner_role",
            "type": "string",
            "nullable": false
        },
        {
            "name": "object_type",
            "type": "string",
            "nullable": false
        },
        {
            "name": "grantee_public",
            "type": "boolean",
            "nullable": false
        },
        {
            "name": "grantee_app",
            "type": "boolean",
            "nullable": false
        }
    ],
    "limits": [
        "Global defaults describe future objects; repeated projected rows preserve ACL expansion semantics."
    ],
    "class": "privilege"
}),
  entry({
    "id": "ev_outside_census",
    "cardinality": { "min": 10, "max": 10 },
    "requiredKeys": { "column": "catalog", "values": ["namespace", "class", "proc", "type", "constraint", "trigger", "policy", "extension", "event_trigger", "default_acl"] },
    "purpose": "outside census",
    "sql": "SELECT 'namespace'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.nspname, NULL::text, x.nspowner, x.nspacl::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_namespace x LEFT JOIN pg_catalog.pg_namespace n ON n.oid = x.oid WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)'))\nUNION ALL\nSELECT 'class'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.relname, x.relkind::text, x.relowner, x.relacl::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_class x LEFT JOIN pg_catalog.pg_namespace n ON n.oid = x.relnamespace WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)'))\nUNION ALL\nSELECT 'proc'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.proname, x.prokind::text, x.proowner, x.proacl::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_proc x LEFT JOIN pg_catalog.pg_namespace n ON n.oid = x.pronamespace WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)'))\nUNION ALL\nSELECT 'type'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.typname, x.typtype::text, x.typowner, x.typacl::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_type x LEFT JOIN pg_catalog.pg_namespace n ON n.oid = x.typnamespace WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)')) AND x.typrelid = 0\nUNION ALL\nSELECT 'constraint'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.conname, x.contype::text, NULL::oid, NULL::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_constraint x LEFT JOIN pg_catalog.pg_namespace n ON n.oid = x.connamespace WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)'))\nUNION ALL\nSELECT 'trigger'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.tgname, x.tgtype::text, NULL::oid, NULL::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_trigger x JOIN pg_catalog.pg_class c ON c.oid = x.tgrelid LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)')) AND NOT x.tgisinternal\nUNION ALL\nSELECT 'policy'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.polname, x.polcmd::text, NULL::oid, NULL::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_policy x JOIN pg_catalog.pg_class c ON c.oid = x.polrelid LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)'))\nUNION ALL\nSELECT 'extension'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.extname, x.extversion, x.extowner, NULL::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_extension x LEFT JOIN pg_catalog.pg_namespace n ON n.oid = x.extnamespace WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)'))\nUNION ALL\nSELECT 'event_trigger'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, x.evtname, x.evtevent::text, x.evtowner, NULL::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_event_trigger x\nUNION ALL\nSELECT 'default_acl'::text AS catalog, pg_catalog.count(*)::text AS n, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(pg_catalog.json_build_array(x.oid, NULL::text, x.defaclobjtype::text, x.defaclrole, x.defaclacl::text)::text, '' ORDER BY x.oid), ''), 'UTF8')), 'hex') AS digest FROM pg_catalog.pg_default_acl x LEFT JOIN pg_catalog.pg_namespace n ON n.oid = x.defaclnamespace WHERE (n.oid IS NULL OR (n.nspname <> $1::name AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(temp_|toast_temp_)')) ORDER BY catalog LIMIT 17",
    "params": [
        "schema"
    ],
    "maxRows": 16,
    "columns": [
        {
            "name": "catalog",
            "type": "string",
            "nullable": false
        },
        {
            "name": "n",
            "type": "string",
            "nullable": false
        },
        {
            "name": "digest",
            "type": "string",
            "nullable": false
        }
    ],
    "limits": [
        "Identity-only SHA256 of ordered JSON arrays (NULL preserved), empty class hashes empty text; counts are decimal strings. Exactly the 10 declared classes must be present once each (requiredKeys): a missing, duplicated or extra class is rejected, so a valid hash never stands for a partial census. The hash covers only: oid, name, kind and owner/ACL text of those 10 classes outside the target and system namespaces. NOT covered: columns/attributes, index definitions, sequence values, function bodies, statistics, row types, internal triggers, system namespaces, pg_inherits, casts, languages, publications, FDW, comments, initial privileges, large objects and cluster-level objects (roles, databases, tablespaces). Global defaults and event triggers remain. Not a complete database fingerprint. A failed or timed-out query is not an empty result."
    ],
    "class": "census"
}),
  entry({
    "id": "ev_sessions",
    "purpose": "sessions",
    "sql": "SELECT a.pid, a.usename::text AS usename, a.application_name, a.backend_type, a.state, a.xact_start::text AS xact_start, a.wait_event_type FROM pg_catalog.pg_stat_activity a WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid() ORDER BY a.pid LIMIT 501",
    "params": [],
    "maxRows": 500,
    "columns": [
        {
            "name": "pid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "usename",
            "type": "string",
            "nullable": true
        },
        {
            "name": "application_name",
            "type": "string",
            "nullable": true
        },
        {
            "name": "backend_type",
            "type": "string",
            "nullable": true
        },
        {
            "name": "state",
            "type": "string",
            "nullable": true
        },
        {
            "name": "xact_start",
            "type": "string",
            "nullable": true
        },
        {
            "name": "wait_event_type",
            "type": "string",
            "nullable": true
        }
    ],
    "limits": [
        "Without statistics privileges, other roles state/query and transaction details are not visible; NULL is not evidence of inactivity."
    ],
    "class": "concurrency"
}),
  entry({
    "id": "ev_target_relation_locks",
    "purpose": "target relation locks",
    "sql": "SELECT l.pid, l.locktype, l.mode, l.granted, l.relation FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1::name AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND (l.pid IS NULL OR l.pid <> pg_catalog.pg_backend_pid()) ORDER BY l.pid, l.relation, l.locktype, l.mode, l.granted, l.virtualtransaction LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "pid",
            "type": "number",
            "nullable": true
        },
        {
            "name": "locktype",
            "type": "string",
            "nullable": false
        },
        {
            "name": "mode",
            "type": "string",
            "nullable": false
        },
        {
            "name": "granted",
            "type": "boolean",
            "nullable": false
        },
        {
            "name": "relation",
            "type": "number",
            "nullable": false
        }
    ],
    "limits": [
        "Relation locks only in the current database, whose identity is derived inside the query (no caller-supplied database identity can turn the result into an apparently empty one); NULL pid includes prepared transactions; no predicate locks or future acquisitions; an empty result is only meaningful together with a successful ev_context. A failed or timed-out query is not an empty result."
    ],
    "class": "concurrency"
}),
  entry({
    "id": "ev_advisory_holders",
    "purpose": "advisory holders",
    "sql": "SELECT l.pid, l.database, l.mode, l.granted FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND l.classid::bigint = (($1::bigint >> 32) & 4294967295) AND l.objid::bigint = ($1::bigint & 4294967295) AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND l.granted ORDER BY l.pid, l.database, l.mode, l.granted, l.virtualtransaction LIMIT 501",
    "params": [
        "key"
    ],
    "maxRows": 500,
    "columns": [
        {
            "name": "pid",
            "type": "number",
            "nullable": true
        },
        {
            "name": "database",
            "type": "number",
            "nullable": false
        },
        {
            "name": "mode",
            "type": "string",
            "nullable": false
        },
        {
            "name": "granted",
            "type": "boolean",
            "nullable": false
        }
    ],
    "limits": [
        "Single int64 key space, current database, granted holders only; two-int keys and waiting requests excluded."
    ],
    "class": "concurrency"
}),
  entry({
    "id": "ev_prepared_xacts",
    "purpose": "prepared xacts",
    "sql": "SELECT p.gid, p.owner::text AS owner, p.database::text AS database FROM pg_catalog.pg_prepared_xacts p WHERE p.database = pg_catalog.current_database() ORDER BY p.gid LIMIT 501",
    "params": [],
    "maxRows": 500,
    "columns": [
        {
            "name": "gid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "owner",
            "type": "string",
            "nullable": false
        },
        {
            "name": "database",
            "type": "string",
            "nullable": false
        }
    ],
    "limits": [
        "Pending prepared transactions block destructive operations; no inspection of their contents."
    ],
    "class": "concurrency"
}),
  entry({
    "id": "ev_outbound_references",
    "purpose": "outbound references",
    "sql": "WITH scope AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1::name), addresses AS (SELECT 'pg_catalog.pg_class'::regclass AS classid, c.oid AS objid, c.relnamespace AS namespace, 'pg_catalog.pg_class'::regclass AS group_classid, c.oid AS group_oid FROM pg_catalog.pg_class c\nUNION ALL SELECT 'pg_catalog.pg_proc'::regclass, p.oid, p.pronamespace, 'pg_catalog.pg_proc'::regclass, p.oid FROM pg_catalog.pg_proc p\nUNION ALL SELECT 'pg_catalog.pg_type'::regclass, t.oid, t.typnamespace, CASE WHEN t.typrelid <> 0 THEN 'pg_catalog.pg_class'::regclass ELSE 'pg_catalog.pg_type'::regclass END, CASE WHEN t.typrelid <> 0 THEN t.typrelid ELSE t.oid END FROM pg_catalog.pg_type t\nUNION ALL SELECT 'pg_catalog.pg_constraint'::regclass, k.oid, k.connamespace, CASE WHEN k.conrelid <> 0 THEN 'pg_catalog.pg_class'::regclass ELSE 'pg_catalog.pg_type'::regclass END, CASE WHEN k.conrelid <> 0 THEN k.conrelid ELSE k.contypid END FROM pg_catalog.pg_constraint k\nUNION ALL SELECT 'pg_catalog.pg_trigger'::regclass, g.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, g.tgrelid FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid\nUNION ALL SELECT 'pg_catalog.pg_rewrite'::regclass, r.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, r.ev_class FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class\nUNION ALL SELECT 'pg_catalog.pg_attrdef'::regclass, a.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, a.adrelid FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid = a.adrelid\nUNION ALL SELECT 'pg_catalog.pg_policy'::regclass, y.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, y.polrelid FROM pg_catalog.pg_policy y JOIN pg_catalog.pg_class c ON c.oid = y.polrelid\nUNION ALL SELECT 'pg_catalog.pg_collation'::regclass, x.oid, x.collnamespace, 'pg_catalog.pg_collation'::regclass, x.oid FROM pg_catalog.pg_collation x\nUNION ALL SELECT 'pg_catalog.pg_operator'::regclass, x.oid, x.oprnamespace, 'pg_catalog.pg_operator'::regclass, x.oid FROM pg_catalog.pg_operator x\nUNION ALL SELECT 'pg_catalog.pg_opclass'::regclass, x.oid, x.opcnamespace, 'pg_catalog.pg_opclass'::regclass, x.oid FROM pg_catalog.pg_opclass x\nUNION ALL SELECT 'pg_catalog.pg_opfamily'::regclass, x.oid, x.opfnamespace, 'pg_catalog.pg_opfamily'::regclass, x.oid FROM pg_catalog.pg_opfamily x\nUNION ALL SELECT 'pg_catalog.pg_extension'::regclass, x.oid, x.extnamespace, 'pg_catalog.pg_extension'::regclass, x.oid FROM pg_catalog.pg_extension x) SELECT DISTINCT s.classid::regclass::text AS source_classid, s.objid AS source_objid, d.objsubid AS source_subid, s.group_classid::regclass::text AS group_classid, s.group_oid AS group_oid, d.deptype::text AS deptype, d.refclassid::regclass::text AS ref_classid, d.refobjid AS ref_objid, d.refobjsubid AS ref_subid, tn.nspname::text AS target_schema FROM addresses s JOIN scope sc ON sc.oid = s.namespace JOIN pg_catalog.pg_depend d ON d.classid = s.classid AND d.objid = s.objid LEFT JOIN addresses t ON t.classid = d.refclassid AND t.objid = d.refobjid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = t.namespace WHERE NOT (d.refclassid = 'pg_catalog.pg_namespace'::regclass AND d.refobjid = sc.oid) AND (t.objid IS NULL OR tn.nspname IS NULL OR tn.nspname <> $1::name) ORDER BY source_classid, source_objid, source_subid, deptype, ref_classid, ref_objid, ref_subid, target_schema LIMIT 501",
    "params": [
        "schema"
    ],
    "maxRows": 500,
    "incompleteWhen": [
        {
            "column": "target_schema",
            "op": "isNull"
        }
    ],
    "columns": [
        {
            "name": "source_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "source_objid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "source_subid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "group_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "group_oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "deptype",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ref_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ref_objid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "ref_subid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "target_schema",
            "type": "string",
            "nullable": true
        }
    ],
    "limits": [
        "One row per dependency edge (classid, objid, objsubid) -> (refclassid, refobjid, refobjsubid) from mapped-class objects of the target namespace to anything outside it, excluding only the edge to the target namespace itself (the unobserved namespace bucket). group_classid/group_oid are auxiliary grouping data (owning relation or the object itself), never an identity; oids from different catalogs are only comparable together with their classid. A destination of an unmapped class, a dangling namespace or another pg_namespace is KEPT with a NULL target_schema and makes the evidence incomplete or unresolved (never silently dropped). Edges of type e/x mean extension membership. Not covered: sources of unmapped classes in the namespace, dependencies not recorded in pg_depend (function bodies with string literals, dynamic SQL), pinned objects and shared (role) dependencies. Edges from objects outside the namespace are in ev_external_dependents. Truncation (row 501) is incomplete. A failed or timed-out query is not an empty result."
    ],
    "class": "dependency"
}),
  entry({
    "id": "ev_companion_items",
    "purpose": "companion items",
    "sql": "WITH scope AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1::name), rels AS (SELECT c.oid, c.relnamespace, c.reltoastrelid FROM pg_catalog.pg_class c JOIN scope s ON s.oid = c.relnamespace), items AS (SELECT 'constraint'::text AS item_kind, 'pg_catalog.pg_constraint'::regclass AS item_classid, k.oid AS item_oid, k.connamespace AS item_namespace_oid, 'pg_catalog.pg_class'::regclass::text AS group_classid, k.conrelid AS group_oid, 'pg_catalog.pg_class'::regclass::text AS related_classid, k.conindid AS related_oid, k.contype::text AS subtype, k.conname::text AS name, NULL::text AS edge_deptype, NULL::text AS edge_ref_subid FROM pg_catalog.pg_constraint k JOIN rels r ON r.oid = k.conrelid\nUNION ALL SELECT 'trigger', 'pg_catalog.pg_trigger'::regclass, g.oid, r.relnamespace, 'pg_catalog.pg_class'::regclass::text, g.tgrelid, 'pg_catalog.pg_constraint'::regclass::text, g.tgconstraint, g.tgisinternal::text, g.tgname::text, NULL, NULL FROM pg_catalog.pg_trigger g JOIN rels r ON r.oid = g.tgrelid\nUNION ALL SELECT 'rule', 'pg_catalog.pg_rewrite'::regclass, w.oid, r.relnamespace, 'pg_catalog.pg_class'::regclass::text, w.ev_class, '', 0::oid, w.ev_type::text, w.rulename::text, NULL, NULL FROM pg_catalog.pg_rewrite w JOIN rels r ON r.oid = w.ev_class\nUNION ALL SELECT 'attrdef', 'pg_catalog.pg_attrdef'::regclass, a.oid, r.relnamespace, 'pg_catalog.pg_class'::regclass::text, a.adrelid, '', 0::oid, a.adnum::text, '', NULL, NULL FROM pg_catalog.pg_attrdef a JOIN rels r ON r.oid = a.adrelid\nUNION ALL SELECT 'policy', 'pg_catalog.pg_policy'::regclass, y.oid, r.relnamespace, 'pg_catalog.pg_class'::regclass::text, y.polrelid, '', 0::oid, y.polcmd::text, y.polname::text, NULL, NULL FROM pg_catalog.pg_policy y JOIN rels r ON r.oid = y.polrelid\nUNION ALL SELECT 'sequence_owner', 'pg_catalog.pg_class'::regclass, q.oid, q.relnamespace, 'pg_catalog.pg_class'::regclass::text, d.refobjid, '', 0::oid, q.relkind::text, q.relname::text, d.deptype::text, d.refobjsubid::text FROM pg_catalog.pg_depend d JOIN rels r ON r.oid = d.refobjid JOIN pg_catalog.pg_class q ON q.oid = d.objid WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i') AND q.relkind = 'S'\nUNION ALL SELECT 'toast_candidate', 'pg_catalog.pg_class'::regclass, t.oid, t.relnamespace, 'pg_catalog.pg_class'::regclass::text, r.oid, '', 0::oid, t.relkind::text, t.relname::text, d.deptype::text, d.refobjsubid::text FROM rels r JOIN pg_catalog.pg_class t ON t.oid = r.reltoastrelid LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = t.oid AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = r.oid\nUNION ALL SELECT 'toast_index_candidate', 'pg_catalog.pg_class'::regclass, ix.indexrelid, xc.relnamespace, 'pg_catalog.pg_class'::regclass::text, r.oid, 'pg_catalog.pg_class'::regclass::text, t.oid, xc.relkind::text, xc.relname::text, d.deptype::text, d.refobjsubid::text FROM rels r JOIN pg_catalog.pg_class t ON t.oid = r.reltoastrelid JOIN pg_catalog.pg_index ix ON ix.indrelid = t.oid JOIN pg_catalog.pg_class xc ON xc.oid = ix.indexrelid LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = ix.indexrelid AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = t.oid) SELECT i.item_kind, i.item_classid::text AS item_classid, i.item_oid, i.item_namespace_oid, i.group_classid, i.group_oid, i.related_classid, i.related_oid, i.subtype, i.name, i.edge_deptype, i.edge_ref_subid, (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_depend e WHERE e.classid = i.item_classid AND e.objid = i.item_oid AND e.refclassid = 'pg_catalog.pg_extension'::regclass AND e.deptype IN ('e', 'x')) AS extension_edges FROM items i ORDER BY i.item_kind, i.item_oid, i.group_oid, i.edge_deptype, i.edge_ref_subid, i.related_oid LIMIT 1001",
    "params": [
        "schema"
    ],
    "maxRows": 1000,
    "columns": [
        {
            "name": "item_kind",
            "type": "string",
            "nullable": false
        },
        {
            "name": "item_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "item_oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "item_namespace_oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "group_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "group_oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "related_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "related_oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "subtype",
            "type": "string",
            "nullable": false
        },
        {
            "name": "name",
            "type": "string",
            "nullable": false
        },
        {
            "name": "edge_deptype",
            "type": "string",
            "nullable": true
        },
        {
            "name": "edge_ref_subid",
            "type": "string",
            "nullable": true
        },
        {
            "name": "extension_edges",
            "type": "string",
            "nullable": false
        }
    ],
    "limits": [
        "Lists companion objects individually (constraints, triggers, view rules, column defaults, policies, owned sequences, TOAST and TOAST index CANDIDATES) of the relations of the target namespace. An item is identified by item_classid + item_oid; group_classid/group_oid are auxiliary grouping data and related_classid/related_oid name an object of a possibly different catalog. Edge-defined kinds (sequence_owner, toast_candidate, toast_index_candidate) emit one row per pg_depend edge with its own edge_deptype and edge_ref_subid (the owning or referenced column): serial sequences use 'a', identity sequences use 'i'; no edge folding. A NULL edge_deptype on an edge-defined kind is an anomaly for the consumer, never evidence of safety. TOAST objects are NOT classified as safe: a consumer may only accept one after verifying the pg_toast namespace, the internal ('i') edge to its relation, reltoastrelid correspondence and an allowed class. Items of classes not listed here, domain constraints and objects of unmapped classes are not enumerated: the consumer must account for every ev_closure row and treat the remainder as unresolved. extension_edges counts e/x edges. Truncation (row 1001) is incomplete. A failed or timed-out query is not an empty result."
    ],
    "class": "inventory"
}),
  entry({
    "id": "ev_internal_edges",
    "purpose": "internal edges",
    "sql": "WITH scope AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1::name), addresses AS (SELECT 'pg_catalog.pg_class'::regclass AS classid, c.oid AS objid, c.relnamespace AS namespace, 'pg_catalog.pg_class'::regclass AS group_classid, c.oid AS group_oid FROM pg_catalog.pg_class c\nUNION ALL SELECT 'pg_catalog.pg_proc'::regclass, p.oid, p.pronamespace, 'pg_catalog.pg_proc'::regclass, p.oid FROM pg_catalog.pg_proc p\nUNION ALL SELECT 'pg_catalog.pg_type'::regclass, t.oid, t.typnamespace, CASE WHEN t.typrelid <> 0 THEN 'pg_catalog.pg_class'::regclass ELSE 'pg_catalog.pg_type'::regclass END, CASE WHEN t.typrelid <> 0 THEN t.typrelid ELSE t.oid END FROM pg_catalog.pg_type t\nUNION ALL SELECT 'pg_catalog.pg_constraint'::regclass, k.oid, k.connamespace, CASE WHEN k.conrelid <> 0 THEN 'pg_catalog.pg_class'::regclass ELSE 'pg_catalog.pg_type'::regclass END, CASE WHEN k.conrelid <> 0 THEN k.conrelid ELSE k.contypid END FROM pg_catalog.pg_constraint k\nUNION ALL SELECT 'pg_catalog.pg_trigger'::regclass, g.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, g.tgrelid FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid\nUNION ALL SELECT 'pg_catalog.pg_rewrite'::regclass, r.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, r.ev_class FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class\nUNION ALL SELECT 'pg_catalog.pg_attrdef'::regclass, a.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, a.adrelid FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid = a.adrelid\nUNION ALL SELECT 'pg_catalog.pg_policy'::regclass, y.oid, c.relnamespace, 'pg_catalog.pg_class'::regclass, y.polrelid FROM pg_catalog.pg_policy y JOIN pg_catalog.pg_class c ON c.oid = y.polrelid\nUNION ALL SELECT 'pg_catalog.pg_collation'::regclass, x.oid, x.collnamespace, 'pg_catalog.pg_collation'::regclass, x.oid FROM pg_catalog.pg_collation x\nUNION ALL SELECT 'pg_catalog.pg_operator'::regclass, x.oid, x.oprnamespace, 'pg_catalog.pg_operator'::regclass, x.oid FROM pg_catalog.pg_operator x\nUNION ALL SELECT 'pg_catalog.pg_opclass'::regclass, x.oid, x.opcnamespace, 'pg_catalog.pg_opclass'::regclass, x.oid FROM pg_catalog.pg_opclass x\nUNION ALL SELECT 'pg_catalog.pg_opfamily'::regclass, x.oid, x.opfnamespace, 'pg_catalog.pg_opfamily'::regclass, x.oid FROM pg_catalog.pg_opfamily x\nUNION ALL SELECT 'pg_catalog.pg_extension'::regclass, x.oid, x.extnamespace, 'pg_catalog.pg_extension'::regclass, x.oid FROM pg_catalog.pg_extension x) SELECT DISTINCT s.classid::regclass::text AS source_classid, s.objid AS source_objid, d.objsubid AS source_subid, s.group_classid::regclass::text AS source_group_classid, s.group_oid AS source_group_oid, d.deptype::text AS deptype, d.refclassid::regclass::text AS ref_classid, d.refobjid AS ref_objid, d.refobjsubid AS ref_subid, t.group_classid::regclass::text AS ref_group_classid, t.group_oid AS ref_group_oid FROM addresses s JOIN scope sc ON sc.oid = s.namespace JOIN pg_catalog.pg_depend d ON d.classid = s.classid AND d.objid = s.objid JOIN addresses t ON t.classid = d.refclassid AND t.objid = d.refobjid AND t.namespace = sc.oid ORDER BY source_classid, source_objid, source_subid, deptype, ref_classid, ref_objid, ref_subid LIMIT 2001",
    "params": [
        "schema"
    ],
    "maxRows": 2000,
    "columns": [
        {
            "name": "source_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "source_objid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "source_subid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "source_group_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "source_group_oid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "deptype",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ref_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ref_objid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "ref_subid",
            "type": "number",
            "nullable": false
        },
        {
            "name": "ref_group_classid",
            "type": "string",
            "nullable": false
        },
        {
            "name": "ref_group_oid",
            "type": "number",
            "nullable": false
        }
    ],
    "limits": [
        "One row per dependency edge between mapped-class objects of the target namespace (no folding; deptype n/a/i/P/S/e/x kept, objsubid/refobjsubid preserved). Together with ev_outbound_references it partitions every pg_depend edge whose source is a mapped-class object of the namespace, except the edge to the namespace itself, which no query observes; this holds only inside one snapshot, not across separately executed statements. Edges to unmapped destination classes appear only in ev_outbound_references as unresolved. Sources of unmapped classes, TOAST objects (pg_toast), objects outside the namespace and dependencies not recorded in pg_depend are not covered. The edges do not by themselves define a linear removal order: cycles, auto and internal edges must be resolved by the consumer. Truncation (row 2001) is incomplete. A failed or timed-out query is not an empty result."
    ],
    "class": "dependency"
}),
]);
// Closed literals include MEMBER/SET only as membership data, never statements.
const LITERALS = Object.freeze(["", "/", ":", "MEMBER", "P", "S", "SET", "UTF8", "^pg_(temp_|toast_temp_)", "a", "advisory", "agenda_test_app", "attrdef", "class", "constraint", "default_acl", "e", "event_trigger", "extension", "hex", "i", "idle_in_transaction_session_timeout", "index", "information_schema", "lock_timeout", "n", "namespace", "pg_catalog", "pg_catalog.pg_attrdef", "pg_catalog.pg_class", "pg_catalog.pg_collation", "pg_catalog.pg_constraint", "pg_catalog.pg_conversion", "pg_catalog.pg_extension", "pg_catalog.pg_namespace", "pg_catalog.pg_opclass", "pg_catalog.pg_operator", "pg_catalog.pg_opfamily", "pg_catalog.pg_policy", "pg_catalog.pg_proc", "pg_catalog.pg_rewrite", "pg_catalog.pg_statistic_ext", "pg_catalog.pg_trigger", "pg_catalog.pg_ts_config", "pg_catalog.pg_ts_dict", "pg_catalog.pg_ts_parser", "pg_catalog.pg_ts_template", "pg_catalog.pg_type", "pg_namespace", "pg_toast", "policy", "proc", "rule", "sequence", "sequence_owner", "server_version_num", "statement_timeout", "toast_candidate", "toast_index_candidate", "transaction_isolation", "transaction_read_only", "trigger", "type", "x"]);
const ALLOWED_FUNCTIONS = Object.freeze(["aclexplode", "coalesce", "convert_to", "count", "current_database", "current_setting", "encode", "json_build_array", "obj_description", "pg_backend_pid", "pg_get_userbyid", "pg_has_role", "pg_is_in_recovery", "sha256", "string_agg", "strpos"]);
const ALLOWED_RELATIONS = Object.freeze(["pg_attrdef", "pg_class", "pg_collation", "pg_constraint", "pg_conversion", "pg_database", "pg_default_acl", "pg_depend", "pg_event_trigger", "pg_extension", "pg_index", "pg_locks", "pg_namespace", "pg_opclass", "pg_operator", "pg_opfamily", "pg_policy", "pg_prepared_xacts", "pg_proc", "pg_rewrite", "pg_roles", "pg_stat_activity", "pg_statistic_ext", "pg_trigger", "pg_ts_config", "pg_ts_dict", "pg_ts_parser", "pg_ts_template", "pg_type"]);
const CASTS = Object.freeze(['name', 'oid', 'text', 'bigint', 'regclass']);
// Statement vocabulary is assembled to keep executable-looking tokens out of this data module.
const FORBIDDEN = new RegExp('\\b(?:' + [
  'IN' + 'SERT', 'UP' + 'DATE', 'DE' + 'LETE', 'DR' + 'OP', 'CAS' + 'CADE',
  'AL' + 'TER', 'CRE' + 'ATE', 'GR' + 'ANT', 'RE' + 'VOKE', 'TRUN' + 'CATE',
  'COPY', 'DO', 'CALL', 'LOCK', 'SET', 'RESET', 'NOTIFY', 'LISTEN', 'UNLISTEN',
  'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'REFRESH', 'DISCARD', 'INTO',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'PREPARE', 'EXECUTE',
].join('|') + ')\\b', 'i');
/** @param {unknown} id @returns {Readonly<Entry>} */
function get(id) {
  const q = CATALOG.find(q => q.id === id);
  if (!q) throw new Error('evidence_query_unknown');
  return q;
}
/** @returns {never} */
function invalid() { throw new Error('evidence_query_invalid'); }
/** Catalog membership remains mandatory for execution-facing validation.
 * The optional entry must be the actual frozen catalog entry, never caller metadata.
 * @param {unknown} sql @param {Readonly<Entry>} [entry] */
function validateSql(sql, entry) {
  const q = CATALOG.find(q => q.sql === sql);
  if (!q || (entry !== undefined && entry !== q)) return invalid();
  return auditSql(sql, { maxRows: q.maxRows, paramCount: q.params.length });
}
/** Pure lexical audit, independently testable without catalog membership.
 * This is not a PostgreSQL grammar parser or permission to execute arbitrary SQL.
 * Repeated bind references are legal; distinct positions must be contiguous.
 * @param {unknown} sql @param {{maxRows:number,paramCount:number}} options */
function auditSql(sql, options) {
  const d = record(options, ['maxRows', 'paramCount']);
  if (!d) return invalid();
  const maxRows = d.maxRows.value;
  const paramCount = d.paramCount.value;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(paramCount) || paramCount < 0) return invalid();
  if (typeof sql !== 'string' || /;|--|\/\*|\*\//.test(sql)) return invalid();
  const stripped = sql.replace(/'(?:[^']|'')*'/g, literal => {
    if (!LITERALS.includes(literal.slice(1, -1).replace(/''/g, "'"))) return invalid();
    return ' ';
  });
  if (stripped.includes("'") || !/^(SELECT|WITH)\b/.test(stripped) || FORBIDDEN.test(stripped)) return invalid();
  const tokens = stripped.match(/::|\$[0-9]+|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|<>|>>|\|\||[().,*=+&:<>!~\-/]/g) || [];
  const ctes = new Set([...stripped.matchAll(/\b([a-z_]+)\s+AS\s*\(\s*SELECT/gi)].map(m => m[1]));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '::' && !CASTS.includes(tokens[i + 1])) return invalid();
    if (tokens[i + 1] === '(' && /^[a-z_]/i.test(token)) {
      const name = token.toLowerCase();
      if (!['as', 'in', 'and', 'or', 'select', 'where', 'not'].includes(name) && !ALLOWED_FUNCTIONS.includes(name)) return invalid();
      if (ALLOWED_FUNCTIONS.includes(name) && name !== 'coalesce' &&
        (tokens[i - 1] !== '.' || tokens[i - 2] !== 'pg_catalog')) return invalid();
    }
    if (token === 'FROM' || token === 'JOIN') {
      let j = i + 1;
      if (tokens[j] === 'LATERAL') j++;
      if (tokens[j] === 'pg_catalog' && tokens[j + 1] === '.') {
        const name = tokens[j + 2];
        if (tokens[j + 3] === '(' ? !ALLOWED_FUNCTIONS.includes(name) : !ALLOWED_RELATIONS.includes(name)) return invalid();
      } else if (!ctes.has(tokens[j])) return invalid();
    }
  }
  const binds = [...new Set([...stripped.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  if (binds.length !== paramCount || binds.some((v, i) => v !== i + 1) ||
    !/\bORDER BY\b/.test(stripped) || !stripped.endsWith(' LIMIT ' + (maxRows + 1))) return invalid();
  return true;
}
/** Only data descriptors on ordinary records; inspect native proxy identity first.
 * @param {unknown} input @param {readonly string[]} keys
 * @returns {Record<string, PropertyDescriptor>|null} */
function record(input, keys) {
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)) return null;
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return null;
  const d = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(d).length !== keys.length ||
    !keys.every(k => Object.hasOwn(d, k) && Object.hasOwn(d[k], 'value'))) return null;
  return d;
}
/** @param {unknown} value @param {Param} type */
function parameter(value, type) {
  if (type === 'schema') return valid(value);
  if (type === 'app') return value === 'agenda_test_app';
  return type === 'key' && typeof value === 'string' && value.length <= 20 &&
    /^-?(0|[1-9][0-9]*)$(?![\s\S])/.test(value) && BigInt(value).toString() === value &&
    BigInt(value) >= -(1n << 63n) && BigInt(value) < (1n << 63n);
}
/** @param {unknown} id @param {unknown} input */
function build(id, input) {
  const q = get(id);
  const d = record(input, q.params);
  if (!d || !q.params.every(type => parameter(d[type].value, type))) throw new Error('evidence_query_params');
  validateSql(q.sql, q);
  return Object.freeze({ id: q.id, text: q.sql, values: Object.freeze(q.params.map(type => d[type].value)), serverValidated: false });
}
/** @param {unknown} id @param {unknown} rows */
function checkRows(id, rows) {
  const q = get(id);
  /** @param {boolean} ok @param {boolean} truncated @param {string} code */
  const result = (ok, truncated, code) => Object.freeze({ ok, truncated, code, serverValidated: false });
  const bad = result(false, false, 'evidence_query_invalid');
  // A failed query is never an empty list: only a genuine array of rows is accepted here.
  if (!rows || typeof rows !== 'object' || isProxy(rows) || !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype) return bad;
  const descriptors = /** @type {Record<string, PropertyDescriptor>} */ (Object.getOwnPropertyDescriptors(rows));
  const length = descriptors.length.value;
  if (length > q.maxRows + 1 || Reflect.ownKeys(descriptors).length !== length + 1) return bad;
  /** @type {Record<string, PropertyDescriptor>[]} */
  const parsed = [];
  for (let i = 0; i < length; i++) {
    const item = descriptors[String(i)];
    if (!item || !Object.hasOwn(item, 'value')) return bad;
    const d = record(item.value, q.columns.map(c => c.name));
    if (!d || !q.columns.every(c => {
      const v = d[c.name].value;
      return v === null ? c.nullable : typeof v === c.type && (c.type !== 'number' || Number.isFinite(v));
    })) return bad;
    parsed.push(d);
  }
  if (length === q.maxRows + 1) return result(false, true, 'evidence_query_truncated');
  if (length < q.cardinality.min || length > q.cardinality.max) return result(false, false, 'evidence_query_cardinality');
  if (q.requiredKeys) {
    const { column, values } = q.requiredKeys;
    const seen = parsed.map(d => d[column].value);
    if (seen.length !== values.length || new Set(seen).size !== seen.length || !values.every(v => seen.includes(v))) {
      return result(false, false, 'evidence_query_cardinality');
    }
  }
  const incomplete = parsed.some(d => q.incompleteWhen.some(rule => {
    const v = d[rule.column].value;
    return rule.op === 'isNull' ? v === null : typeof v === 'number' && v >= rule.value;
  }));
  return incomplete ? result(false, false, 'evidence_query_incomplete') : result(true, false, 'ok');
}
module.exports = Object.freeze({ CATALOG, LIMITATIONS, PENDING, LITERALS, ALLOWED_FUNCTIONS,
  ALLOWED_RELATIONS, get, build, validateSql, auditSql, checkRows });
