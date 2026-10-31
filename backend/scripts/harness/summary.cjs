'use strict';
const { EXIT, MODES, SUMMARY_STATUSES, SUMMARY_PHASES, SUMMARY_PREFIX } = require('./constants.cjs');
const { CATALOG, HarnessError } = require('./harness-error.cjs');
// ok=0; not_ready=2; failed=1; aborted=130/143; error=3/4.
/** @type {Readonly<Record<string, readonly number[]>>} */
const STATUS_EXITS = Object.freeze({ ok: Object.freeze([EXIT.OK]), not_ready: Object.freeze([EXIT.PRECONDITION]),
  failed: Object.freeze([EXIT.FAILED]), aborted: Object.freeze([EXIT.SIGINT, EXIT.SIGTERM]),
  error: Object.freeze([EXIT.CLEANUP, EXIT.INTEGRITY]) });
/** @typedef {{schemaVersion:1, tool:'test-db', mode:string, status:string, exitCode:number, code:string|null, phase:string, durationMs:number}} Summary */
const KEYS = Object.freeze(['schemaVersion', 'tool', 'mode', 'status', 'exitCode', 'code', 'phase', 'durationMs']);
/** @param {unknown} obj @returns {asserts obj is Summary} */
function validateSummary(obj) {
  const fail = () => { throw new HarnessError('H-SUMMARY-INVALID'); };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(obj))) return fail();
  if (Reflect.ownKeys(obj).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(obj, key)) ||
      Object.values(Object.getOwnPropertyDescriptors(obj)).some(d => !Object.hasOwn(d, 'value'))) return fail();
  const value = /** @type {Summary} */ (obj);
  if (value.schemaVersion !== 1 || value.tool !== 'test-db' || !MODES.includes(value.mode) ||
      !SUMMARY_STATUSES.includes(value.status) || !SUMMARY_PHASES.includes(value.phase) ||
      !Number.isInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 86400000 ||
      (value.code !== null && (typeof value.code !== 'string' || !Object.hasOwn(CATALOG, value.code))) ||
      !STATUS_EXITS[/** @type {keyof typeof STATUS_EXITS} */ (value.status)].includes(value.exitCode)) return fail();
}
/** @param {Omit<Summary, 'schemaVersion'|'tool'>} input @returns {Readonly<Summary>} */
function buildSummary(input) {
  const summary = { ...input, schemaVersion: 1, tool: 'test-db' };
  validateSummary(summary);
  return Object.freeze(summary);
}
/** @param {unknown} summary @returns {string} */
function formatSummaryLine(summary) {
  validateSummary(summary);
  // Orden canónico incluso cuando el objeto de entrada tenga otro orden de inserción.
  return SUMMARY_PREFIX + JSON.stringify({ schemaVersion: summary.schemaVersion, tool: summary.tool,
    mode: summary.mode, status: summary.status, exitCode: summary.exitCode, code: summary.code,
    phase: summary.phase, durationMs: summary.durationMs });
}
module.exports = Object.freeze({ buildSummary, validateSummary, formatSummaryLine, STATUS_EXITS });
