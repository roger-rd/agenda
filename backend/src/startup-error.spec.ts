import 'reflect-metadata';
import { EnvironmentValidationError } from './config/env.validation';
import { startupErrorMessage } from './startup-error';

describe('Mensaje de error de arranque', () => {
  it('preserva el mensaje de validación y le da prioridad sobre code', () => {
    const message = 'PORT: debe ser un entero entre 1 y 65535\nNODE_ENV: debe ser development, test o production';
    const error = Object.assign(new EnvironmentValidationError(message), { code: 'EACCES' });
    expect(startupErrorMessage(error)).toBe(message);
  });

  it.each(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'E_TEST_123'])('incluye únicamente el código válido %s', code => {
    expect(startupErrorMessage({ code })).toBe(`No se pudo iniciar el servidor (${code}).`);
  });

  it.each([new Error('secreto'), 'secreto', null, undefined, { message: 'secreto' }])('usa el mensaje genérico para %p', error => {
    expect(startupErrorMessage(error)).toBe('No se pudo iniciar el servidor.');
  });

  it.each(['sk_live_x', 'eaddrinuse', ' EADDRINUSE', 'EADDR INUSE', 'EADDRINUSE ', '', 'E', 123, null])('rechaza el código inválido %p', code => {
    expect(startupErrorMessage({ code })).toBe('No se pudo iniciar el servidor.');
  });

  it('no refleja mensaje, stack, causa ni otros valores del error', () => {
    const error = Object.assign(new Error('password=hunter2', { cause: new Error('causa secreta') }), {
      code: 'EADDRINUSE', stack: 'traza secreta /Users/x/app.ts:10', address: 'dirección secreta',
    });
    expect(startupErrorMessage(error)).toBe('No se pudo iniciar el servidor (EADDRINUSE).');
  });
});
