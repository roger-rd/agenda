import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseIdentityService, evaluateDatabaseIdentity } from './database-identity.service';
const expected = { user: 'agenda_test_app', database: 'agenda_test' };
const valid = { usuario: expected.user, base: expected.database, rolsuper: false, rolcreaterole: false, rolcreatedb: false,
  rolreplication: false, rolbypassrls: false, crea_en_public: false, crea_en_base: false };
it('acepta identidad de mínimo privilegio', () => expect(evaluateDatabaseIdentity(valid, expected)).toBe(true));
it.each(Object.keys(valid))('rechaza atributo incorrecto %s', key => {
  expect(evaluateDatabaseIdentity({ ...valid, [key]: key === 'usuario' || key === 'base' ? 'CANARIO_SECRETO_123' : true }, expected)).toBe(false);
});
it.each([undefined, null, {}, { ...valid, rolsuper: undefined }])('rechaza identidad incompleta %#', row => expect(evaluateDatabaseIdentity(row, expected)).toBe(false));
it.each(['success', 'unsafe', 'query-error', 'empty'])('servicio %s ejecuta una sola consulta', async mode => {
  const query = jest.fn();
  if (mode === 'query-error') query.mockRejectedValue(new Error('CANARIO_SECRETO_123'));
  else query.mockResolvedValue(mode === 'empty' ? [] : [{ ...valid, rolsuper: mode === 'unsafe' }]);
  const info = jest.fn();
  const service = new DatabaseIdentityService({ query } as unknown as DataSource,
    { database: { credentials: { user: expected.user }, name: expected.database } } as AppConfigService,
    { info } as unknown as PinoLogger);
  if (mode === 'success') {
    await service.onApplicationBootstrap();
    expect(info).toHaveBeenCalledWith({ event: 'database_identity_verified', ...expected }, 'Identidad de base de datos verificada.');
  } else {
    await expect(service.onApplicationBootstrap()).rejects.toThrow(mode === 'query-error' ?
      'No se pudo comprobar la identidad de la base de datos.' : 'La identidad o los privilegios de la base de datos no son seguros.');
    expect(info).not.toHaveBeenCalled();
  }
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]).toHaveLength(1);
  expect(query.mock.calls[0][0]).toMatch(/^select current_user/);
});
