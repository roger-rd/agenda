'use strict';
const { validate } = require('./c8-target.cjs');
const { evaluate } = require('./c8-gate.cjs');
const { recover } = require('./c8-sweep-policy.cjs');
const { validate: validateBudget } = require('./c8-budget.cjs');
/** L0 monotónico. Observaciones desconocidas y pérdida invalidan todo el run.
 * observe debe representar pg_locks, incluso para el hijo (otro pid).
 * No hay temporizador, conexión, señal ni SQL ejecutado en este módulo.
 * @param {{observe:()=>{held:boolean,pid:number}|null,terminate:()=>void,pid:number,child?:boolean}} deps */
function authorization({ observe, terminate, pid, child = false }) {
  let state = 'new'; let terminated = false;
  function lose() {
    state = 'unknown';
    if (!terminated) { terminated = true; terminate(); }
  }
  function held() {
    if (state !== 'held') return false;
    try {
      const value = observe();
      if (!value || value.held !== true || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        (child ? value.pid === pid : value.pid !== pid)) lose();
    } catch { lose(); }
    return state === 'held';
  }
  /** @param {boolean} acquired */
  function acquire(acquired) {
    if (state !== 'new') return false;
    if (acquired !== true) { state = 'busy'; return false; }
    state = 'held'; return held();
  }
  return Object.freeze({ held, lose, acquire, state: () => state });
}
/** @typedef {{phase:(phase:string)=>boolean,target:unknown,appTarget:unknown,
 * tryL0:()=>boolean,auth:ReturnType<typeof authorization>,
 * schemas:()=>readonly import('./c8-gate.cjs').Schema[],
 * client:import('./c8-sweep-policy.cjs').Client,now:()=>number,
 * budget:{wrapper:number,child:number,app:number,preflight:number},
 * baseline:()=>{otherRolePids:readonly number[]|null,foreignLease:boolean|null}}} Dependencies */
/** P1–P5/P9 son evidencias explícitas del adaptador, nunca valores por defecto.
 * El plan solo habilita la futura integración: no lanza Jest.
 * @param {Dependencies} deps */
function preflight(deps) {
  const { auth } = deps;
  /** @param {string} code @param {number} exitCode */
  const result = (code, exitCode) => Object.freeze({ code, exitCode, executable: exitCode === 0 });
  const lost = () => result('lock_lost', 3);
  const start = deps.now();
  const withinBudget = () => Number.isSafeInteger(start) && Number.isSafeInteger(deps.now()) && deps.now() >= start && deps.now() - start < 30000;
  try {
    for (const phase of ['P1', 'P2', 'P3', 'P4', 'P5']) {
      if (!deps.phase(phase) || !withinBudget()) return result('preflight_failed', 2);
      if (phase === 'P1') { validate(deps.target, 'owner'); validate(deps.appTarget, 'app'); }
    }
    if (!auth.acquire(deps.tryL0())) return auth.state() === 'unknown' ? lost() : result('run_in_progress', 2);
    if (!deps.phase('P6a') || !auth.held()) return auth.held() ? result('preflight_failed', 2) : lost();
    const structural = evaluate(deps.schemas(), deps.client.inspect, 'P6a', deps.client.roles());
    if (!auth.held()) return lost();
    if (!structural.ok) return result(structural.code, 2);
    if (!deps.phase('P7') || !auth.held()) return auth.held() ? result('preflight_failed', 2) : lost();
    const baseline = deps.baseline();
    validateBudget(deps.budget);
    if (!auth.held()) return lost();
    if (!Array.isArray(baseline.otherRolePids) || baseline.otherRolePids.length !== 0) return result('baseline_dirty', 2);
    if (baseline.foreignLease !== false) return result('lease_live', 2);
    if (!deps.phase('P8') || !auth.held() || !withinBudget()) return auth.held() ? result('recovery_failed', 2) : lost();
    const recovery = recover(deps.schemas(), { ...deps, deadline: start + 30000 });
    if (!auth.held()) return lost();
    if (recovery.exitCode !== 0) return result(recovery.code, recovery.exitCode);
    if (!deps.phase('P6b') || !auth.held()) return auth.held() ? result('preflight_failed', 2) : lost();
    const gate = evaluate(deps.schemas(), deps.client.inspect, 'P6b', deps.client.roles());
    if (!auth.held()) return lost();
    if (!gate.ok) return result(gate.code, 2);
    if (!deps.phase('P9') || !auth.held() || !withinBudget()) return auth.held() ? result('preflight_failed', 2) : lost();
    return result('ok', 0);
  } catch { return auth.state() === 'unknown' ? lost() : result('preflight_failed', 2); }
}
module.exports = Object.freeze({ authorization, preflight });
