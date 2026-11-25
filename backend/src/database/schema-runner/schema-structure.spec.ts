import { DataSource, type EntityMetadata } from 'typeorm';
import { ENTITIES, INVITATION_ENTITIES } from '../../persistence/entities';
import { SCHEMA_MANIFEST, type ManifestEntry } from '../migrations/schema-manifest';
import { UP_STATEMENTS as INITIAL } from '../migrations/initial-schema.statements';
import { UP_STATEMENTS as SECOND } from '../migrations/invitations.statements';
import { OBSERVED_INITIAL_DEFINITIONS, RECONSTRUCTED_INVITATION_DEFINITIONS, withObservedDefinitions } from './testing/observed-initial-definitions';
import { definitionLines, footprintOf, deriveStructure, derivePrefix, shapeLines, definitionsDigest, evaluateStructure, normalizeExpression, diffStructure, projectDriftLine, type DriftLine, type StructureRow } from './schema-structure';

// Solo las pruebas inspeccionan metadatos; las entidades de invitaciones siguen fuera del registro activo.
/** Real manifest without its pins: the shape/definitions tests decide pins themselves (the real pins are covered in their own describe). */
const combined: ManifestEntry[] = SCHEMA_MANIFEST.map(e => ({ ...e, definitionsDigest: null }));
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
    ['invitaciones', SECOND, SCHEMA_MANIFEST[1].tables, [14, 16, 7]],
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

it.each([[1, { columns: 68, constraints: 64, indexes: 26 }], [2, { columns: 82, constraints: 80, indexes: 33 }]] as const)(
  'huella del prefijo %i cuenta constraints e índices de respaldo', (k, expected) => {
    expect(footprintOf(derivePrefix(SCHEMA_MANIFEST, k))).toEqual(expected);
  });

describe('límites cerrados de las líneas de definición', () => {
  const rows = () => derivePrefix(SCHEMA_MANIFEST, 2);
  it.each(['table_name', 'name'] as const)('descarta el conjunto por identificador %s inseguro', field => {
    for (const invalid of ['a.b', 'a;DROP', 'á', 'a'.repeat(64), 'a\n']) {
      const input = rows(); input.find(r => r.type === 'c')![field] = invalid;
      expect(definitionLines(input)).toEqual({ definitions: [], definitionsOmitted: true });
    }
  });
  it('el límite también se aplica tras normalizar y a predicados parciales', () => {
    for (const predicate of ["'á' = 'á'", 'id > 0\n', '('.repeat(700) + 'id' + ')'.repeat(700)]) {
      const input = rows(); input.find(r => r.kind === 'idx' && r.predicate !== null)!.predicate = predicate;
      expect(definitionLines(input)).toEqual({ definitions: [], definitionsOmitted: true });
    }
  });
});


describe('diagnóstico de deriva (solo informa; nunca cambia la verificación)', () => {
  const original = deriveStructure([...INITIAL, ...SECOND]);
  const diff = (rows: unknown, k = 2, manifest = combined) => diffStructure(rows, manifest, k);
  const only = (rows: StructureRow[]) => diff(rows).lines;
  const pinned = combined.map((e, i) => ({ ...e, definitionsDigest: definitionsDigest(deriveStructure(combined.slice(0, i + 1).flatMap(e => [...e.up]))) }));

  it('una estructura idéntica no produce líneas de forma ni de definiciones', () => {
    expect(diff(clone(original), 2, pinned)).toEqual({ lines: [{ category: 'unknown', stage: 'passed' }], omitted: 0 });
  });
  it.each([
    ['falta columna', (rows: StructureRow[]) => { rows.splice(rows.findIndex(r => r.kind === 'col'), 1); }, 'missing', 'col'],
    ['sobra columna', (rows: StructureRow[]) => { rows.push({ ...rows.find(r => r.kind === 'col')!, name: 'extra' }); }, 'unexpected', 'col'],
    ['falta constraint', (rows: StructureRow[]) => { rows.splice(rows.findIndex(r => r.kind === 'con' && r.type === 'f'), 1); }, 'missing', 'con'],
    ['falta índice', (rows: StructureRow[]) => { rows.splice(rows.findIndex(r => r.kind === 'idx' && !r.is_unique), 1); }, 'missing', 'idx'],
  ] as const)('%s', (_label, mutate, category, kind) => {
    const rows = clone(original); mutate(rows);
    const lines = only(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ category, kind });
    expect(lines[0]).not.toHaveProperty('field');
  });
  it.each([
    ['tipo', (rows: StructureRow[]) => { rows.find(r => r.kind === 'col')!.type = 'text'; }, 'col', 'type'],
    ['nulabilidad', (rows: StructureRow[]) => { rows.find(r => r.kind === 'col')!.not_null = false; }, 'col', 'not_null'],
    ['columnas de una FK', (rows: StructureRow[]) => { rows.find(r => r.type === 'f' && r.columns!.length > 1)!.columns!.reverse(); }, 'con', 'columns'],
    ['destino de una FK', (rows: StructureRow[]) => { rows.find(r => r.type === 'f')!.ref_table = 'alien.organizations'; }, 'con', 'ref_table'],
    ['acción DELETE', (rows: StructureRow[]) => { rows.find(r => r.type === 'f')!.on_delete = 'a'; }, 'con', 'on_delete'],
    ['acción UPDATE', (rows: StructureRow[]) => { rows.find(r => r.type === 'f')!.on_update = 'a'; }, 'con', 'on_update'],
    ['unicidad de un índice', (rows: StructureRow[]) => { rows.find(r => r.kind === 'idx')!.is_unique = false; }, 'idx', 'is_unique'],
    ['columnas de un índice', (rows: StructureRow[]) => { rows.find(r => r.kind === 'idx')!.columns = ['version']; }, 'idx', 'columns'],
    ['predicado de un índice parcial', (rows: StructureRow[]) => { rows.find(r => r.kind === 'idx' && r.predicate !== null)!.predicate = null; }, 'idx', 'has_predicate'],
  ] as const)('cambia %s con campo, valor esperado y observado', (_label, mutate, kind, field) => {
    const rows = clone(original); mutate(rows);
    const lines = only(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ category: 'changed', kind, field });
    expect(lines[0]).toHaveProperty('expected'); expect(lines[0]).toHaveProperty('observed');
    expect(lines[0].expected).not.toEqual(lines[0].observed);
  });
  it('el valor por defecto nunca se divulga, solo si existe o no', () => {
    const rows = clone(original); rows.find(r => r.kind === 'col')!.default_expression = "'secreto-7Q'";
    const [line] = only(rows);
    expect(line).toMatchObject({ category: 'changed', field: 'default_expression', expected: null, observed: '<omitted>' });
    expect(JSON.stringify(line)).not.toContain('secreto-7Q');
  });
  it('si la forma coincide y hay pin, un texto de CHECK o de predicado distinto informa solo los dos digests', () => {
    for (const kind of ['check', 'predicate']) {
      const rows = clone(original);
      if (kind === 'check') rows.find(r => r.type === 'c')!.definition = "CHECK ('secreto-7Q' = 'secreto-7Q')";
      else rows.find(r => r.kind === 'idx' && r.predicate !== null)!.predicate = "'secreto-7Q' = 'secreto-7Q'";
      const result = diff(rows, 2, pinned);
      expect(result).toEqual({ lines: [{ category: 'definitions', expected: pinned[1].definitionsDigest, observed: definitionsDigest(rows) }], omitted: 0 });
      expect(JSON.stringify(result)).not.toContain('secreto-7Q');
    }
  });
  it('sin pin no hay línea de definiciones: no se puede afirmar nada sobre ellas', () => {
    const rows = clone(original); rows.find(r => r.type === 'c')!.definition = 'CHECK (true)';
    expect(diff(rows, 2, combined)).toEqual({ lines: [{ category: 'unknown', stage: 'passed' }], omitted: 0 });
  });
  it('filas duplicadas, ilegibles o de otra forma se marcan sin copiar su contenido', () => {
    const duplicated = diff([...original, original[0]]).lines;
    expect(duplicated.some(l => l.category === 'duplicate')).toBe(true);
    const unreadable = diff(original.map((r, i) => i ? r : { ...r, type: undefined })).lines;
    expect(unreadable.some(l => l.category === 'unreadable')).toBe(true);
    expect(diff([{ kind: 'col', table_name: 'x; DROP', name: 'y' }]).lines.some(l => l.category === 'unreadable')).toBe(true);
    for (const rows of [null, {}, 'texto']) expect(diff(rows)).toEqual({ lines: [{ category: 'unreadable' }], omitted: 0 });
    expect(diff(Array(2001).fill(original[0]))).toEqual({ lines: [{ category: 'unknown', stage: 'size' }], omitted: 0 });
  });
  it('limita a 50 líneas, cuenta las omitidas y ordena de forma estable', () => {
    const result = diff([]);
    expect(result.lines).toHaveLength(50);
    expect(result.omitted).toBe(original.length - 50);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.lines)).toBe(true);
    expect(diff(clone(original).slice(1).reverse())).toEqual(diff(clone(original).slice(1)));
    const keys = result.lines.map(l => [l.kind, l.table, l.name].join('|'));
    expect(keys).toEqual([...keys].sort());
    // Las anomalías van primero: el tope no puede ocultarlas detrás de muchas filas ausentes.
    const mixed = diff([{ kind: 'col', table_name: 'x; DROP', name: 'y' }, ...clone(original).slice(0, 1)]);
    expect(mixed.lines[0]).toEqual({ category: 'unreadable' });
    expect(mixed.lines).toHaveLength(50);
  });
  it('projectDriftLine descarta todo lo que no sea una proyección cerrada y segura', () => {
    expect(projectDriftLine({ category: 'inventada' as never })).toEqual({ category: 'unknown' });
    expect(projectDriftLine({ category: 'changed', kind: 'col', table: 'users; DROP', name: 'id', field: 'type', expected: 'uuid', observed: 'text' }))
      .toEqual({ category: 'changed', kind: 'col', table: '<omitted>', name: 'id', field: 'type', expected: 'uuid', observed: 'text' });
    expect(projectDriftLine({ category: 'changed', kind: 'col', table: 'users', name: 'id', field: 'definition' as never, expected: 'x', observed: 'y' }))
      .toEqual({ category: 'changed', kind: 'col', table: 'users', name: 'id' });
    expect(projectDriftLine({ category: 'changed', kind: 'col', table: 'users', name: 'id', field: 'type', expected: "uuid'; DROP", observed: 'a'.repeat(41) }))
      .toMatchObject({ expected: '<omitted>', observed: '<omitted>' });
    expect(projectDriftLine({ category: 'changed', kind: 'idx', table: 'users', name: 'IX_x', field: 'columns', expected: Array(17).fill('a'), observed: ['a', 'b c'] }))
      .toMatchObject({ expected: '<omitted>', observed: '<omitted>' });
    expect(projectDriftLine({ category: 'definitions', expected: 'a'.repeat(64), observed: 'x\n' + 'a'.repeat(62) }))
      .toEqual({ category: 'definitions', expected: 'a'.repeat(64), observed: '<omitted>' });
    expect(projectDriftLine({ category: 'changed', kind: 'con', table: 'users', name: 'FK', field: 'columns', expected: ['id'], observed: ['id'], extra: 'secreto' } as DriftLine & { extra: string }))
      .not.toHaveProperty('extra');
    expect(Object.isFrozen(projectDriftLine({ category: 'missing' }))).toBe(true);
  });
});


describe('columnas de un CHECK: conjunto; en claves, únicas, FK e índices: orden estricto', () => {
  const original = deriveStructure([...INITIAL, ...SECOND]);
  const pinned = combined.map((e, i) => ({ ...e, definitionsDigest: definitionsDigest(deriveStructure(combined.slice(0, i + 1).flatMap(e => [...e.up]))) }));
  const times = (rows: StructureRow[]) => rows.find(r => r.name === 'CK_user_sessions_times')!;
  const composite = (rows: StructureRow[], kind: 'con' | 'idx', type: string | undefined, name: string) =>
    rows.find(r => r.kind === kind && r.name === name && (type === undefined || r.type === type))!;

  it('la derivación conserva las columnas del CHECK de sesiones y la base puede listarlas en otro orden', () => {
    expect(new Set(times(original).columns)).toEqual(new Set(['created_at', 'last_seen_at', 'expires_at', 'revoked_at']));
    // Orden observado en agenda_test: el de la primera aparición en la expresión.
    const rows = clone(original); times(rows).columns = ['expires_at', 'created_at', 'last_seen_at', 'revoked_at'];
    expect(shapeLines(rows)).toEqual(shapeLines(original));
    expect(definitionsDigest(rows)).toBe(definitionsDigest(original));
    expect(evaluateStructure(rows, combined, 2)).toMatchObject({ structure: 'definitions_unpinned', code: null });
    expect(evaluateStructure(rows, pinned, 2)).toMatchObject({ structure: 'verified', code: null });
  });
  it('acepta cualquier permutación de las columnas de cualquier CHECK', () => {
    const rows = clone(original);
    for (const r of rows) if (r.kind === 'con' && r.type === 'c' && r.columns!.length > 1) r.columns!.reverse();
    expect(rows.some(r => r.type === 'c' && r.columns!.length > 1)).toBe(true);
    expect(evaluateStructure(rows, pinned, 2)).toMatchObject({ structure: 'verified', code: null });
  });
  it.each([
    ['falta una columna', (rows: StructureRow[]) => { times(rows).columns = ['expires_at', 'created_at', 'last_seen_at']; }],
    ['sobra una columna', (rows: StructureRow[]) => { times(rows).columns = ['expires_at', 'created_at', 'last_seen_at', 'revoked_at', 'id']; }],
    ['otra columna', (rows: StructureRow[]) => { times(rows).columns = ['expires_at', 'created_at', 'last_seen_at', 'user_id']; }],
    ['sin columnas repetidas pero distintas', (rows: StructureRow[]) => { times(rows).columns = ['created_at']; }],
  ])('un CHECK con %s sigue siendo deriva, incluso con otro orden', (_label, mutate) => {
    const rows = clone(original); mutate(rows);
    expect(evaluateStructure(rows, pinned, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift', structureDigest: null });
    const lines = diffStructure(rows, pinned, 2).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ category: 'changed', kind: 'con', table: 'user_sessions', name: 'CK_user_sessions_times', field: 'columns' });
  });
  it('un CHECK con columnas repetidas se rechaza como fila ilegible', () => {
    const rows = clone(original); times(rows).columns = ['created_at', 'created_at', 'expires_at', 'last_seen_at'];
    expect(evaluateStructure(rows, pinned, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
  });
  it.each([
    ['clave primaria compuesta', 'con', 'p', 'PK_invitation_companies', 'columns'],
    ['única compuesta', 'con', 'u', 'UQ_organization_memberships_org_user', 'columns'],
    ['FK compuesta (columnas locales)', 'con', 'f', 'FK_invitation_companies_company', 'columns'],
    ['FK compuesta (columnas referenciadas)', 'con', 'f', 'FK_invitation_companies_company', 'ref_columns'],
    ['índice compuesto', 'idx', undefined, 'IX_invitations_org_created', 'columns'],
    ['índice de respaldo de la clave primaria', 'idx', undefined, 'PK_invitation_companies', 'columns'],
  ] as const)('el orden sigue importando en %s', (_label, kind, type, name, field) => {
    const rows = clone(original);
    const target = composite(rows, kind, type, name);
    expect(target[field]!.length).toBeGreaterThan(1);
    target[field]!.reverse();
    expect(evaluateStructure(rows, pinned, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
    const lines = diffStructure(rows, pinned, 2).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ category: 'changed', field });
  });
  it('la expresión del CHECK sigue comprobándose por separado, con su digest', () => {
    const rows = clone(original); times(rows).columns!.reverse();
    times(rows).definition = 'CHECK (expires_at > created_at)';
    expect(evaluateStructure(rows, pinned, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
    expect(diffStructure(rows, pinned, 2).lines).toEqual([{ category: 'definitions', expected: pinned[1].definitionsDigest, observed: definitionsDigest(rows) }]);
    expect(evaluateStructure(rows, combined, 2)).toMatchObject({ structure: 'definitions_unpinned' });
  });
  it('una diferencia solo de orden en un CHECK no produce líneas de deriva', () => {
    const rows = clone(original); times(rows).columns!.reverse();
    expect(diffStructure(rows, pinned, 2)).toEqual({ lines: [{ category: 'unknown', stage: 'passed' }], omitted: 0 });
  });
});


describe('etapa que falla cuando la evaluación rechaza y el diff queda vacío', () => {
  const original = deriveStructure([...INITIAL, ...SECOND]);
  const roleCheck = (rows: StructureRow[]) => rows.find(r => r.name === 'CK_organization_memberships_role')!;

  it('acepta la forma con ARRAY[...] con que PostgreSQL devuelve un IN, y con el orden de columnas observado', () => {
    const rows = clone(original);
    roleCheck(rows).definition = "CHECK (role::text = ANY (ARRAY['community_manager'::character varying, 'worker'::character varying, 'client'::character varying]::text[]))";
    rows.find(r => r.name === 'CK_user_sessions_times')!.columns = ['expires_at', 'created_at', 'last_seen_at', 'revoked_at'];
    expect(normalizeExpression(roleCheck(rows).definition!)).toContain('ARRAY [');
    expect(evaluateStructure(rows, combined, 2)).toMatchObject({ structure: 'definitions_unpinned', code: null });
    expect(definitionLines(rows).definitionsOmitted).toBe(false);
  });
  it.each([
    ['definitions', (rows: StructureRow[]) => { roleCheck(rows).definition = 'CHECK (role @ 1)'; }],
    ['shape', (rows: StructureRow[]) => { roleCheck(rows).columns = ['id']; }],
    ['rows', (rows: StructureRow[]) => { roleCheck(rows).columns = ['no valido!']; }],
    ['duplicates', (rows: StructureRow[]) => { rows.push({ ...roleCheck(rows) }); }],
  ])('indica la etapa %s sin revelar contenido', (stage, mutate) => {
    const rows = clone(original); mutate(rows);
    expect(evaluateStructure(rows, combined, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
    const drift = diffStructure(rows, combined, 2);
    expect(drift.lines.every(l => l.category !== 'unknown' || l.stage === stage)).toBe(true);
    if (stage === 'definitions') expect(drift).toEqual({ lines: [{ category: 'unknown', stage: 'definitions' }], omitted: 0 });
    expect(JSON.stringify(drift)).not.toContain('@');
  });
  it('coincide con la etapa que no es una lista: no es una matriz', () => {
    expect(diffStructure('x', combined, 2).lines[0]).toEqual({ category: 'unreadable' });
  });
  it('una etapa fuera del conjunto cerrado no viaja', () => {
    expect(projectDriftLine({ category: 'unknown', stage: 'secreto' } as unknown as DriftLine)).toEqual({ category: 'unknown' });
    expect(projectDriftLine({ category: 'unknown', stage: 'definitions' })).toEqual({ category: 'unknown', stage: 'definitions' });
  });
});


describe('normalización de operadores de patrón y literales', () => {
  it.each(['~', '~*', '!~', '!~*', '~~', '~~*', '!~~', '!~~*'])('conserva el operador %s como un único token', op => {
    expect(normalizeExpression(`CHECK (a ${op} 'x'::text)`)).toBe(`CHECK ( a ${op} 'x' :: text )`);
  });
  it('no confunde ~~ (LIKE) con ~ ~ (coincidencia con negación unaria), ni los demás operadores entre sí', () => {
    const forms = ['a ~~ b', 'a ~ ~b', 'a ~~* b', 'a ~* ~b', 'a !~~ b', 'a !~ ~b', 'a !~~* b', 'a !~* ~b', 'a ~ b', 'a ~* b', 'a !~ b', 'a !~* b'];
    const out = forms.map(f => normalizeExpression(f));
    expect(new Set(out).size).toBe(forms.length);
  });
  it('CK_users_password_hash, tal como lo imprime PostgreSQL, conserva ~~ y el literal intacto', () => {
    const pg = "CHECK (password_hash ~~ '$argon2id$%'::text AND char_length(password_hash) >= 40 AND char_length(password_hash) <= 512)";
    const n = normalizeExpression(pg);
    expect(n).toContain("password_hash ~~ '$argon2id$%' :: text");
    expect(n).not.toContain('~ ~');
    expect(normalizeExpression("CHECK (password_hash ~~ '$argon2id$%'::text)")).not.toBe(normalizeExpression("CHECK (password_hash ~~ '$argon2id$%%'::text)"));
    expect(normalizeExpression("CHECK (a ~~ '  x'::text)")).toContain("'  x'");
  });
});


describe('definiciones observadas en agenda_test para el esquema inicial (offline)', () => {
  const OBSERVED_DIGEST = '2264ec9a2899ced9beb0e24280bd5d3a260e46016d9f6e5450076f5089985c94';
  // Digest observado en agenda_test tras aplicar invitaciones (prefijo 2).
  const OBSERVED_DIGEST_2 = '66741a61b78e6f262643c87fb19de20b2d56a45a3645965f7f1fabb1b8ed1556';
  const key = (r: StructureRow) => (r.kind === 'con' && r.type === 'c' ? `check:${r.table_name}:${r.name}` : r.kind === 'idx' && r.predicate !== null ? `predicate:${r.table_name}:${r.name}` : null);
  const observed = () => {
    const rows = deriveStructure(INITIAL);
    for (const r of rows) {
      const k = key(r); if (k === null) continue;
      if (!(k in OBSERVED_INITIAL_DEFINITIONS)) throw new Error(`sin definición observada: ${k}`);
      if (r.kind === 'con') r.definition = OBSERVED_INITIAL_DEFINITIONS[k]; else r.predicate = OBSERVED_INITIAL_DEFINITIONS[k];
    }
    return rows;
  };
  it('hay una definición observada por cada una de las 33 CHECK y los 4 predicados, y ninguna sobra', () => {
    const keys = deriveStructure(INITIAL).map(key).filter((k): k is string => k !== null);
    expect(keys.filter(k => k.startsWith('check:'))).toHaveLength(33);
    expect(keys.filter(k => k.startsWith('predicate:'))).toHaveLength(4);
    expect(Object.keys(OBSERVED_INITIAL_DEFINITIONS).sort()).toEqual([...keys].sort());
  });
  it('el digest de la estructura con esas definiciones es el observado en la base', () => {
    expect(definitionsDigest(observed())).toBe(OBSERVED_DIGEST);
  });
  it('el manifiesto fija el digest de cada prefijo observado, con los sha256 sin cambios', () => {
    expect(SCHEMA_MANIFEST.map(e => e.definitionsDigest)).toEqual([OBSERVED_DIGEST, OBSERVED_DIGEST_2]);
    expect(definitionsDigest(observed())).toBe(SCHEMA_MANIFEST[0].definitionsDigest);
    expect(SCHEMA_MANIFEST.map(e => e.sha256.slice(0, 8))).toEqual(['33d0baa6', 'e2c0f806']);
  });
  it('con el pin, la estructura observada del prefijo 1 queda verified y una definición alterada es deriva', () => {
    expect(evaluateStructure(observed(), SCHEMA_MANIFEST, 1)).toMatchObject({ structure: 'verified', structureDigest: OBSERVED_DIGEST, code: null });
    const rows = observed(); const r = rows.find(x => x.name === 'CK_users_password_hash')!;
    r.definition = r.definition!.replace('>= 40', '>= 41');
    expect(evaluateStructure(rows, SCHEMA_MANIFEST, 1)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
    expect(diffStructure(rows, SCHEMA_MANIFEST, 1).lines).toEqual([{ category: 'definitions', expected: OBSERVED_DIGEST, observed: definitionsDigest(rows) }]);
  });
  // Las 8 definiciones de invitaciones se reconstruyeron desde los statements y se contrastaron con el digest observado del prefijo 2;
  // no se recibieron sus líneas originales. Que el digest coincida exactamente es la prueba de que el texto es el mismo.
  describe('prefijo 2: 37 observadas + 8 reconstruidas, contrastadas con el digest observado', () => {
    const prefix2 = () => withObservedDefinitions(deriveStructure([...INITIAL, ...SECOND]));
    it('hay 45 definiciones: 40 CHECK y 5 predicados; las 8 nuevas están todas cubiertas', () => {
      const keys = deriveStructure([...INITIAL, ...SECOND]).map(key).filter((k): k is string => k !== null);
      expect(keys.filter(k => k.startsWith('check:'))).toHaveLength(40);
      expect(keys.filter(k => k.startsWith('predicate:'))).toHaveLength(5);
      expect(Object.keys(RECONSTRUCTED_INVITATION_DEFINITIONS).sort()).toEqual(keys.filter(k => k.includes(':invitations:')).sort());
      expect(Object.keys(RECONSTRUCTED_INVITATION_DEFINITIONS)).toHaveLength(8);
      expect(definitionLines(prefix2()).definitions).toHaveLength(45);
    });
    it('el digest con esas 45 definiciones es el observado en agenda_test', () => {
      expect(definitionsDigest(prefix2())).toBe(OBSERVED_DIGEST_2);
    });
    it('las 37 del prefijo inicial permanecen iguales: no se pisan y su digest sigue siendo el del pin inicial', () => {
      expect(Object.keys(OBSERVED_INITIAL_DEFINITIONS).filter(k => k in RECONSTRUCTED_INVITATION_DEFINITIONS)).toEqual([]);
      expect(definitionsDigest(withObservedDefinitions(deriveStructure(INITIAL)))).toBe(OBSERVED_DIGEST);
    });
    it('con ambos pins, el prefijo 2 observado queda verified; cualquier definición nueva alterada es deriva con dos digests', () => {
      expect(evaluateStructure(prefix2(), SCHEMA_MANIFEST, 2)).toMatchObject({ structure: 'verified', structureDigest: OBSERVED_DIGEST_2, code: null });
      for (const name of Object.keys(RECONSTRUCTED_INVITATION_DEFINITIONS).map(k => k.split(':')[2])) {
        const rows = prefix2(); const r = rows.find(x => x.name === name)!;
        if (r.kind === 'con') r.definition = r.definition!.replace('CHECK (', 'CHECK ( true AND'); else r.predicate = `${r.predicate!} AND true`;
        expect(evaluateStructure(rows, SCHEMA_MANIFEST, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
        expect(diffStructure(rows, SCHEMA_MANIFEST, 2).lines).toEqual([{ category: 'definitions', expected: OBSERVED_DIGEST_2, observed: definitionsDigest(rows) }]);
      }
    });
    it('sin pin, la misma estructura sigue siendo definitions_unpinned', () => {
      expect(evaluateStructure(prefix2(), combined, 2)).toMatchObject({ structure: 'definitions_unpinned', structureDigest: OBSERVED_DIGEST_2, code: null });
    });
  });
  it('cualquier alteración de una definición observada cambia el digest', () => {
    for (const mutate of [(d: string) => d.replace('~~', '~'), (d: string) => d.replace("'$argon2id$%'", () => "'$argon2id$'"), (d: string) => d.replace('>= 40', '>= 41')]) {
      const rows = observed(); const r = rows.find(x => x.name === 'CK_users_password_hash')!;
      r.definition = mutate(r.definition!);
      expect(definitionsDigest(rows)).not.toBe(OBSERVED_DIGEST);
    }
  });
});

describe('etapa también cuando el diff falla por dentro (con pin y definición ilegible)', () => {
  it('con el pin real del prefijo 2, una definición que no se puede normalizar indica la etapa definitions', () => {
    const rows = withObservedDefinitions(deriveStructure([...INITIAL, ...SECOND]));
    rows.find(r => r.name === 'CK_invitations_role')!.definition = 'CHECK (role @ 1)';
    expect(evaluateStructure(rows, SCHEMA_MANIFEST, 2)).toMatchObject({ structure: 'drift', code: 'schema_drift' });
    expect(diffStructure(rows, SCHEMA_MANIFEST, 2)).toEqual({ lines: [{ category: 'unknown', stage: 'definitions' }], omitted: 0 });
  });
});
