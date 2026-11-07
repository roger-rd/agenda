import { DataSource, Table, TableForeignKey, type EntityMetadata } from 'typeorm';
import { ADD_FOREIGN_KEYS, CREATE_INDEXES, CREATE_TABLES, DOWN_STATEMENTS, TABLE_ORDER } from '../../database/migrations/initial-schema.statements';
import { ENTITIES } from './index';

/**
 * The frozen DDL is compared with what TypeORM itself would emit for the eight entities. TypeORM's SQL builders are
 * pure string functions (they are `protected`, hence the casts): nothing here connects, queries or executes DDL.
 */
interface Builders {
  createTableSql(table: Table, createForeignKeys: boolean): { query: string };
  createIndexSql(table: Table, index: Table['indices'][number]): { query: string };
  createForeignKeySql(table: Table, foreignKey: TableForeignKey): { query: string };
  dropTableSql(table: Table): { query: string };
}
let source: DataSource;
let builders: Builders;
let metas: EntityMetadata[];
let tables: Table[];
beforeAll(async () => {
  source = new DataSource({ type: 'postgres', schema: 'public', entities: [...ENTITIES] });
  await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  builders = source.driver.createQueryRunner('master') as unknown as Builders;
  metas = TABLE_ORDER.map(name => source.entityMetadatas.find(m => m.tableName === name)!);
  tables = metas.map(m => Table.create(m, source.driver));
});

function splitTop(body: string): string[] {
  const out: string[] = []; let depth = 0, quote = false, ident = false, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === "'") { if (body[i + 1] === "'") i++; else quote = false; } continue; }
    if (ident) { if (c === '"') ident = false; continue; }
    if (c === "'") quote = true; else if (c === '"') ident = true; else if (c === '(') depth++; else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(body.slice(start, i).trim()); start = i + 1; }
  }
  out.push(body.slice(start).trim());
  return out;
}
/** Whitespace and spacing around punctuation are not significant; string literals are compared byte for byte. */
const canon = (sql: string) => sql.split(/('(?:[^']|'')*')/).map((part, i) => (i % 2 ? part : part.replace(/\s+/g, ' ').replace(/ ?([(),]) ?/g, '$1'))).join('').trim();
const clauses = (createTable: string) => {
  const m = /^CREATE TABLE ("public"\."[a-z_]+") \(([\s\S]*)\)\s*$/.exec(createTable.trim());
  if (!m) throw new Error(`CREATE TABLE inesperado: ${createTable.slice(0, 60)}`);
  const all = splitTop(m[2].trim()).map(canon);
  return { table: m[1], columns: all.filter(c => !c.startsWith('CONSTRAINT')), constraints: all.filter(c => c.startsWith('CONSTRAINT')).sort() };
};
const expectedTables = () => tables.map(t => builders.createTableSql(t, false).query);
const expectedIndexes = () => tables.flatMap(t => t.indices.map(i => builders.createIndexSql(t, i).query));
const expectedForeignKeys = () => tables.flatMap((t, n) => metas[n].foreignKeys.map(f => builders.createForeignKeySql(t, TableForeignKey.create(f, source.driver)).query));

describe('correspondencia del DDL congelado con las ocho entidades', () => {
  it('se genera sin abrir ninguna conexión', () => {
    expect(source.isInitialized).toBe(false);
    expect(metas).toHaveLength(8);
    expect(metas.map(m => m.tableName)).toEqual([...TABLE_ORDER]);
    expect(source.entityMetadatas).toHaveLength(8);
  });
  it('las tablas coinciden: mismas columnas en el mismo orden y mismas restricciones (UNIQUE, CHECK, PK)', () => {
    const frozen = CREATE_TABLES.map(clauses), generated = expectedTables().map(clauses);
    expect(frozen.map(t => t.table)).toEqual(generated.map(t => t.table));
    frozen.forEach((t, i) => {
      expect([t.table, t.columns]).toEqual([t.table, generated[i].columns]);
      expect([t.table, t.constraints]).toEqual([t.table, generated[i].constraints]);
    });
  });
  it('totales: 8 tablas, 9 UNIQUE, 33 CHECK, 8 claves primarias', () => {
    const all = CREATE_TABLES.flatMap(s => clauses(s).constraints);
    expect([CREATE_TABLES.length, all.filter(c => c.includes(' UNIQUE(')).length, all.filter(c => c.includes(' CHECK(')).length, all.filter(c => c.includes(' PRIMARY KEY(')).length])
      .toEqual([8, 9, 33, 8]);
  });
  it('los nueve índices coinciden, parciales incluidos', () => {
    expect(CREATE_INDEXES.map(canon).sort()).toEqual(expectedIndexes().map(canon).sort());
    expect(CREATE_INDEXES).toHaveLength(9);
  });
  it('las catorce claves foráneas coinciden, con sus acciones de borrado y actualización', () => {
    expect(ADD_FOREIGN_KEYS.map(canon).sort()).toEqual(expectedForeignKeys().map(canon).sort());
    expect(ADD_FOREIGN_KEYS).toHaveLength(14);
  });
  it('la bajada coincide con las eliminaciones que generaría TypeORM, en orden inverso', () => {
    expect(DOWN_STATEMENTS.map(canon)).toEqual([...tables].reverse().map(t => canon(builders.dropTableSql(t).query)));
  });
  it('cada tabla, restricción, índice y clave de las entidades está en el DDL y viceversa', () => {
    const names = (sqls: readonly string[], re: RegExp) => sqls.flatMap(s => [...s.matchAll(re)].map(m => m[1])).sort();
    const entityConstraints = metas.flatMap(m => [...m.checks.map(c => c.name), ...m.uniques.map(u => u.name), ...m.primaryColumns.slice(0, 1).map(c => c.primaryKeyConstraintName)]).sort();
    expect(names(CREATE_TABLES, /CONSTRAINT "((?:UQ|CK|PK)_[A-Za-z0-9_]+)"/g)).toEqual(entityConstraints);
    expect(names(CREATE_INDEXES, /CREATE INDEX "([^"]+)"/g)).toEqual(metas.flatMap(m => m.indices.map(i => i.name!)).sort());
    expect(names(ADD_FOREIGN_KEYS, /ADD CONSTRAINT "([^"]+)"/g)).toEqual(metas.flatMap(m => m.foreignKeys.map(f => f.name)).sort());
  });
  it('la columna password_hash y token_hash existen como columnas normales: ocultarlas es un asunto del ORM, no del DDL', () => {
    const text = CREATE_TABLES.join('\n');
    expect(text).toContain('"password_hash" text NOT NULL');
    expect(text).toContain('"token_hash" bytea NOT NULL');
  });
});

describe('controles negativos: la comparación no es vacía', () => {
  const frozenFirst = () => clauses(CREATE_TABLES[5]);
  it('un cambio en una expresión CHECK, un límite, un tipo o un nombre se detecta', () => {
    const generated = clauses(expectedTables()[5]);
    for (const [from, to] of [['BETWEEN 1 AND 120', 'BETWEEN 1 AND 121'], ['<= 5000', '<= 5001'], ['character varying(120)', 'character varying(121)'], ['"CK_posts_title"', '"CK_posts_titulo"'],
      ["'Subido'", "'Subida'"], ['NOT NULL', 'NULL']]) {
      const mutated = clauses(CREATE_TABLES[6].replace(from, to));
      expect([from, JSON.stringify(mutated) === JSON.stringify(clauses(expectedTables()[6]))]).toEqual([from, false]);
    }
    expect(JSON.stringify(frozenFirst())).not.toBe(JSON.stringify(generated.constraints.length ? { ...generated, constraints: [] } : generated));
  });
  it('un cambio en una acción de clave foránea o en el predicado de un índice se detecta', () => {
    const fkIndex = ADD_FOREIGN_KEYS.findIndex(s => s.includes('FK_company_accesses_membership'));
    expect(canon(ADD_FOREIGN_KEYS[fkIndex].replace('ON UPDATE CASCADE', 'ON UPDATE RESTRICT'))).not.toBe(expectedForeignKeys().map(canon).find(s => s.includes('FK_company_accesses_membership')));
    expect(canon(CREATE_INDEXES[5].replace('deleted_at IS NULL', 'deleted_at IS NOT NULL'))).not.toBe(expectedIndexes().map(canon).find(s => s.includes('IX_posts_company_schedule')));
  });
  it('canon ignora solo el espaciado, no el contenido de los literales', () => {
    expect(canon('a  (  b ,c )')).toBe('a(b,c)');
    expect(canon("x !~ '  '")).toBe("x !~ '  '");
    expect(canon("x !~ '  '")).not.toBe(canon("x !~ ' '"));
  });
});
