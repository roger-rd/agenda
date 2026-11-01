'use strict';
const { quote, mark } = require('./c8-names.cjs');
/** Datos inertes. PROCEDURES: comprobar compatibilidad/privilegios en C8.2/C8.3.
 * No existe variante CASCADE: vaciado y su evidencia quedan fuera de C8.1.
 * @param {string} name @param {string} runId */
function templates(name, runId) {
  const schema = quote(name); const marker = mark(runId);
  const revokes = [];
  for (const role of ['"agenda_test_app"', 'PUBLIC']) {
    for (const object of [`SCHEMA ${schema}`, ...['TABLES', 'SEQUENCES', 'FUNCTIONS', 'PROCEDURES'].map(kind => `ALL ${kind} IN SCHEMA ${schema}`)]) {
      revokes.push(`REVOKE ALL PRIVILEGES ON ${object} FROM ${role}`);
    }
  }
  return Object.freeze({ create: `CREATE SCHEMA ${schema} AUTHORIZATION "agenda_test_owner"`,
    comment: `COMMENT ON SCHEMA ${schema} IS '${marker}'`,
    grants: Object.freeze([`GRANT USAGE ON SCHEMA ${schema} TO "agenda_test_app"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO "agenda_test_app"`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO "agenda_test_app"`]),
    revokes: Object.freeze(revokes), drop: `DROP SCHEMA ${schema}` });
}
module.exports = Object.freeze({ templates });
