import { allows } from '../../scripts/harness/c8-ddl-filter.cjs';
import { templates } from '../../scripts/harness/c8-ddl-templates.cjs';
import { NAME, RUN, seeded } from './support/c8-fakes';
const t = templates(NAME, RUN);
const statements = [t.create, t.comment, ...t.grants, ...t.revokes, t.drop];
describe('C8 filtro cerrado', () => {
  it.each(['SELECT 1', 'DROP SCHEMA x CASCADE', `DROP TABLE "${NAME}".items`,
    `${t.drop};${t.create}`, `${t.drop}; SELECT 1`, undefined, false, [], Object(t.drop)])('rechaza SQL fuera de la lista exacta %#', sql => {
    expect(allows(sql, NAME, RUN)).toBe(false);
  });
  it.each(['leading-space', 'trailing-space', 'leading-newline', 'trailing-newline', 'double-space', 'lowercase', 'mixed-case'] as const)('no normaliza %s en ninguna plantilla', change => {
    for (const sql of statements) {
      const altered = change === 'leading-space' ? ` ${sql}` : change === 'trailing-space' ? `${sql} ` :
        change === 'leading-newline' ? `\n${sql}` : change === 'trailing-newline' ? `${sql}\n` :
        change === 'double-space' ? sql.replace(' ', '  ') : change === 'lowercase' ? sql.toLowerCase() :
        sql[0].toLowerCase() + sql.slice(1);
      expect(altered).not.toBe(sql); expect(allows(altered, NAME, RUN)).toBe(false);
      expect(allows(sql, NAME, RUN)).toBe(true);
    }
  });
  it('cada plantilla pertenece exactamente al esquema validado', () => {
    const otherName = NAME.replace(/1$/, '2'); const other = templates(otherName, RUN);
    for (const sql of [other.create, other.comment, ...other.grants, ...other.revokes, other.drop]) {
      expect(allows(sql, otherName, RUN)).toBe(true); expect(allows(sql, NAME, RUN)).toBe(false);
    }
    for (const sql of statements) expect(allows(sql, otherName, RUN)).toBe(false);
  });
  it('COMMENT pertenece al runId exacto; un runId inválido rechaza todas las plantillas', () => {
    const otherRun = 'b'.repeat(32); const other = templates(NAME, otherRun);
    expect(allows(other.comment, NAME, otherRun)).toBe(true); expect(allows(other.comment, NAME, RUN)).toBe(false);
    expect(allows(t.comment, NAME, otherRun)).toBe(false);
    // Solo COMMENT codifica runId. Las demás sentencias son idénticas entre runs.
    for (const sql of statements) {
      expect(allows(sql, NAME, RUN + '\n')).toBe(false); expect(allows(sql, 'public', RUN)).toBe(false);
    }
  });
  it.each(statements)('permite %s', sql => { expect(allows(sql, NAME, RUN)).toBe(true); });
  it.each(['; SELECT 1', ';', ' --comment', ' /* comment */', ' CASCADE', ' WITH GRANT OPTION', '\0', '\n', ' $$x$$'])('rechaza sufijo %j', suffix => {
    for (const sql of statements) expect(allows(sql + suffix, NAME, RUN)).toBe(false);
  });
  it.each(['SET ROLE agenda_test_owner', 'SET SESSION AUTHORIZATION agenda_test_owner', 'COPY x TO STDOUT',
    'SELECT pg_sleep(1)', 'DO $$BEGIN END$$', 'DROP SCHEMA public', null, 0, {}, ''])('rechaza ajenos %#', sql => {
    expect(allows(sql, NAME, RUN)).toBe(false);
  });
  it('no acepta otros esquemas ni ambigüedad con semilla fija', () => {
    const random = seeded();
    for (const sql of statements) {
      expect(allows(sql.replace(NAME, NAME.replace(/1$/, '2')), NAME, RUN)).toBe(false);
      for (let i = 0; i < 20; i++) {
        const at = random() % sql.length;
        expect(allows(sql.slice(0, at) + '\0' + sql.slice(at), NAME, RUN)).toBe(false);
      }
    }
  });
});
