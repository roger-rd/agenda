import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../common/errors/domain-error';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { mapDatabaseFailure } from '../database/errors/database-http';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { Clock } from '../common/clock/clock';
import { IdGenerator } from '../common/ids/id-generator';
import { InvitationConflictError } from './invitation-errors';
import { hashInvitationToken, InvitationTokens } from './invitation-token';
import { decodeInvitationsCursor } from './invitations-cursor';
import { InvitationsService, INSERT_INVITATION_COMPANIES_SQL, INSERT_INVITATION_SQL, LIST_INVITATIONS_SQL, REVOKE_INVITATION_SQL } from './invitations.service';
import type { InvitationsScope } from './invitations-scope';
import type { CreateInvitationDto } from './create-invitation.dto';
import type { ListInvitationsQuery } from './list-invitations.query';
import { FakeDb } from './testing/fake-db';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = uuid(0xa0); const OTHER_ORG = uuid(0xb0); const MEMBERSHIP = uuid(0xc0);
const scope: InvitationsScope = { organizationId: ORG, membershipId: MEMBERSHIP, role: 'community_manager' };
const NOW = new Date('2026-11-25T12:00:00.000Z');
const DAY = 86_400_000;

function setup(options: { now?: Date } = {}) {
  const db = new FakeDb();
  db.companies.set(ORG, new Set([uuid(1), uuid(2), uuid(3)])); db.companies.set(OTHER_ORG, new Set([uuid(9)]));
  let now = options.now ?? NOW; let ids = 0x100; let tokens = 0;
  const clock: Clock = { now: () => new Date(now) };
  const generator: IdGenerator = { next: () => uuid(ids++) };
  const tokenSource: InvitationTokens = { next: () => Buffer.alloc(32, ++tokens).toString('base64url') };
  const service = new InvitationsService(db.runner, generator, clock, tokenSource);
  return { db, service, setNow: (value: Date) => { now = value; }, token: (n: number) => Buffer.alloc(32, n).toString('base64url') };
}
const dto = (extra: Partial<CreateInvitationDto> = {}): CreateInvitationDto =>
  ({ email: 'Ana@Example.com', role: 'worker', companyIds: [uuid(1), uuid(2)], validityDays: 7, ...extra });
const listQuery = (extra: Partial<ListInvitationsQuery> = {}): ListInvitationsQuery => ({ limit: 20, ...extra });
const writes = (db: FakeDb) => db.statements.filter(s => /^(INSERT|UPDATE|DELETE)/.test(s.sql));
const rejection = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('debía rechazar'); }, (error: unknown) => error);

describe('crear invitaciones', () => {
  it('inserta la invitación y sus empresas en una transacción, con la organización y el creador de la sesión', async () => {
    const { db, service, token } = setup();
    const result = await service.create(scope, dto());
    expect(db.runs).toBe(1); expect(db.outcomes).toEqual(['commit']);
    expect(result).toEqual({
      id: uuid(0x100), email: 'ana@example.com', role: 'worker', companyIds: [uuid(1), uuid(2)], status: 'open',
      createdAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(), revokedAt: null, acceptedAt: null,
      token: token(1), link: `/invitacion#${token(1)}`,
    });
    const insert = db.statements.find(s => s.sql === INSERT_INVITATION_SQL)!;
    expect(insert.params).toEqual([uuid(0x100), ORG, 'ana@example.com', 'worker', hashInvitationToken(token(1)), MEMBERSHIP, NOW, new Date(NOW.getTime() + 7 * DAY)]);
    expect(db.statements.find(s => s.sql === INSERT_INVITATION_COMPANIES_SQL)!.params).toEqual([uuid(0x100), ORG, [uuid(1), uuid(2)]]);
  });
  it('guarda solo el hash: el token en claro no aparece en ninguna sentencia ni en la fila', async () => {
    const { db, service, token } = setup();
    await service.create(scope, dto());
    expect(JSON.stringify(db.statements)).not.toContain(token(1));
    expect(JSON.stringify([...db.invitations.values()])).not.toContain(token(1));
    expect(db.invitations.get(uuid(0x100))!.tokenHash.equals(hashInvitationToken(token(1)))).toBe(true);
  });
  it.each([1, 7, 30] as const)('vigencia de %i días', async days => {
    const { service } = setup();
    expect((await service.create(scope, dto({ validityDays: days }))).expiresAt).toBe(new Date(NOW.getTime() + days * DAY).toISOString());
  });
  it('la organización viene siempre de la sesión: todo parámetro de organización es el suyo', async () => {
    const { db, service } = setup();
    await service.create(scope, dto());
    for (const s of db.statements) expect(s.params).toContain(ORG);
    expect(db.statements.some(s => s.params.includes(OTHER_ORG))).toBe(false);
  });
  it.each([
    ['correo inválido', { email: 'sin-arroba' }, 'email'], ['rol community_manager', { role: 'community_manager' as never }, 'role'],
    ['empresas vacías', { companyIds: [] }, 'companyIds'], ['51 empresas', { companyIds: Array.from({ length: 51 }, (_, i) => uuid(i + 1)) }, 'companyIds'],
    ['empresas duplicadas', { companyIds: [uuid(1), uuid(1)] }, 'companyIds'], ['id de empresa no canónico', { companyIds: ['x'] }, 'companyIds'],
    ['vigencia 14', { validityDays: 14 as never }, 'validityDays'],
  ])('rechaza %s antes de tocar la base', async (_n, extra, field) => {
    const { db, service } = setup();
    expect(await rejection(service.create(scope, dto(extra)))).toMatchObject({ code: 'invalid_input', httpStatus: 400, field });
    expect(db.runs).toBe(0); expect(db.statements).toEqual([]);
  });
  it('solo un community manager opera', async () => {
    const { db, service } = setup();
    for (const role of ['worker', 'client'] as const) {
      expect(await rejection(service.create({ ...scope, role } as unknown as InvitationsScope, dto()))).toBeInstanceOf(ForbiddenError);
    }
    expect(db.runs).toBe(0);
  });
  it('una empresa de otra organización o inexistente da el mismo 400, sin insertar nada', async () => {
    const { db, service } = setup();
    for (const companyIds of [[uuid(9)], [uuid(1), uuid(0x999)]]) {
      expect(await rejection(service.create(scope, dto({ companyIds })))).toMatchObject({ code: 'invalid_input', field: 'companyIds' });
    }
    expect(writes(db)).toEqual([]); expect(db.outcomes).toEqual(['rollback', 'rollback']); expect(db.invitations.size).toBe(0);
  });
  it('rechaza a un miembro activo y a uno desactivado con conflictos distintos, sin reactivar nada', async () => {
    const { db, service } = setup();
    db.members.push({ organizationId: ORG, email: 'activo@example.com', active: true }, { organizationId: ORG, email: 'baja@example.com', active: false });
    const active = await rejection(service.create(scope, dto({ email: 'Activo@Example.com' })));
    const deactivated = await rejection(service.create(scope, dto({ email: 'baja@example.com' })));
    expect(active).toMatchObject({ code: 'member_already_active', httpStatus: 409 });
    expect(deactivated).toMatchObject({ code: 'member_deactivated', httpStatus: 409 });
    expect((active as Error).message).not.toBe((deactivated as Error).message);
    expect(writes(db)).toEqual([]);
    expect(db.members).toEqual([{ organizationId: ORG, email: 'activo@example.com', active: true }, { organizationId: ORG, email: 'baja@example.com', active: false }]);
  });
  it('un miembro de otra organización no bloquea la invitación', async () => {
    const { service, db } = setup();
    db.members.push({ organizationId: OTHER_ORG, email: 'ana@example.com', active: true });
    await expect(service.create(scope, dto())).resolves.toMatchObject({ email: 'ana@example.com' });
  });
  it('otra invitación abierta para el mismo correo da un conflicto propio, también si ya venció', async () => {
    const { db, service, setNow } = setup();
    await service.create(scope, dto({ validityDays: 1 }));
    expect(await rejection(service.create(scope, dto()))).toMatchObject({ code: 'invitation_pending_exists', httpStatus: 409 });
    setNow(new Date(NOW.getTime() + 2 * DAY));
    expect(await rejection(service.create(scope, dto()))).toMatchObject({ code: 'invitation_pending_exists' });
    expect(db.invitations.size).toBe(1);
  });
  it('tras revocar, el mismo correo puede invitarse otra vez', async () => {
    const { service } = setup();
    const first = await service.create(scope, dto());
    await service.revoke(scope, first.id);
    await expect(service.create(scope, dto())).resolves.toMatchObject({ status: 'open' });
  });
  it('dos creaciones simultáneas del mismo correo: una gana y la otra recibe el conflicto', async () => {
    const { db, service } = setup();
    const results = await Promise.allSettled([service.create(scope, dto()), service.create(scope, dto())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'invitation_pending_exists' });
    expect(db.invitations.size).toBe(1);
  });
  it('si falla la inserción de las empresas, se revierte todo y no queda invitación', async () => {
    const { db, service } = setup();
    db.failOn = sql => (sql === INSERT_INVITATION_COMPANIES_SQL ? { severity: 'ERROR', code: '23503', constraint: 'FK_invitation_companies_company' } : null);
    expect(await rejection(service.create(scope, dto()))).toMatchObject({ code: 'invalid_input', field: 'companyIds' });
    expect(db.outcomes).toEqual(['rollback']); expect(db.invitations.size).toBe(0);
  });
});

describe('resultado desconocido: nunca se reintenta', () => {
  it.each(['08006', 'ECONNRESET'])('un fallo %s en la inserción se informa una vez, sin reintento ni diagnóstico', async code => {
    const { db, service } = setup();
    db.failOn = sql => (sql === INSERT_INVITATION_SQL ? { severity: 'ERROR', code, message: 'secreto del driver' } : null);
    const error = await rejection(service.create(scope, dto())) as DatabaseOperationError;
    expect(error).toBeInstanceOf(DatabaseOperationError);
    expect(error.context).toEqual({ operation: 'insert', table: 'invitations', atomic: true, valuesOrigin: 'request' });
    expect(mapDatabaseFailure(error.failure, { method: 'POST', registry: new ConstraintRegistry(), context: error.context })).toMatchObject({ status: 503, code: 'outcome_unknown' });
    expect(JSON.stringify(error)).not.toContain('secreto');
    expect(db.runs).toBe(1);
    expect(db.statements.filter(s => s.sql === INSERT_INVITATION_SQL)).toHaveLength(1);
  });
  it('lo mismo al renovar: una sola ejecución y sin segunda transacción', async () => {
    const { db, service } = setup();
    const created = await service.create(scope, dto());
    const before = db.runs;
    db.failOn = sql => (sql === INSERT_INVITATION_SQL ? { severity: 'ERROR', code: '08006' } : null);
    expect(await rejection(service.renew(scope, created.id))).toBeInstanceOf(DatabaseOperationError);
    expect(db.runs).toBe(before + 1);
    expect(db.statements.filter(s => s.sql === INSERT_INVITATION_SQL)).toHaveLength(2);
  });
});

describe('revocar invitaciones', () => {
  it('revoca una abierta con el reloj y devuelve id, estado y fecha', async () => {
    const { db, service, setNow } = setup();
    const created = await service.create(scope, dto());
    setNow(new Date(NOW.getTime() + 1000));
    expect(await service.revoke(scope, created.id)).toEqual({ id: created.id, status: 'revoked', revokedAt: new Date(NOW.getTime() + 1000).toISOString() });
    expect(db.invitations.get(created.id)!.revokedAt).toEqual(new Date(NOW.getTime() + 1000));
  });
  it('revoca también una vencida', async () => {
    const { service, setNow } = setup();
    const created = await service.create(scope, dto({ validityDays: 1 }));
    setNow(new Date(NOW.getTime() + 3 * DAY));
    await expect(service.revoke(scope, created.id)).resolves.toMatchObject({ status: 'revoked' });
  });
  it('es idempotente sobre una ya revocada: misma fecha y sin escribir', async () => {
    const { db, service, setNow } = setup();
    const created = await service.create(scope, dto());
    const first = await service.revoke(scope, created.id);
    setNow(new Date(NOW.getTime() + 60_000));
    const before = writes(db).length;
    expect(await service.revoke(scope, created.id)).toEqual(first);
    expect(writes(db)).toHaveLength(before);
  });
  it('una aceptada da conflicto y no se toca', async () => {
    const { db, service } = setup();
    const created = await service.create(scope, dto());
    db.invitations.get(created.id)!.acceptedAt = new Date(NOW.getTime() + 5);
    expect(await rejection(service.revoke(scope, created.id))).toMatchObject({ code: 'invitation_accepted', httpStatus: 409 });
    expect(db.invitations.get(created.id)!.revokedAt).toBeNull();
    expect(db.statements.some(s => s.sql === REVOKE_INVITATION_SQL)).toBe(false);
  });
  it('una invitación ajena y una inexistente dan exactamente el mismo 404', async () => {
    const { db, service } = setup();
    db.invitations.set(uuid(0x500), { id: uuid(0x500), organizationId: OTHER_ORG, email: 'x@example.com', role: 'client', tokenHash: Buffer.alloc(32), createdByMembershipId: uuid(1),
      createdAtUs: '2026-11-25T11:00:00.000000Z', expiresAt: new Date(NOW.getTime() + DAY), revokedAt: null, acceptedAt: null, companyIds: [uuid(9)] });
    const foreign = await rejection(service.revoke(scope, uuid(0x500))); const missing = await rejection(service.revoke(scope, uuid(0x501)));
    expect(foreign).toBeInstanceOf(NotFoundError); expect(missing).toBeInstanceOf(NotFoundError);
    expect({ ...(foreign as object) }).toEqual({ ...(missing as object) });
    expect((foreign as Error).message).toBe((missing as Error).message);
    expect(db.invitations.get(uuid(0x500))!.revokedAt).toBeNull();
  });
  it('un id mal formado es 404 sin consultar la base; un rol distinto es 403', async () => {
    const { db, service } = setup();
    expect(await rejection(service.revoke(scope, 'no-es-uuid'))).toBeInstanceOf(NotFoundError);
    expect(await rejection(service.revoke({ ...scope, role: 'worker' } as unknown as InvitationsScope, uuid(1)))).toBeInstanceOf(ForbiddenError);
    expect(db.runs).toBe(0);
  });
});

describe('renovar invitaciones: revocar la anterior y crear otra en una transacción', () => {
  it('revoca la anterior y crea un reemplazo con nuevo id y token, mismo correo, rol y empresas', async () => {
    const { db, service, token, setNow } = setup();
    const old = await service.create(scope, dto({ role: 'client', companyIds: [uuid(3), uuid(1)] }));
    setNow(new Date(NOW.getTime() + 1000));
    const renewed = await service.renew(scope, old.id);
    expect(renewed.id).not.toBe(old.id); expect(renewed.token).toBe(token(2)); expect(renewed.token).not.toBe(old.token);
    expect(renewed).toMatchObject({ email: old.email, role: 'client', status: 'open', companyIds: [uuid(1), uuid(3)] });
    expect(renewed.link).toBe(`/invitacion#${token(2)}`);
    expect(renewed.expiresAt).toBe(new Date(NOW.getTime() + 1000 + 7 * DAY).toISOString());
    expect(db.invitations.get(old.id)!.revokedAt).toEqual(new Date(NOW.getTime() + 1000));
    expect(db.invitations.get(renewed.id)!.revokedAt).toBeNull();
    expect(db.invitations.get(renewed.id)!.tokenHash.equals(hashInvitationToken(token(2)))).toBe(true);
    expect(db.outcomes).toEqual(['commit', 'commit']);
  });
  it('una vencida se renueva; una aceptada o revocada no', async () => {
    const { db, service, setNow } = setup();
    const expired = await service.create(scope, dto({ email: 'a@example.com', validityDays: 1 }));
    setNow(new Date(NOW.getTime() + 2 * DAY));
    await expect(service.renew(scope, expired.id)).resolves.toMatchObject({ status: 'open' });
    const accepted = await service.create(scope, dto({ email: 'b@example.com' }));
    db.invitations.get(accepted.id)!.acceptedAt = new Date(NOW.getTime() + 2 * DAY);
    expect(await rejection(service.renew(scope, accepted.id))).toMatchObject({ code: 'invitation_accepted', httpStatus: 409 });
    const revoked = await service.create(scope, dto({ email: 'c@example.com' }));
    await service.revoke(scope, revoked.id);
    expect(await rejection(service.renew(scope, revoked.id))).toMatchObject({ code: 'invitation_revoked', httpStatus: 409 });
    expect(db.invitations.size).toBe(4);
  });
  it('acepta una vigencia opcional y rechaza una inválida sin tocar la base', async () => {
    const { db, service } = setup();
    const old = await service.create(scope, dto());
    await expect(service.renew(scope, old.id, 30)).resolves.toMatchObject({ expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    const runs = db.runs;
    expect(await rejection(service.renew(scope, uuid(0x100), 14))).toMatchObject({ code: 'invalid_input', field: 'validityDays' });
    expect(db.runs).toBe(runs);
  });
  it('dos renovaciones concurrentes del mismo id: un éxito, un conflicto y un único reemplazo', async () => {
    const { db, service } = setup();
    const old = await service.create(scope, dto());
    const results = await Promise.allSettled([service.renew(scope, old.id), service.renew(scope, old.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(InvitationConflictError);
    expect(failed.reason).toMatchObject({ code: 'invitation_revoked', httpStatus: 409 });
    expect(db.invitations.size).toBe(2);
    expect([...db.invitations.values()].filter(i => i.revokedAt === null)).toHaveLength(1);
    expect(db.outcomes.filter(o => o === 'rollback')).toHaveLength(1);
  });
  it('renovar y revocar a la vez: gana el primero y el segundo ve el estado resultante', async () => {
    const { db, service } = setup();
    const old = await service.create(scope, dto());
    const [renew, revoke] = await Promise.allSettled([service.renew(scope, old.id), service.revoke(scope, old.id)]);
    expect(renew.status).toBe('fulfilled');
    expect(revoke).toMatchObject({ status: 'fulfilled', value: { status: 'revoked' } }); // idempotente sobre la revocada por la renovación
    expect(db.invitations.size).toBe(2);
  });
  it.each([
    ['la inserción de la nueva invitación', INSERT_INVITATION_SQL, { severity: 'ERROR', code: '23514', constraint: 'CK_invitations_times' }],
    ['la inserción de sus empresas', INSERT_INVITATION_COMPANIES_SQL, { severity: 'ERROR', code: '23503', constraint: 'FK_invitation_companies_company' }],
  ])('si falla %s, el rollback conserva intacta la anterior', async (_n, failing, error) => {
    const { db, service } = setup();
    const old = await service.create(scope, dto());
    const snapshot = JSON.stringify([...db.invitations.values()]);
    db.failOn = sql => (sql === failing ? error : null);
    await rejection(service.renew(scope, old.id));
    expect(db.outcomes.at(-1)).toBe('rollback');
    expect(JSON.stringify([...db.invitations.values()])).toBe(snapshot);
    expect(db.invitations.get(old.id)!.revokedAt).toBeNull(); expect(db.invitations.size).toBe(1);
    db.failOn = null;
    await expect(service.renew(scope, old.id)).resolves.toMatchObject({ status: 'open' });
  });
  it('si el correo ya es miembro, no se revoca ni se reemplaza', async () => {
    const { db, service } = setup();
    const old = await service.create(scope, dto());
    db.members.push({ organizationId: ORG, email: 'ana@example.com', active: false });
    expect(await rejection(service.renew(scope, old.id))).toMatchObject({ code: 'member_deactivated' });
    expect(db.invitations.get(old.id)!.revokedAt).toBeNull(); expect(db.invitations.size).toBe(1);
  });
  it('ajena o inexistente: el mismo 404; mal formada: 404 sin consultar; otro rol: 403', async () => {
    const { db, service } = setup();
    expect(await rejection(service.renew(scope, uuid(0x700)))).toBeInstanceOf(NotFoundError);
    expect(await rejection(service.renew(scope, 'x'))).toBeInstanceOf(NotFoundError);
    expect(await rejection(service.renew({ ...scope, role: 'client' } as unknown as InvitationsScope, uuid(1)))).toBeInstanceOf(ForbiddenError);
    expect(writes(db)).toEqual([]);
  });
});

describe('listar invitaciones', () => {
  it('solo las de la organización de la sesión, sin token ni hash, con el estado calculado por el reloj', async () => {
    const { db, service, setNow } = setup();
    const a = await service.create(scope, dto({ email: 'a@example.com', validityDays: 1 }));
    await service.create(scope, dto({ email: 'b@example.com' }));
    db.invitations.set(uuid(0x600), { id: uuid(0x600), organizationId: OTHER_ORG, email: 'x@example.com', role: 'client', tokenHash: Buffer.alloc(32, 9), createdByMembershipId: uuid(1),
      createdAtUs: '2026-11-25T11:00:00.000000Z', expiresAt: new Date(NOW.getTime() + DAY), revokedAt: null, acceptedAt: null, companyIds: [uuid(9)] });
    setNow(new Date(NOW.getTime() + 2 * DAY));
    const { items, nextCursor } = await service.list(scope, listQuery());
    expect(nextCursor).toBeNull();
    expect(items.map(i => [i.email, i.status])).toEqual([['b@example.com', 'open'], ['a@example.com', 'expired']]);
    expect(items.map(i => i.id)).not.toContain(uuid(0x600)); expect(items.map(i => i.id)).toContain(a.id);
    expect(JSON.stringify(items)).not.toMatch(/token|hash/i);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['acceptedAt', 'companyIds', 'createdAt', 'email', 'expiresAt', 'id', 'revokedAt', 'role', 'status']);
  });
  it('el filtro de estado se aplica con el mismo reloj que el cálculo', async () => {
    const { db, service, setNow } = setup();
    const open = await service.create(scope, dto({ email: 'open@example.com' }));
    const expired = await service.create(scope, dto({ email: 'exp@example.com', validityDays: 1 }));
    const revoked = await service.create(scope, dto({ email: 'rev@example.com' })); await service.revoke(scope, revoked.id);
    const accepted = await service.create(scope, dto({ email: 'acc@example.com' })); db.invitations.get(accepted.id)!.acceptedAt = new Date(NOW.getTime() + 1);
    setNow(new Date(NOW.getTime() + 2 * DAY));
    const idsOf = async (status: ListInvitationsQuery['status']) => (await service.list(scope, listQuery({ status }))).items.map(i => i.id);
    expect(await idsOf('open')).toEqual([open.id]); expect(await idsOf('expired')).toEqual([expired.id]);
    expect(await idsOf('revoked')).toEqual([revoked.id]); expect(await idsOf('accepted')).toEqual([accepted.id]);
    expect((await idsOf(undefined))).toHaveLength(4);
  });
  it('solo un community manager lista', async () => {
    const { db, service } = setup();
    expect(await rejection(service.list({ ...scope, role: 'worker' } as unknown as InvitationsScope, listQuery()))).toBeInstanceOf(ForbiddenError);
    expect(db.runs).toBe(0);
  });
  it('un cursor mal formado se rechaza antes de consultar', async () => {
    const { db, service } = setup();
    expect(await rejection(service.list(scope, listQuery({ cursor: 'basura' })))).toMatchObject({ code: 'invalid_input', field: 'cursor' });
    expect(db.runs).toBe(0);
  });
  it('recorre todas las páginas sin omitir ni repetir, incluso con instantes que solo difieren en microsegundos o empatan', async () => {
    const { db, service } = setup();
    const at = ['2026-11-25T10:00:00.123456Z', '2026-11-25T10:00:00.123456Z', '2026-11-25T10:00:00.123999Z', '2026-11-25T10:00:00.123001Z',
      '2026-11-25T10:00:00.123000Z', '2026-11-25T09:00:00.000000Z', '2026-11-25T10:00:00.124000Z'];
    at.forEach((createdAtUs, i) => db.invitations.set(uuid(0x800 + i), { id: uuid(0x800 + i), organizationId: ORG, email: `u${i}@example.com`, role: 'worker', tokenHash: Buffer.alloc(32),
      createdByMembershipId: MEMBERSHIP, createdAtUs, expiresAt: new Date(NOW.getTime() + DAY), revokedAt: null, acceptedAt: null, companyIds: [uuid(1)] }));
    const expected = [...db.invitations.values()].sort((a, b) => (a.createdAtUs === b.createdAtUs ? (a.id < b.id ? 1 : -1) : a.createdAtUs < b.createdAtUs ? 1 : -1)).map(i => i.id);
    for (const limit of [1, 2, 3, 7]) {
      const seen: string[] = []; let cursor: string | undefined; let pages = 0;
      do {
        const page = await service.list(scope, listQuery({ limit, cursor }));
        seen.push(...page.items.map(i => i.id)); cursor = page.nextCursor ?? undefined; pages++;
      } while (cursor && pages < 20);
      expect(seen).toEqual(expected);
    }
  });
  it('el cursor lleva el texto exacto de PostgreSQL con microsegundos, que es lo que vuelve como cota', async () => {
    const { db, service } = setup();
    for (const [i, us] of ['2026-11-25T10:00:00.123999Z', '2026-11-25T10:00:00.123001Z'].entries()) {
      db.invitations.set(uuid(0x900 + i), { id: uuid(0x900 + i), organizationId: ORG, email: `m${i}@example.com`, role: 'worker', tokenHash: Buffer.alloc(32), createdByMembershipId: MEMBERSHIP,
        createdAtUs: us, expiresAt: new Date(NOW.getTime() + DAY), revokedAt: null, acceptedAt: null, companyIds: [uuid(1)] });
    }
    const first = await service.list(scope, listQuery({ limit: 1 }));
    expect(decodeInvitationsCursor(first.nextCursor!)).toEqual({ createdAt: '2026-11-25T10:00:00.123999Z', id: uuid(0x900) });
    await service.list(scope, listQuery({ limit: 1, cursor: first.nextCursor! }));
    const call = db.statements.filter(s => s.sql === LIST_INVITATIONS_SQL).at(-1)!;
    expect(call.params[1]).toBe('2026-11-25T10:00:00.123999Z'); expect(typeof call.params[1]).toBe('string');
  });
  it('demostración: una cota en milisegundos habría perdido filas, la de microsegundos no', () => {
    const rows = ['2026-11-25T10:00:00.123999Z', '2026-11-25T10:00:00.123500Z', '2026-11-25T10:00:00.123001Z'];
    const olderThan = (bound: string) => rows.filter(us => us < bound);
    // Primera página (limit 1) devuelve la más reciente: .123999. Una cota en ms (un Date) la volvería .123000 o .124000.
    const msBound = new Date('2026-11-25T10:00:00.123999Z').toISOString().replace('Z', '000Z');
    expect(msBound).toBe('2026-11-25T10:00:00.123000Z');
    expect(olderThan(msBound)).toEqual([]); // se perderían .123500 y .123001
    expect(olderThan('2026-11-25T10:00:00.123999Z')).toEqual(['2026-11-25T10:00:00.123500Z', '2026-11-25T10:00:00.123001Z']);
  });
});

describe('created_at_us: UTC explícito, sin depender del TimeZone de la conexión', () => {
  // Estas comprobaciones son sobre el texto fijo de la consulta. El comportamiento real con otros TimeZone se prueba en la fase conectada (I1-D).
  const expression = /to_char\(i\.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS created_at_us/;
  it('se genera con AT TIME ZONE \'UTC\' explícito, seis decimales (US) y la Z literal como sufijo', () => {
    expect(LIST_INVITATIONS_SQL).toMatch(expression);
    expect(LIST_INVITATIONS_SQL.match(/created_at_us/g)).toHaveLength(1);
    expect(LIST_INVITATIONS_SQL).not.toMatch(/current_setting|SET (LOCAL )?TIME ?ZONE|::timestamp\b(?!tz)/i);
  });
  it('la cota vuelve como timestamptz con su Z explícita y se compara contra la columna cruda, sin conversión de zona', () => {
    expect(LIST_INVITATIONS_SQL).toContain('(i.created_at, i.id) < ($2::timestamptz, $3::uuid)');
    expect(LIST_INVITATIONS_SQL.match(/AT TIME ZONE/g)).toHaveLength(1);
  });
  it('el texto del cursor termina en Z con seis decimales, así que representa el mismo instante en cualquier TimeZone de la sesión', async () => {
    const { db, service } = setup();
    db.invitations.set(uuid(0xa00), { id: uuid(0xa00), organizationId: ORG, email: 'z@example.com', role: 'worker', tokenHash: Buffer.alloc(32), createdByMembershipId: MEMBERSHIP,
      createdAtUs: '2026-11-25T10:00:00.123456Z', expiresAt: new Date(NOW.getTime() + DAY), revokedAt: null, acceptedAt: null, companyIds: [uuid(1)] });
    db.invitations.set(uuid(0xa01), { id: uuid(0xa01), organizationId: ORG, email: 'y@example.com', role: 'worker', tokenHash: Buffer.alloc(32), createdByMembershipId: MEMBERSHIP,
      createdAtUs: '2026-11-25T09:00:00.000001Z', expiresAt: new Date(NOW.getTime() + DAY), revokedAt: null, acceptedAt: null, companyIds: [uuid(1)] });
    const cursor = decodeInvitationsCursor((await service.list(scope, listQuery({ limit: 1 }))).nextCursor!);
    expect(cursor.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    // Con zona explícita Z, Date interpreta el mismo instante que PostgreSQL con '...Z'::timestamptz.
    expect(new Date(cursor.createdAt.replace(/\d{3}Z$/, 'Z')).getTime()).toBe(Date.parse('2026-11-25T10:00:00.123Z'));
  });
});

describe('sentencias fijas', () => {
  it('cada lectura y escritura queda acotada por la organización y ninguna lectura devuelve token_hash', async () => {
    const { db, service } = setup();
    const created = await service.create(scope, dto());
    await service.list(scope, listQuery()); await service.renew(scope, created.id); await service.revoke(scope, uuid(0x101));
    for (const { sql } of db.statements) {
      expect(sql).toMatch(/organization_id = \$[12]|\$2::uuid|\(\$1, \$2,|VALUES \(\$1, \$2/);
      if (/^SELECT/.test(sql)) expect(sql).not.toMatch(/token_hash/);
    }
    expect(LIST_INVITATIONS_SQL).toMatch(/WHERE i\.organization_id = \$1 /);
    expect(LIST_INVITATIONS_SQL).toMatch(/ORDER BY i\.created_at DESC, i\.id DESC LIMIT \$4$/);
    expect(REVOKE_INVITATION_SQL).toMatch(/AND organization_id = \$2 AND accepted_at IS NULL AND revoked_at IS NULL/);
  });
  it('ninguna sentencia toca membresías ni usuarios más que para leerlos', async () => {
    const { db, service } = setup();
    await service.create(scope, dto());
    expect(db.statements.filter(s => /organization_memberships|\busers\b/.test(s.sql)).every(s => /^SELECT/.test(s.sql))).toBe(true);
  });
  it('los errores de dominio de otra capa pasan intactos', async () => {
    const { db, service } = setup();
    db.failOn = sql => (sql === INSERT_INVITATION_SQL ? new ConflictError('x') : null);
    expect(await rejection(service.create(scope, dto()))).toBeInstanceOf(ConflictError);
    expect(await rejection(service.create(scope, dto({ role: 'worker', email: '' })))).toBeInstanceOf(InvalidInputError);
  });
});
