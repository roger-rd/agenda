'use strict';
const { recognized, evaluate } = require('./c8-gate.cjs');
const { templates } = require('./c8-ddl-templates.cjs');
const { parseMark } = require('./c8-names.cjs');
/** @typedef {import('./c8-gate.cjs').Schema} Schema */
/** @typedef {{held:()=>boolean,lose:()=>void}} Authorization */
/** @typedef {{record:(statement:string)=>void,inspect:(schema:Schema)=>import('./c8-gate.cjs').Privileges,
 * roles:()=>{evaluable:boolean,membership:boolean,setMembership:boolean},
 * acquire:(schema:Schema)=>boolean,refresh:(schema:Schema)=>Schema,target:()=>boolean}} Client */
/** @param {Schema} schema */
function decide(schema) {
  if (!recognized(schema)) return 'ignore';
  if (schema.lease === 'live') return 'lease_live';
  if (schema.lease !== 'free' || !Number.isSafeInteger(schema.ageMs) || schema.ageMs < 0) return 'recovery_failed';
  return schema.ageMs >= 3600000 ? 'drop' : 'neutralize';
}
/** Modela órdenes con cliente inyectado: nunca contiene ejecutor SQL.
 * Una excepción COMMIT no demuestra rollback: se clasifica no-verificable.
 * @param {readonly Schema[]} schemas @param {{client:Client,auth:Authorization,now:()=>number,deadline?:number}} deps */
function recover(schemas, { client, auth, now, deadline }) {
  let dropped = 0; let neutralized = 0; let unchanged = 0; let unknown = 0;
  /** Estados por esquema intentado, sin nombres ni errores externos. */
  /** @type {string[]} */
  const states = [];
  /** @param {string} code @param {number} exitCode */
  const result = (code, exitCode) => Object.freeze({ code, exitCode, dropped, neutralized, unchanged, unknown,
    states: Object.freeze([...states]) });
  const start = now(); const items = schemas.filter(recognized);
  const end = deadline === undefined ? start + 30000 : Math.min(deadline, start + 30000);
  const permitted = () => auth.held() && client.target() === true && Number.isSafeInteger(end) && Number.isSafeInteger(now()) && now() - start >= 0 && now() < end;
  if (!auth.held()) return result('lock_lost', 3);
  if (!Number.isSafeInteger(start) || items.length > 10) return result('recovery_failed', 2);
  for (const original of items) {
    let transaction = false; let committing = false;
    try {
      if (!permitted()) throw new Error('denied');
      let schema = client.refresh(original);
      const action = decide(schema);
      if (action === 'lease_live') return result('lease_live', 2);
      if (!['drop', 'neutralize'].includes(action) || client.acquire(schema) !== true) throw new Error('denied');
      schema = client.refresh(schema);
      if (!recognized(schema) || !schema.leaseOwned || decide(schema) !== action) throw new Error('denied');
      const t = templates(schema.name, /** @type {string} */ (parseMark(schema.comment)));
      const leaseHeld = () => {
        const fresh = client.refresh(schema);
        return recognized(fresh) && fresh.name === schema.name && fresh.comment === schema.comment && fresh.leaseOwned === true;
      };
      if (!permitted()) throw new Error('denied');
      client.record('BEGIN'); transaction = true;
      client.record('SET LOCAL lock_timeout = 2000');
      if (action === 'drop') {
        const fresh = client.refresh(schema);
        if (!permitted() || !recognized(fresh) || fresh.name !== schema.name || fresh.comment !== schema.comment ||
          fresh.leaseOwned !== true || fresh.empty !== true || decide(fresh) !== 'drop') throw new Error('denied');
        client.record(t.drop);
      } else {
        for (const statement of t.revokes) { if (!leaseHeld() || !permitted()) throw new Error('denied'); client.record(statement); }
        if (!leaseHeld() || !permitted() || !evaluate([schema], client.inspect, 'P6b', client.roles()).ok) throw new Error('denied');
      }
      if (!permitted()) throw new Error('denied');
      committing = true; client.record('COMMIT'); transaction = false;
      if (!auth.held()) return result('lock_lost', 3);
      if (action === 'drop') { dropped++; states.push('dropped'); }
      else { neutralized++; states.push('neutralizado-y-verificado'); }
    } catch {
      if (transaction) {
        try {
          client.record('ROLLBACK');
          if (committing) { unknown++; states.push('no-verificable'); }
          else { unchanged++; states.push('sin-cambios(rollback)'); }
        } catch { unknown++; states.push('no-verificable'); }
      } else { unknown++; states.push('no-verificable'); }
      return result(auth.held() ? 'recovery_failed' : 'lock_lost', auth.held() ? 2 : 3);
    }
  }
  return result('ok', 0);
}
module.exports = Object.freeze({ decide, recover });
