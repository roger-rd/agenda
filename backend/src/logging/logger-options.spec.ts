import 'reflect-metadata';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import { createLoggerOptions, requestId, sanitizeUrl } from './logger-options';
import { installFatalHandlers } from './fatal-handlers';
import { isUuidV7, Uuid7Generator } from '../common/ids/uuid7-generator';

describe('Logging', () => {
  it('redacta cabeceras y claves anidadas sin filtrar secretos', () => {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const options = createLoggerOptions({ logLevel: 'info' }, stream);
    // Sin serializadores para verificar también las reglas defensivas de redact.
    const logger = pino({ ...options, serializers: {} }, stream);
    logger.info({ req: { headers: { authorization: 'secret-auth', cookie: 'secret-cookie', 'x-csrf-token': 'secret-csrf', 'x-api-key': 'secret-key' } }, res: { headers: { 'set-cookie': 'secret-set' } }, password: 'secret-password', data: { token: 'secret-token', nested: { passwordHash: 'secret-hash', accessToken: 'secret-access', refreshToken: 'secret-refresh', secret: 'secret-value', apiKey: 'secret-api', cookie: 'secret-c' } } });
    expect(output).not.toContain('secret-');
    expect(output).toContain('[REDACTED]');
  });
  it('silent no emite', () => {
    const write = jest.fn();
    const stream = new Writable({ write(chunk, _encoding, done) { write(chunk); done(); } });
    pino(createLoggerOptions({ logLevel: 'silent' }), stream).fatal('mensaje');
    expect(write).not.toHaveBeenCalled();
  });
  it('sanitiza query, tokens y codificación; preserva UUID', () => {
    const uuid = new Uuid7Generator().next();
    expect(sanitizeUrl(`/x/${'a'.repeat(24)}/${uuid}?token=secret`)).toBe(`/x/[REDACTED]/${uuid}`);
    expect(sanitizeUrl(`/x/${'%61'.repeat(24)}`)).toBe('/x/[REDACTED]');
    expect(sanitizeUrl('/x/%XX')).toBe('/x/[REDACTED]');
  });
  it.each([undefined, 'short', 'x'.repeat(65), 'with spaces', 'abcdefgh\n', 'abcdefgh\r', 'abcdefgh\u0000', ['abcdefgh']])('reemplaza id inválido %p', value => expect(isUuidV7(requestId(value, new Uuid7Generator()))).toBe(true));
  it('reutiliza ids válidos', () => expect(requestId('valid_ID.123-xyz', new Uuid7Generator())).toBe('valid_ID.123-xyz'));
  it.each(['unhandledRejection', 'uncaughtException'])('fatal %s no registra el objeto y sale con 1', event => {
    const emitter = Object.assign(new EventEmitter(), { exit: jest.fn() });
    const logger = { fatal: jest.fn() };
    const remove = installFatalHandlers(logger, emitter);
    emitter.emit(event, { secret: 'no-divulgar' });
    expect(logger.fatal).toHaveBeenCalledWith({ event }, 'Fallo fatal del proceso.');
    expect(emitter.exit).toHaveBeenCalledWith(1);
    remove();
    expect(emitter.listenerCount(event)).toBe(0);
  });
});
