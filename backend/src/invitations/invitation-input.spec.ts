import { computeExpiresAt, normalizeCompanyIds, normalizeInvitationEmail, normalizeValidityDays } from './invitation-input';
import { DAY_MS, DEFAULT_INVITATION_VALIDITY_DAYS, INVITATION_MAX_COMPANIES, INVITATION_ROLES, INVITATION_STATUSES, INVITATION_VALIDITY_DAYS } from './invitation-constants';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe('constantes', () => {
  it('vigencias 1, 7 y 30 con 7 por defecto; roles invitables sin community_manager; estados cerrados', () => {
    expect(INVITATION_VALIDITY_DAYS).toEqual([1, 7, 30]);
    expect(DEFAULT_INVITATION_VALIDITY_DAYS).toBe(7);
    expect(INVITATION_ROLES).toEqual(['worker', 'client']);
    expect(INVITATION_STATUSES).toEqual(['open', 'accepted', 'revoked', 'expired']);
    expect(INVITATION_MAX_COMPANIES).toBe(50);
  });
});

describe('correo de la invitación', () => {
  it('normaliza como el registro: sin espacios exteriores y en minúsculas', () => {
    expect(normalizeInvitationEmail('  Ana.Perez@Example.COM \n')).toBe('ana.perez@example.com');
  });
  it.each([undefined, null, 7, {}, '', 'a@b', 'sin-arroba', 'a@@b.co', 'ñ@example.com', 'a b@example.com', '.a@example.com', 'a..b@example.com',
    `${'a'.repeat(65)}@example.com`, `a@${'b'.repeat(64)}.com`, `${'a'.repeat(110)}@example.com`])('rechaza %p', value => {
    expect(normalizeInvitationEmail(value)).toBeNull();
  });
});

describe('empresas invitadas: entre 1 y 50 ids únicos', () => {
  it('acepta 1 y 50 ids canónicos y los devuelve sin reordenar', () => {
    expect(normalizeCompanyIds([uuid(1)])).toEqual([uuid(1)]);
    const fifty = Array.from({ length: 50 }, (_, i) => uuid(i + 1)).reverse();
    expect(normalizeCompanyIds(fifty)).toEqual(fifty);
  });
  it('rechaza la lista vacía: ya no se crean invitaciones sin empresas', () => expect(normalizeCompanyIds([])).toBeNull());
  it('rechaza más de 50', () => expect(normalizeCompanyIds(Array.from({ length: 51 }, (_, i) => uuid(i + 1)))).toBeNull());
  it('rechaza duplicados, también exactos al final de una lista larga', () => {
    expect(normalizeCompanyIds([uuid(1), uuid(2), uuid(1)])).toBeNull();
    expect(normalizeCompanyIds([...Array.from({ length: 49 }, (_, i) => uuid(i + 1)), uuid(1)])).toBeNull();
  });
  it('un id en mayúsculas no es un duplicado ni se corrige: se rechaza', () => {
    expect(uuid(10)).not.toBe(uuid(10).toUpperCase());
    expect(normalizeCompanyIds([uuid(10).toUpperCase()])).toBeNull();
    expect(normalizeCompanyIds([uuid(10), uuid(10).toUpperCase()])).toBeNull();
  });
  it.each([undefined, null, 'x', {}, [7], [null], [uuid(1), 5], ['01900000-0000-4000-8000-000000000001'], ['01900000-0000-7000-c000-000000000001'],
    [' ' + uuid(1)], [uuid(1) + '\n'], ['no-es-uuid'], [''], [['x']]])('rechaza %p', value => expect(normalizeCompanyIds(value)).toBeNull());
  it('no modifica la entrada', () => {
    const input = [uuid(2), uuid(1)]; const copy = [...input];
    const out = normalizeCompanyIds(input)!;
    expect(input).toEqual(copy); expect(out).not.toBe(input);
  });
});

describe('vigencia', () => {
  it('ausente es 7; 1, 7 y 30 se aceptan', () => {
    expect(normalizeValidityDays(undefined)).toBe(7);
    for (const days of [1, 7, 30] as const) expect(normalizeValidityDays(days)).toBe(days);
  });
  it.each([null, 0, 2, 14, 31, -1, 7.5, '7', '30', true, NaN, [7], {}])('rechaza %p sin convertirlo', value => expect(normalizeValidityDays(value)).toBeNull());
  it('el vencimiento son días de 24 horas exactas desde el reloj y siempre es posterior', () => {
    const now = new Date('2026-11-25T10:00:00.123Z');
    for (const days of INVITATION_VALIDITY_DAYS) {
      const expires = computeExpiresAt(now, days);
      expect(expires.getTime() - now.getTime()).toBe(days * DAY_MS);
      expect(expires.getTime()).toBeGreaterThan(now.getTime());
    }
    expect(computeExpiresAt(now, 7).toISOString()).toBe('2026-12-02T10:00:00.123Z');
    expect(now.toISOString()).toBe('2026-11-25T10:00:00.123Z');
  });
  it('rechaza una fecha inválida', () => expect(() => computeExpiresAt(new Date('x'), 7)).toThrow('Fecha inválida'));
});
