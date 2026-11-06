'use strict';
/**
 * Closed, deterministic evidence-state vocabulary. Pure data and functions, no I/O.
 *
 * Two independent dimensions:
 *  - structural: how far the data can be trusted as a complete, unambiguous record
 *    (structurally_valid < incomplete < unresolved < invalid, ordered by severity);
 *  - demonstration: whether the SQL behind it was validated against a real server. Only an
 *    attestation layer (not part of this module) may ever raise it; fromReasons defaults to
 *    not_demonstrated and nothing here can turn structural validity into authorization.
 *
 * Aggregation is conservative: the worst structural state wins, reasons are the sorted union,
 * and a set is demonstrated only if every member is. Verdicts are branded (private WeakSet), so a
 * forged or cloned object is never accepted by combine or isEligible.
 */
const STRUCTURAL = Object.freeze(['structurally_valid', 'incomplete', 'unresolved', 'invalid']);
const DEMONSTRATION = Object.freeze(['demonstrated', 'not_demonstrated']);
const STATUS = Object.freeze(['valid_demonstrated', 'not_demonstrated', 'incomplete', 'unresolved', 'invalid']);
/** Stable reason codes and the structural state each one implies. */
const REASONS = Object.freeze({
  hostile_input: 'invalid', malformed_observation: 'invalid', unknown_query: 'invalid', stale_sql: 'invalid',
  params_mismatch: 'invalid', duplicate_observation: 'invalid', duplicate_row: 'invalid', duplicate_identity: 'invalid',
  rows_invalid: 'invalid', column_shape: 'invalid', column_type: 'invalid', null_contract_violation: 'invalid',
  number_out_of_range: 'invalid', decimal_not_canonical: 'invalid', enum_violation: 'invalid', cardinality: 'invalid',
  no_observations: 'unresolved', query_missing: 'unresolved', query_failed: 'unresolved', unmapped_class: 'unresolved',
  null_unknown: 'unresolved',
  truncated: 'incomplete', depth_frontier: 'incomplete',
});
const MAX_REASONS = 64;
const issued = new WeakSet();

/** @param {string} state */
function severity(state) {
  const index = STRUCTURAL.indexOf(state);
  if (index < 0) throw new TypeError('evidence_states_input');
  return index;
}
/** @param {string} code @returns {string} */
function reasonState(code) {
  if (typeof code !== 'string' || !Object.hasOwn(REASONS, code)) throw new TypeError('evidence_states_input');
  return /** @type {Record<string,string>} */ (REASONS)[code];
}
/** @param {string} structural @param {readonly string[]} reasons @param {string} demonstration */
function seal(structural, reasons, demonstration) {
  const status = structural !== 'structurally_valid' ? structural
    : demonstration === 'demonstrated' ? 'valid_demonstrated' : 'not_demonstrated';
  const verdict = Object.freeze({ structural, demonstration, status, reasons: Object.freeze([...reasons]),
    eligible: structural === 'structurally_valid' && demonstration === 'demonstrated' });
  issued.add(verdict);
  return verdict;
}
/** @param {readonly string[]} codes @param {{demonstration?: string}} [options] */
function fromReasons(codes, options) {
  if (!Array.isArray(codes) || codes.length > MAX_REASONS) throw new TypeError('evidence_states_input');
  const demonstration = options === undefined || options.demonstration === undefined ? 'not_demonstrated' : options.demonstration;
  if (!DEMONSTRATION.includes(demonstration)) throw new TypeError('evidence_states_input');
  const unique = [...new Set(codes.map(code => (reasonState(code), code)))].sort();
  const structural = unique.reduce((worst, code) => (severity(reasonState(code)) > severity(worst) ? reasonState(code) : worst), 'structurally_valid');
  return seal(structural, unique, demonstration);
}
/** @param {readonly unknown[]} verdicts */
function combine(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.some(v => !isVerdict(v))) throw new TypeError('evidence_states_input');
  if (verdicts.length === 0) return fromReasons(['no_observations']);
  const list = /** @type {readonly any[]} */ (verdicts);
  const reasons = [...new Set(list.flatMap(v => v.reasons))].sort();
  const structural = list.reduce((worst, v) => (severity(v.structural) > severity(worst) ? v.structural : worst), 'structurally_valid');
  const demonstration = list.every(v => v.demonstration === 'demonstrated') ? 'demonstrated' : 'not_demonstrated';
  return seal(structural, reasons, demonstration);
}
/** @param {unknown} value */
function isVerdict(value) { return typeof value === 'object' && value !== null && issued.has(value); }
/** Structural validity AND demonstration are both required; C3-B can never produce the latter. @param {unknown} value */
function isEligible(value) { return isVerdict(value) && /** @type {any} */ (value).eligible === true; }

module.exports = Object.freeze({ STRUCTURAL, DEMONSTRATION, STATUS, REASONS, fromReasons, combine, isVerdict, isEligible, severity, reasonState });
