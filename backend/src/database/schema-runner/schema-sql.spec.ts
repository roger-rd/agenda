import { createHash } from 'node:crypto';
import { TABLE_ORDER } from '../migrations/initial-schema.statements';
import {
  ALL_STATEMENTS, APPLICATION_PRIVILEGES_SQL, CONTROL_STATEMENTS, LOCK_STATEMENTS, MIGRATIONS_PRIVILEGES_SQL, READ_ONLY_QUERIES,
  REVOKE_MIGRATIONS_SEQUENCE_SQL, REVOKE_MIGRATIONS_TABLE_SQL, TABLE_LOCK_SQL, TABLES_EMPTY_SQL, TRANSACTION_CLOSED_SQL, WRITE_STATEMENTS, TABLE_LOCK_STATEMENTS,
} from './schema-sql';

const PINNED: Record<string, string> = {
  IDENTITY_SQL: 'eef357730288614d63b630965b90f4bb5652044361970415820deedca1c6390c',
  RELATIONS_SQL: 'cba74027fcb17e417a750485ac44ddfd12665108be2e74fc4010513839a0ccbb',
  FOREIGN_OBJECTS_SQL: 'fdfa2b1173082954659ed7733f99ca94c5d25bbd558b2335102df6aa4e39b19b',
  MIGRATIONS_COLUMNS_SQL: 'de1cae131b2b390855e0c3c22cdc4356c9a86fea44ca9a0ea368e9ec65d30219',
  EXECUTED_SQL: 'cb15f00ca8b9b2fb12fe9a8628a1ea6ef728cd9ad232a64298c2bfd5cd3f44bc',
  MIGRATIONS_PRIVILEGES_SQL: 'b3d103bb65732edbcd333c8a987bc6accda6d9c377d30f773954dae75d7664e4',
  MIGRATIONS_ACL_SQL: '0c4024aa2bbab0516ea2f577255444c31273d476872f4c9d38e981b81a3730e7',
  APPLICATION_PRIVILEGES_SQL: '2022924dee1bd314c56e380d1a2a06a655afd2440a1eddbebbdfe09a0a8c5b23',
  TABLE_LOCK_SQL: '925cd78dcad020c20d2a07d4a1601fb6ea1e6398649ffda07bcfbd0691b23621',
  TABLES_EMPTY_SQL: '7686c52620904d3b565b7204224ce872c9f07a4ddd4d69d17d49cac4dcc16a7d',
  TRANSACTION_CLOSED_SQL: '4208bee0ecb74d59b05be68655723663cd1bfd1ecbf374410e98da9670cc1a7e',
  LOCK_SQL: '3c0bda1b9a8fefaea0108077aa3182c999667daef4d5358cd1d764d69b026bb0',
  UNLOCK_SQL: 'fdedfdff4885636e341ac8d4f30fbd8e17bd8b8c10d37b46167697839a429205',
  BEGIN_READ_ONLY_SQL: '884b307eaf68c26c0ee2c95bfebc014c633d0d00e03a5e60391e7b2efc4dcd48',
  ROLLBACK_SQL: '587fa628a9fe4642ac0e22825a97e81d388af674f7251a9fb699f96901dcb710',
  REVOKE_MIGRATIONS_TABLE_SQL: '049094e413a86c040a85ac1faa52cde66d36a2c617e04ae48ac768e51f08622b',
  REVOKE_MIGRATIONS_SEQUENCE_SQL: 'cd52838d41e1f9c11aafdfd19ca1607fff31ff74bd78d5cb6df770c1e48b125e',
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const withoutLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');

describe('SQL fijado del runner de esquema', () => {
  it('cada sentencia coincide con su SHA-256 fijado y no hay sentencias sin fijar', () => {
    expect(Object.keys(ALL_STATEMENTS).sort()).toEqual(Object.keys(PINNED).sort());
    for (const [name, text] of Object.entries(ALL_STATEMENTS)) expect([name, sha(text)]).toEqual([name, PINNED[name]]);
  });

  it('las consultas son de solo lectura: ninguna palabra de escritura fuera de literales', () => {
    const forbidden = /\b(insert|update|delete|truncate|create|drop|alter|grant|revoke|copy|call|do|vacuum|lock|set|reset|listen|notify)\b/i;
    for (const [name, text] of Object.entries(READ_ONLY_QUERIES)) {
      expect([name, /^SELECT\b/.test(text)]).toEqual([name, true]);
      expect([name, text.includes(';')]).toEqual([name, false]);
      expect([name, forbidden.test(withoutLiterals(text).replace(/\bpg_(?:try_)?advisory\w*/g, ''))]).toEqual([name, false]);
    }
  });

  it('las únicas escrituras son los dos REVOKE exactos, separados de toda verificación', () => {
    expect(WRITE_STATEMENTS).toEqual({
      REVOKE_MIGRATIONS_TABLE_SQL: 'REVOKE ALL ON TABLE "public"."schema_migrations" FROM "agenda_test_app"',
      REVOKE_MIGRATIONS_SEQUENCE_SQL: 'REVOKE ALL ON SEQUENCE "public"."schema_migrations_id_seq" FROM "agenda_test_app"',
    });
    expect(REVOKE_MIGRATIONS_TABLE_SQL).not.toMatch(/\bPUBLIC\b/);
    expect(REVOKE_MIGRATIONS_SEQUENCE_SQL).not.toMatch(/\bPUBLIC\b/);
    for (const text of Object.values({ ...READ_ONLY_QUERIES, ...LOCK_STATEMENTS, ...CONTROL_STATEMENTS })) expect(text.replace(/WITH GRANT OPTION/g, '')).not.toMatch(/\b(?:REVOKE|GRANT)\b/);
  });

  it('los privilegios efectivos del rol de aplicación se calculan con funciones que incluyen herencia y PUBLIC', () => {
    expect(MIGRATIONS_PRIVILEGES_SQL).toContain('has_table_privilege($1::name');
    expect(MIGRATIONS_PRIVILEGES_SQL).toContain('has_any_column_privilege($1::name');
    expect(MIGRATIONS_PRIVILEGES_SQL).toContain('has_sequence_privilege($1::name');
    expect(MIGRATIONS_PRIVILEGES_SQL).toContain("p.privilege || ' WITH GRANT OPTION'");
    expect(MIGRATIONS_PRIVILEGES_SQL).not.toMatch(/relacl|aclexplode|agenda_test_app/);
    expect(APPLICATION_PRIVILEGES_SQL).toContain('has_table_privilege($1::name');
    expect(APPLICATION_PRIVILEGES_SQL).not.toContain('agenda_test_app');
  });

  it('la prueba de transacción cerrada no depende solo del identificador de transacción', () => {
    expect(TRANSACTION_CLOSED_SQL).toContain('pg_current_xact_id_if_assigned()');
    expect(TRANSACTION_CLOSED_SQL).toContain('backend_xid');
    expect(TRANSACTION_CLOSED_SQL).toContain('xact_start IS NOT DISTINCT FROM');
    expect(TRANSACTION_CLOSED_SQL).toContain('pg_backend_pid()');
  });

  it('el vacío de tablas cubre exactamente las 8 tablas en orden', () => {
    expect([...TABLE_ORDER]).toHaveLength(8);
    const columns = [...TABLES_EMPTY_SQL.matchAll(/AS "([a-z_]+)"/g)].map(m => m[1]);
    expect(columns).toEqual([...TABLE_ORDER]);
    for (const table of TABLE_ORDER) expect(TABLES_EMPTY_SQL).toContain(`NOT EXISTS (SELECT 1 FROM "public"."${table}")`);
  });

  it('G. el bloqueo de revert: ACCESS EXCLUSIVE sobre las ocho tablas, calificadas, una vez cada una y en el orden fijo', () => {
    expect(TABLE_LOCK_SQL).toBe(`LOCK TABLE ${TABLE_ORDER.map(t => `"public"."${t}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
    const quoted = [...TABLE_LOCK_SQL.matchAll(/"public"\."([a-z_]+)"/g)].map(m => m[1]);
    expect(quoted).toEqual([...TABLE_ORDER]);
    expect(new Set(quoted).size).toBe(8);
    expect(TABLE_LOCK_SQL.endsWith(' IN ACCESS EXCLUSIVE MODE')).toBe(true);
    expect(TABLE_LOCK_SQL).not.toMatch(/;|NOWAIT|\bSHARE\b|\bROW\b|schema_migrations|\bONLY\b|\$/);
    expect(TABLE_LOCK_SQL.startsWith('LOCK TABLE ')).toBe(true);
    expect(Object.values(READ_ONLY_QUERIES)).not.toContain(TABLE_LOCK_SQL);
    expect(Object.values(TABLE_LOCK_STATEMENTS)).toEqual([TABLE_LOCK_SQL]);
  });

  it('el rol y las tablas viajan como parámetros, nunca interpolados en las consultas', () => {
    for (const text of Object.values(READ_ONLY_QUERIES)) expect(text).not.toContain('agenda_test_app');
    expect(ALL_STATEMENTS.LOCK_SQL).toContain('$1::bigint');
    expect(ALL_STATEMENTS.UNLOCK_SQL).toContain('$1::bigint');
  });
});
