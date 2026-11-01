'use strict';
const { templates } = require('./c8-ddl-templates.cjs');
/** Comparación exacta contra gramática finita generada: no normaliza espacios,
 * comentarios ni identificadores. No es un parser SQL de propósito general.
 * @param {unknown} sql @param {string} name @param {string} runId */
function allows(sql, name, runId) {
  try {
    const t = templates(name, runId);
    return typeof sql === 'string' && [t.create, t.comment, ...t.grants, ...t.revokes, t.drop].includes(sql);
  } catch { return false; }
}
module.exports = Object.freeze({ allows });
