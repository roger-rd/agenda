import { DomainError, ForbiddenError, InvalidInputError, NotFoundError } from '../common/errors/domain-error';
import { STALE } from '../database/errors/database-http';
import type { AuthenticatedSession } from '../auth/session.service';
import { ASSIGNABLE_ROLES, DEFAULT_MEMBER_PAGE_SIZE, DEFAULT_MEMBER_STATUS, MEMBER_MAX_COMPANIES, MEMBER_MIN_COMPANIES, MEMBER_ROLES, MEMBER_STATUS_FILTERS } from './member-constants';
import { accessDiff, accessUpdateResult, isMemberVersion, memberUpdateDecision, memberUpdateFailure, memberView, normalizeAccessCompanyIds, normalizeAccessUpdate, sortCompanyIds, type LockedMember, type MemberRow } from './member-contracts';
import { MEMBER_CONFLICTS, MemberConflictError, type MemberConflictCode } from './member-errors';
import { membersScope } from './members-scope';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = new Date('2026-11-26T12:00:00.000Z');
const member = (extra: Partial<LockedMember> = {}): LockedMember => ({ id: uuid(1), role: 'worker', version: 3, deactivatedAt: null, ...extra });
const row = (extra: Partial<MemberRow> = {}): MemberRow => ({ id: uuid(1), name: 'Ana', email: 'ana@example.com', role: 'worker', deactivatedAt: null, version: 2, createdAt: NOW, companyIds: [uuid(12), uuid(10)], ...extra });

describe('constantes', () => {
  it('0 a 50 empresas, roles y filtros cerrados, valores por defecto', () => {
    expect([MEMBER_MIN_COMPANIES, MEMBER_MAX_COMPANIES]).toEqual([0, 50]);
    expect(MEMBER_ROLES).toEqual(['community_manager', 'worker', 'client']);
    expect(ASSIGNABLE_ROLES).toEqual(['worker', 'client']);
    expect(MEMBER_STATUS_FILTERS).toEqual(['active', 'deactivated', 'all']);
    expect(DEFAULT_MEMBER_STATUS).toBe('active');
    expect(DEFAULT_MEMBER_PAGE_SIZE).toBe(20);
  });
});

describe('orden determinista de companyIds', () => {
  it('ascendente por el texto del id, sin modificar la entrada', () => {
    const input = [uuid(30), uuid(2), uuid(0x1f), uuid(10)]; const copy = [...input];
    expect(sortCompanyIds(input)).toEqual([uuid(2), uuid(10), uuid(30), uuid(0x1f)].sort());
    expect(sortCompanyIds(input)).toEqual([...copy].sort());
    expect(input).toEqual(copy);
  });
});

describe('ids de empresas de la actualización: 0 a 50, únicos y canónicos', () => {
  it('la lista vacía es válida (retira todos los accesos)', () => expect(normalizeAccessCompanyIds([])).toEqual([]));
  it('acepta 50 y los devuelve ordenados aunque vengan en cualquier orden', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => uuid(i + 1)).reverse();
    expect(normalizeAccessCompanyIds(fifty)).toEqual([...fifty].sort());
  });
  it.each([
    ['51', Array.from({ length: 51 }, (_, i) => uuid(i + 1))], ['duplicados', [uuid(1), uuid(1)]], ['mayúsculas', [uuid(10).toUpperCase()]],
    ['UUIDv4', ['01900000-0000-4000-8000-000000000001']], ['variante inválida', ['01900000-0000-7000-c000-000000000001']], ['con espacio', [` ${uuid(1)}`]],
    ['no texto', [5]], ['nulo dentro', [null]], ['no es lista', 'x'], ['indefinido', undefined], ['nulo', null], ['objeto', {}],
  ])('rechaza %s sin corregirlo', (_label, value) => expect(normalizeAccessCompanyIds(value)).toBeNull());
  it('la versión es un entero de 1 a 2147483647', () => {
    for (const value of [1, 2, 2147483647]) expect(isMemberVersion(value)).toBe(true);
    for (const value of [0, -1, 1.5, 2147483648, '1', null, undefined, NaN]) expect(isMemberVersion(value)).toBe(false);
  });
});

describe('normalización de la petición: cuerpo antes que el id', () => {
  const ok = { memberId: uuid(5), version: 2, companyIds: [uuid(2), uuid(1)] };
  it('devuelve las empresas ordenadas', () => {
    expect(normalizeAccessUpdate(ok)).toEqual({ ok: true, memberId: uuid(5), version: 2, companyIds: [uuid(1), uuid(2)] });
    expect(normalizeAccessUpdate({ ...ok, companyIds: [] })).toMatchObject({ ok: true, companyIds: [] });
  });
  it('cuerpo inválido: 400 con su campo, aunque el id también esté mal', () => {
    for (const [input, field] of [[{ ...ok, version: 0 }, 'version'], [{ ...ok, companyIds: [uuid(1), uuid(1)] }, 'companyIds'], [{ ...ok, memberId: 'x', version: 'a' }, 'version'], [{ ...ok, memberId: 'x', companyIds: 'y' }, 'companyIds']] as const) {
      const result = normalizeAccessUpdate(input as never);
      expect(!result.ok && result.error).toBeInstanceOf(InvalidInputError);
      expect(!result.ok && result.error).toMatchObject({ field });
    }
  });
  it('id mal formado con cuerpo válido: el mismo 404 que un miembro inexistente', () => {
    expect(uuid(10)).not.toBe(uuid(10).toUpperCase());
    for (const memberId of ['x', '', uuid(10).toUpperCase(), undefined, 5]) {
      const result = normalizeAccessUpdate({ ...ok, memberId } as never);
      expect(!result.ok && result.error).toBeInstanceOf(NotFoundError);
    }
    // Ids de otras versiones de UUID son ids bien formados: la consulta dirá si existen.
    expect(normalizeAccessUpdate({ ...ok, memberId: '01900000-0000-4000-8000-000000000001' })).toMatchObject({ ok: true });
  });
});

describe('orden de diagnóstico con la fila bloqueada: existencia, versión, rol y estado', () => {
  it.each([
    ['sin fila (o de otra organización)', null, 3, 'not_found'],
    ['versión desactualizada', member(), 2, 'version_conflict'],
    ['versión futura', member(), 4, 'version_conflict'],
    ['community manager', member({ role: 'community_manager' }), 3, 'not_assignable'],
    ['desactivado', member({ deactivatedAt: NOW }), 3, 'deactivated'],
    ['activo con versión correcta', member(), 3, 'proceed'],
    ['cliente activo', member({ role: 'client' }), 3, 'proceed'],
  ] as const)('%s', (_label, locked, version, expected) => expect(memberUpdateDecision(locked, version)).toBe(expected));
  it('la precedencia es estricta: versión antes que rol, rol antes que estado', () => {
    expect(memberUpdateDecision(member({ role: 'community_manager', deactivatedAt: NOW }), 1)).toBe('version_conflict');
    expect(memberUpdateDecision(member({ role: 'community_manager', deactivatedAt: NOW }), 3)).toBe('not_assignable');
    expect(memberUpdateDecision(member({ deactivatedAt: NOW }), 1)).toBe('version_conflict');
  });
  it('cada decisión tiene su error: 404 o un 409 distinguible', () => {
    expect(memberUpdateFailure('not_found')).toBeInstanceOf(NotFoundError);
    expect(memberUpdateFailure('version_conflict')).toMatchObject({ code: 'version_conflict', httpStatus: 409, message: STALE });
    expect(memberUpdateFailure('not_assignable')).toMatchObject({ code: 'member_not_assignable', httpStatus: 409 });
    expect(memberUpdateFailure('deactivated')).toMatchObject({ code: 'member_deactivated', httpStatus: 409 });
  });
});

describe('diferencias de accesos', () => {
  const a = uuid(1), b = uuid(2), c = uuid(3);
  it('el mismo conjunto en otro orden no es un cambio', () => {
    expect(accessDiff([a, b, c], [c, a, b])).toEqual({ add: [], remove: [], changed: false });
    expect(accessDiff([], [])).toEqual({ add: [], remove: [], changed: false });
  });
  it('solo las diferencias, ordenadas: altas, bajas y ambas', () => {
    expect(accessDiff([a, b], [a, b, c])).toEqual({ add: [c], remove: [], changed: true });
    expect(accessDiff([a, b, c], [b])).toEqual({ add: [], remove: [a, c], changed: true });
    expect(accessDiff([c, a], [b])).toEqual({ add: [b], remove: [a, c], changed: true });
  });
  it('retirar todo es un cambio si había accesos', () => {
    expect(accessDiff([a, b], [])).toEqual({ add: [], remove: [a, b], changed: true });
  });
});

describe('vistas', () => {
  it('worker y client: accesos asignados ordenados, estado y fecha ISO', () => {
    expect(memberView(row())).toEqual({ id: uuid(1), user: { name: 'Ana', email: 'ana@example.com' }, role: 'worker', status: 'active', version: 2,
      companyAccess: 'assigned', companyIds: [uuid(10), uuid(12)], createdAt: NOW.toISOString() });
    expect(memberView(row({ role: 'client', deactivatedAt: NOW, companyIds: [] }))).toMatchObject({ status: 'deactivated', companyAccess: 'assigned', companyIds: [] });
  });
  it('community manager: todas las empresas, nunca como lista de accesos', () => {
    expect(memberView(row({ role: 'community_manager', companyIds: [uuid(10)] }))).toMatchObject({ companyAccess: 'all', companyIds: [] });
  });
  it('no incluye nada más que los campos del contrato', () => {
    expect(Object.keys(memberView({ ...row(), passwordHash: 'x', organizationId: 'y' } as never))).toEqual(['id', 'user', 'role', 'status', 'version', 'companyAccess', 'companyIds', 'createdAt']);
    expect(accessUpdateResult({ id: uuid(1), role: 'worker', version: 3, companyIds: [uuid(9), uuid(2)], extra: 'x' } as never)).toEqual({ id: uuid(1), role: 'worker', version: 3, companyIds: [uuid(2), uuid(9)] });
  });
});

describe('errores y alcance', () => {
  it('tres 409 distinguibles, mensajes fijos', () => {
    const codes = Object.keys(MEMBER_CONFLICTS) as MemberConflictCode[];
    expect(codes).toEqual(['version_conflict', 'member_deactivated', 'member_not_assignable']);
    expect(new Set(codes.map(c => MEMBER_CONFLICTS[c])).size).toBe(3);
    for (const code of codes) {
      const error = new MemberConflictError(code);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code, httpStatus: 409, message: MEMBER_CONFLICTS[code], field: undefined });
      expect(error.message).not.toMatch(/[@#$%{}]/);
    }
  });
  const session = (membership: { id: string; role: string } | null, organization: { id: string } | null) => ({ organization, membership } as unknown as AuthenticatedSession);
  it('la organización sale de la sesión; solo un community manager', () => {
    expect(membersScope(session({ id: 'm', role: 'community_manager' }, { id: 'o' }))).toEqual({ organizationId: 'o', membershipId: 'm', role: 'community_manager' });
    for (const role of ['worker', 'client', 'otro']) expect(() => membersScope(session({ id: 'm', role }, { id: 'o' }))).toThrow(ForbiddenError);
    expect(() => membersScope(session(null, { id: 'o' }))).toThrow(ForbiddenError);
    expect(() => membersScope(session({ id: 'm', role: 'community_manager' }, null))).toThrow(ForbiddenError);
  });
});
