import { createHash } from 'node:crypto';
import type { ManifestEntry } from '../migrations/schema-manifest';
import { tablesOfPrefix } from './schema-guards';
import { SchemaRunnerError, type SchemaErrorCode } from './schema-target';

/** Offline grammar for the frozen catalogues, deliberately limited to their DDL forms. No SQL is executed here. */
export type StructureStatus = 'verified' | 'definitions_unpinned' | 'drift' | 'unchecked';
export interface StructureRow {
  kind: 'col' | 'con' | 'idx'; table_name: string; name: string;
  type?: string; not_null?: boolean; default_expression?: string | null;
  columns?: string[]; ref_table?: string | null; ref_columns?: string[];
  on_delete?: string; on_update?: string; is_unique?: boolean;
  definition?: string; predicate?: string | null;
}
function invalid(): never { throw new SchemaRunnerError('manifest_invalid'); }
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Token normalization preserves quoted identifiers and literal bytes, including significant whitespace. */
export function normalizeExpression(text: string): string {
  if (/--|\/\*|\*\//.test(text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, ''))) invalid();
  const tokens = text.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|::|>=|<=|<>|!=|!~\*?|~\*?|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[(),.=<>+*/%~-]/g) ?? [];
  if (tokens.join('') !== text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\s+/g, s => /^\s+$/.test(s) ? '' : s)) invalid();
  return tokens.join(' ');
}

function splitClauses(body: string): string[] {
  let depth = 0; let quote = ''; let start = 0; const clauses: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote) { if (body[i + 1] === quote) i++; else quote = ''; } continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') { if (--depth < 0) invalid(); }
    else if (c === ',' && depth === 0) { clauses.push(body.slice(start, i).trim()); start = i + 1; }
  }
  if (quote || depth !== 0) invalid();
  clauses.push(body.slice(start).trim());
  if (clauses.some(c => !c)) invalid();
  return clauses;
}
const columnList = (text: string): string[] => splitClauses(text).map(c => {
  const m = /^"([a-z][a-z0-9_]{0,62})"$/.exec(c); return m ? m[1] : invalid();
});
/** CHECK conkey is a set of referenced attributes in physical column order in PostgreSQL. */
export function checkColumns(expression: string, columns: readonly string[]): string[] {
  const tokens = normalizeExpression(expression).match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const names = new Set(tokens.filter(t => !t.startsWith("'")).map(t => t.replace(/^"|"$/g, '')));
  return columns.filter(c => names.has(c));
}
const actions: Readonly<Record<string, string>> = { RESTRICT: 'r', CASCADE: 'c', 'NO ACTION': 'a', 'SET NULL': 'n', 'SET DEFAULT': 'd' };

export function deriveStructure(statements: readonly string[]): StructureRow[] {
  const rows: StructureRow[] = []; const tables = new Map<string, string[]>();
  for (const statement of statements) {
    let m: RegExpExecArray | null;
    if ((m = /^CREATE TABLE "public"\."([a-z][a-z0-9_]{0,62})" \(([\s\S]*)\)$/.exec(statement.trim()))) {
      const table = m[1]; if (tables.has(table)) invalid();
      const clauses = splitClauses(m[2]); const names: string[] = []; tables.set(table, names);
      for (const clause of clauses.filter(c => c.startsWith('"'))) {
        const c = /^"([a-z][a-z0-9_]{0,62})" (uuid|integer|text|bytea|boolean|character varying\([1-9][0-9]*\)|TIMESTAMP WITH TIME ZONE)( NOT NULL)?$/.exec(clause);
        if (!c || names.includes(c[1])) invalid();
        names.push(c[1]); rows.push({ kind: 'col', table_name: table, name: c[1], type: c[2].toLowerCase(), not_null: !!c[3], default_expression: null });
      }
      if (!names.length) invalid();
      for (const clause of clauses.filter(c => !c.startsWith('"'))) {
        const c = /^CONSTRAINT "([A-Za-z_][A-Za-z0-9_]{0,62})" (PRIMARY KEY|UNIQUE|CHECK) \(([\s\S]+)\)$/.exec(clause);
        if (!c) invalid();
        // Balanced expressions with no trailing statement or unsupported constraint modifier.
        splitClauses(c[3]); normalizeExpression(c[3]);
        const type = c[2] === 'PRIMARY KEY' ? 'p' : c[2] === 'UNIQUE' ? 'u' : 'c';
        const columns = type === 'c' ? checkColumns(c[3], names) : columnList(c[3]);
        if (columns.some(n => !names.includes(n))) invalid();
        rows.push({ kind: 'con', table_name: table, name: c[1], type, columns, ref_table: null, ref_columns: [], on_delete: ' ', on_update: ' ', definition: `${c[2]} (${c[3]})` });
        if (type !== 'c') rows.push({ kind: 'idx', table_name: table, name: c[1], columns, is_unique: true, predicate: null, definition: `index ${table} ${c[1]}` });
      }
    } else if ((m = /^ALTER TABLE "public"\."([a-z][a-z0-9_]{0,62})" ADD CONSTRAINT "([A-Za-z_][A-Za-z0-9_]{0,62})" FOREIGN KEY \(([^)]+)\) REFERENCES "public"\."([a-z][a-z0-9_]{0,62})" \(([^)]+)\) ON DELETE (RESTRICT|CASCADE|NO ACTION|SET NULL|SET DEFAULT) ON UPDATE (RESTRICT|CASCADE|NO ACTION|SET NULL|SET DEFAULT)$/.exec(statement))) {
      if (!tables.has(m[1])) invalid();
      rows.push({ kind: 'con', table_name: m[1], name: m[2], type: 'f', columns: columnList(m[3]), ref_table: `public.${m[4]}`, ref_columns: columnList(m[5]), on_delete: actions[m[6]], on_update: actions[m[7]], definition: statement });
    } else if ((m = /^CREATE (UNIQUE )?INDEX "([A-Za-z_][A-Za-z0-9_]{0,62})" ON "public"\."([a-z][a-z0-9_]{0,62})" \(([^)]+)\)(?: WHERE ([\s\S]+))?$/.exec(statement))) {
      if (!tables.has(m[3])) invalid();
      if (m[5]) { splitClauses(m[5]); normalizeExpression(m[5]); }
      rows.push({ kind: 'idx', table_name: m[3], name: m[2], columns: columnList(m[4]), is_unique: !!m[1], predicate: m[5] ?? null, definition: statement });
    } else invalid();
  }
  if (new Set(rows.map(r => JSON.stringify([r.kind, r.table_name, r.name]))).size !== rows.length) invalid();
  return rows;
}

/** JSON tuples avoid delimiter collisions; sorted lines make catalogue row order irrelevant. */
export function shapeLines(rows: readonly StructureRow[]): string[] {
  return rows.map(r => JSON.stringify(r.kind === 'col' ? ['col', r.table_name, r.name, r.type, r.not_null, r.default_expression === null ? null : normalizeExpression(r.default_expression!)] :
    r.kind === 'con' ? ['con', r.table_name, r.name, r.type, r.columns, r.ref_table, r.ref_columns, r.on_delete, r.on_update] :
      ['idx', r.name, r.table_name, r.is_unique, r.columns, r.predicate !== null])).sort();
}
export function definitionsDigest(rows: readonly StructureRow[]): string {
  const definitions = rows.flatMap(r => r.kind === 'con' && r.type === 'c' ? [JSON.stringify(['check', r.table_name, r.name, normalizeExpression(r.definition!)])] :
    r.kind === 'idx' && r.predicate !== null ? [JSON.stringify(['predicate', r.table_name, r.name, normalizeExpression(r.predicate!)])] : []);
  return createHash('sha256').update(JSON.stringify([...shapeLines(rows), ...definitions].sort())).digest('hex');
}

function readable(value: unknown): value is StructureRow {
  if (!value || typeof value !== 'object') return false;
  const r = value as StructureRow;
  if (typeof r.name !== 'string' || !identifier.test(r.name) || typeof r.table_name !== 'string' || !identifier.test(r.table_name)) return false;
  const columns = (v: unknown): v is string[] => Array.isArray(v) && v.every(c => typeof c === 'string' && identifier.test(c)) && new Set(v).size === v.length;
  const expression = (v: unknown) => v === null || (typeof v === 'string' && v.length > 0);
  if (r.kind === 'col') return typeof r.type === 'string' && r.type.length > 0 && typeof r.not_null === 'boolean' && expression(r.default_expression);
  if (!columns(r.columns)) return false;
  if (r.kind === 'idx') return typeof r.is_unique === 'boolean' && expression(r.predicate) && typeof r.definition === 'string' && r.definition.length > 0;
  return r.kind === 'con' && ['p', 'u', 'c', 'f'].includes(r.type!) && columns(r.ref_columns) &&
    (r.ref_table === null || (typeof r.ref_table === 'string' && /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(r.ref_table))) &&
    typeof r.on_delete === 'string' && typeof r.on_update === 'string' && typeof r.definition === 'string' && r.definition.length > 0;
}
/** Every prefix must describe exactly its declared tables, before a connection can be opened. */
export function derivePrefix(manifest: readonly ManifestEntry[], k: number): StructureRow[] {
  const tables = tablesOfPrefix(manifest, k);
  const rows = deriveStructure(manifest.slice(0, k).flatMap(e => [...e.up]));
  const created = [...new Set(rows.filter(r => r.kind === 'col').map(r => r.table_name))];
  if (JSON.stringify(created) !== JSON.stringify(tables)) invalid();
  return rows;
}

export function evaluateStructure(input: unknown, manifest: readonly ManifestEntry[], k: number): { structure: StructureStatus; structureDigest: string | null; code: SchemaErrorCode | null } {
  const fail = (code: SchemaErrorCode = 'schema_drift') => ({ structure: 'drift' as const, structureDigest: null, code });
  if (!Array.isArray(input)) return fail();
  if (input.length > 2000) return fail('state_truncated');
  if (!input.every(readable)) return fail();
  if (new Set(input.map(r => JSON.stringify([r.kind, r.table_name, r.name]))).size !== input.length) return fail();
  const expected = derivePrefix(manifest, k);
  try {
    if (JSON.stringify(shapeLines(input)) !== JSON.stringify(shapeLines(expected))) return fail();
    const digest = definitionsDigest(input);
    const pin = manifest[k - 1]?.definitionsDigest;
    if (pin !== null && pin !== digest) return fail();
    return { structure: pin === null ? 'definitions_unpinned' : 'verified', structureDigest: digest, code: null };
  } catch { return fail(); }
}

/** Huella de catálogo: incluye los índices de respaldo de PK y UNIQUE. */
export function footprintOf(rows: StructureRow[]): { columns: number; constraints: number; indexes: number } {
  return { columns: rows.filter(r => r.kind === 'col').length,
    constraints: rows.filter(r => r.kind === 'con' && ['p', 'u', 'c', 'f'].includes(r.type!)).length,
    indexes: rows.filter(r => r.kind === 'idx').length };
}

export interface DefinitionLine {
  readonly kind: 'check' | 'predicate'; readonly table: string; readonly name: string; readonly definition: string;
}

/** Solo recibe filas ya verificadas. Una línea insegura descarta el conjunto completo. */
export function definitionLines(rows: readonly StructureRow[]): { definitions: readonly DefinitionLine[]; definitionsOmitted: boolean } {
  const definitions: DefinitionLine[] = [];
  const printable = (value: string) => value.length >= 1 && value.length <= 2000 && !/[^\x20-\x7E]/.test(value);
  try {
    for (const row of rows) {
      const kind = row.kind === 'con' && row.type === 'c' ? 'check' : row.kind === 'idx' && row.predicate !== null ? 'predicate' : null;
      if (kind === null) continue;
      const raw = kind === 'check' ? row.definition! : row.predicate!;
      const definition = normalizeExpression(raw);
      if (!identifier.test(row.table_name) || row.table_name !== row.table_name.trim() || !identifier.test(row.name) || row.name !== row.name.trim() || !printable(raw) || !printable(definition)) throw new Error();
      definitions.push(Object.freeze({ kind, table: row.table_name, name: row.name, definition }));
    }
  } catch { return { definitions: Object.freeze([]), definitionsOmitted: true }; }
  definitions.sort((a, b) => {
    for (const key of ['kind', 'table', 'name'] as const) { if (a[key] < b[key]) return -1; if (a[key] > b[key]) return 1; }
    return 0;
  });
  return { definitions: Object.freeze(definitions), definitionsOmitted: false };
}
