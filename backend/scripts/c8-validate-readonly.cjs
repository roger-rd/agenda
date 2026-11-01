'use strict';
// Intentionally manual, absent from package.json. No dependency is loaded on rejection.
const AUTHORIZATION = 'C8_2B_EXPLICIT_AUTHORIZATION';
const LOCK_AUTHORIZATION = 'C8_2B_LOCKS_AUTHORIZED';
/** @typedef {{query:(id:string,params?:unknown[])=>Promise<unknown>,end:()=>Promise<unknown>,pid:number}} Client */
/** @typedef {{connector?:{connect:(role:'owner'|'app',credentials:unknown)=>Promise<Client>},
 * readEnvFiles?:()=>Promise<{owner:Record<string,unknown>,app:Record<string,unknown>}>,
 * now?:()=>number,stdout?:(line:string)=>void}} Dependencies */
/** No environment provider is wired in C8.2-A. Authorized execution still needs
 * explicit injected dependencies; installing a production provider belongs to a later stage.
 * @param {string[]} argv @param {Dependencies} [deps] */
async function main(argv, deps = {}) {
  const output = deps.stdout ?? (line => process.stdout.write(line));
  /** @param {string} status @param {string} code @param {number} exitCode @param {number} [checks] */
  const finish = (status, code, exitCode, checks = 0) => {
    output(`AGENDA_C8_VALIDATE ${JSON.stringify(status === 'disabled' ? { status, code } : { status, code, checks })}\n`);
    return exitCode;
  };
  const allowed = ['--real', `--confirm=${AUTHORIZATION}`, '--level-b', `--confirm-b=${LOCK_AUTHORIZATION}`];
  const hasB = argv.includes('--level-b');
  if (!Array.isArray(argv) || new Set(argv).size !== argv.length || argv.some(x => !allowed.includes(x)) ||
      !argv.includes('--real') || !argv.includes(`--confirm=${AUTHORIZATION}`) ||
      hasB !== argv.includes(`--confirm-b=${LOCK_AUTHORIZATION}`)) return finish('disabled', 'stage_not_authorized', 2);
  if (!deps.connector || !deps.readEnvFiles) return finish('disabled', 'stage_not_authorized', 2);
  const { mapIdentity, mapServer, mapRoleAttrs, mapGlobalDefaultAcl, mapSchemas, mapRoles,
    mapPrivileges, mapSessions, mapNumbackends, classifyPgError, L0_KEY, observeL0 } = require('./harness/c8-pg-adapter.cjs');
  const { evaluate, evaluateGlobalDefaultAcl, recognized } = require('./harness/c8-gate.cjs');
  const { TARGET } = require('./harness/c8-target.cjs');
  /** @type {Client[]} */ const clients = [];
  let checks = 0; let code = 'validation_failed'; let ok = false;
  const now = deps.now ?? Date.now; const start = now();
  /** @param {boolean} pass */
  const check = pass => {
    if (!pass || !Number.isSafeInteger(start) || !Number.isSafeInteger(now()) || now() < start || now() - start >= 30000) throw null;
    checks++;
  };
  try {
    const credentials = await deps.readEnvFiles();
    const owner = await deps.connector.connect('owner', { ...credentials.owner, level: 'A' }); clients.push(owner);
    const app = await deps.connector.connect('app', { ...credentials.app, level: 'A' }); clients.push(app);
    for (const [client, role] of /** @type {[Client,'owner'|'app'][]} */ ([[owner, 'owner'], [app, 'app']])) {
      check(mapIdentity(await client.query('identity'), role) !== null);
      check(mapServer(await client.query('server')) !== null);
      check(mapRoleAttrs(await client.query('role_attrs')) !== null);
    }
    const attrs = mapRoleAttrs(await owner.query('role_attrs'));
    check(attrs !== null);
    const roles = mapRoles(await owner.query('role_membership', [TARGET.app]), await owner.query('auth_members'), /** @type {number} */ (attrs?.appOid));
    check(roles.evaluable && !roles.membership && !roles.setMembership);
    const global = evaluateGlobalDefaultAcl(mapGlobalDefaultAcl(await owner.query('default_acl_global')));
    if (!global.ok) { code = global.code; throw null; } checks++;
    const schemas = mapSchemas(await owner.query('schemas'), now()); check(schemas !== null);
    for (const schema of (schemas ?? []).filter(recognized)) {
      const p = mapPrivileges(await owner.query('effective', [schema.name, TARGET.app]),
        await owner.query('effective_coverage', [schema.name]), await owner.query('default_acl_schema', [schema.name]));
      const gate = evaluate([schema], () => p, 'P6b', roles);
      if (!gate.ok) { code = gate.code; throw null; } checks++;
    }
    const sessions = mapSessions(await owner.query('sessions'), clients.map(c => c.pid));
    check(sessions.otherRolePids !== null && sessions.otherRolePids.length === 0);
    check(mapNumbackends(await owner.query('numbackends')) !== null);
    const round = await owner.query('key_roundtrip', [L0_KEY]);
    check(Array.isArray(round) && round.length === 1 && round[0].key === L0_KEY && round[0].reconstructed === L0_KEY &&
      round[0].classid === (BigInt(L0_KEY) >> 32n).toString() && round[0].objid === (BigInt(L0_KEY) & 4294967295n).toString());
    await app.query('timeout_probe', [0.001]); checks++;
    // The negative probe deliberately poisons/destroys app; run it after all app reads.
    let probeError;
    try { await app.query('probe_42809', [TARGET.app]); } catch (err) {
      // ReadOnlyClient exposes sanitized SQLSTATE as sqlstate, never a driver message.
      probeError = err && typeof err === 'object' && 'sqlstate' in err ? { code: err.sqlstate } : err;
    }
    check(classifyPgError(probeError, 'probe-42809').kind === 'expected');
    if (hasB) {
      const holder = await deps.connector.connect('owner', { ...credentials.owner, level: 'B' }); clients.push(holder);
      const observer = await deps.connector.connect('app', { ...credentials.app, level: 'B' }); clients.push(observer);
      const contender = await deps.connector.connect('app', { ...credentials.app, level: 'B' }); clients.push(contender);
      const db = await owner.query('database', [TARGET.app]);
      check(Array.isArray(db) && db.length === 1 && Number.isSafeInteger(db[0].oid));
      const databaseOid = /** @type {{oid:number}[]} */ (db)[0].oid;
      const acquired = await holder.query('advisory_try_lock', [L0_KEY]);
      check(Array.isArray(acquired) && acquired.length === 1 && acquired[0].acquired === true);
      check(observeL0(await observer.query('advisory_holders', [L0_KEY]), { databaseOid, expectedPid: holder.pid })?.held === true);
      const collision = await contender.query('advisory_try_lock', [L0_KEY]);
      check(Array.isArray(collision) && collision.length === 1 && collision[0].acquired === false);
      const released = await holder.query('advisory_unlock', [L0_KEY]);
      check(Array.isArray(released) && released.length === 1 && released[0].unlocked === true);
    }
    ok = true; code = 'ok';
  } catch { /* Summary contains only fixed codes and counts. */ }
  finally {
    for (const client of clients.reverse()) try { await client.end(); } catch { ok = false; code = 'validation_failed'; }
  }
  return finish(ok ? 'ok' : 'failed', code, ok ? 0 : 2, checks);
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = Object.freeze({ AUTHORIZATION, LOCK_AUTHORIZATION, main });
