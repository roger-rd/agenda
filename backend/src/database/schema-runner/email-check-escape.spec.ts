import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREATE_TABLES, UP_STATEMENTS } from '../migrations/initial-schema.statements';
import { evaluateIdentity } from './schema-guards';

/**
 * CK_users_email contains a regular expression with an escaped dot. PostgreSQL reads that literal text raw only while
 * standard_conforming_strings = on (the default since 9.1, and a condition the runner verifies). The tests pin the
 * exact text that reaches the server and what it means, so neither a doubled backslash nor a lost one can slip in.
 */
const statement = UP_STATEMENTS.find(s => s.includes('"CK_users_email"')) as string;
const literal = /email ~ '((?:[^']|'')*)'/.exec(statement)?.[1] as string;
const EXPECTED = String.raw`^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$`;
const BACKSLASH = String.fromCharCode(92);

/** Translation of the only POSIX class used, so the pattern can be exercised with the JS engine. */
const asJs = (posix: string) => new RegExp(posix.replace(/\[:space:\]/g, '\\s'));

describe('escape del CHECK del correo (CK_users_email)', () => {
  it('existe una única sentencia con la restricción y un único literal de expresión regular', () => {
    expect(UP_STATEMENTS.filter(s => s.includes('"CK_users_email"'))).toHaveLength(1);
    expect(CREATE_TABLES).toContain(statement);
    expect(statement.match(/ ~ '/g)).toHaveLength(1);
    expect(literal).toBeDefined();
  });

  it('el literal enviado al servidor es exactamente el esperado, con una sola barra invertida antes del punto', () => {
    expect(literal).toBe(EXPECTED);
    expect(literal.split(BACKSLASH)).toHaveLength(2);
    expect(literal).toContain(`${BACKSLASH}.`);
    expect(literal).not.toContain(`${BACKSLASH}${BACKSLASH}`);
    expect(statement).not.toMatch(/E'/);
    expect(statement).not.toContain(`${BACKSLASH}${BACKSLASH}.`);
  });

  it('el texto fuente del catálogo conserva la barra simple dentro de String.raw', () => {
    const source = readFileSync(join(__dirname, '../migrations/initial-schema.statements.ts'), 'utf8');
    const line = source.split('\n').find(l => l.includes('CK_users_email')) as string;
    expect(line).toContain(String.raw`+\.[^[:space:]@]+$'`);
    expect(line).not.toContain(String.raw`\\.`);
    expect(source).toMatch(/String\.raw`/);
  });

  it('con comillas estándar activadas, el patrón significa "punto literal"', () => {
    const pattern = asJs(literal);
    for (const ok of ['a@b.co', 'x.y@mail.example.org', 'a+b@c.d']) expect([ok, pattern.test(ok)]).toEqual([ok, true]);
    for (const bad of ['a@b', 'a@bco', 'a b@c.d', 'a@b c.d', 'a@@b.c', '@b.c', 'a@.c', 'a@b.', `a@b${BACKSLASH}c`, `a@b${BACKSLASH}cd`, 'a@b-c']) expect([bad, pattern.test(bad)]).toEqual([bad, false]);
  });

  it('con la barra duplicada el significado cambiaría, y por eso se vigila: aceptaría una barra literal', () => {
    const doubled = asJs(literal.replace(`${BACKSLASH}.`, `${BACKSLASH}${BACKSLASH}.`));
    expect(doubled.test(`a@b${BACKSLASH}cd`)).toBe(true);
    expect(doubled.test('a@b.co')).toBe(false);
    const missing = asJs(literal.replace(`${BACKSLASH}.`, '.'));
    expect(missing.test('a@bxco')).toBe(true);
  });

  it('el runner se niega a continuar si standard_conforming_strings no está activado', () => {
    const base = {
      database: 'agenda_test', current_user: 'agenda_test_owner', session_user: 'agenda_test_owner', version_num: 160015, in_recovery: false,
      transaction_read_only: 'off', default_read_only: 'off', current_schema: 'public', effective_search_path: 'public',
      statement_timeout: '15s', lock_timeout: '5s', idle_in_transaction_session_timeout: '30s', application_name: 'agenda-schema-runner',
      rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true,
      can_use_public: true, can_create_public: true, owns_database: true, event_triggers: 0, owner_memberships: 0, app_role_exists: true,
    };
    expect(evaluateIdentity([{ ...base, standard_conforming_strings: 'on' }], 'apply')).toBeNull();
    for (const value of ['off', 'ON ', 'true', '', null, undefined]) expect(evaluateIdentity([{ ...base, standard_conforming_strings: value }], 'apply')).toBe('standard_conforming_strings_off');
  });
});
