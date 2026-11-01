'use strict';
/** @param {unknown} value @returns {value is string} */
function valid(value) { return typeof value === 'string' && /^uow_[0-9]{10}_[a-z0-9]{6}_[0-9]{1,3}$(?![\s\S])/.test(value); }
/** @param {unknown} value @returns {value is string} */
function validRun(value) { return typeof value === 'string' && /^[a-f0-9]{32}$(?![\s\S])/.test(value); }
/** @param {unknown} value */
function quote(value) { if (!valid(value)) throw new Error('schema_invalid'); return `"${value}"`; }
/** UTC; entropía uniforme suministrada como seis caracteres base36.
 * @param {{now:()=>number, random:()=>string}} deps @param {number} index */
function generate({ now, random }, index) {
  const time = now(); const entropy = random();
  if (!Number.isSafeInteger(time) || !Number.isInteger(index) || index < 0 || index > 999 ||
      typeof entropy !== 'string' || !/^[a-z0-9]{6}$(?![\s\S])/.test(entropy)) throw new Error('schema_invalid');
  const date = new Date(time);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2099) throw new Error('schema_invalid');
  const stamp = date.toISOString().slice(2, 16).replace(/[-T:]/g, '');
  const name = `uow_${stamp}_${entropy}_${index}`;
  quote(name); return name;
}
/** @param {unknown} runId */
function mark(runId) { if (!validRun(runId)) throw new Error('run_invalid'); return `agenda-test/v1/run/${runId}`; }
/** @param {unknown} comment */
function parseMark(comment) {
  if (typeof comment !== 'string' || !comment.startsWith('agenda-test/v1/run/')) return null;
  const runId = comment.slice(19);
  return validRun(runId) && mark(runId) === comment ? runId : null;
}
module.exports = Object.freeze({ valid, validRun, quote, generate, mark, parseMark });
