import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { DataSource, type EntityMetadata } from 'typeorm';
import * as ts from 'typescript';
import { Organization } from './organization.entity';
import { OrganizationMembership } from './organization-membership.entity';
import { ENTITIES, User, UserSession } from './index';
import { SERVICE_ENFORCED, SQL_ENFORCED } from '../invariants';
import { POST_FORMATS, POST_STATUSES, ROLES } from '../constants';

const backendSrc = path.resolve(__dirname, '../..');
const frontendRoot = path.resolve(__dirname, '../../../../');
const read = (file: string) => fs.readFileSync(file, 'utf8');
let metadatas: EntityMetadata[];
beforeAll(async () => {
  const source = new DataSource({ type: 'postgres', entities: [...ENTITIES], synchronize: false });
  await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  metadatas = source.entityMetadatas;
});

describe('invariantes documentadas frente a las reglas de servicio', () => {
  it('cada restricción citada por una regla SQL existe de verdad', () => {
    const existing = new Set(metadatas.flatMap(m => [...m.checks.map(c => c.name), ...m.uniques.map(u => u.name), ...m.foreignKeys.map(f => f.name)]));
    expect(new Set(SQL_ENFORCED.map(r => r.id)).size).toBe(SQL_ENFORCED.length);
    for (const rule of SQL_ENFORCED) {
      expect([rule.id, rule.constraints.length > 0]).toEqual([rule.id, true]);
      for (const name of rule.constraints) expect([rule.id, name, existing.has(name!)]).toEqual([rule.id, name, true]);
    }
  });
  it('ninguna regla de servicio se presenta como restricción SQL, y viceversa', () => {
    const sql = new Set(SQL_ENFORCED.map(r => r.id));
    for (const rule of SERVICE_ENFORCED) expect(sql.has(rule.id)).toBe(false);
    expect(new Set(SERVICE_ENFORCED.map(r => r.id)).size).toBe(SERVICE_ENFORCED.length);
    expect(Object.isFrozen(SQL_ENFORCED) && Object.isFrozen(SERVICE_ENFORCED)).toBe(true);
  });
  it('mantener al menos un community manager activo se declara como regla de servicio con transacción, no como restricción', () => {
    const rule = SERVICE_ENFORCED.find(r => r.id === 'keep_one_active_community_manager');
    expect(rule?.description).toMatch(/at least one active community manager/);
    expect(rule?.description).toMatch(/transaction/);
    expect(rule?.description).toMatch(/cannot guarantee/);
    const entity = read(path.join(__dirname, 'organization-membership.entity.ts'));
    expect(entity).toMatch(/NOT guaranteed by this entity/);
    expect(entity).toMatch(/transaction/);
    expect(JSON.stringify(SQL_ENFORCED)).not.toMatch(/community_manager.*(active|last)/i);
  });
  it('el responsable sin acceso conserva la publicación: el esquema solo exige pertenencia a la organización', () => {
    expect(SERVICE_ENFORCED.map(r => r.id)).toEqual(expect.arrayContaining(['responsible_authorization_at_write', 'unauthorized_responsible_cannot_operate']));
    const posts = metadatas.find(m => m.tableName === 'posts')!;
    const responsible = posts.foreignKeys.find(f => f.name === 'FK_posts_responsible')!;
    expect(responsible.referencedEntityMetadata.tableName).toBe('organization_memberships');
    expect(metadatas.find(m => m.tableName === 'company_accesses')!.foreignKeys.some(f => f.referencedEntityMetadata.tableName === 'posts')).toBe(false);
  });
});

describe('activación controlada de las entidades de identidad', () => {
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
  it('solo los archivos autorizados importan las entidades de identidad desde persistence', () => {
    const allowedFiles = [
      'auth/auth.module.ts',
      'auth/session.service.ts',
      'auth/session.service.spec.ts',
      'auth/authentication.service.ts',
      'auth/authentication.service.spec.ts',
      'registration/registration.module.ts',
      'registration/registration.service.ts',
      'registration/registration.service.spec.ts',
      'app.module.spec.ts',
    ];
    const allowedEntities: Record<string, string> = {
      'persistence/entities/user-session.entity': 'UserSession',
      'persistence/entities/user.entity': 'User',
      'persistence/entities/organization.entity': 'Organization',
      'persistence/entities/organization-membership.entity': 'OrganizationMembership',
    };
    const outside = sources(backendSrc).filter(file => !file.startsWith(path.join(backendSrc, 'persistence') + path.sep));
    expect(outside.length).toBeGreaterThan(10);
    const actualFiles = new Set<string>();
    for (const file of outside) {
      const relativeFile = path.relative(backendSrc, file).split(path.sep).join('/');
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        // Incluye imports estáticos, reexports, require e import dinámico; solo
        // se autorizan imports nombrados estáticos de los archivos exactos.
        if (ts.isStringLiteralLike(node) && /(^|\/)persistence(\/|$)/.test(node.text)) {
          actualFiles.add(relativeFile);
          expect(allowedFiles).toContain(relativeFile);
          const target = path.relative(backendSrc, path.resolve(path.dirname(file), node.text)).split(path.sep).join('/');
          expect(Object.keys(allowedEntities)).toContain(target);
          const declaration = node.parent;
          expect(ts.isImportDeclaration(declaration)).toBe(true);
          if (!ts.isImportDeclaration(declaration)) return;
          expect(declaration.moduleSpecifier).toBe(node);
          expect(declaration.importClause?.name).toBeUndefined();
          const bindings = declaration.importClause?.namedBindings;
          expect(bindings && ts.isNamedImports(bindings)).toBe(true);
          if (!bindings || !ts.isNamedImports(bindings)) return;
          expect(bindings.elements.length).toBeGreaterThan(0);
          for (const element of bindings.elements) {
            expect((element.propertyName ?? element.name).text).toBe(allowedEntities[target]);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    for (const file of allowedFiles) {
      expect(fs.statSync(path.join(backendSrc, file)).isFile()).toBe(true);
    }
    // Una excepción inexistente o que ya no importe entidades también falla.
    expect([...actualFiles].sort()).toEqual([...allowedFiles].sort());
  });
  it('las entidades de identidad resuelven sus FK sin conexión ni entidades extra', async () => {
    const entities = [User, Organization, OrganizationMembership, UserSession];
    const source = new DataSource({ type: 'postgres', entities, synchronize: false });
    // Mismo mecanismo local del beforeAll: no llama initialize ni abre conexiones.
    await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    expect(source.isInitialized).toBe(false);
    expect(source.entityMetadatas.map(metadata => metadata.target)).toEqual(expect.arrayContaining(entities));
    expect(source.entityMetadatas).toHaveLength(4);
    const membership = source.getMetadata(OrganizationMembership);
    expect(membership.foreignKeys.map(fk => [fk.name, fk.referencedEntityMetadata.tableName]).sort()).toEqual([
      ['FK_organization_memberships_organization', 'organizations'],
      ['FK_organization_memberships_user', 'users'],
    ]);
    const references = source.entityMetadatas.flatMap(metadata => metadata.foreignKeys);
    expect(references).toHaveLength(4);
    expect(source.getMetadata(UserSession).foreignKeys.map(fk => [fk.name, fk.referencedEntityMetadata.tableName]).sort()).toEqual([
      ['FK_user_sessions_membership', 'organization_memberships'],
      ['FK_user_sessions_user', 'users'],
    ]);
    for (const fk of references) expect(entities).toContain(fk.referencedEntityMetadata.target);
    for (const metadata of source.entityMetadatas) {
      for (const relation of metadata.relations) expect(entities).toContain(relation.inverseEntityMetadata.target);
    }
  });
  it('el DataSource de la aplicación conserva entities vacío y migrations vacío, y la barrera sigue intacta', () => {
    const source = read(path.join(backendSrc, 'database/data-source-options.ts'));
    expect(source).toContain('entities: [], migrations: [], synchronize: false, dropSchema: false, migrationsRun: false');
    expect(source).toContain('!Array.isArray(options.migrations) || options.migrations.length !== 0 || options.username?.endsWith(\'_owner\')');
    expect(read(path.join(backendSrc, 'database/database.module.ts'))).toContain('autoLoadEntities: true');
    expect(read(path.join(backendSrc, 'app.module.ts'))).not.toMatch(/persistence|TypeOrmModule\.forFeature/);
  });
  it('no existen migraciones ni scripts de migración nuevos', () => {
    expect(sources(backendSrc).filter(f => /migration/i.test(path.basename(f)) && !f.includes('config/'))).toEqual([]);
  });
});

describe('secretos fuera de registros, serialización y consola', () => {
  const SENTINEL = 'SENTINEL-argon2id-secreto-unico';
  const make = () => {
    const user = Object.assign(new User(), { id: 'u1', email: 'a@b.cl', name: 'Ana', passwordHash: `$argon2id$${SENTINEL}`, passwordChangedAt: new Date(0), version: 1 });
    const session = Object.assign(new UserSession(), { id: 's1', tokenHash: Buffer.from(SENTINEL), userId: 'u1', activeOrganizationId: null,
      createdAt: new Date(0), lastSeenAt: new Date(0), expiresAt: new Date(1), revokedAt: null });
    return { user, session };
  };
  const renderings = (value: unknown) => [JSON.stringify(value), JSON.stringify({ nested: [value] }), inspect(value, { depth: 10, showHidden: false }),
    inspect({ a: { b: value } }, { depth: 10 }), `${JSON.stringify(value)}`, String(Object.keys(JSON.parse(JSON.stringify(value)) as object))];
  it('ni la contraseña ni el hash del token aparecen al serializar o inspeccionar', () => {
    const { user, session } = make();
    for (const text of [...renderings(user), ...renderings(session)]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(Buffer.from(SENTINEL).toString('hex'));
      expect(text).not.toContain(Buffer.from(SENTINEL).toString('base64'));
      expect(text).not.toMatch(/passwordHash|tokenHash|password_hash|token_hash/);
    }
    expect(inspect(user)).toBe('User(u1)');
    expect(inspect(session)).toBe('UserSession(s1)');
  });
  it('toda columna con nombre sensible está excluida de las lecturas por defecto y solo vive en User y UserSession', () => {
    const sensitive = metadatas.flatMap(m => m.columns.filter(c => !c.databaseName.endsWith('_at') && /password|token|secret|hash|salt|credential/i.test(c.databaseName)).map(c => [m.tableName, c.databaseName, c.isSelect]));
    expect(sensitive).toEqual(expect.arrayContaining([['users', 'password_hash', false], ['user_sessions', 'token_hash', false]]));
    expect(sensitive).toHaveLength(2);
  });
  it('el resto de las entidades no contiene datos sensibles que filtrar', () => {
    const toJson = metadatas.filter(m => typeof (m.target as { prototype: { toJSON?: unknown } }).prototype.toJSON === 'function').map(m => m.tableName).sort();
    expect(toJson).toEqual(['user_sessions', 'users']);
  });
  it('los constructores no requieren argumentos (TypeORM instancia sin ellos)', () => {
    for (const E of ENTITIES) expect(() => new (E as new () => object)()).not.toThrow();
  });
});

describe('alineación con el frontend actual', () => {
  const types = read(path.join(frontendRoot, 'src/types/index.ts'));
  const union = (name: string) => [...(new RegExp(`export type ${name} = ([^;]+);`).exec(types)![1]).matchAll(/'([^']+)'/g)].map(m => m[1]);
  const fields = (name: string) => [...(new RegExp(`export interface ${name} \\{([^}]+)\\}`).exec(types)![1]).matchAll(/^\s*([A-Za-z_]+)\??:/gm)].map(m => m[1]);
  it('roles, estados y formatos coinciden con src/types/index.ts', () => {
    expect(union('Role')).toEqual([...ROLES]);
    expect(union('PostStatus')).toEqual([...POST_STATUSES]);
    expect(union('PostFormat')).toEqual([...POST_FORMATS]);
  });
  it('límites del frontend: título 120, comentario 2000, nombres 2-80, correo 120, color #rrggbb', () => {
    expect(read(path.join(frontendRoot, 'src/features/posts/validation.ts'))).toContain('draft.title.length > 120');
    expect(read(path.join(frontendRoot, 'src/store/operations.ts'))).toContain('body.length > 2000');
    expect(read(path.join(frontendRoot, 'src/store/settings.ts'))).toContain('name.length < 2 || name.length > 80');
    expect(read(path.join(frontendRoot, 'src/store/profile.ts'))).toContain('email.length > 120');
    expect(read(path.join(frontendRoot, 'src/lib/color.ts'))).toContain('/^#[0-9a-f]{6}$/i');
  });
  // Mapa explícito campo del frontend -> columna. Si el frontend añade o renombra un campo, este test obliga a decidirlo.
  const MAPPING: Record<string, Record<string, string | null>> = {
    Organization: { id: 'organizations.id', name: 'organizations.name' },
    Company: { id: 'companies.id', organizationId: 'companies.organization_id', name: 'companies.name', color: 'companies.color' },
    User: { id: 'users.id', name: 'users.name', role: 'organization_memberships.role', example: null, email: 'users.email' },
    Membership: { id: null, userId: 'company_accesses.membership_id', companyId: 'company_accesses.company_id' },
    Comment: { id: 'post_comments.id', postId: 'post_comments.post_id', authorId: 'post_comments.author_user_id', body: 'post_comments.body', createdAt: 'post_comments.created_at' },
    Post: { id: 'posts.id', companyId: 'posts.company_id', title: 'posts.title', description: 'posts.description', scheduledAt: 'posts.scheduled_at', format: 'posts.format',
      status: 'posts.status', responsibleId: 'posts.responsible_user_id', visible_para_cliente: 'posts.client_visible', attachments: null,
      instagramUrl: 'posts.instagram_url', confirmadoPor: 'posts.confirmed_by_user_id', confirmadoEn: 'posts.confirmed_at' },
  };
  it.each(Object.entries(MAPPING))('cada campo de %s está mapeado o descartado a propósito', (name, mapping) => {
    expect(fields(name).sort()).toEqual(Object.keys(mapping).sort());
    for (const target of Object.values(mapping)) {
      if (target === null) continue;
      const [table, column] = target.split('.');
      expect([target, metadatas.find(m => m.tableName === table)?.columns.some(c => c.databaseName === column)]).toEqual([target, true]);
    }
  });
  it('lo que el frontend descarta o difiere queda explícito', () => {
    expect(MAPPING.User.example).toBeNull();
    expect(MAPPING.Post.attachments).toBeNull();
    expect(MAPPING.Membership.id).toBeNull();
  });
});
