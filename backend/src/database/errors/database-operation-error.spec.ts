import { TypeORMError } from 'typeorm';
import { own } from '../../logging/error-sanitizer';
import { createOperationContext } from './database-failure';
import { DatabaseOperationError, wrapDatabaseError } from './database-operation-error';
it('envoltorio fijo sin causa ni datos sensibles y contexto autenticado', () => {
  const context = createOperationContext({ operation: 'insert' });
  const wrapped = wrapDatabaseError(new TypeORMError('CANARIO_CRITERIA'), context);
  expect(wrapped).toBeInstanceOf(DatabaseOperationError); expect(own(wrapped, 'context')).toBe(context);
  expect(own(wrapped, 'message')).toBe('Error de operación de base de datos.'); expect(own(wrapped, 'cause')).toBeUndefined();
  expect(JSON.stringify(wrapped)).toEqual(JSON.stringify({ name: 'DatabaseOperationError', message: 'Error de operación de base de datos.' }));
  expect(own(wrapDatabaseError(new TypeORMError(), { operation: 'insert', atomic: true }), 'context')).toBeUndefined();
});
it('no reconocido y Proxy se devuelven intactos sin lanzar', () => {
  const get = jest.fn(() => { throw new Error('CANARIO_GET'); });
  for (const e of [new Error('CANARIO_MSG'), new Proxy({}, { get, getPrototypeOf: get }), null, undefined]) expect(wrapDatabaseError(e)).toBe(e);
  expect(get).not.toHaveBeenCalled();
});
