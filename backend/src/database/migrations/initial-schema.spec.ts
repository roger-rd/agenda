import { ADD_FOREIGN_KEYS, COUNTS, CREATE_INDEXES, CREATE_TABLES, DOWN_STATEMENTS, DROP_TABLES, TABLE_ORDER, UP_STATEMENTS } from './initial-schema.statements';

// --- minimal, quote-aware SQL helpers (the statements are fixed text; this is not a SQL parser) ---
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
/** Removes string literals and quoted identifiers so keywords can be searched without false hits. */
const bare = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""');
/** Statement without CHECK expressions, index predicates and referential actions: only the structure remains. */
function skeleton(sql: string): string {
  if (sql.startsWith('CREATE TABLE')) {
    const m = /^(CREATE TABLE "public"\."[a-z_]+") \(\n([\s\S]*)\n\)$/.exec(sql)!;
    return `${m[1]} (${splitTop(m[2]).filter(c => !c.startsWith('CONSTRAINT "CK_')).join(', ')})`;
  }
  return sql.replace(/ WHERE .*$/, '').replace(/ ON DELETE [A-Z]+ ON UPDATE [A-Z]+$/, '');
}
const list = (text: string) => [...text.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);

interface Table { name: string; columns: { name: string; definition: string; nullable: boolean }[]; uniques: { name: string; columns: string[] }[];
  checks: { name: string; expression: string }[]; primary: { name: string; columns: string[] } }
function table(sql: string): Table {
  const m = /^CREATE TABLE "public"\."([a-z_]+)" \(\n([\s\S]*)\n\)$/.exec(sql);
  if (!m) throw new Error(`CREATE TABLE inesperado: ${sql.slice(0, 60)}`);
  const t: Table = { name: m[1], columns: [], uniques: [], checks: [], primary: { name: '', columns: [] } };
  for (const clause of splitTop(m[2])) {
    let c: RegExpExecArray | null;
    if ((c = /^CONSTRAINT "(UQ_[A-Za-z0-9_]+)" UNIQUE \((.+)\)$/.exec(clause))) t.uniques.push({ name: c[1], columns: list(c[2]) });
    else if ((c = /^CONSTRAINT "(CK_[A-Za-z0-9_]+)" CHECK \((.+)\)$/.exec(clause))) t.checks.push({ name: c[1], expression: c[2] });
    else if ((c = /^CONSTRAINT "(PK_[A-Za-z0-9_]+)" PRIMARY KEY \((.+)\)$/.exec(clause))) t.primary = { name: c[1], columns: list(c[2]) };
    else if ((c = /^"([a-z_]+)" ((?:uuid|text|integer|boolean|bytea|TIMESTAMP WITH TIME ZONE|character varying\(\d+\))(?: NOT NULL)?)$/.exec(clause)))
      t.columns.push({ name: c[1], definition: c[2].replace(/ NOT NULL$/, ''), nullable: !c[2].endsWith(' NOT NULL') });
    else throw new Error(`cláusula inesperada: ${clause}`);
  }
  return t;
}
interface Fk { table: string; name: string; columns: string[]; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string }
function fk(sql: string): Fk {
  const m = /^ALTER TABLE "public"\."([a-z_]+)" ADD CONSTRAINT "(FK_[A-Za-z0-9_]+)" FOREIGN KEY \((.+?)\) REFERENCES "public"\."([a-z_]+)" \((.+?)\) ON DELETE ([A-Z]+) ON UPDATE ([A-Z]+)$/.exec(sql);
  if (!m) throw new Error(`FK inesperada: ${sql.slice(0, 80)}`);
  return { table: m[1], name: m[2], columns: list(m[3]), refTable: m[4], refColumns: list(m[5]), onDelete: m[6], onUpdate: m[7] };
}
function index(sql: string) {
  const m = /^CREATE INDEX "(IX_[A-Za-z0-9_]+)" ON "public"\."([a-z_]+)" \((.+?)\)(?: WHERE (.+))?$/.exec(sql);
  if (!m) throw new Error(`índice inesperado: ${sql.slice(0, 80)}`);
  return { name: m[1], table: m[2], columns: list(m[3]), where: m[4] ?? null };
}
const tables = CREATE_TABLES.map(table);
const byName = new Map(tables.map(t => [t.name, t]));
const fks = ADD_FOREIGN_KEYS.map(fk);
const indexes = CREATE_INDEXES.map(index);
const sameSet = (a: string[], b: string[]) => [...a].sort().join(',') === [...b].sort().join(',');

describe('catálogo congelado de la migración inicial', () => {
  it('ocho tablas, nueve índices, catorce claves foráneas; 31 sentencias de subida y 8 de bajada', () => {
    expect([CREATE_TABLES.length, CREATE_INDEXES.length, ADD_FOREIGN_KEYS.length, UP_STATEMENTS.length, DOWN_STATEMENTS.length]).toEqual([8, 9, 14, 31, 8]);
    expect(COUNTS).toEqual({ tables: 8, indexes: 9, foreignKeys: 14, uniques: 9, checks: 33, primaryKeys: 8 });
    expect(tables.reduce((n, t) => n + t.uniques.length, 0)).toBe(COUNTS.uniques);
    expect(tables.reduce((n, t) => n + t.checks.length, 0)).toBe(COUNTS.checks);
    expect(tables.filter(t => t.primary.columns.length > 0)).toHaveLength(COUNTS.primaryKeys);
  });
  it('todo está congelado y es de texto fijo', () => {
    for (const value of [CREATE_TABLES, CREATE_INDEXES, ADD_FOREIGN_KEYS, DROP_TABLES, UP_STATEMENTS, DOWN_STATEMENTS, TABLE_ORDER, COUNTS]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => (UP_STATEMENTS as string[]).push('DROP TABLE x')).toThrow(TypeError);
    expect(UP_STATEMENTS).toEqual([...CREATE_TABLES, ...CREATE_INDEXES, ...ADD_FOREIGN_KEYS]);
    expect(DOWN_STATEMENTS).toBe(DROP_TABLES);
  });
  it('cada sentencia es una sola orden, sin comentarios ni terminador', () => {
    for (const sql of [...UP_STATEMENTS, ...DOWN_STATEMENTS]) {
      expect([sql.slice(0, 40), /;|--|\/\*|\*\//.test(bare(sql))]).toEqual([sql.slice(0, 40), false]);
      expect(sql).toBe(sql.trim());
    }
  });
  it('la subida tiene tres fases en orden: tablas, índices y claves foráneas', () => {
    const kind = (sql: string) => (sql.startsWith('CREATE TABLE ') ? 1 : sql.startsWith('CREATE INDEX ') ? 2 : sql.startsWith('ALTER TABLE ') ? 3 : 0);
    const kinds = UP_STATEMENTS.map(kind);
    expect(kinds.includes(0)).toBe(false);
    expect([...kinds].sort()).toEqual(kinds);
    expect(kinds.filter(k => k === 1)).toHaveLength(8);
  });
  it('las tablas se crean en el orden declarado y no incluyen schema_migrations', () => {
    expect(tables.map(t => t.name)).toEqual([...TABLE_ORDER]);
    expect(TABLE_ORDER).toEqual(['organizations', 'users', 'organization_memberships', 'companies', 'company_accesses', 'user_sessions', 'posts', 'post_comments']);
    expect(UP_STATEMENTS.join('\n') + DOWN_STATEMENTS.join('\n')).not.toMatch(/schema_migrations|migrations/i);
  });
  it('todas las referencias a tablas están calificadas con "public"', () => {
    for (const sql of UP_STATEMENTS) {
      const outside = sql.replace(/'(?:[^']|'')*'/g, "''");
      expect([sql.slice(0, 50), /\b(?:TABLE|REFERENCES|ON)\s+"(?!public"\."[a-z_]+")/.test(outside)]).toEqual([sql.slice(0, 50), false]);
      expect([sql.slice(0, 50), (outside.match(/"public"\."[a-z_]+"/g) ?? []).length > 0]).toEqual([sql.slice(0, 50), true]);
    }
    for (const sql of DOWN_STATEMENTS) expect(sql).toMatch(/^DROP TABLE "public"\."[a-z_]+"$/);
  });
  it('identificadores: caracteres seguros, hasta 63, y nombres de relación únicos en el esquema', () => {
    const names = [...tables.flatMap(t => [t.name, t.primary.name, ...t.uniques.map(u => u.name)]), ...indexes.map(i => i.name)];
    expect(new Set(names).size).toBe(names.length);
    const all = [...names, ...tables.flatMap(t => t.checks.map(c => c.name)), ...fks.map(f => f.name), ...tables.flatMap(t => t.columns.map(c => c.name))];
    for (const n of all) { expect(n).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/); expect(n.length).toBeLessThanOrEqual(63); }
    const constraintNames = [...tables.flatMap(t => [t.primary.name, ...t.uniques.map(u => u.name), ...t.checks.map(c => c.name)]), ...fks.map(f => f.name)];
    expect(new Set(constraintNames).size).toBe(constraintNames.length);
  });
  it('cada tabla declara una clave primaria con su prefijo y columnas existentes', () => {
    for (const t of tables) {
      expect(t.primary.name).toBe(`PK_${t.name}`);
      for (const c of t.primary.columns) expect(t.columns.map(x => x.name)).toContain(c);
      expect(t.primary.columns.every(c => !t.columns.find(x => x.name === c)!.nullable)).toBe(true);
      for (const u of t.uniques) for (const c of u.columns) expect(t.columns.map(x => x.name)).toContain(c);
    }
  });
});

describe('claves foráneas', () => {
  it('cada una referencia columnas con tipos idénticos y un destino que es clave primaria o unicidad exacta', () => {
    for (const f of fks) {
      const source = byName.get(f.table)!, target = byName.get(f.refTable)!;
      expect([f.name, source !== undefined && target !== undefined]).toEqual([f.name, true]);
      expect(f.columns).toHaveLength(f.refColumns.length);
      f.columns.forEach((c, i) => {
        const a = source.columns.find(x => x.name === c)!, b = target.columns.find(x => x.name === f.refColumns[i])!;
        expect([f.name, c, a?.definition]).toEqual([f.name, c, b?.definition]);
      });
      const targets = [target.primary.columns, ...target.uniques.map(u => u.columns)];
      expect([f.name, targets.some(t => sameSet(t, f.refColumns))]).toEqual([f.name, true]);
    }
  });
  it('referencian tablas creadas antes de añadirse (las claves van después de todas las tablas)', () => {
    for (const f of fks) { expect(TABLE_ORDER).toContain(f.table); expect(TABLE_ORDER).toContain(f.refTable); }
    expect(UP_STATEMENTS.findIndex(s => s.startsWith('ALTER TABLE'))).toBeGreaterThan(UP_STATEMENTS.findLastIndex(s => s.startsWith('CREATE TABLE')));
  });
  it('toda referencia entre tablas con organización incluye organization_id en ambos lados', () => {
    const tenant = (t: string) => byName.get(t)!.columns.some(c => c.name === 'organization_id');
    for (const f of fks) if (tenant(f.table) && tenant(f.refTable)) {
      expect([f.name, f.columns.includes('organization_id') && f.refColumns.includes('organization_id')]).toEqual([f.name, true]);
    }
  });
  it('acciones: CASCADE solo en tres enlaces de bajada y una actualización de rol; RESTRICT en el resto', () => {
    expect(fks.filter(f => f.onDelete === 'CASCADE').map(f => f.name).sort()).toEqual(['FK_company_accesses_company', 'FK_company_accesses_membership', 'FK_user_sessions_user']);
    expect(fks.filter(f => f.onUpdate === 'CASCADE').map(f => f.name)).toEqual(['FK_company_accesses_membership']);
    for (const f of fks.filter(x => !['FK_company_accesses_company', 'FK_company_accesses_membership', 'FK_user_sessions_user'].includes(x.name))) {
      expect([f.name, f.onDelete, f.onUpdate]).toEqual([f.name, 'RESTRICT', 'RESTRICT']);
    }
    expect(fks.find(f => f.name === 'FK_post_comments_post')!.onDelete).toBe('RESTRICT');
  });
  it('las referencias opcionales combinan columnas obligatoria y anulable (MATCH SIMPLE)', () => {
    const optional = ['FK_posts_confirmed_by', 'FK_posts_deleted_by', 'FK_user_sessions_membership'];
    for (const f of fks) {
      const cols = f.columns.map(c => byName.get(f.table)!.columns.find(x => x.name === c)!);
      expect([f.name, cols.some(c => c.nullable)]).toEqual([f.name, optional.includes(f.name)]);
    }
  });
  it('el acceso a empresa referencia (id, organización, rol) y su CHECK excluye al community manager', () => {
    const access = fks.find(f => f.name === 'FK_company_accesses_membership')!;
    expect(access.columns).toEqual(['membership_id', 'organization_id', 'membership_role']);
    expect(access.refColumns).toEqual(['id', 'organization_id', 'role']);
    expect(byName.get('organization_memberships')!.uniques.some(u => sameSet(u.columns, ['id', 'organization_id', 'role']))).toBe(true);
    expect(byName.get('company_accesses')!.checks).toEqual([{ name: 'CK_company_accesses_role', expression: "membership_role IN ('worker', 'client')" }]);
  });
});

describe('índices', () => {
  it('nueve, sobre columnas existentes; los parciales excluyen borrados o limitan a managers activos', () => {
    expect(indexes).toHaveLength(9);
    for (const i of indexes) for (const c of i.columns) expect([i.name, byName.get(i.table)!.columns.map(x => x.name).includes(c)]).toEqual([i.name, true]);
    expect(indexes.filter(i => i.where).map(i => [i.name, i.where])).toEqual([
      ['IX_organization_memberships_active_managers', "role = 'community_manager' AND deactivated_at IS NULL"],
      ['IX_posts_company_schedule', 'deleted_at IS NULL'], ['IX_posts_org_schedule', 'deleted_at IS NULL'], ['IX_posts_responsible', 'deleted_at IS NULL']]);
    for (const i of indexes.filter(x => x.where)) for (const w of bare(i.where!).match(/\b[a-z_]+\b/g) ?? []) {
      if (!['AND', 'IS', 'NULL', 'OR', 'NOT'].includes(w.toUpperCase())) expect(byName.get(i.table)!.columns.map(c => c.name)).toContain(w);
    }
  });
  it('ningún índice es único (las unicidades viven en las tablas)', () => { for (const sql of CREATE_INDEXES) expect(sql).not.toMatch(/UNIQUE|CONCURRENTLY/); });
});

describe('restricciones CHECK', () => {
  it('solo mencionan columnas de su tabla y funciones de PostgreSQL 16 conocidas', () => {
    const words = new Set(['and', 'or', 'not', 'in', 'is', 'null', 'like', 'between', 'btrim', 'lower', 'char_length', 'octet_length', 'substr', 'text']);
    for (const t of tables) for (const c of t.checks) {
      const ids = (bare(c.expression).match(/\b[a-z][a-z0-9_]*\b/g) ?? []).filter(w => !words.has(w));
      for (const id of ids) expect([t.name, c.name, t.columns.some(x => x.name === id)]).toEqual([t.name, c.name, true]);
    }
  });
  it('confirmación, borrado lógico, límites y formas clave están presentes con su texto exacto', () => {
    const check = (t: string, n: string) => byName.get(t)!.checks.find(c => c.name === n)!.expression;
    expect(check('posts', 'CK_posts_confirmation')).toBe("((status = 'Subido') = (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)) AND ((confirmed_by_user_id IS NULL) = (confirmed_at IS NULL))");
    expect(check('posts', 'CK_posts_soft_delete')).toBe('(deleted_at IS NULL) = (deleted_by_user_id IS NULL)');
    expect(check('posts', 'CK_posts_description')).toBe('char_length(description) <= 5000');
    expect(check('posts', 'CK_posts_status')).toBe("status IN ('Pendiente', 'En proceso', 'Completado', 'Subido')");
    expect(check('posts', 'CK_posts_format')).toBe("format IN ('Post', 'Carrusel', 'Reel', 'Historia')");
    expect(check('organization_memberships', 'CK_organization_memberships_role')).toBe("role IN ('community_manager', 'worker', 'client')");
    expect(check('companies', 'CK_companies_color')).toBe("color ~ '^#[0-9a-f]{6}$'");
    expect(check('users', 'CK_users_password_hash')).toContain("LIKE '$argon2id$%'");
    expect(check('user_sessions', 'CK_user_sessions_token_hash')).toBe('octet_length(token_hash) = 32');
    for (const t of tables.filter(x => x.name !== 'company_accesses')) expect(check(t.name, `CK_${t.name}_id_v7`)).toContain("substr(id::text, 15, 1) = '7'");
  });
  it('la columna de contraseña y la de hash de token nunca tienen valor por defecto', () => {
    expect(UP_STATEMENTS.join('\n')).not.toMatch(/\bDEFAULT\b|GENERATED|SERIAL|IDENTITY|now\(\)|gen_random_uuid|uuid_generate/i);
  });
});

describe('ausencia de instrucciones no autorizadas', () => {
  const FORBIDDEN = ['DROP', 'TRUNCATE', 'DELETE', 'UPDATE', 'INSERT', 'GRANT', 'REVOKE', 'EXTENSION', 'COPY', 'SET', 'CALL', 'DO', 'EXECUTE', 'FUNCTION',
    'PROCEDURE', 'TRIGGER', 'POLICY', 'ROLE', 'SEQUENCE', 'VIEW', 'TYPE', 'SCHEMA', 'DATABASE', 'COMMENT', 'ENABLE', 'SECURITY', 'OWNER', 'VACUUM', 'ANALYZE',
    'LOCK', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'ALTER'];
  it('la subida solo usa CREATE TABLE, CREATE INDEX y ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY', () => {
    for (const sql of UP_STATEMENTS) {
      expect([sql.slice(0, 40), /^(?:CREATE TABLE "public"\."|CREATE INDEX "IX_|ALTER TABLE "public"\."[a-z_]+" ADD CONSTRAINT "FK_)/.test(sql)]).toEqual([sql.slice(0, 40), true]);
      const words = bare(skeleton(sql)).toUpperCase().match(/\b[A-Z_]+\b/g) ?? [];
      const hits = words.filter(w => FORBIDDEN.includes(w) && !(w === 'ALTER' && sql.startsWith('ALTER TABLE')));
      expect([sql.slice(0, 40), hits]).toEqual([sql.slice(0, 40), []]);
    }
  });
  it('CASCADE aparece solo como acción de claves foráneas concretas', () => {
    const cascades = UP_STATEMENTS.filter(s => /\bCASCADE\b/.test(bare(s)));
    expect(cascades.every(s => s.startsWith('ALTER TABLE') && /ON (?:DELETE|UPDATE) CASCADE/.test(s))).toBe(true);
    expect(cascades).toHaveLength(3);
    expect(DOWN_STATEMENTS.join('\n')).not.toMatch(/CASCADE|IF EXISTS/i);
  });
  it('ninguna instrucción es DML, concede permisos ni crea extensiones o funciones', () => {
    const text = bare(UP_STATEMENTS.map(skeleton).join('\n')).toUpperCase();
    for (const forbidden of [/\bINSERT\b/, /\bUPDATE\s+[A-Z"]/, /\bDELETE\s+FROM\b/, /\bGRANT\b/, /\bREVOKE\b/, /\bCREATE\s+(?:EXTENSION|FUNCTION|TRIGGER|POLICY|ROLE|SCHEMA|SEQUENCE|VIEW|TYPE|UNIQUE)/])
      expect([String(forbidden), forbidden.test(text)]).toEqual([String(forbidden), false]);
  });
});

describe('bajada', () => {
  it('elimina las ocho tablas en el orden inverso de creación, sin CASCADE ni IF EXISTS', () => {
    expect(DOWN_STATEMENTS.map(s => /^DROP TABLE "public"\."([a-z_]+)"$/.exec(s)![1])).toEqual([...TABLE_ORDER].reverse());
  });
  it('nunca elimina una tabla que otra aún no eliminada referencia (hijos primero)', () => {
    const remaining = new Set<string>(TABLE_ORDER);
    for (const dropped of DOWN_STATEMENTS.map(s => /"([a-z_]+)"$/.exec(s)![1])) {
      const dependents = fks.filter(f => f.refTable === dropped && f.table !== dropped && remaining.has(f.table));
      expect([dropped, dependents.map(f => f.name)]).toEqual([dropped, []]);
      remaining.delete(dropped);
    }
    expect(remaining.size).toBe(0);
  });
});
