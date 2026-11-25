import { createValidationPipe } from '../common/http/validation.pipe';
import { AcceptInvitationDto } from './accept-invitation.dto';
import { InspectInvitationDto } from './inspect-invitation.dto';

const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const body = <T>(value: unknown, metatype: new () => T) => createValidationPipe().transform(value, { type: 'body', metatype });
const accept = (value: unknown) => body(value, AcceptInvitationDto);
const inspect = (value: unknown) => body(value, InspectInvitationDto);
const valid = { token: TOKEN, name: 'Ana', password: 'una-contraseña-larga-2026' };

describe('InspectInvitationDto', () => {
  it('acepta la forma válida, también con un token no canónico (será unavailable, no un 400)', async () => {
    await expect(inspect({ token: TOKEN })).resolves.toBeInstanceOf(InspectInvitationDto);
    await expect(inspect({ token: 'no-canónico' })).resolves.toMatchObject({ token: 'no-canónico' });
    await expect(inspect({ token: 'a'.repeat(128) })).resolves.toBeInstanceOf(InspectInvitationDto);
  });
  it.each([undefined, null, 7, true, [], {}, 'a'.repeat(129)])('400 con token %p', async token => {
    await expect(inspect({ token })).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400, field: 'token' });
  });
  it.each(['email', 'id', 'organizationId', 'status', 'password'])('400 por la propiedad desconocida %s', async key => {
    await expect(inspect({ token: TOKEN, [key]: 'x' })).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400 });
  });
  it('JSON incorrecto o de otro tipo conserva los errores habituales', async () => {
    for (const value of [undefined, null, 'texto', [], 5]) await expect(inspect(value)).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400 });
  });
});

describe('AcceptInvitationDto', () => {
  it('acepta la forma válida', async () => {
    const dto = await accept({ ...valid });
    expect(dto).toBeInstanceOf(AcceptInvitationDto);
    expect(dto).toMatchObject(valid);
  });
  it.each(['token', 'name', 'password'])('400 con %s ausente, nulo o de otro tipo', async key => {
    for (const value of [undefined, null, 7, true, [], {}]) await expect(accept({ ...valid, [key]: value })).rejects.toMatchObject({ code: 'invalid_input', field: key });
  });
  it('límites de longitud: token 128, nombre 200, contraseña 1024 (el resto lo decide la política)', async () => {
    await expect(accept({ ...valid, token: 'a'.repeat(128), name: 'a'.repeat(200), password: 'a'.repeat(1024) })).resolves.toBeInstanceOf(AcceptInvitationDto);
    await expect(accept({ ...valid, token: 'a'.repeat(129) })).rejects.toMatchObject({ field: 'token' });
    await expect(accept({ ...valid, name: 'a'.repeat(201) })).rejects.toMatchObject({ field: 'name' });
    await expect(accept({ ...valid, password: 'a'.repeat(1025) })).rejects.toMatchObject({ field: 'password' });
  });
  it.each(['email', 'role', 'organizationId', 'organizationName', 'companyIds', 'id', 'status', 'csrfToken', 'validityDays'])('400 por la propiedad desconocida %s (el correo sale de la invitación)', async key => {
    await expect(accept({ ...valid, [key]: 'ajeno' })).rejects.toMatchObject({ code: 'invalid_input', httpStatus: 400 });
  });
  it('el error de validación no repite los valores recibidos', async () => {
    const error = await accept({ ...valid, password: 'x'.repeat(1025), token: 'Secreto-Canario-7Q' }).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toMatch(/Secreto-Canario|xxxxxxxxxx/);
  });
});
