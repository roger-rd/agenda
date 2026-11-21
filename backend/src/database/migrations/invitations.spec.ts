import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { DataSource, Table, TableForeignKey, type EntityMetadata, type QueryRunner } from 'typeorm';
import * as ts from 'typescript';
import { ENTITIES, INVITATION_ENTITIES, Invitation } from '../../persistence/entities';
import { ADD_FOREIGN_KEYS, COUNTS, CREATE_INDEXES, CREATE_TABLES, DOWN_STATEMENTS, DROP_TABLES, TABLE_ORDER, UP_STATEMENTS } from './invitations.statements';
import { UP_STATEMENTS as INITIAL_UP, COUNTS as INITIAL_COUNTS } from './initial-schema.statements';
import { PENDING_MIGRATIONS, SCHEMA_MANIFEST, digestOf, verifyManifest } from './schema-manifest';
import { Invitations1795219200000 } from './1795219200000-invitations';

/** Pure SQL builders only: never initialize, connect or execute a query. */
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
  source = new DataSource({ type: 'postgres', schema: 'public', entities: [...ENTITIES, ...INVITATION_ENTITIES], synchronize: false });
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
const EXPECTED_CONSTRAINTS = [
  "CONSTRAINT \"UQ_invitations_id_org\" UNIQUE (\"id\", \"organization_id\")",
  "CONSTRAINT \"UQ_invitations_token_hash\" UNIQUE (\"token_hash\")",
  "CONSTRAINT \"CK_invitations_acceptance_pair\" CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL))",
  "CONSTRAINT \"CK_invitations_email\" CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 120 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$')",
  "CONSTRAINT \"CK_invitations_id_v7\" CHECK (substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b'))",
  "CONSTRAINT \"CK_invitations_role\" CHECK (role IN ('worker', 'client'))",
  "CONSTRAINT \"CK_invitations_state\" CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))",
  "CONSTRAINT \"CK_invitations_times\" CHECK (expires_at > created_at AND (revoked_at IS NULL OR revoked_at >= created_at) AND (accepted_at IS NULL OR (accepted_at >= created_at AND accepted_at < expires_at)))",
  "CONSTRAINT \"CK_invitations_token_hash\" CHECK (octet_length(token_hash) = 32)",
  "CONSTRAINT \"PK_invitations\" PRIMARY KEY (\"id\")"
];
const EXPECTED_FKS = [
  "ALTER TABLE \"public\".\"invitations\" ADD CONSTRAINT \"FK_invitations_organization\" FOREIGN KEY (\"organization_id\") REFERENCES \"public\".\"organizations\" (\"id\") ON DELETE RESTRICT ON UPDATE RESTRICT",
  "ALTER TABLE \"public\".\"invitations\" ADD CONSTRAINT \"FK_invitations_created_by\" FOREIGN KEY (\"created_by_membership_id\", \"organization_id\") REFERENCES \"public\".\"organization_memberships\" (\"id\", \"organization_id\") ON DELETE RESTRICT ON UPDATE RESTRICT",
  "ALTER TABLE \"public\".\"invitations\" ADD CONSTRAINT \"FK_invitations_accepted_by\" FOREIGN KEY (\"accepted_by_user_id\") REFERENCES \"public\".\"users\" (\"id\") ON DELETE RESTRICT ON UPDATE RESTRICT",
  "ALTER TABLE \"public\".\"invitation_companies\" ADD CONSTRAINT \"FK_invitation_companies_invitation\" FOREIGN KEY (\"invitation_id\", \"organization_id\") REFERENCES \"public\".\"invitations\" (\"id\", \"organization_id\") ON DELETE CASCADE ON UPDATE RESTRICT",
  "ALTER TABLE \"public\".\"invitation_companies\" ADD CONSTRAINT \"FK_invitation_companies_company\" FOREIGN KEY (\"company_id\", \"organization_id\") REFERENCES \"public\".\"companies\" (\"id\", \"organization_id\") ON DELETE RESTRICT ON UPDATE RESTRICT"
];
const EXPECTED_INDEXES = [
  "CREATE INDEX \"IX_invitations_org_created\" ON \"public\".\"invitations\" (\"organization_id\", \"created_at\", \"id\")",
  "CREATE UNIQUE INDEX \"UQ_invitations_open_email\" ON \"public\".\"invitations\" (\"organization_id\", \"email\") WHERE accepted_at IS NULL AND revoked_at IS NULL",
  "CREATE INDEX \"IX_invitation_companies_company\" ON \"public\".\"invitation_companies\" (\"company_id\")"
];

/** One method for both frozen catalogues; count structural clauses, never commas inside expressions. */
function measure(statements: readonly string[]) {
  const definitions = statements.filter(s => s.startsWith('CREATE TABLE')).map(clauses);
  const constraints = definitions.flatMap(t => t.constraints);
  const primaryKeys = constraints.filter(c => c.includes(' PRIMARY KEY(')).length;
  const uniques = constraints.filter(c => c.includes(' UNIQUE(')).length;
  const checks = constraints.filter(c => c.includes(' CHECK(')).length;
  const foreignKeys = statements.filter(s => s.startsWith('ALTER TABLE')).length;
  const indexes = statements.filter(s => /^CREATE (?:UNIQUE )?INDEX /.test(s)).length;
  return { counts: { tables: definitions.length, indexes, foreignKeys, uniques, checks, primaryKeys },
    footprint: { columns: definitions.reduce((n, t) => n + t.columns.length, 0),
      constraints: primaryKeys + uniques + checks + foreignKeys, indexes: primaryKeys + uniques + indexes } };
}
// pendiente de aplicar; test/pg conserva 68/64/26 hasta que la migración se aplique y se verifique contra agenda_test
const PENDING_FOOTPRINT = Object.freeze({ columns: 82, constraints: 80, indexes: 33 });

describe('invitaciones pendientes: catálogo y metadatos offline', () => {
  it('coincide con TypeORM sin conexión, incluidas acciones, índice parcial y bajada', () => {
    expect(source.isInitialized).toBe(false);
    expect(CREATE_TABLES.map(clauses)).toEqual(tables.map(t => clauses(builders.createTableSql(t, false).query)));
    expect(CREATE_INDEXES.map(canon).sort()).toEqual(tables.flatMap(t => t.indices.map(i => canon(builders.createIndexSql(t, i).query))).sort());
    expect(ADD_FOREIGN_KEYS.map(canon).sort()).toEqual(tables.flatMap((t, i) => metas[i].foreignKeys.map(f =>
      canon(builders.createForeignKeySql(t, TableForeignKey.create(f, source.driver)).query))).sort());
    expect(DOWN_STATEMENTS.map(canon)).toEqual([...tables].reverse().map(t => canon(builders.dropTableSql(t).query)));
  });
  it('fija literalmente cada restricción e índice y las fases del catálogo', () => {
    expect(clauses(CREATE_TABLES[0]).constraints).toEqual(EXPECTED_CONSTRAINTS.map(canon).sort());
    expect(clauses(CREATE_TABLES[1]).constraints).toEqual([canon('CONSTRAINT "PK_invitation_companies" PRIMARY KEY ("invitation_id", "company_id")')]);
    expect(ADD_FOREIGN_KEYS).toEqual(EXPECTED_FKS);
    expect(CREATE_INDEXES).toEqual(EXPECTED_INDEXES);
    expect(UP_STATEMENTS).toEqual([...CREATE_TABLES, ...ADD_FOREIGN_KEYS, ...CREATE_INDEXES]);
    expect(TABLE_ORDER).toEqual(['invitations', 'invitation_companies']);
    expect(DOWN_STATEMENTS).toEqual(['DROP TABLE "public"."invitation_companies"', 'DROP TABLE "public"."invitations"']);
    expect(DOWN_STATEMENTS).toBe(DROP_TABLES);
    for (const value of [CREATE_TABLES, ADD_FOREIGN_KEYS, CREATE_INDEXES, UP_STATEMENTS, DOWN_STATEMENTS, TABLE_ORDER, COUNTS]) expect(Object.isFrozen(value)).toBe(true);
    expect(metas[0].checks.find(c => c.name === 'CK_invitations_email')!.expression)
      .toBe(source.getMetadata('users').checks.find(c => c.name === 'CK_users_email')!.expression);
  });
  it('las tres FK de aislamiento incluyen dos columnas y destinos únicos de la organización', () => {
    const composite = metas.flatMap(m => m.foreignKeys).filter(f => ['FK_invitations_created_by', 'FK_invitation_companies_invitation', 'FK_invitation_companies_company'].includes(f.name));
    expect(composite).toHaveLength(3);
    for (const f of composite) {
      expect(f.columns).toHaveLength(2);
      expect(f.columns[1].databaseName).toBe('organization_id');
      expect(f.referencedColumns.map(c => c.databaseName)).toEqual(['id', 'organization_id']);
      expect(f.referencedEntityMetadata.uniques.some(u => u.columns.map(c => c.databaseName).join(',') === 'id,organization_id')).toBe(true);
    }
  });
  it('deriva los conteos por entidad y por statements de forma independiente', () => {
    const expected = [[11, 1, 2, 7, 3, 2], [3, 1, 0, 0, 2, 1]];
    metas.forEach((m, i) => {
      expect([m.columns.length, new Set(m.primaryColumns.map(c => c.primaryKeyConstraintName)).size, m.uniques.length, m.checks.length, m.foreignKeys.length, m.indices.length]).toEqual(expected[i]);
      const subset = UP_STATEMENTS.filter(s => new RegExp('^(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX "[^"]+" ON) "public"\\."' + m.tableName + '"').test(s));
      const { counts: c, footprint: f } = measure(subset);
      expect([f.columns, c.primaryKeys, c.uniques, c.checks, c.foreignKeys, c.indexes]).toEqual(expected[i]);
    });
    expect(measure(UP_STATEMENTS).counts).toEqual(COUNTS);
    expect(COUNTS).toEqual({ tables: 2, indexes: 3, foreignKeys: 5, uniques: 2, checks: 7, primaryKeys: 2 });
    const combined = measure([...INITIAL_UP, ...UP_STATEMENTS]);
    expect(combined.counts).toEqual({ tables: 10, indexes: 12, foreignKeys: 19, uniques: 11, checks: 40, primaryKeys: 10 });
    const all = source.entityMetadatas;
    expect({ tables: all.length, indexes: all.reduce((n, m) => n + m.indices.length, 0),
      foreignKeys: all.reduce((n, m) => n + m.foreignKeys.length, 0), uniques: all.reduce((n, m) => n + m.uniques.length, 0),
      checks: all.reduce((n, m) => n + m.checks.length, 0), primaryKeys: all.filter(m => m.primaryColumns.length > 0).length }).toEqual(combined.counts);
    for (const key of Object.keys(COUNTS) as (keyof typeof COUNTS)[]) expect(combined.counts[key]).toBe(INITIAL_COUNTS[key] + COUNTS[key]);
    expect(measure(INITIAL_UP).footprint).toEqual({ columns: 68, constraints: 64, indexes: 26 });
    expect(measure(UP_STATEMENTS).footprint).toEqual({ columns: 14, constraints: 16, indexes: 7 });
    expect(combined.footprint).toEqual(PENDING_FOOTPRINT);
  });
  it('mantiene el manifiesto inicial intacto y fija la huella pendiente', () => {
    expect(SCHEMA_MANIFEST).toHaveLength(1);
    expect(SCHEMA_MANIFEST[0].sha256).toBe('33d0baa69ac1943dd6908af3382456fcecf3048ccd0ba282a466a32aa958f0ab');
    expect(PENDING_MIGRATIONS).toHaveLength(1);
    expect(Object.isFrozen(PENDING_MIGRATIONS)).toBe(true);
    expect(Object.isFrozen(PENDING_MIGRATIONS[0])).toBe(true);
    expect(PENDING_MIGRATIONS[0]).toMatchObject({ name: 'Invitations1795219200000', timestamp: 1795219200000,
      sha256: 'e2c0f8061c469fcd8ae73b7145d321c0f4c1d0fb46e7d1c12d34bbd47a48f11f', immutable: true, downScope: 'development-and-test-only', counts: COUNTS });
    expect(PENDING_MIGRATIONS[0].timestamp).toBeGreaterThan(SCHEMA_MANIFEST[0].timestamp);
    expect(digestOf(UP_STATEMENTS, DOWN_STATEMENTS)).toBe(PENDING_MIGRATIONS[0].sha256);
    expect(verifyManifest([...SCHEMA_MANIFEST, ...PENDING_MIGRATIONS])).toEqual([]);
  });
  it('oculta el hash en selección, serialización e inspección y conserva ocho entidades iniciales', () => {
    expect(metas[0].columns.find(c => c.databaseName === 'token_hash')!.isSelect).toBe(false);
    const hash = Buffer.from('secreto-invitacion-solo-prueba');
    const invitation = Object.assign(new Invitation(), { id: 'i1', tokenHash: hash });
    for (const text of [JSON.stringify(invitation), JSON.stringify({ nested: [invitation] }), inspect(invitation), inspect({ nested: invitation }, { depth: 10, showHidden: true })]) {
      expect(text).not.toMatch(/tokenHash|token_hash/);
      for (const encoding of ['utf8', 'hex', 'base64'] as const) expect(text).not.toContain(hash.toString(encoding));
    }
    expect(inspect(invitation)).toBe('Invitation(i1)');
    expect(ENTITIES).toHaveLength(8);
    expect(INVITATION_ENTITIES).toHaveLength(2);
    expect(Object.isFrozen(INVITATION_ENTITIES)).toBe(true);
    for (const entity of INVITATION_ENTITIES) expect(ENTITIES).not.toContain(entity);
    for (const m of metas) {
      expect(m.relations).toEqual([]);
      expect(m.columns.some(c => ['version', 'updated_at'].includes(c.databaseName))).toBe(false);
      for (const c of m.columns) expect([c.default, c.isGenerated, c.isCreateDate, c.isUpdateDate, c.isVersion]).toEqual([undefined, false, false, false, false]);
    }
  });
  it('ningún archivo externo importa las entidades pendientes ni su registro', () => {
    const root = path.resolve(__dirname, '../..');
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? files(full) : e.name.endsWith('.ts') ? [full] : [];
    });
    for (const file of files(root).filter(f => !/^persistence[/\\]/.test(path.relative(root, f)) && !f.startsWith(__dirname + path.sep))) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) expect(node.text).not.toMatch(/invitation[^/]*\.entity/);
        if (ts.isIdentifier(node)) expect(node.text).not.toMatch(/^(?:Invitation|InvitationCompany|INVITATION_ENTITIES)$/);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  });
});

const fakeRunner = (database: unknown, failAt?: number) => {
  const calls: string[] = []; let running = false; let overlap = false;
  const runner = { dataSource: { options: { database } }, query: async (sql: string) => {
    if (running) overlap = true;
    running = true;
    await Promise.resolve();
    calls.push(sql); running = false;
    if (calls.length === failAt) throw new Error('fallo simulado');
    return [];
  } } as unknown as QueryRunner;
  return { runner, calls, overlap: () => overlap };
};
describe('ejecución simulada de la migración pendiente', () => {
  it('no declara transacción y up solo ejecuta el catálogo en orden', async () => {
    const migration = new Invitations1795219200000();
    expect(migration.name).toBe('Invitations1795219200000');
    expect('transaction' in migration).toBe(false);
    for (const db of ['agenda_test', 'agenda_dev', 'otra', undefined]) {
      const fake = fakeRunner(db);
      await migration.up(fake.runner);
      expect(fake.calls).toEqual(UP_STATEMENTS);
      expect(fake.overlap()).toBe(false);
    }
  });
  it.each(['agenda_test', 'agenda_dev', 'x_test', 'a1_dev'])('permite down en %s', async db => {
    const fake = fakeRunner(db);
    await new Invitations1795219200000().down(fake.runner);
    expect(fake.calls).toEqual(DOWN_STATEMENTS);
    expect(fake.overlap()).toBe(false);
  });
  it.each(['agenda', 'agenda_prod', 'agenda_test_backup', 'agenda_dev2', 'AGENDA_TEST', '_test', 'test', '', 'agenda test', 'agenda_test;drop', undefined, null, 5])('rechaza down en %p antes de ejecutar', async db => {
    const fake = fakeRunner(db);
    await expect(new Invitations1795219200000().down(fake.runner)).rejects.toThrow('migration_down_forbidden');
    expect(fake.calls).toEqual([]);
  });
  it.each(['up', 'down'] as const)('propaga fallos y detiene %s', async direction => {
    const fake = fakeRunner('agenda_test', 1);
    await expect(new Invitations1795219200000()[direction](fake.runner)).rejects.toThrow('fallo simulado');
    expect(fake.calls).toEqual((direction === 'up' ? UP_STATEMENTS : DOWN_STATEMENTS).slice(0, 1));
  });
});
