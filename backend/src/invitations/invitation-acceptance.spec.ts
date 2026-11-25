import { InvalidInputError, ServiceUnavailableError } from '../common/errors/domain-error';
import { acceptanceCookieGate, acceptanceCookieGateFromHeader, acceptanceDecision, acceptanceFailure, acceptanceInstant, acceptanceResponse,
  inspectionView, normalizeAcceptance, normalizeInvitationToken, type InspectionRow, type LockedInvitation } from './invitation-acceptance';
import { InvitationAcceptanceError } from './invitation-acceptance-errors';
import { generateInvitationToken } from './invitation-token';
import { generateSessionToken } from '../identity/session-token';

const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const T0 = new Date('2026-11-25T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const row = (extra: Partial<LockedInvitation> = {}): LockedInvitation => ({
  id: '01900000-0000-7000-8000-000000000001', organizationId: '01900000-0000-7000-8000-0000000000a0', email: 'ana@example.com', role: 'worker',
  createdAt: at(-1000), expiresAt: at(86_400_000), revokedAt: null, acceptedAt: null, ...extra,
});
const inspection = (extra: Partial<InspectionRow> = {}): InspectionRow => ({
  organizationName: 'Equipo', role: 'client', email: 'ana@example.com', companyNames: ['Zeta', 'Álvaro', 'Beta'],
  createdAt: at(-1000), expiresAt: at(1000), revokedAt: null, acceptedAt: null, ...extra,
});
const PASSWORD = 'una-contraseña-larga-válida-2026';

describe('token de la invitación en la entrada', () => {
  it('solo la forma canónica exacta; nada se recorta ni se corrige', () => {
    expect(normalizeInvitationToken(TOKEN)).toBe(TOKEN);
    expect(normalizeInvitationToken(generateInvitationToken())).not.toBeNull();
    for (const bad of [` ${TOKEN}`, `${TOKEN} `, `${TOKEN}\n`, TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}A`, `${TOKEN.slice(0, 42)}B`, '', undefined, null, 7, {}, [TOKEN]]) {
      expect(normalizeInvitationToken(bad)).toBeNull();
    }
  });
});

describe('normalización de la aceptación: orden y uniformidad', () => {
  it('acepta y devuelve token, nombre sin dobles espacios y contraseña en NFC', () => {
    const result = normalizeAcceptance({ token: TOKEN, name: '  Ana   María  ', password: 'café-contraseña-larga-2026' });
    expect(result).toEqual({ ok: true, token: TOKEN, name: 'Ana María', password: 'café-contraseña-larga-2026' });
  });
  it('un token no canónico es el 404 uniforme aunque nombre y contraseña también estén mal', () => {
    for (const token of ['x', `${TOKEN} `, undefined, 5]) {
      const result = normalizeAcceptance({ token, name: 7, password: 'corta' });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(InvitationAcceptanceError);
      expect(!result.ok && result.error).toMatchObject({ code: 'invitation_unavailable', httpStatus: 404, field: undefined });
    }
  });
  it.each([undefined, null, 7, '', '   ', 'a\u0000b', '\ud800', 'x'.repeat(300)])('nombre %p: 400 con el campo name, antes de mirar la contraseña', name => {
    const result = normalizeAcceptance({ token: TOKEN, name, password: 'corta' });
    expect(!result.ok && result.error).toBeInstanceOf(InvalidInputError);
    expect(!result.ok && result.error).toMatchObject({ code: 'invalid_input', httpStatus: 400, field: 'name' });
  });
  it.each([undefined, null, 7, '', 'a'.repeat(14), 'a'.repeat(129), `${'a'.repeat(14)}\u0000`, `${'a'.repeat(14)}\ud800`])('contraseña %p: 400 con el campo password', password => {
    const result = normalizeAcceptance({ token: TOKEN, name: 'Ana', password });
    expect(!result.ok && result.error).toMatchObject({ code: 'invalid_input', httpStatus: 400, field: 'password' });
  });
  it('los límites de la contraseña son 15 y 128 puntos de código (NFC), no bytes', () => {
    expect(normalizeAcceptance({ token: TOKEN, name: 'Ana', password: 'a'.repeat(15) }).ok).toBe(true);
    expect(normalizeAcceptance({ token: TOKEN, name: 'Ana', password: 'a'.repeat(128) }).ok).toBe(true);
    expect(normalizeAcceptance({ token: TOKEN, name: 'Ana', password: '😀'.repeat(15) }).ok).toBe(true);
    expect(normalizeAcceptance({ token: TOKEN, name: 'Ana', password: '😀'.repeat(129) }).ok).toBe(false);
  });
  it('ningún error repite lo recibido', () => {
    const secret = 'Secreto-Canario-7Q';
    for (const input of [{ token: secret, name: 'Ana', password: PASSWORD }, { token: TOKEN, name: `${secret}\u0000`, password: PASSWORD }, { token: TOKEN, name: 'Ana', password: `${secret}\u0000` }]) {
      const result = normalizeAcceptance(input);
      expect(JSON.stringify(!result.ok && result.error)).not.toContain(secret);
      expect(!result.ok && result.error.message).not.toContain(secret);
    }
  });
  it('no recibe ni devuelve el correo: sale de la invitación', () => {
    const result = normalizeAcceptance({ token: TOKEN, name: 'Ana', password: PASSWORD, email: 'otro@example.com' } as never);
    expect(result).toEqual({ ok: true, token: TOKEN, name: 'Ana', password: PASSWORD });
  });
});

describe('cookie de sesión previa: contrato exacto', () => {
  const NAME = 'agenda_session';
  const valid = generateSessionToken(() => Buffer.alloc(32, 3));
  it.each([[undefined], [''], ['otra=1'], ['otra=1; tercera=2'], [`${NAME}x=${valid}`], [`x${NAME}=${valid}`], [`__Host-${NAME}=${valid}`]])('ausente (%p): continúa', header => {
    expect(acceptanceCookieGateFromHeader(header, NAME)).toEqual({ proceed: true });
  });
  it('en producción solo cuenta la cookie con su nombre __Host-', () => {
    expect(acceptanceCookieGateFromHeader(`${NAME}=${valid}`, '__Host-agenda_session')).toEqual({ proceed: true });
    expect(acceptanceCookieGateFromHeader(`__Host-agenda_session=${valid}`, '__Host-agenda_session').proceed).toBe(false);
  });
  it.each([
    ['válida', `${NAME}=${valid}`], ['válida entre otras', `a=1; ${NAME}=${valid}; b=2`], ['con tabuladores de borde', `\t${NAME}=${valid}\t`],
    ['valor vacío', `${NAME}=`], ['sin signo igual', NAME], ['token mal formado', `${NAME}=abc`], ['token de 44 caracteres', `${NAME}=${valid}A`],
    ['duplicada', `${NAME}=${valid}; ${NAME}=${valid}`], ['duplicada con valores distintos', `${NAME}=${valid}; ${NAME}=otro`],
    ['carácter de control', `${NAME}=${valid}\u0001`], ['cabecera demasiado larga', `${'a=1; '.repeat(2000)}${NAME}=${valid}`], ['más de 50 pares', `${Array.from({ length: 60 }, (_, i) => `c${i}=1`).join('; ')}`],
    ['tabulador dentro de un par', `${NAME}=${valid}\tx`],
  ])('%s: 409 session_active sin tocar nada', (_label, header) => {
    const gate = acceptanceCookieGateFromHeader(header, NAME);
    expect(gate.proceed).toBe(false);
    if (gate.proceed) return;
    expect(gate.error).toBeInstanceOf(InvitationAcceptanceError);
    expect(gate.error).toMatchObject({ code: 'session_active', httpStatus: 409 });
    expect(gate.setCookie).toBe(false); expect(gate.revokeSession).toBe(false);
    expect(JSON.stringify(gate.error)).not.toContain(valid);
  });
  it('decide solo por el estado de la lectura: ok, invalid y duplicate se rechazan; absent continúa', () => {
    expect(acceptanceCookieGate({ status: 'absent' })).toEqual({ proceed: true });
    for (const result of [{ status: 'ok', token: valid }, { status: 'invalid' }, { status: 'duplicate' }] as const) expect(acceptanceCookieGate(result).proceed).toBe(false);
  });
});

describe('decisión de aceptación con la fila bloqueada', () => {
  it('sin fila, aceptada o revocada: no disponible, con independencia del reloj', () => {
    expect(acceptanceDecision(null, T0)).toBe('unavailable');
    expect(acceptanceDecision(row({ acceptedAt: at(-1) }), T0)).toBe('unavailable');
    expect(acceptanceDecision(row({ revokedAt: at(-1) }), T0)).toBe('unavailable');
    expect(acceptanceDecision(row({ revokedAt: at(-1), expiresAt: at(-5) }), T0)).toBe('unavailable');
    expect(acceptanceDecision(row({ revokedAt: at(-1), createdAt: at(5) }), T0)).toBe('unavailable');
  });
  it('vence exactamente en expires_at: un milisegundo antes procede, en el instante ya venció', () => {
    expect(acceptanceDecision(row({ expiresAt: at(1) }), T0)).toBe('proceed');
    expect(acceptanceDecision(row({ expiresAt: at(0) }), T0)).toBe('expired');
    expect(acceptanceDecision(row({ expiresAt: at(-1) }), T0)).toBe('expired');
  });
  it('un reloj anterior a created_at es un fallo controlado, nunca un éxito ni un vencimiento', () => {
    expect(acceptanceDecision(row({ createdAt: at(0) }), T0)).toBe('proceed');
    expect(acceptanceDecision(row({ createdAt: at(1) }), T0)).toBe('clock_before_creation');
    expect(acceptanceDecision(row({ createdAt: at(1), expiresAt: at(-1) }), T0)).toBe('clock_before_creation');
  });
  it('la espera de un bloqueo que cruza el vencimiento se ve con el reloj leído después', () => {
    const invitation = row({ expiresAt: at(500) });
    expect(acceptanceDecision(invitation, at(0))).toBe('proceed'); // lectura previa, antes de esperar
    expect(acceptanceDecision(invitation, at(600))).toBe('expired'); // lectura tras adquirir el bloqueo
  });
  it('cada decisión que no es proceder tiene su error: 404, 409 o 503 controlado', () => {
    expect(acceptanceFailure('unavailable')).toMatchObject({ code: 'invitation_unavailable', httpStatus: 404 });
    expect(acceptanceFailure('expired')).toMatchObject({ code: 'invitation_expired', httpStatus: 409 });
    const clock = acceptanceFailure('clock_before_creation');
    expect(clock).toBeInstanceOf(ServiceUnavailableError);
    expect(clock).toMatchObject({ code: 'service_unavailable', httpStatus: 503, retryAfterSeconds: 1 });
  });
  it('la marca de aceptación es exactamente la lectura posterior al bloqueo, sin GREATEST y solo dentro de la vigencia', () => {
    const invitation = row();
    const instant = acceptanceInstant(invitation, T0);
    expect(instant.getTime()).toBe(T0.getTime()); expect(instant).not.toBe(T0);
    expect(acceptanceInstant(row({ createdAt: at(0) }), T0).getTime()).toBe(T0.getTime());
    for (const bad of [row({ createdAt: at(1) }), row({ expiresAt: at(0) }), row({ acceptedAt: at(-1) }), row({ revokedAt: at(-1) })]) {
      expect(() => acceptanceInstant(bad, T0)).toThrow('fuera de vigencia');
    }
  });
});

describe('vista de la inspección', () => {
  it('abierta: organización, rol, empresas por nombre ordenadas, correo y vencimiento, sin ids', () => {
    const view = inspectionView(inspection(), T0);
    expect(view).toEqual({ status: 'open', organization: { name: 'Equipo' }, role: 'client', email: 'ana@example.com',
      companies: [{ name: 'Beta' }, { name: 'Zeta' }, { name: 'Álvaro' }], expiresAt: at(1000).toISOString() });
    expect(JSON.stringify(view)).not.toMatch(/"id"|organizationId|accountExists|token|hash/i);
  });
  it('no modifica la entrada y devuelve copias', () => {
    const input = inspection(); const names = [...input.companyNames];
    inspectionView(input, T0);
    expect([...input.companyNames]).toEqual(names);
  });
  it('desconocida, revocada, aceptada o con reloj anterior a la creación: unavailable', () => {
    expect(inspectionView(null, T0)).toEqual({ status: 'unavailable' });
    for (const extra of [{ revokedAt: at(-1) }, { acceptedAt: at(-1) }, { createdAt: at(1) }, { revokedAt: at(-1), expiresAt: at(-5) }, { acceptedAt: at(-1), expiresAt: at(-5) }]) {
      expect(inspectionView(inspection(extra), T0)).toEqual({ status: 'unavailable' });
    }
  });
  it('vencida solo con una invitación real, abierta y con la fecha pasada: expired sin más campos', () => {
    expect(inspectionView(inspection({ expiresAt: at(0) }), T0)).toEqual({ status: 'expired' });
    expect(inspectionView(inspection({ expiresAt: at(-1) }), T0)).toEqual({ status: 'expired' });
    expect(inspectionView(inspection({ expiresAt: at(1) }), T0).status).toBe('open');
  });
});

describe('cuerpo de la respuesta 201', () => {
  it('copia solo los campos de identidad y el CSRF derivado; nunca un token', () => {
    const body = acceptanceResponse({
      user: { id: 'u', email: 'ana@example.com', name: 'Ana', passwordHash: '$argon2id$secreto' } as never,
      organization: { id: 'o', name: 'Equipo', nameKey: 'equipo' } as never,
      membership: { id: 'm', role: 'worker', deactivatedAt: null } as never, csrfToken: 'csrf', expiresAt: at(1000),
    });
    expect(body).toEqual({ user: { id: 'u', email: 'ana@example.com', name: 'Ana' }, organization: { id: 'o', name: 'Equipo' },
      membership: { id: 'm', role: 'worker' }, csrfToken: 'csrf', expiresAt: at(1000).toISOString() });
    expect(JSON.stringify(body)).not.toMatch(/argon2|nameKey|deactivated|"token"|sessionToken/i);
  });
});
