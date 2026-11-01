import { templates } from '../../scripts/harness/c8-ddl-templates.cjs';
import { NAME, RUN } from './support/c8-fakes';
describe('C8 plantillas inertes', () => {
  it('owner, marca, mínimos y DROP restrictivo', () => {
    const t = templates(NAME, RUN);
    expect(t.create).toBe(`CREATE SCHEMA "${NAME}" AUTHORIZATION "agenda_test_owner"`);
    expect(t.comment).toBe(`COMMENT ON SCHEMA "${NAME}" IS 'agenda-test/v1/run/${RUN}'`);
    expect(t.drop).toBe(`DROP SCHEMA "${NAME}"`);
    expect(t.grants).toEqual([`GRANT USAGE ON SCHEMA "${NAME}" TO "agenda_test_app"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${NAME}" TO "agenda_test_app"`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${NAME}" TO "agenda_test_app"`]);
    expect(JSON.stringify(t)).not.toMatch(/CASCADE|GRANT OPTION/);
    expect(Object.isFrozen(t)).toBe(true); expect(Object.isFrozen(t.revokes)).toBe(true); expect(Object.isFrozen(t.grants)).toBe(true);
  });
  it('revoca todas las clases a ambos destinatarios', () => {
    const t = templates(NAME, RUN); expect(t.revokes).toHaveLength(10);
    for (const role of ['"agenda_test_app"', 'PUBLIC']) {
      expect(t.revokes).toContain(`REVOKE ALL PRIVILEGES ON SCHEMA "${NAME}" FROM ${role}`);
      for (const kind of ['TABLES', 'SEQUENCES', 'FUNCTIONS', 'PROCEDURES']) {
        expect(t.revokes).toContain(`REVOKE ALL PRIVILEGES ON ALL ${kind} IN SCHEMA "${NAME}" FROM ${role}`);
      }
    }
  });
  it.each(['public', NAME + '\n', NAME + '";DROP SCHEMA public', NAME.toUpperCase(), '\0'])('no interpola %j', name => {
    expect(() => templates(name, RUN)).toThrow('schema_invalid');
  });
});
