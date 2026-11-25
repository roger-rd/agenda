import { deriveStructure } from '../database/schema-runner/schema-structure';
import { UP_STATEMENTS as INITIAL } from '../database/migrations/initial-schema.statements';
import { UP_STATEMENTS as SECOND } from '../database/migrations/invitations.statements';
import { ACCEPTANCE_COMPANIES_SQL, ACCEPTANCE_SQL, INSERT_ACCESSES_SQL, INSERT_MEMBERSHIP_SQL, INSERT_USER_SQL, INSPECT_INVITATION_SQL,
  LOCK_INVITATION_BY_TOKEN_SQL, MARK_ACCEPTED_SQL, USER_EXISTS_BY_EMAIL_SQL } from './invitation-acceptance-sql';

const statements = Object.entries(ACCEPTANCE_SQL);
const columns = (() => {
  const map = new Map<string, Set<string>>();
  for (const row of deriveStructure([...INITIAL, ...SECOND])) if (row.kind === 'col') map.set(row.table_name, (map.get(row.table_name) ?? new Set()).add(row.name));
  return map;
})();
const placeholders = (sql: string) => [...new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);

describe('SQL fijo de la aceptación', () => {
  it('ocho sentencias; ninguna se construye con valores: todo son parámetros numerados y contiguos', () => {
    expect(statements.map(([name]) => name)).toEqual(['INSPECT_INVITATION_SQL', 'LOCK_INVITATION_BY_TOKEN_SQL', 'ACCEPTANCE_COMPANIES_SQL', 'USER_EXISTS_BY_EMAIL_SQL', 'INSERT_USER_SQL', 'INSERT_MEMBERSHIP_SQL', 'INSERT_ACCESSES_SQL', 'MARK_ACCEPTED_SQL']);
    expect(Object.isFrozen(ACCEPTANCE_SQL)).toBe(true);
    for (const [name, sql] of statements) {
      const used = placeholders(sql);
      expect(used.length).toBeGreaterThan(0);
      expect(used).toEqual(Array.from({ length: used.length }, (_, i) => i + 1));
      expect(sql).not.toMatch(/'[^']*'|;|--|\/\*/); // sin literales de texto, ni varias sentencias, ni comentarios
      expect(name).toBeTruthy();
    }
    expect(Object.fromEntries(statements.map(([name, sql]) => [name, placeholders(sql).length]))).toEqual({
      INSPECT_INVITATION_SQL: 1, LOCK_INVITATION_BY_TOKEN_SQL: 1, ACCEPTANCE_COMPANIES_SQL: 2, USER_EXISTS_BY_EMAIL_SQL: 1,
      INSERT_USER_SQL: 5, INSERT_MEMBERSHIP_SQL: 5, INSERT_ACCESSES_SQL: 5, MARK_ACCEPTED_SQL: 3,
    });
  });
  it('las invitaciones se buscan solo por el hash del token (bytea), y el bloqueo es sobre su fila', () => {
    expect(INSPECT_INVITATION_SQL).toMatch(/WHERE i\.token_hash = \$1$/);
    expect(LOCK_INVITATION_BY_TOKEN_SQL).toMatch(/WHERE i\.token_hash = \$1 FOR UPDATE OF i$/);
    expect(INSPECT_INVITATION_SQL).not.toMatch(/FOR UPDATE/);
  });
  it('ninguna lectura devuelve token_hash ni password_hash, y solo el alta de usuario escribe una contraseña', () => {
    for (const sql of [INSPECT_INVITATION_SQL, LOCK_INVITATION_BY_TOKEN_SQL, ACCEPTANCE_COMPANIES_SQL, USER_EXISTS_BY_EMAIL_SQL]) {
      const projection = sql.slice(0, sql.indexOf(' FROM ')); // columnas devueltas
      expect(projection).not.toMatch(/token_hash|password_hash/);
      expect(sql).toMatch(/^SELECT /);
    }
    expect(statements.filter(([, sql]) => /password_hash/.test(sql)).map(([name]) => name)).toEqual(['INSERT_USER_SQL']);
    expect(statements.filter(([, sql]) => /user_sessions/.test(sql))).toEqual([]); // la sesión llega con el ayudante compartido con el login
    expect(statements.filter(([, sql]) => /^(UPDATE|DELETE)/.test(sql)).map(([name]) => name)).toEqual(['MARK_ACCEPTED_SQL']);
  });
  it('la marca de uso mueve los dos campos juntos y conserva la vigencia sin GREATEST', () => {
    expect(MARK_ACCEPTED_SQL).toBe('UPDATE public.invitations SET accepted_at = $2::timestamptz, accepted_by_user_id = $3 WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND created_at <= $2::timestamptz AND expires_at > $2::timestamptz RETURNING id');
    expect(MARK_ACCEPTED_SQL).not.toMatch(/GREATEST|LEAST|now\(\)|current_timestamp/i);
    expect(MARK_ACCEPTED_SQL.match(/accepted_at = /g)).toHaveLength(1);
    expect(MARK_ACCEPTED_SQL.match(/accepted_by_user_id = /g)).toHaveLength(1);
    expect(MARK_ACCEPTED_SQL.match(/SET (.*) WHERE/)![1].split(', ')).toHaveLength(2);
  });
  it('los accesos llevan el rol de la membresía y la organización, como exige la FK compuesta', () => {
    expect(INSERT_ACCESSES_SQL).toContain('(membership_id, company_id, organization_id, membership_role, created_at)');
    expect(INSERT_ACCESSES_SQL).toContain('SELECT $1::uuid, c, $2::uuid, $3::varchar, $4::timestamptz FROM unnest($5::uuid[]) AS c');
    expect(INSERT_MEMBERSHIP_SQL).toContain('deactivated_at, version, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, 1, $5, $5)');
    expect(INSERT_USER_SQL).toContain('VALUES ($1, $2, $3, $4, $5, 1, $5, $5)');
  });
  it('todas las tablas y columnas existen en el esquema aplicado (manifiesto)', () => {
    const referenced = new Map<string, string[]>();
    const add = (table: string, list: string[]) => referenced.set(table, [...(referenced.get(table) ?? []), ...list]);
    for (const sql of [INSERT_USER_SQL, INSERT_MEMBERSHIP_SQL, INSERT_ACCESSES_SQL]) {
      const m = /^INSERT INTO public\.(\w+) \(([^)]+)\)/.exec(sql)!;
      add(m[1], m[2].split(',').map(c => c.trim()));
    }
    add('invitations', ['accepted_at', 'accepted_by_user_id', 'id', 'revoked_at', 'created_at', 'expires_at', 'token_hash', 'organization_id', 'email', 'role']);
    add('invitation_companies', ['invitation_id', 'company_id', 'organization_id']);
    add('companies', ['id', 'organization_id', 'name']);
    add('organizations', ['id', 'name']);
    add('users', ['email']);
    for (const [table, list] of referenced) {
      expect(columns.has(table)).toBe(true);
      for (const column of list) expect(columns.get(table)!.has(column)).toBe(true);
    }
    expect(ACCEPTANCE_COMPANIES_SQL).toContain('FROM public.invitation_companies WHERE invitation_id = $1 AND organization_id = $2 ORDER BY company_id');
    expect(USER_EXISTS_BY_EMAIL_SQL).toBe('SELECT 1 AS found FROM public.users WHERE email = $1 LIMIT 1');
  });
  it('la inspección acota las empresas por la organización de la invitación y las ordena por nombre', () => {
    expect(INSPECT_INVITATION_SQL).toContain('c.id = ic.company_id AND c.organization_id = ic.organization_id');
    expect(INSPECT_INVITATION_SQL).toContain('ic.invitation_id = i.id AND ic.organization_id = i.organization_id ORDER BY c.name');
    expect(INSPECT_INVITATION_SQL).toContain('JOIN public.organizations o ON o.id = i.organization_id');
  });
});
