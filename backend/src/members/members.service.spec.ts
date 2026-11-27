import { ForbiddenError, InvalidInputError, NotFoundError, ServiceUnavailableError } from '../common/errors/domain-error';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { mapDatabaseFailure } from '../database/errors/database-http';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import type { ListMembersQuery } from './list-members.query';
import { MemberConflictError } from './member-errors';
import { BUMP_MEMBER_VERSION_SQL, COUNT_ORG_COMPANIES_SQL, CURRENT_ACCESSES_SQL, DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL, LIST_MEMBERS_SQL, LOCK_MEMBER_SQL } from './member-sql';
import { decodeMembersCursor } from './members-cursor';
import { MembersService, translateMemberWriteError } from './members.service';
import type { MembersScope } from './members-scope';
import { FakeMembersDb, type FakeMembership } from './testing/fake-db';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = uuid(0xa0); const OTHER_ORG = uuid(0xb0);
const scope: MembersScope = { organizationId: ORG, membershipId: uuid(0xc0), role: 'community_manager' };
const CREATED = new Date('2026-11-01T00:00:00.000Z');
const NOW = new Date('2026-11-26T12:00:00.000Z');
const C = [uuid(11), uuid(12), uuid(13), uuid(14)];
const FOREIGN = uuid(99);
const WORKER = uuid(1), CLIENT = uuid(2), MANAGER = uuid(0xc0), GONE = uuid(3), ALIEN = uuid(4);

function setup() {
  const db = new FakeMembersDb();
  db.companies.set(ORG, new Set(C)); db.companies.set(OTHER_ORG, new Set([FOREIGN]));
  const add = (id: string, extra: Partial<FakeMembership>) => db.memberships.set(id, { id, organizationId: ORG, name: 'Persona', email: `${id.slice(-4)}@example.com`,
    role: 'worker', version: 3, deactivatedAt: null, createdAt: CREATED, updatedAt: CREATED, ...extra });
  add(WORKER, { name: 'Trabajador' }); add(CLIENT, { role: 'client', name: 'Cliente' }); add(MANAGER, { role: 'community_manager', name: 'Gestora', version: 1 });
  add(GONE, { deactivatedAt: CREATED, name: 'Baja' }); add(ALIEN, { organizationId: OTHER_ORG, name: 'Ajeno' });
  const access = (membershipId: string, companyId: string, organizationId = ORG, role = 'worker') => db.accesses.push({ membershipId, companyId, organizationId, role, createdAt: CREATED });
  access(WORKER, C[0]); access(WORKER, C[1]); access(CLIENT, C[2], ORG, 'client'); access(GONE, C[0]); access(ALIEN, FOREIGN, OTHER_ORG);
  let now = NOW;
  const service = new MembersService(db.runner, { now: () => new Date(now) });
  return { db, service, setNow: (value: Date) => { now = value; } };
}
const query = (extra: Partial<ListMembersQuery> = {}): ListMembersQuery => ({ limit: 20, status: 'active', ...extra });
const change = (version: number, companyIds: string[]) => ({ version, companyIds });
const rejection = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('debía rechazar'); }, (error: unknown) => error);
const state = (db: FakeMembersDb) => JSON.stringify({ m: [...db.memberships.values()], a: [...db.accesses].sort((x, y) => `${x.membershipId}${x.companyId}`.localeCompare(`${y.membershipId}${y.companyId}`)) });
const writes = (db: FakeMembersDb) => db.statements.filter(s => /^(INSERT|UPDATE|DELETE)/.test(s.sql)).map(s => s.sql);

describe('listar miembros', () => {
  it('solo los de la organización de la sesión, activos por defecto, ordenados por id y con accesos ordenados', async () => {
    const { service } = setup();
    const { items, nextCursor } = await service.list(scope, query());
    expect(items.map(i => i.id)).toEqual([WORKER, CLIENT, MANAGER]);
    expect(nextCursor).toBeNull();
    expect(items[0]).toMatchObject({ user: { name: 'Trabajador' }, role: 'worker', status: 'active', version: 3, companyAccess: 'assigned', companyIds: [C[0], C[1]] });
    expect(items[2]).toMatchObject({ role: 'community_manager', companyAccess: 'all', companyIds: [] });
  });
  it('los desactivados solo con deactivated o all, y el filtro de rol', async () => {
    const { service } = setup();
    expect((await service.list(scope, query({ status: 'deactivated' }))).items.map(i => i.id)).toEqual([GONE]);
    expect((await service.list(scope, query({ status: 'all' }))).items.map(i => i.id)).toEqual([WORKER, CLIENT, GONE, MANAGER]);
    expect((await service.list(scope, query({ role: 'client' }))).items.map(i => i.id)).toEqual([CLIENT]);
    expect((await service.list(scope, query({ role: 'worker', status: 'all' }))).items.map(i => i.id)).toEqual([WORKER, GONE]);
  });
  it('pagina por id sin omitir ni repetir', async () => {
    const { service } = setup();
    for (const limit of [1, 2, 3, 4]) {
      const seen: string[] = []; let cursor: string | undefined; let pages = 0;
      do {
        const page = await service.list(scope, query({ limit, status: 'all', cursor }));
        seen.push(...page.items.map(i => i.id)); cursor = page.nextCursor ?? undefined; pages++;
        if (cursor) expect(decodeMembersCursor(cursor).id).toBe(page.items.at(-1)!.id);
      } while (cursor && pages < 10);
      expect(seen).toEqual([WORKER, CLIENT, GONE, MANAGER]);
    }
  });
  it('un rol distinto de community manager recibe 403 sin consultar; un cursor inválido es 400 sin consultar', async () => {
    const { db, service } = setup();
    for (const role of ['worker', 'client'] as const) expect(await rejection(service.list({ ...scope, role } as unknown as MembersScope, query()))).toBeInstanceOf(ForbiddenError);
    expect(await rejection(service.list(scope, query({ cursor: 'basura' })))).toMatchObject({ code: 'invalid_input', field: 'cursor' });
    expect(db.runs).toBe(0);
  });
  it('un fallo de base es un 503 reintentable, nunca un resultado desconocido', async () => {
    const { db, service } = setup();
    for (const code of ['08006', '55P03']) {
      db.failOn = sql => (sql === LIST_MEMBERS_SQL ? { severity: 'ERROR', code, message: 'secreto' } : null);
      const error = await rejection(service.list(scope, query()));
      expect(error).toBeInstanceOf(ServiceUnavailableError); expect(JSON.stringify(error)).not.toContain('secreto');
    }
  });
});

describe('cambiar accesos: permisos y validación antes de consultar', () => {
  it('la organización y el rol salen de la sesión; otros roles no consultan', async () => {
    const { db, service } = setup();
    for (const role of ['worker', 'client'] as const) expect(await rejection(service.updateAccesses({ ...scope, role } as unknown as MembersScope, WORKER, change(3, [])))).toBeInstanceOf(ForbiddenError);
    expect(db.runs).toBe(0);
  });
  it('cuerpo inválido: 400 sin consultar; id mal formado: el mismo 404 sin consultar', async () => {
    const { db, service } = setup();
    expect(await rejection(service.updateAccesses(scope, WORKER, change(0, [])))).toMatchObject({ code: 'invalid_input', field: 'version' });
    expect(await rejection(service.updateAccesses(scope, WORKER, change(3, [C[0], C[0]])))).toMatchObject({ code: 'invalid_input', field: 'companyIds' });
    expect(await rejection(service.updateAccesses(scope, 'x', change(3, [])))).toBeInstanceOf(NotFoundError);
    expect(db.runs).toBe(0);
  });
  it('todo parámetro de organización es el de la sesión', async () => {
    const { db, service } = setup();
    await service.updateAccesses(scope, WORKER, change(3, [C[2]]));
    for (const s of db.statements) expect(s.params).toContain(ORG);
    expect(JSON.stringify(db.statements.map(s => s.params))).not.toContain(OTHER_ORG);
  });
});

describe('diagnóstico con la membresía bloqueada, en el orden definido', () => {
  it('la primera sentencia es siempre el bloqueo y nada se consulta ni escribe si el diagnóstico falla', async () => {
    const { db, service } = setup();
    for (const [id, version, error] of [[uuid(0x999), 3, NotFoundError], [ALIEN, 3, NotFoundError], [WORKER, 2, MemberConflictError], [MANAGER, 1, MemberConflictError], [GONE, 3, MemberConflictError]] as const) {
      db.statements.length = 0;
      expect(await rejection(service.updateAccesses(scope, id, change(version, [C[0]])))).toBeInstanceOf(error);
      expect(db.statements.map(s => s.sql)).toEqual([LOCK_MEMBER_SQL]);
    }
    expect(writes(db)).toEqual([]);
  });
  it('una membresía ajena e inexistente dan el mismo 404', async () => {
    const { service } = setup();
    const foreign = await rejection(service.updateAccesses(scope, ALIEN, change(3, []))); const missing = await rejection(service.updateAccesses(scope, uuid(0x999), change(3, [])));
    expect({ ...(foreign as object) }).toEqual({ ...(missing as object) }); expect((foreign as Error).message).toBe((missing as Error).message);
  });
  it('versión desactualizada: 409 aunque los accesos coincidan exactamente', async () => {
    const { db, service } = setup();
    const snap = state(db);
    expect(await rejection(service.updateAccesses(scope, WORKER, change(2, [C[1], C[0]])))).toMatchObject({ code: 'version_conflict', httpStatus: 409 });
    expect(state(db)).toBe(snap);
  });
  it('la versión se diagnostica antes que el rol y el estado; el rol antes que el estado', async () => {
    const { db, service } = setup();
    expect(await rejection(service.updateAccesses(scope, MANAGER, change(9, [])))).toMatchObject({ code: 'version_conflict' });
    expect(await rejection(service.updateAccesses(scope, MANAGER, change(1, [])))).toMatchObject({ code: 'member_not_assignable' });
    expect(await rejection(service.updateAccesses(scope, GONE, change(9, [])))).toMatchObject({ code: 'version_conflict' });
    expect(await rejection(service.updateAccesses(scope, GONE, change(3, [])))).toMatchObject({ code: 'member_deactivated' });
    db.memberships.get(GONE)!.role = 'community_manager';
    expect(await rejection(service.updateAccesses(scope, GONE, change(3, [])))).toMatchObject({ code: 'member_not_assignable' });
  });
  it('empresa de otra organización o inexistente: el mismo 400 y sin cambios', async () => {
    const { db, service } = setup();
    const snap = state(db);
    for (const companyIds of [[FOREIGN], [C[0], uuid(0x888)]]) {
      expect(await rejection(service.updateAccesses(scope, WORKER, change(3, companyIds)))).toMatchObject({ code: 'invalid_input', field: 'companyIds' });
    }
    expect(state(db)).toBe(snap); expect(writes(db)).toEqual([]);
  });
});

describe('conjunto idéntico: 200 sin cambiar versión ni fecha', () => {
  it('en otro orden, sin ninguna escritura', async () => {
    const { db, service } = setup();
    const snap = state(db);
    expect(await service.updateAccesses(scope, WORKER, change(3, [C[1], C[0]]))).toEqual({ id: WORKER, role: 'worker', version: 3, companyIds: [C[0], C[1]] });
    expect(state(db)).toBe(snap); expect(writes(db)).toEqual([]);
    expect(db.memberships.get(WORKER)!.updatedAt).toEqual(CREATED);
    expect(db.outcomes).toEqual(['commit']);
  });
  it('[] sobre un miembro sin accesos tampoco cambia nada', async () => {
    const { db, service } = setup();
    db.accesses = db.accesses.filter(a => a.membershipId !== CLIENT);
    expect(await service.updateAccesses(scope, CLIENT, change(3, []))).toMatchObject({ version: 3, companyIds: [] });
    expect(writes(db)).toEqual([]);
  });
});

describe('cambios efectivos: solo las diferencias y una sola subida de versión', () => {
  it('sustituir: borra lo retirado, inserta lo añadido y sube la versión una vez, en ese orden', async () => {
    const { db, service } = setup();
    const result = await service.updateAccesses(scope, WORKER, change(3, [C[3], C[1]]));
    expect(result).toEqual({ id: WORKER, role: 'worker', version: 4, companyIds: [C[1], C[3]] });
    expect(db.statements.map(s => s.sql)).toEqual([LOCK_MEMBER_SQL, COUNT_ORG_COMPANIES_SQL, CURRENT_ACCESSES_SQL, DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL, BUMP_MEMBER_VERSION_SQL]);
    expect(db.statements.find(s => s.sql === DELETE_ACCESSES_SQL)!.params).toEqual([WORKER, ORG, [C[0]]]);
    expect(db.statements.find(s => s.sql === INSERT_ACCESSES_SQL)!.params).toEqual([WORKER, ORG, 'worker', NOW, [C[3]]]);
    expect(db.accessesOf(WORKER)).toEqual([C[1], C[3]]);
    expect(db.memberships.get(WORKER)).toMatchObject({ version: 4, updatedAt: NOW });
    // El acceso conservado no se reescribe: mantiene su fecha original.
    expect(db.accesses.find(a => a.membershipId === WORKER && a.companyId === C[1])!.createdAt).toEqual(CREATED);
    expect(db.accessesOf(CLIENT)).toEqual([C[2]]);
  });
  it('solo añadir o solo quitar no ejecuta la otra escritura', async () => {
    const { db, service } = setup();
    await service.updateAccesses(scope, WORKER, change(3, [C[0], C[1], C[2]]));
    expect(writes(db)).toEqual([INSERT_ACCESSES_SQL, BUMP_MEMBER_VERSION_SQL]);
    db.statements.length = 0;
    await service.updateAccesses(scope, WORKER, change(4, [C[2]]));
    expect(writes(db)).toEqual([DELETE_ACCESSES_SQL, BUMP_MEMBER_VERSION_SQL]);
    expect(db.memberships.get(WORKER)!.version).toBe(5);
  });
  it('un cliente recibe el rol de su membresía en los accesos', async () => {
    const { db, service } = setup();
    await service.updateAccesses(scope, CLIENT, change(3, [C[0], C[2]]));
    expect(db.accesses.filter(a => a.membershipId === CLIENT).every(a => a.role === 'client')).toBe(true);
  });
  it('[] retira todos los accesos sin desactivar al miembro, sin consultar empresas y con una sola subida', async () => {
    const { db, service } = setup();
    expect(await service.updateAccesses(scope, WORKER, change(3, []))).toEqual({ id: WORKER, role: 'worker', version: 4, companyIds: [] });
    expect(db.accessesOf(WORKER)).toEqual([]);
    expect(db.memberships.get(WORKER)).toMatchObject({ deactivatedAt: null, version: 4, role: 'worker' });
    expect(db.statements.some(s => s.sql === COUNT_ORG_COMPANIES_SQL || s.sql === INSERT_ACCESSES_SQL)).toBe(false);
    expect(writes(db)).toEqual([DELETE_ACCESSES_SQL, BUMP_MEMBER_VERSION_SQL]);
  });
  it('no escribe en usuarios, sesiones ni otras membresías', async () => {
    const { db, service } = setup();
    await service.updateAccesses(scope, WORKER, change(3, [C[2]]));
    for (const { sql } of db.statements) expect(sql).not.toMatch(/public\.users|user_sessions|deactivated_at =/);
    expect(db.memberships.get(CLIENT)!.version).toBe(3);
  });
});

describe('fallos en cada escritura: rollback completo y sin reintento', () => {
  it.each([[DELETE_ACCESSES_SQL, 'el borrado'], [INSERT_ACCESSES_SQL, 'el alta'], [BUMP_MEMBER_VERSION_SQL, 'la subida de versión']])(
    'si falla %s no cambian accesos, versión ni fecha', async (failing, label) => {
      expect(label).toBeTruthy();
      const { db, service } = setup();
      const snap = state(db);
      db.failOn = sql => (sql === failing ? { severity: 'ERROR', code: '23514', constraint: 'CK_otra', detail: 'secreto' } : null);
      const error = await rejection(service.updateAccesses(scope, WORKER, change(3, [C[1], C[3]])));
      expect(error).toBeInstanceOf(DatabaseOperationError); expect(JSON.stringify(error)).not.toContain('secreto');
      expect(state(db)).toBe(snap); expect(db.outcomes).toEqual(['rollback']);
      expect(db.statements.filter(s => s.sql === failing)).toHaveLength(1); expect(db.runs).toBe(1);
      db.failOn = null;
      await expect(service.updateAccesses(scope, WORKER, change(3, [C[1], C[3]]))).resolves.toMatchObject({ version: 4 });
    });
  it('si la versión no se puede subir (cero filas) es conflicto y se revierte todo', async () => {
    const { db, service } = setup();
    const snap = state(db);
    db.before.set(BUMP_MEMBER_VERSION_SQL, () => { db.memberships.get(WORKER)!.version = 99; });
    expect(await rejection(service.updateAccesses(scope, WORKER, change(3, [C[3]])))).toMatchObject({ code: 'version_conflict' });
    db.memberships.get(WORKER)!.version = 3;
    expect(state(db)).toBe(snap);
  });
  it('una empresa que desaparece entre la comprobación y el alta: 400 companyIds y rollback', async () => {
    const { db, service } = setup();
    const snap = state(db);
    db.before.set(INSERT_ACCESSES_SQL, () => { db.companies.get(ORG)!.delete(C[3]); });
    expect(await rejection(service.updateAccesses(scope, WORKER, change(3, [C[3]])))).toMatchObject({ code: 'invalid_input', field: 'companyIds' });
    db.companies.get(ORG)!.add(C[3]);
    expect(state(db)).toBe(snap);
  });
  it('un bloqueo agotado es un 503 reintentable con contexto atómico', async () => {
    const { db, service } = setup();
    db.failOn = sql => (sql === LOCK_MEMBER_SQL ? { severity: 'ERROR', code: '55P03' } : null);
    const error = await rejection(service.updateAccesses(scope, WORKER, change(3, []))) as DatabaseOperationError;
    expect(error.context).toEqual({ operation: 'update', table: 'company_accesses', atomic: true, valuesOrigin: 'request' });
    expect(mapDatabaseFailure(error.failure, { method: 'PUT', registry: new ConstraintRegistry(), context: error.context })).toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(db.runs).toBe(1);
  });
});

describe('resultado de commit incierto: sin reintento automático', () => {
  it.each([[true], [false]])('aplicado=%s: outcome_unknown, una sola transacción, y repetir con la misma versión lo aclara', async applied => {
    const { db, service } = setup();
    db.commitFailure = { error: { severity: 'ERROR', code: '08006', message: 'secreto' }, applied };
    const error = await rejection(service.updateAccesses(scope, WORKER, change(3, [C[3]]))) as DatabaseOperationError;
    expect(mapDatabaseFailure(error.failure, { method: 'PUT', registry: new ConstraintRegistry(), context: error.context })).toMatchObject({ status: 503, code: 'outcome_unknown' });
    expect(JSON.stringify(error)).not.toContain('secreto');
    expect(db.runs).toBe(1); expect(db.statements.filter(s => s.sql === BUMP_MEMBER_VERSION_SQL)).toHaveLength(1);
    db.commitFailure = null;
    // El cliente vuelve a leer: si se aplicó, la versión ya subió y la repetición con la antigua es un 409; si no, se aplica.
    const retry = service.updateAccesses(scope, WORKER, change(3, [C[3]]));
    if (applied) expect(await rejection(retry)).toMatchObject({ code: 'version_conflict' });
    else await expect(retry).resolves.toMatchObject({ version: 4 });
    expect((await service.list(scope, query())).items.find(i => i.id === WORKER)).toMatchObject({ version: 4, companyIds: [C[3]] });
  });
});

describe('dos cambios concurrentes con la misma versión', () => {
  it('dos cambios efectivos: un éxito y un conflicto, y solo el del ganador queda', async () => {
    const { db, service } = setup();
    const results = await Promise.allSettled([service.updateAccesses(scope, WORKER, change(3, [C[2]])), service.updateAccesses(scope, WORKER, change(3, [C[3]]))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'version_conflict', httpStatus: 409 });
    const winner = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ companyIds: string[] }>).value;
    expect(db.accessesOf(WORKER)).toEqual(winner.companyIds);
    expect(db.memberships.get(WORKER)!.version).toBe(4);
    expect(db.outcomes.sort()).toEqual(['commit', 'rollback']);
  });
  it('un cambio efectivo y otro idéntico al estado previo: el segundo es conflicto si el primero ya subió la versión', async () => {
    const { db, service } = setup();
    const [first, second] = await Promise.allSettled([service.updateAccesses(scope, WORKER, change(3, [])), service.updateAccesses(scope, WORKER, change(3, [C[0], C[1]]))]);
    expect(first.status).toBe('fulfilled'); expect(second).toMatchObject({ status: 'rejected' });
    expect(db.accessesOf(WORKER)).toEqual([]);
  });
  it('dos peticiones idénticas al estado actual: ambas 200 y nada cambia', async () => {
    const { db, service } = setup();
    const snap = state(db);
    const results = await Promise.all([service.updateAccesses(scope, WORKER, change(3, [C[0], C[1]])), service.updateAccesses(scope, WORKER, change(3, [C[1], C[0]]))]);
    expect(results.map(r => r.version)).toEqual([3, 3]); expect(state(db)).toBe(snap);
  });
  it('miembros distintos no se bloquean entre sí', async () => {
    const { db, service } = setup();
    await expect(Promise.all([service.updateAccesses(scope, WORKER, change(3, [])), service.updateAccesses(scope, CLIENT, change(3, []))])).resolves.toHaveLength(2);
    expect(db.accessesOf(WORKER).length + db.accessesOf(CLIENT).length).toBe(0);
  });
});

describe('traducción de errores de escritura', () => {
  it('dominio intacto, FK de empresas como entrada inválida y el resto con su clasificación', () => {
    const domain = new InvalidInputError();
    expect(translateMemberWriteError(domain)).toBe(domain);
    expect(translateMemberWriteError({ severity: 'ERROR', code: '23503', constraint: 'FK_company_accesses_company' })).toMatchObject({ code: 'invalid_input', field: 'companyIds' });
    for (const input of [{ severity: 'ERROR', code: '23503', constraint: 'FK_company_accesses_membership' }, { severity: 'ERROR', code: '23505', constraint: 'PK_company_accesses' }, { code: 'ECONNRESET' }]) {
      expect(translateMemberWriteError(input)).toBeInstanceOf(DatabaseOperationError);
    }
    expect(translateMemberWriteError(new Error('interno'))).toEqual(new Error('interno'));
  });
});
