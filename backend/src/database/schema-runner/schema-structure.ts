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

/** Token normalization keeps `~~`, `~~*`, `!~~` and `!~~*` (LIKE, ILIKE, NOT LIKE, NOT ILIKE as PostgreSQL prints them) as single tokens, distinct from `~ ~`. It preserves quoted identifiers and literal bytes, including significant whitespace. */
export function normalizeExpression(text: string): string {
  if (/--|\/\*|\*\//.test(text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, ''))) invalid();
  const tokens = text.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|::|>=|<=|<>|!=|!~~\*?|~~\*?|!~\*?|~\*?|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[()[\],.=<>+*/%~-]/g) ?? [];
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
/**
 * Columns referenced by a CHECK, as a set. PostgreSQL gives the order of a CHECK's conkey no positional meaning (on agenda_test it
 * follows the first appearance in the expression, not the physical order), so shapeLines compares CHECK columns sorted.
 * Primary keys, uniques, foreign keys and indexes keep their strict order, where it is part of the definition.
 */
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
    r.kind === 'con' ? ['con', r.table_name, r.name, r.type, r.type === 'c' ? [...r.columns!].sort() : r.columns, r.ref_table, r.ref_columns, r.on_delete, r.on_update] :
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

export type EvaluationStage = 'input' | 'size' | 'rows' | 'duplicates' | 'shape' | 'definitions' | 'pin' | 'passed';
const EVALUATION_STAGES: readonly EvaluationStage[] = ['input', 'size', 'rows', 'duplicates', 'shape', 'definitions', 'pin', 'passed'];

/** Single source of truth: evaluateStructure and diffStructure both go through it, so the failing stage is always known. */
function inspectStructure(input: unknown, manifest: readonly ManifestEntry[], k: number):
  { structure: StructureStatus; structureDigest: string | null; code: SchemaErrorCode | null; stage: EvaluationStage } {
  const fail = (stage: EvaluationStage, code: SchemaErrorCode = 'schema_drift') => ({ structure: 'drift' as const, structureDigest: null, code, stage });
  if (!Array.isArray(input)) return fail('input');
  if (input.length > 2000) return fail('size', 'state_truncated');
  if (!input.every(readable)) return fail('rows');
  if (new Set(input.map(r => JSON.stringify([r.kind, r.table_name, r.name]))).size !== input.length) return fail('duplicates');
  const expected = derivePrefix(manifest, k);
  let stage: EvaluationStage = 'shape';
  try {
    if (JSON.stringify(shapeLines(input)) !== JSON.stringify(shapeLines(expected))) return fail('shape');
    stage = 'definitions';
    const digest = definitionsDigest(input);
    stage = 'pin';
    const pin = manifest[k - 1]?.definitionsDigest;
    if (pin !== null && pin !== digest) return fail('pin');
    return { structure: pin === null ? 'definitions_unpinned' : 'verified', structureDigest: digest, code: null, stage: 'passed' };
  } catch { return fail(stage); }
}

export function evaluateStructure(input: unknown, manifest: readonly ManifestEntry[], k: number): { structure: StructureStatus; structureDigest: string | null; code: SchemaErrorCode | null } {
  const { structure, structureDigest, code } = inspectStructure(input, manifest, k);
  return { structure, structureDigest, code };
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

/** 'definitions': the shape matches but the text of a CHECK or of a partial-index predicate differs from the pinned digest. */
export type DriftCategory = 'missing' | 'unexpected' | 'changed' | 'definitions' | 'unreadable' | 'duplicate' | 'unknown';
const DRIFT_CATEGORIES: readonly DriftCategory[] = ['missing', 'unexpected', 'changed', 'definitions', 'unreadable', 'duplicate', 'unknown'];
const DRIFT_RANK: Readonly<Record<DriftCategory, number>> = { unreadable: 0, duplicate: 1, unknown: 2, definitions: 3, changed: 4, unexpected: 5, missing: 6 };
const hexDigest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
type DriftValue = string | boolean | null | readonly string[];
export interface DriftLine {
  readonly category: DriftCategory;
  readonly kind?: StructureRow['kind'];
  readonly table?: string;
  readonly name?: string;
  readonly field?: string;
  readonly stage?: EvaluationStage;
  readonly expected?: DriftValue;
  readonly observed?: DriftValue;
}
export interface StructureDrift { readonly lines: readonly DriftLine[]; readonly omitted: number }
const driftFields = {
  col: ['type', 'not_null', 'default_expression'],
  con: ['type', 'columns', 'ref_table', 'ref_columns', 'on_delete', 'on_update'],
  idx: ['is_unique', 'columns', 'has_predicate'],
} as const;
const safeIdentifier = (v: unknown): v is string => typeof v === 'string' && identifier.test(v);
function driftValue(value: unknown, kind: DriftLine['kind'], field: string): DriftValue {
  if (value === null || typeof value === 'boolean') return value;
  if (field === 'columns' || field === 'ref_columns')
    return Array.isArray(value) && value.length <= 16 && value.every(safeIdentifier) ? Object.freeze([...value]) : '<omitted>';
  if (typeof value !== 'string') return '<omitted>';
  if (field === 'ref_table') return value.split('.').length === 2 && value.split('.').every(safeIdentifier) ? value : '<omitted>';
  if (field === 'on_delete' || field === 'on_update') return /^[ arcdn]$/.test(value) ? value : '<omitted>';
  if (field === 'type' && kind === 'con') return /^[pucf]$/.test(value) ? value : '<omitted>';
  if (field === 'type') return /^[a-z0-9 ()]{1,40}$/.test(value) ? value : '<omitted>';
  // Expressions can contain literals and are never disclosed.
  return '<omitted>';
}

/** Closed output projection, shared by the diff and CLI. No raw row fields travel. */
export function projectDriftLine(line: DriftLine): DriftLine {
  const category = DRIFT_CATEGORIES.includes(line.category) ? line.category : 'unknown';
  const kind = line.kind === 'col' || line.kind === 'con' || line.kind === 'idx' ? line.kind : undefined;
  const result: { category: DriftCategory; kind?: StructureRow['kind']; table?: string; name?: string; field?: string; stage?: EvaluationStage; expected?: DriftValue; observed?: DriftValue } = { category };
  if (kind) result.kind = kind;
  if (line.table !== undefined) result.table = safeIdentifier(line.table) ? line.table : '<omitted>';
  if (line.name !== undefined) result.name = safeIdentifier(line.name) ? line.name : '<omitted>';
  if (line.stage !== undefined && EVALUATION_STAGES.includes(line.stage)) result.stage = line.stage;
  if (category === 'definitions') {
    // Only digests travel: never the text of an expression.
    if ('expected' in line) result.expected = hexDigest(line.expected) ? line.expected : '<omitted>';
    if ('observed' in line) result.observed = hexDigest(line.observed) ? line.observed : '<omitted>';
  } else if (kind && line.field && (driftFields[kind] as readonly string[]).includes(line.field)) {
    result.field = line.field;
    if ('expected' in line) result.expected = driftValue(line.expected, kind, line.field);
    if ('observed' in line) result.observed = driftValue(line.observed, kind, line.field);
  }
  return Object.freeze(result);
}

function stageOf(input: unknown, manifest: readonly ManifestEntry[], k: number): EvaluationStage | undefined {
  try { return inspectStructure(input, manifest, k).stage; } catch { return undefined; }
}

/** Diagnostic only: uses the same shape tuples without changing verification or issuing queries. */
export function diffStructure(input: unknown, manifest: readonly ManifestEntry[], k: number): StructureDrift {
  const lines: DriftLine[] = [];
  const minimal = (category: DriftCategory, stage?: EvaluationStage): StructureDrift =>
    Object.freeze({ lines: Object.freeze([Object.freeze(stage ? { category, stage } : { category })]), omitted: 0 });
  if (!Array.isArray(input)) return minimal('unreadable');
  if (input.length > 2000) return minimal('unknown', 'size');
  try {
    const key = (r: StructureRow) => JSON.stringify([r.kind, r.table_name, r.name]);
    const expected = new Map(derivePrefix(manifest, k).map(r => [key(r), r]));
    const seen = new Set<string>();
    const add = (category: DriftCategory, r: StructureRow, extra: Partial<DriftLine> = {}) =>
      lines.push(projectDriftLine({ category, kind: r.kind, table: r.table_name, name: r.name, ...extra }));
    for (const raw of input) {
      const r = raw as StructureRow;
      if (!r || !safeIdentifier(r.table_name) || !safeIdentifier(r.name)) { lines.push({ category: 'unreadable' }); continue; }
      const id = key(r);
      if (seen.has(id)) add('duplicate', r);
      seen.add(id);
      if (!readable(r)) { add('unreadable', r); continue; }
      const prior = expected.get(id);
      if (!prior) { add('unexpected', r); continue; }
      try {
        const before = JSON.parse(shapeLines([prior])[0]) as unknown[];
        const after = JSON.parse(shapeLines([r])[0]) as unknown[];
        driftFields[r.kind].forEach((field, i) => {
          if (JSON.stringify(before[i + 3]) !== JSON.stringify(after[i + 3]))
            add('changed', r, { field, expected: driftValue(before[i + 3], r.kind, field), observed: driftValue(after[i + 3], r.kind, field) });
        });
      } catch { add('unreadable', r); }
    }
    for (const [id, r] of expected) if (!seen.has(id)) add('missing', r);
    // Same shape: the remaining difference can only be the normalized text of CHECK or predicate definitions.
    const pin = manifest[k - 1]?.definitionsDigest;
    if (lines.length === 0 && typeof pin === 'string') {
      const observed = definitionsDigest(input as StructureRow[]);
      if (observed !== pin) lines.push({ category: 'definitions', expected: pin, observed });
    }
  } catch { return minimal('unknown', stageOf(input, manifest, k)); }
  // The evaluation failed but the per-row comparison found nothing: say which stage of the evaluation failed.
  if (!lines.length) return minimal('unknown', stageOf(input, manifest, k));
  // Anomalies first, so the 50-line cap can never hide an unreadable or duplicated row behind many missing ones.
  lines.sort((a, b) => {
    if (DRIFT_RANK[a.category] !== DRIFT_RANK[b.category]) return DRIFT_RANK[a.category] - DRIFT_RANK[b.category];
    for (const field of ['kind', 'table', 'name', 'field'] as const) {
      const x = a[field] ?? ''; const y = b[field] ?? '';
      if (x < y) return -1; if (x > y) return 1;
    }
    return JSON.stringify(a).localeCompare(JSON.stringify(b), 'en');
  });
  return Object.freeze({ lines: Object.freeze(lines.slice(0, 50).map(projectDriftLine)), omitted: Math.max(0, lines.length - 50) });
}
