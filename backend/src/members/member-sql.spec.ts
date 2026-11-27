import { deriveStructure } from '../database/schema-runner/schema-structure';
import { UP_STATEMENTS as INITIAL } from '../database/migrations/initial-schema.statements';
import { UP_STATEMENTS as SECOND } from '../database/migrations/invitations.statements';
import { BUMP_MEMBER_VERSION_SQL, COUNT_ORG_COMPANIES_SQL, CURRENT_ACCESSES_SQL, DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL, LIST_MEMBERS_SQL, LOCK_MEMBER_SQL, MEMBER_SQL } from './member-sql';

const statements = Object.entries(MEMBER_SQL);
const columns = new Map<string, Set<string>>();
for (const r of deriveStructure([...INITIAL, ...SECOND])) if (r.kind === 'col') columns.set(r.table_name, (columns.get(r.table_name) ?? new Set()).add(r.name));
const params = (sql: string) => [...new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);

describe('SQL fijo de miembros', () => {
  it('siete sentencias; parámetros numerados y contiguos; una sola sentencia cada una', () => {
    expect(statements.map(([name]) => name)).toEqual(['LOCK_MEMBER_SQL', 'COUNT_ORG_COMPANIES_SQL', 'CURRENT_ACCESSES_SQL', 'DELETE_ACCESSES_SQL', 'INSERT_ACCESSES_SQL', 'BUMP_MEMBER_VERSION_SQL', 'LIST_MEMBERS_SQL']);
    expect(Object.isFrozen(MEMBER_SQL)).toBe(true);
    expect(Object.fromEntries(statements.map(([name, sql]) => [name, params(sql).length]))).toEqual({
      LOCK_MEMBER_SQL: 2, COUNT_ORG_COMPANIES_SQL: 2, CURRENT_ACCESSES_SQL: 2, DELETE_ACCESSES_SQL: 3, INSERT_ACCESSES_SQL: 5, BUMP_MEMBER_VERSION_SQL: 4, LIST_MEMBERS_SQL: 5 });
    for (const [, sql] of statements) {
      expect(params(sql)).toEqual(Array.from({ length: params(sql).length }, (_, i) => i + 1));
      expect(sql).not.toMatch(/;|--|\/\*/);
      expect(sql.match(/'[^']*'/g)?.filter(lit => !["'all'", "'active'", "'deactivated'"].includes(lit)) ?? []).toEqual([]);
    }
  });
  it('toda sentencia está acotada por la organización de la sesión', () => {
    for (const sql of [LOCK_MEMBER_SQL, BUMP_MEMBER_VERSION_SQL]) expect(sql).toMatch(/organization_id = \$2/);
    expect(COUNT_ORG_COMPANIES_SQL).toContain('organization_id = $1');
    expect(CURRENT_ACCESSES_SQL).toContain('membership_id = $1 AND organization_id = $2');
    expect(DELETE_ACCESSES_SQL).toContain('membership_id = $1 AND organization_id = $2 AND company_id = ANY($3::uuid[])');
    expect(INSERT_ACCESSES_SQL).toContain('SELECT $1::uuid, c, $2::uuid, $3::varchar, $4::timestamptz');
    expect(LIST_MEMBERS_SQL).toContain('WHERE m.organization_id = $1 ');
    expect(LIST_MEMBERS_SQL).toContain('a.membership_id = m.id AND a.organization_id = m.organization_id');
  });
  it('la fila de la membresía se bloquea antes de decidir: SELECT ... FOR UPDATE acotado, sin actualizar en el bloqueo', () => {
    expect(LOCK_MEMBER_SQL).toBe('SELECT m.id, m.role, m.version, m.deactivated_at FROM public.organization_memberships m WHERE m.id = $1 AND m.organization_id = $2 FOR UPDATE OF m');
    expect(LOCK_MEMBER_SQL).not.toMatch(/UPDATE public/);
  });
  it('solo se escriben las diferencias y la versión sube una vez, comprobando la versión leída', () => {
    const writes = statements.filter(([, sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql)).map(([name]) => name);
    expect(writes).toEqual(['DELETE_ACCESSES_SQL', 'INSERT_ACCESSES_SQL', 'BUMP_MEMBER_VERSION_SQL']);
    expect(BUMP_MEMBER_VERSION_SQL).toBe('UPDATE public.organization_memberships SET version = version + 1, updated_at = $3::timestamptz WHERE id = $1 AND organization_id = $2 AND version = $4 RETURNING version');
    expect(DELETE_ACCESSES_SQL).toContain('company_id = ANY($3::uuid[])'); // no borra todo: solo lo retirado
    expect(INSERT_ACCESSES_SQL).toContain('unnest($5::uuid[])');
  });
  it('los listados ordenan de forma determinista: miembros por id y empresas por id', () => {
    expect(LIST_MEMBERS_SQL).toMatch(/ORDER BY m\.id LIMIT \$5$/);
    expect(LIST_MEMBERS_SQL).toContain('ORDER BY a.company_id)::text[] AS company_ids');
    expect(CURRENT_ACCESSES_SQL).toMatch(/ORDER BY company_id$/);
    expect(LIST_MEMBERS_SQL).not.toMatch(/ORDER BY m\.created_at/);
    expect(LIST_MEMBERS_SQL).toContain('($2::uuid IS NULL OR m.id > $2::uuid)');
  });
  it('los filtros cubren active, deactivated y all, y el rol opcional', () => {
    expect(LIST_MEMBERS_SQL).toContain("($4::text = 'all' OR ($4::text = 'active' AND m.deactivated_at IS NULL) OR ($4::text = 'deactivated' AND m.deactivated_at IS NOT NULL))");
    expect(LIST_MEMBERS_SQL).toContain('($3::text IS NULL OR m.role = $3::text)');
  });
  it('ninguna lectura devuelve contraseña ni toca usuarios más que para leer nombre y correo', () => {
    for (const [, sql] of statements) expect(sql).not.toMatch(/password|token|user_sessions/i);
    expect(statements.filter(([, sql]) => /public\.users/.test(sql)).map(([name]) => name)).toEqual(['LIST_MEMBERS_SQL']);
  });
  it('todas las columnas referidas existen en el esquema aplicado', () => {
    const needed: Record<string, string[]> = {
      organization_memberships: ['id', 'organization_id', 'role', 'version', 'deactivated_at', 'user_id', 'created_at', 'updated_at'],
      company_accesses: ['membership_id', 'company_id', 'organization_id', 'membership_role', 'created_at'],
      companies: ['id', 'organization_id'], users: ['id', 'name', 'email'],
    };
    for (const [table, list] of Object.entries(needed)) for (const column of list) expect(columns.get(table)!.has(column)).toBe(true);
    expect(/\(([^)]+)\) SELECT/.exec(INSERT_ACCESSES_SQL)![1].split(', ').every(c => columns.get('company_accesses')!.has(c))).toBe(true);
  });
});
