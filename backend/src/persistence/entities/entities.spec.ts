import { DataSource, type EntityMetadata } from 'typeorm';
import { ENTITIES } from './index';
import { ACCESS_ROLES, LIMITS, POST_FORMATS, POST_STATUSES, ROLES } from '../constants';

/** Metadata is built without connecting: the driver object is created, but no pool, socket or query exists. */
let metadatas: EntityMetadata[];
beforeAll(async () => {
  const source = new DataSource({ type: 'postgres', entities: [...ENTITIES], synchronize: false, migrationsRun: false, dropSchema: false });
  await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  metadatas = source.entityMetadatas;
  expect(source.isInitialized).toBe(false);
});
const table = (name: string) => {
  const found = metadatas.find(m => m.tableName === name);
  if (!found) throw new Error(`tabla ausente: ${name}`);
  return found;
};
const names = (m: EntityMetadata) => m.columns.map(c => c.databaseName);

type Col = [name: string, type: string, length: number | undefined, nullable: boolean, select: boolean];
const uuid = (name: string, nullable = false): Col => [name, 'uuid', undefined, nullable, true];
const ts = (name: string, nullable = false): Col => [name, 'timestamptz', undefined, nullable, true];
const int = (name: string): Col => [name, 'integer', undefined, false, true];
const varchar = (name: string, length: number, nullable = false): Col => [name, 'varchar', length, nullable, true];
const EXPECTED: Record<string, { columns: Col[]; primary: string[] }> = {
  organizations: { primary: ['id'], columns: [uuid('id'), varchar('name', 80), varchar('name_key', 80), int('version'), ts('created_at'), ts('updated_at')] },
  users: { primary: ['id'], columns: [uuid('id'), varchar('email', 120), varchar('name', 80), ['password_hash', 'text', undefined, false, false],
    ts('password_changed_at'), int('version'), ts('created_at'), ts('updated_at')] },
  organization_memberships: { primary: ['id'], columns: [uuid('id'), uuid('organization_id'), uuid('user_id'), varchar('role', 20), ts('deactivated_at', true),
    int('version'), ts('created_at'), ts('updated_at')] },
  companies: { primary: ['id'], columns: [uuid('id'), uuid('organization_id'), varchar('name', 80), varchar('name_key', 80), varchar('color', 7), int('version'),
    ts('created_at'), ts('updated_at')] },
  company_accesses: { primary: ['membership_id', 'company_id'], columns: [uuid('membership_id'), uuid('company_id'), uuid('organization_id'),
    varchar('membership_role', 20), ts('created_at')] },
  posts: { primary: ['id'], columns: [uuid('id'), uuid('organization_id'), uuid('company_id'), varchar('title', 120), ['description', 'text', undefined, false, true],
    ts('scheduled_at'), varchar('format', 10), varchar('status', 12), uuid('responsible_user_id'), ['client_visible', 'boolean', undefined, false, true],
    varchar('instagram_url', 2048, true), uuid('confirmed_by_user_id', true), ts('confirmed_at', true), uuid('created_by_user_id'), ts('deleted_at', true),
    uuid('deleted_by_user_id', true), int('version'), ts('created_at'), ts('updated_at')] },
  post_comments: { primary: ['id'], columns: [uuid('id'), uuid('organization_id'), uuid('post_id'), uuid('author_user_id'), ['body', 'text', undefined, false, true], ts('created_at')] },
  user_sessions: { primary: ['id'], columns: [uuid('id'), ['token_hash', 'bytea', undefined, false, false], uuid('user_id'), uuid('active_organization_id', true),
    ts('created_at'), ts('last_seen_at'), ts('expires_at'), ts('revoked_at', true)] },
};

describe('registro de entidades', () => {
  it('son exactamente las ocho tablas del MVP, congeladas y en inglés snake_case', () => {
    expect(Object.isFrozen(ENTITIES)).toBe(true);
    expect(ENTITIES).toHaveLength(8);
    expect(metadatas.map(m => m.tableName).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const m of metadatas) {
      expect(m.tableName).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const c of m.columns) expect(c.databaseName).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
  it('no declaran relaciones de objeto: las referencias son claves foráneas compuestas explícitas', () => {
    for (const m of metadatas) expect(m.relations).toEqual([]);
  });
  it('no definen valores por defecto, generación, fechas automáticas ni columnas de versión de TypeORM', () => {
    for (const m of metadatas) for (const c of m.columns) {
      expect([m.tableName, c.databaseName, c.default, c.isGenerated, c.isCreateDate, c.isUpdateDate, c.isVersion])
        .toEqual([m.tableName, c.databaseName, undefined, false, false, false, false]);
    }
  });
  it('los nombres de PK, índices y únicas son únicos en el esquema y caben en un identificador de PostgreSQL', () => {
    const relationNames = metadatas.flatMap(m => [m.primaryColumns[0].primaryKeyConstraintName, ...m.indices.map(i => i.name), ...m.uniques.map(u => u.name)]);
    expect(relationNames.every(n => typeof n === 'string')).toBe(true);
    expect(new Set(relationNames).size).toBe(relationNames.length);
    const all = [...relationNames, ...metadatas.flatMap(m => [...m.foreignKeys.map(f => f.name), ...m.checks.map(c => c.name)])] as string[];
    expect(all.every(n => n.length <= 63)).toBe(true);
    expect(new Set(metadatas.flatMap(m => [...m.foreignKeys.map(f => f.name), ...m.checks.map(c => `${m.tableName}.${c.name}`)])).size)
      .toBe(metadatas.reduce((n, m) => n + m.foreignKeys.length + m.checks.length, 0));
  });
});

describe.each(Object.entries(EXPECTED))('columnas de %s', (name, expected) => {
  it('tipos, longitudes, nulabilidad y selección exactos', () => {
    const m = table(name);
    expect(names(m)).toEqual(expected.columns.map(c => c[0]));
    for (const [column, type, length, nullable, select] of expected.columns) {
      const c = m.columns.find(x => x.databaseName === column)!;
      expect([column, c.type, c.length === '' ? undefined : Number(c.length), c.isNullable, c.isSelect])
        .toEqual([column, type, length, nullable, select]);
    }
  });
  it('clave primaria', () => {
    const m = table(name);
    expect(m.primaryColumns.map(c => c.databaseName)).toEqual(expected.primary);
    expect(new Set(m.primaryColumns.map(c => c.primaryKeyConstraintName)).size).toBe(1);
    expect(m.primaryColumns[0].primaryKeyConstraintName).toBe(`PK_${name}`);
  });
});

describe('unicidades e índices', () => {
  // Los decoradores de clase se aplican de abajo hacia arriba: el orden de registro no es significativo.
  const uniques = (m: EntityMetadata) => m.uniques.map(u => [u.name, u.columns.map(c => c.databaseName)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  it('unicidades declaradas, incluidas las que sirven de destino de claves compuestas', () => {
    expect(uniques(table('organizations'))).toEqual([['UQ_organizations_name_key', ['name_key']]]);
    expect(uniques(table('users'))).toEqual([['UQ_users_email', ['email']]]);
    expect(uniques(table('organization_memberships'))).toEqual([['UQ_organization_memberships_id_org', ['id', 'organization_id']],
      ['UQ_organization_memberships_id_org_role', ['id', 'organization_id', 'role']], ['UQ_organization_memberships_org_user', ['organization_id', 'user_id']]]);
    expect(uniques(table('companies'))).toEqual([['UQ_companies_id_org', ['id', 'organization_id']], ['UQ_companies_org_name_key', ['organization_id', 'name_key']]]);
    expect(uniques(table('posts'))).toEqual([['UQ_posts_id_org', ['id', 'organization_id']]]);
    expect(uniques(table('user_sessions'))).toEqual([['UQ_user_sessions_token_hash', ['token_hash']]]);
    expect(uniques(table('company_accesses'))).toEqual([]);
    expect(uniques(table('post_comments'))).toEqual([]);
  });
  it('índices no únicos, con los parciales que excluyen publicaciones borradas', () => {
    const indices = metadatas.flatMap(m => m.indices.map(i => [m.tableName, i.name, i.columns.map(c => c.databaseName), i.isUnique, i.where ?? null]));
    expect(indices).toEqual(expect.arrayContaining([
      ['organization_memberships', 'IX_organization_memberships_user', ['user_id'], false, null],
      ['organization_memberships', 'IX_organization_memberships_active_managers', ['organization_id'], false, "role = 'community_manager' AND deactivated_at IS NULL"],
      ['company_accesses', 'IX_company_accesses_company', ['company_id'], false, null],
      ['posts', 'IX_posts_company_schedule', ['company_id', 'scheduled_at'], false, 'deleted_at IS NULL'],
      ['posts', 'IX_posts_org_schedule', ['organization_id', 'scheduled_at'], false, 'deleted_at IS NULL'],
      ['posts', 'IX_posts_responsible', ['organization_id', 'responsible_user_id'], false, 'deleted_at IS NULL'],
      ['post_comments', 'IX_post_comments_post_created', ['post_id', 'created_at', 'id'], false, null],
      ['user_sessions', 'IX_user_sessions_user', ['user_id'], false, null],
      ['user_sessions', 'IX_user_sessions_expires', ['expires_at'], false, null],
    ]));
    expect(indices).toHaveLength(9);
  });
});

describe('claves foráneas y aislamiento por organización', () => {
  const FKS: [string, string, string[], string, string[], string, string][] = [
    ['FK_organization_memberships_organization', 'organization_memberships', ['organization_id'], 'organizations', ['id'], 'RESTRICT', 'RESTRICT'],
    ['FK_organization_memberships_user', 'organization_memberships', ['user_id'], 'users', ['id'], 'RESTRICT', 'RESTRICT'],
    ['FK_companies_organization', 'companies', ['organization_id'], 'organizations', ['id'], 'RESTRICT', 'RESTRICT'],
    ['FK_company_accesses_membership', 'company_accesses', ['membership_id', 'organization_id', 'membership_role'], 'organization_memberships', ['id', 'organization_id', 'role'], 'CASCADE', 'CASCADE'],
    ['FK_company_accesses_company', 'company_accesses', ['company_id', 'organization_id'], 'companies', ['id', 'organization_id'], 'CASCADE', 'RESTRICT'],
    ['FK_posts_company', 'posts', ['company_id', 'organization_id'], 'companies', ['id', 'organization_id'], 'RESTRICT', 'RESTRICT'],
    ['FK_posts_responsible', 'posts', ['organization_id', 'responsible_user_id'], 'organization_memberships', ['organization_id', 'user_id'], 'RESTRICT', 'RESTRICT'],
    ['FK_posts_created_by', 'posts', ['organization_id', 'created_by_user_id'], 'organization_memberships', ['organization_id', 'user_id'], 'RESTRICT', 'RESTRICT'],
    ['FK_posts_confirmed_by', 'posts', ['organization_id', 'confirmed_by_user_id'], 'organization_memberships', ['organization_id', 'user_id'], 'RESTRICT', 'RESTRICT'],
    ['FK_posts_deleted_by', 'posts', ['organization_id', 'deleted_by_user_id'], 'organization_memberships', ['organization_id', 'user_id'], 'RESTRICT', 'RESTRICT'],
    ['FK_post_comments_post', 'post_comments', ['post_id', 'organization_id'], 'posts', ['id', 'organization_id'], 'RESTRICT', 'RESTRICT'],
    ['FK_post_comments_author', 'post_comments', ['organization_id', 'author_user_id'], 'organization_memberships', ['organization_id', 'user_id'], 'RESTRICT', 'RESTRICT'],
    ['FK_user_sessions_user', 'user_sessions', ['user_id'], 'users', ['id'], 'CASCADE', 'RESTRICT'],
    ['FK_user_sessions_membership', 'user_sessions', ['active_organization_id', 'user_id'], 'organization_memberships', ['organization_id', 'user_id'], 'RESTRICT', 'RESTRICT'],
  ];
  const all = () => metadatas.flatMap(m => m.foreignKeys.map(f => ({ m, f })));
  it('son exactamente las declaradas, con sus acciones de borrado y actualización', () => {
    const actual = all().map(({ m, f }) => [f.name, m.tableName, f.columns.map(c => c.databaseName), f.referencedEntityMetadata.tableName,
      f.referencedColumns.map(c => c.databaseName), f.onDelete, f.onUpdate]);
    expect(actual).toHaveLength(FKS.length);
    expect(actual).toEqual(expect.arrayContaining(FKS));
  });
  it('toda referencia entre tablas con organización incluye organization_id en ambos lados', () => {
    const tenant = (m: EntityMetadata) => names(m).includes('organization_id');
    for (const { m, f } of all()) {
      if (!tenant(m) || !tenant(f.referencedEntityMetadata)) continue;
      expect([f.name, f.columns.map(c => c.databaseName).includes('organization_id')]).toEqual([f.name, true]);
      expect([f.name, f.referencedColumns.map(c => c.databaseName).includes('organization_id')]).toEqual([f.name, true]);
    }
    // Las únicas referencias fuera de las tablas con organización son hacia organizations y users.
    for (const { m, f } of all()) {
      if (!tenant(f.referencedEntityMetadata)) expect(['organizations', 'users', 'organization_memberships', 'companies', 'user_sessions']).toContain(m.tableName);
    }
  });
  it('cada destino es una clave primaria o una unicidad exacta (requisito de PostgreSQL)', () => {
    for (const { f } of all()) {
      const target = f.referencedEntityMetadata;
      const wanted = f.referencedColumns.map(c => c.databaseName).sort().join(',');
      const sets = [target.primaryColumns.map(c => c.databaseName), ...target.uniques.map(u => u.columns.map(c => c.databaseName))].map(s => [...s].sort().join(','));
      expect([f.name, sets.includes(wanted)]).toEqual([f.name, true]);
    }
  });
  it('las referencias opcionales combinan una columna obligatoria con una anulable (MATCH SIMPLE las omite si es NULL)', () => {
    const optional = ['FK_posts_confirmed_by', 'FK_posts_deleted_by', 'FK_user_sessions_membership'];
    for (const { f } of all()) {
      const nullable = f.columns.filter(c => c.isNullable).map(c => c.databaseName);
      const required = f.columns.filter(c => !c.isNullable).map(c => c.databaseName);
      if (optional.includes(f.name)) { expect(nullable).toHaveLength(1); expect(required.length).toBeGreaterThanOrEqual(1); }
      else expect([f.name, nullable]).toEqual([f.name, []]);
    }
    expect(all().filter(({ f }) => f.columns.some(c => c.isNullable)).map(({ f }) => f.name).sort()).toEqual([...optional].sort());
  });
  it('el responsable y los autores son miembros de la organización, no solo usuarios', () => {
    const posts = table('posts').foreignKeys.filter(f => f.name !== 'FK_posts_company');
    expect(posts).toHaveLength(4);
    for (const f of posts) expect(f.referencedEntityMetadata.tableName).toBe('organization_memberships');
  });
  it('CASCADE solo en filas de enlace y sesiones: nunca desde publicaciones hacia comentarios', () => {
    expect(all().filter(({ f }) => f.onDelete === 'CASCADE').map(({ f }) => f.name).sort())
      .toEqual(['FK_company_accesses_company', 'FK_company_accesses_membership', 'FK_user_sessions_user']);
    expect(table('post_comments').foreignKeys.find(f => f.name === 'FK_post_comments_post')!.onDelete).toBe('RESTRICT');
  });
});

describe('restricciones CHECK', () => {
  const CHECKS: Record<string, string[]> = {
    organizations: ['CK_organizations_id_v7', 'CK_organizations_name', 'CK_organizations_name_key', 'CK_organizations_version'],
    users: ['CK_users_id_v7', 'CK_users_email', 'CK_users_name', 'CK_users_password_hash', 'CK_users_version'],
    organization_memberships: ['CK_organization_memberships_id_v7', 'CK_organization_memberships_role', 'CK_organization_memberships_deactivated', 'CK_organization_memberships_version'],
    companies: ['CK_companies_id_v7', 'CK_companies_name', 'CK_companies_name_key', 'CK_companies_color', 'CK_companies_version'],
    company_accesses: ['CK_company_accesses_role'],
    posts: ['CK_posts_id_v7', 'CK_posts_title', 'CK_posts_description', 'CK_posts_format', 'CK_posts_status', 'CK_posts_instagram_url', 'CK_posts_confirmation',
      'CK_posts_soft_delete', 'CK_posts_version'],
    post_comments: ['CK_post_comments_id_v7', 'CK_post_comments_body'],
    user_sessions: ['CK_user_sessions_id_v7', 'CK_user_sessions_token_hash', 'CK_user_sessions_times'],
  };
  const expression = (t: string, name: string) => table(t).checks.find(c => c.name === name)!.expression!;
  it('cada tabla tiene exactamente los CHECK previstos', () => {
    for (const [t, expected] of Object.entries(CHECKS)) expect([t, table(t).checks.map(c => c.name).sort()]).toEqual([t, [...expected].sort()]);
  });
  it('solo mencionan columnas de su tabla y funciones de PostgreSQL 16 conocidas', () => {
    const words = new Set(['and', 'or', 'not', 'in', 'is', 'null', 'like', 'between', 'btrim', 'lower', 'char_length', 'octet_length', 'substr', 'text']);
    for (const m of metadatas) for (const c of m.checks) {
      const stripped = c.expression!.replace(/'(?:[^']|'')*'/g, "''");
      expect([c.name, /;|--|\/\*|\*\//.test(stripped)]).toEqual([c.name, false]);
      expect([c.name, (stripped.match(/\(/g) ?? []).length]).toEqual([c.name, (stripped.match(/\)/g) ?? []).length]);
      const identifiers = (stripped.match(/\b[a-z][a-z0-9_]*\b/g) ?? []).filter(w => !words.has(w));
      for (const id of identifiers) expect([c.name, names(m).includes(id)]).toEqual([c.name, true]);
    }
  });
  it('vocabularios cerrados idénticos a los del frontend', () => {
    for (const [t, name, values] of [['organization_memberships', 'CK_organization_memberships_role', ROLES], ['posts', 'CK_posts_format', POST_FORMATS],
      ['posts', 'CK_posts_status', POST_STATUSES], ['company_accesses', 'CK_company_accesses_role', ACCESS_ROLES]] as const) {
      const listed = [...expression(t, name).matchAll(/'([^']+)'/g)].map(m => m[1]);
      expect([name, listed]).toEqual([name, [...values]]);
    }
    expect(ACCESS_ROLES).not.toContain('community_manager');
  });
  it('confirmación: ambos campos presentes exactamente cuando el estado es Subido', () => {
    const e = expression('posts', 'CK_posts_confirmation');
    expect(e).toContain("(status = 'Subido') = (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)");
    expect(e).toContain('(confirmed_by_user_id IS NULL) = (confirmed_at IS NULL)');
  });
  it('borrado lógico: deleted_at y deleted_by_user_id van juntos', () => {
    expect(expression('posts', 'CK_posts_soft_delete')).toBe('(deleted_at IS NULL) = (deleted_by_user_id IS NULL)');
    const deleted = table('posts').columns.find(c => c.databaseName === 'deleted_at')!;
    expect([deleted.isDeleteDate, deleted.isNullable]).toEqual([true, true]);
    expect(names(table('post_comments'))).not.toContain('deleted_at');
  });
  it('límites de texto: 5000 de descripción, 2000 de comentario, 120 de título, 80 de nombres', () => {
    expect(LIMITS.description).toBe(5000);
    expect(expression('posts', 'CK_posts_description')).toBe('char_length(description) <= 5000');
    expect(expression('post_comments', 'CK_post_comments_body')).toContain('BETWEEN 1 AND 2000');
    expect(expression('posts', 'CK_posts_title')).toContain('BETWEEN 1 AND 120');
    expect(expression('posts', 'CK_posts_title')).toContain('title = btrim(title)');
    expect(expression('post_comments', 'CK_post_comments_body')).toContain('body = btrim(body)');
    for (const [t, n] of [['organizations', 'CK_organizations_name'], ['companies', 'CK_companies_name'], ['users', 'CK_users_name']]) expect(expression(t, n)).toContain('BETWEEN 2 AND 80');
  });
  it('formas: UUIDv7, color, correo canónico, Argon2id, hash de token de 32 bytes y URL http(s)', () => {
    expect(expression('posts', 'CK_posts_id_v7')).toContain("substr(id::text, 15, 1) = '7'");
    expect(expression('companies', 'CK_companies_color')).toBe("color ~ '^#[0-9a-f]{6}$'");
    expect(expression('users', 'CK_users_email')).toContain('email = lower(btrim(email))');
    expect(expression('users', 'CK_users_password_hash')).toContain("LIKE '$argon2id$%'");
    expect(expression('user_sessions', 'CK_user_sessions_token_hash')).toBe('octet_length(token_hash) = 32');
    expect(expression('posts', 'CK_posts_instagram_url')).toContain("'^https?://[^[:space:]]+$'");
  });
  it('un acceso a empresa solo puede colgar de un trabajador o un cliente', () => {
    expect(expression('company_accesses', 'CK_company_accesses_role')).toBe("membership_role IN ('worker', 'client')");
  });
});
