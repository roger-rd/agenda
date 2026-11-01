'use strict';
const { writable } = require('./c8-gate.cjs');
const { templates } = require('./c8-ddl-templates.cjs');
/** @typedef {{schema:import('./c8-gate.cjs').Schema,runId:string,runSessions:number|null,
 * otherRolePids:readonly number[]|null,foreignLocks:boolean|null,numbackends:number|null,
 * baseline:number,ownBackends:number,baselineClean:boolean,error:boolean,target:boolean}} Evidence */
/** @param {Evidence} e */
function evaluate(e) {
  if (e.baselineClean !== true) return Object.freeze({ ok: false, code: 'baseline_dirty', exitCode: 2 });
  const positive = writable(e.schema, e.runId) && e.schema.empty === true && e.target === true && e.error === false &&
    e.runSessions === 0 && Array.isArray(e.otherRolePids) && e.otherRolePids.length === 0 && e.foreignLocks === false;
  const counts = [e.numbackends, e.baseline, e.ownBackends];
  const evaluable = counts.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);
  const veto = !evaluable || /** @type {number} */ (e.numbackends) > e.baseline + e.ownBackends;
  return Object.freeze({ ok: positive && !veto, code: positive && !veto ? 'ok' : 'cleanup_unknown', exitCode: positive && !veto ? 0 : 3 });
}
/** E1–E5 se vuelven a obtener dentro de la transacción con L0/L1 mantenidos.
 * La quiescencia debe observarse por el adaptador; aquí nunca se espera ni reintenta.
 * @param {{auth:import('./c8-sweep-policy.cjs').Authorization, inspect:()=>Evidence,
 * record:(statement:string)=>void}} deps */
function cleanup({ auth, inspect, record }) {
  let transaction = false;
  const lost = () => Object.freeze({ ok: false, code: 'lock_lost', exitCode: 3 });
  try {
    if (!auth.held()) return lost();
    const first = inspect(); const decision = evaluate(first);
    if (!auth.held()) return lost();
    if (!decision.ok) return decision;
    record('BEGIN'); transaction = true; record('SET LOCAL lock_timeout = 2000');
    const fresh = inspect();
    if (!auth.held() || !evaluate(fresh).ok || fresh.schema.name !== first.schema.name || fresh.runId !== first.runId ||
      fresh.schema.comment !== first.schema.comment) throw new Error('denied');
    const sql = templates(fresh.schema.name, fresh.runId).drop;
    if (!auth.held()) throw new Error('denied');
    record(sql);
    if (!auth.held()) throw new Error('denied');
    record('COMMIT'); transaction = false;
    return auth.held() ? Object.freeze({ ok: true, code: 'ok', exitCode: 0 }) : lost();
  } catch {
    if (transaction) { try { record('ROLLBACK'); } catch { /* Estado desconocido, nunca reintentar. */ } }
    return auth.held() ? Object.freeze({ ok: false, code: 'cleanup_unknown', exitCode: 3 }) : lost();
  }
}
module.exports = Object.freeze({ evaluate, cleanup });
