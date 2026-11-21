import { DataSource, type EntityMetadata } from 'typeorm';
import { ENTITIES, INVITATION_ENTITIES } from '../../persistence/entities';
import { SCHEMA_MANIFEST, PENDING_MIGRATIONS } from '../migrations/schema-manifest';
import { UP_STATEMENTS as INITIAL } from '../migrations/initial-schema.statements';
import { UP_STATEMENTS as SECOND } from '../migrations/invitations.statements';
import { deriveStructure, derivePrefix, shapeLines, definitionsDigest, evaluateStructure, normalizeExpression, type StructureRow } from './schema-structure';

// Only specs inspect entity metadata. The pending catalogue is never activated in production.
const combined = [...SCHEMA_MANIFEST, ...PENDING_MIGRATIONS];
let source: DataSource;
beforeAll(async () => {
  source = new DataSource({ type: 'postgres', schema: 'public', entities: [...ENTITIES, ...INVITATION_ENTITIES], synchronize: false });
  await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
});

/** Independent derivation: no DDL builders or statement parser, only TypeORM metadata. */
function fromMetadata(metas: EntityMetadata[]): StructureRow[] {
  const rows: StructureRow[] = [];
  const action = (s: string | undefined) => ({ RESTRICT: 'r', CASCADE: 'c', 'NO ACTION': 'a', 'SET NULL': 'n', 'SET DEFAULT': 'd' })[s ?? 'NO ACTION'];
  for (const m of metas) {
    const table_name = m.tableName;
    for (const c of m.columns) rows.push({ kind: 'col', table_name, name: c.databaseName,
      type: c.type === 'timestamptz' ? 'timestamp with time zone' : c.type === 'varchar' ? `character varying(${c.length})` : String(c.type),
      not_null: !c.isNullable, default_expression: c.default === undefined ? null : String(c.default) });
    const constraint = (name: string, type: string, columns: string[]) => {
      rows.push({ kind: 'con', table_name, name, type, columns, ref_table: null, ref_columns: [], on_delete: ' ', on_update: ' ', definition: '' });
      rows.push({ kind: 'idx', table_name, name, columns, is_unique: true, predicate: null, definition: '' });
    };
    constraint(m.primaryColumns[0].primaryKeyConstraintName!, 'p', m.primaryColumns.map(c => c.databaseName));
    for (const u of m.uniques) constraint(u.name, 'u', u.columns.map(c => c.databaseName));
    for (const c of m.checks) {
      const withoutLiterals = c.expression.replace(/'(?:[^']|'')*'/g, '');
      const columns = m.columns.filter(column => new RegExp(`\\b${column.databaseName}\\b`).test(withoutLiterals)).map(column => column.databaseName);
      rows.push({ kind: 'con', table_name, name: c.name, type: 'c', columns, ref_table: null, ref_columns: [], on_delete: ' ', on_update: ' ', definition: c.expression });
    }
    for (const f of m.foreignKeys) rows.push({ kind: 'con', table_name, name: f.name, type: 'f', columns: f.columns.map(c => c.databaseName),
      ref_table: `public.${f.referencedEntityMetadata.tableName}`, ref_columns: f.referencedColumns.map(c => c.databaseName), on_delete: action(f.onDelete), on_update: action(f.onUpdate), definition: '' });
    for (const i of m.indices) rows.push({ kind: 'idx', table_name, name: i.name, columns: i.columns.map(c => c.databaseName), is_unique: i.isUnique, predicate: i.where ?? null, definition: '' });
  }
  return rows;
}
const measure = (rows: StructureRow[]) => ['col', 'con', 'idx'].map(kind => rows.filter(r => r.kind === kind).length);
const clone = (rows: StructureRow[]) => rows.map(r => ({ ...r, columns: r.columns && [...r.columns], ref_columns: r.ref_columns && [...r.ref_columns] }));

describe('forma offline y metadatos independientes', () => {
  it.each([
    ['inicial', INITIAL, SCHEMA_MANIFEST[0].tables, [68, 64, 26]],
    ['invitaciones', SECOND, PENDING_MIGRATIONS[0].tables, [14, 16, 7]],
    ['acumulado', [...INITIAL, ...SECOND], combined.flatMap(e => [...e.tables]), [82, 80, 33]],
  ] as const)('%s coincide con metadatos y huella numérica', (_label, statements, tables, footprint) => {
    const parsed = deriveStructure(statements);
    const metadata = fromMetadata(source.entityMetadatas.filter(m => tables.includes(m.tableName)));
    expect(shapeLines(parsed)).toEqual(shapeLines(metadata));
    expect(measure(parsed)).toEqual(footprint); expect(measure(metadata)).toEqual(footprint);
    expect(source.isInitialized).toBe(false);
  });
  it.each([
    'SELECT 1', 'CREATE EXTENSION foo', 'ALTER TABLE "public"."users" ADD COLUMN "x" integer',
    'CREATE TABLE "public"."x" ("a" made_up)', 'CREATE TABLE "public"."x" ("a" integer DEFAULT 1)',
    'CREATE TABLE "public"."x" ("a" integer, CONSTRAINT "CK_x" CHECK (a > 0) NOT VALID)',
    'CREATE TABLE "public"."x" ("a" integer); DROP TABLE "public"."users"',
    'CREATE TABLE "public"."x" ("a" integer, CONSTRAINT "CK_x" CHECK (a > 0); SELECT 1)',
    'CREATE INDEX "IX_x" ON "public"."users" (lower("name"))',
  ])('forma desconocida falla cerrada: %s', statement => {
    expect(() => deriveStructure([statement])).toThrow('manifest_invalid');
  });
  it('los metadatos de tablas deben coincidir con cada prefijo de statements', () => {
    expect(() => derivePrefix([{ ...SCHEMA_MANIFEST[0], tables: [...SCHEMA_MANIFEST[0].tables].reverse() }], 1)).toThrow('manifest_invalid');
    expect(() => derivePrefix([{ ...SCHEMA_MANIFEST[0], tables: ['missing'] }], 1)).toThrow('manifest_invalid');
  });
  it('rechaza tablas, columnas y constraints repetidas', () => {
    expect(() => deriveStructure([INITIAL[0], INITIAL[0]])).toThrow('manifest_invalid');
    expect(() => deriveStructure(['CREATE TABLE "public"."x" ("a" integer, "a" integer)'])).toThrow('manifest_invalid');
    expect(() => deriveStructure(['CREATE TABLE "public"."x" ("a" integer, CONSTRAINT "CK_x" CHECK (a > 0), CONSTRAINT "CK_x" CHECK (a < 5))'])).toThrow('manifest_invalid');
  });
});

describe('catálogo falso y dos niveles de verificación', () => {
  const original = deriveStructure([...INITIAL, ...SECOND]);
  const pinned = combined.map((e, i) => ({ ...e, definitionsDigest: definitionsDigest(deriveStructure(combined.slice(0, i + 1).flatMap(e => [...e.up]))) }));
  it('forma exacta con pin verificado; sin pin informa el digest observado', () => {
    expect(evaluateStructure(original, pinned, 2)).toEqual({ structure: 'verified', structureDigest: pinned[1].definitionsDigest, code: null });
    expect(evaluateStructure(original, combined, 2)).toEqual({ structure: 'definitions_unpinned', structureDigest: pinned[1].definitionsDigest, code: null });
  });
  it.each([
    ['falta columna', (rows: StructureRow[]) => { rows.splice(rows.findIndex(r => r.kind === 'col'), 1); }],
    ['sobra columna', (rows: StructureRow[]) => { rows.push({ ...rows[0], name: 'extra' }); }],
    ['tipo', (rows: StructureRow[]) => { rows.find(r => r.kind === 'col')!.type = 'text'; }],
    ['nullabilidad', (rows: StructureRow[]) => { rows.find(r => r.kind === 'col')!.not_null = false; }],
    ['default', (rows: StructureRow[]) => { rows.find(r => r.kind === 'col')!.default_expression = '1'; }],
    ['constraint', (rows: StructureRow[]) => { rows.find(r => r.kind === 'con')!.name = 'Other'; }],
    ['orden de columnas FK', (rows: StructureRow[]) => { rows.find(r => r.type === 'f' && r.columns!.length > 1)!.columns!.reverse(); }],
    ['destino FK', (rows: StructureRow[]) => { rows.find(r => r.type === 'f')!.ref_table = 'alien.organizations'; }],
    ['acción DELETE', (rows: StructureRow[]) => { rows.find(r => r.type === 'f')!.on_delete = 'a'; }],
    ['acción UPDATE', (rows: StructureRow[]) => { rows.find(r => r.type === 'f')!.on_update = 'a'; }],
    ['índice', (rows: StructureRow[]) => { rows.find(r => r.kind === 'idx')!.columns = ['version']; }],
    ['índice parcial', (rows: StructureRow[]) => { rows.find(r => r.kind === 'idx' && r.predicate !== null)!.predicate = null; }],
    ['índice único', (rows: StructureRow[]) => { rows.find(r => r.kind === 'idx')!.is_unique = false; }],
  ])('detecta deriva de forma: %s, incluso sin pin', (_label, mutate) => {
    const rows = clone(original); mutate(rows);
    expect(evaluateStructure(rows, combined, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift', structureDigest: null });
  });
  it.each(['check', 'predicate'])('cambiar texto de %s requiere pin para afirmar ausencia de deriva', kind => {
    const rows = clone(original);
    if (kind === 'check') rows.find(r => r.type === 'c')!.definition = 'CHECK (true)';
    else rows.find(r => r.kind === 'idx' && r.predicate !== null)!.predicate = 'false';
    expect(evaluateStructure(rows, pinned, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
    const unpinned = evaluateStructure(rows, combined, 2);
    expect(unpinned).toMatchObject({ structure: 'definitions_unpinned', code: null });
    expect(unpinned.structureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(unpinned.structureDigest).not.toBe(pinned[1].definitionsDigest);
  });
  it('rechaza filas duplicadas, ilegibles y truncadas sin afirmar verificación', () => {
    for (const rows of [null, {}, [null], [...original, original[0]], original.map((r, i) => i ? r : { ...r, name: 3 }),
      original.map(r => r.kind === 'idx' ? { ...r, columns: [null] } : r), original.map(r => r.type === 'c' ? { ...r, definition: undefined } : r)])
      expect(evaluateStructure(rows, pinned, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
    expect(evaluateStructure(Array(2001).fill(original[0]), pinned, 2)).toMatchObject({ structure: 'drift', code: 'state_truncated' });
  });
  it('canonicalización estable ante orden y espacios, conservando bytes de literales', () => {
    const rows = clone(original).reverse();
    for (const r of rows) {
      if (r.definition) r.definition = '  ' + normalizeExpression(r.definition) + '\n';
      if (r.predicate) r.predicate = '  ' + normalizeExpression(r.predicate) + '\n';
    }
    expect(shapeLines(rows)).toEqual(shapeLines(original));
    expect(definitionsDigest(rows)).toBe(definitionsDigest(original));
    expect(normalizeExpression("name = 'a  b'")).not.toBe(normalizeExpression("name = 'a b'"));
    expect(evaluateStructure(rows, pinned, 2).structure).toBe('verified');
  });
});
