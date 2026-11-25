import { DomainError, ServiceUnavailableError } from '../common/errors/domain-error';
import { ACCEPTANCE_ERRORS, ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE, clockBeforeCreationError, InvitationAcceptanceError, type AcceptanceErrorCode } from './invitation-acceptance-errors';
import { INVITATION_CONFLICTS } from './invitation-errors';

describe('errores de la aceptación', () => {
  const codes = Object.keys(ACCEPTANCE_ERRORS) as AcceptanceErrorCode[];
  it('conjunto cerrado: 404 uniforme y tres 409 distinguibles, con mensajes fijos y distintos', () => {
    expect(codes).toEqual(['invitation_unavailable', 'invitation_expired', 'account_exists', 'session_active']);
    expect(new Set(codes.map(c => ACCEPTANCE_ERRORS[c].message)).size).toBe(codes.length);
    expect(codes.map(c => new InvitationAcceptanceError(c).httpStatus)).toEqual([404, 409, 409, 409]);
    for (const code of codes) {
      const error = new InvitationAcceptanceError(code);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code, message: ACCEPTANCE_ERRORS[code].message, field: undefined });
    }
  });
  it('ningún mensaje contiene valores del cliente ni de la base: son literales sin marcadores', () => {
    for (const code of codes) expect(ACCEPTANCE_ERRORS[code].message).not.toMatch(/[@#$%{}<>]|https?:|token|hash|contraseña elegida/i);
    expect(ACCEPTANCE_ERRORS.account_exists.message).toContain('Inicia sesión');
    expect(ACCEPTANCE_ERRORS.session_active.message).toContain('Cierra la sesión');
  });
  it('los códigos no chocan con los de la gestión de invitaciones', () => {
    for (const code of codes) expect(Object.keys(INVITATION_CONFLICTS)).not.toContain(code);
  });
  it('un reloj anterior a la creación es un 503 controlado y reintentable, con el código genérico', () => {
    const error = clockBeforeCreationError();
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({ code: 'service_unavailable', httpStatus: 503, retryAfterSeconds: 1 });
  });
  it('el mensaje de resultado incierto documenta la recuperación por login sin afirmar que un login fallido pruebe nada', () => {
    const message = ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE;
    expect(message).toContain('Inicia sesión');
    expect(message).toMatch(/no demuestra que no se aceptó/);
    expect(message).toMatch(/una vez con el mismo enlace/);
    expect(message).not.toMatch(/reintent|automátic/i);
    expect(message).not.toMatch(/[@#$%{}]/);
  });
});
