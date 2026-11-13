import { ServiceUnavailableError, UnauthenticatedError } from '../common/errors/domain-error';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { mapDatabaseFailure } from '../database/errors/database-http';
import { translateAuthPersistenceError } from './auth-errors';

it('conserva intactos los errores de dominio y los no clasificados', () => {
  for (const error of [new UnauthenticatedError(), new ServiceUnavailableError(), new Error('interno')]) {
    expect(translateAuthPersistenceError(error)).toBe(error);
  }
});
it.each([['08006', 'outcome_unknown'], ['55P03', 'service_unavailable']])('traduce %s sin perder el resultado', (code, expected) => {
  const error = translateAuthPersistenceError({ severity: 'ERROR', code }) as DatabaseOperationError;
  expect(error).toBeInstanceOf(DatabaseOperationError);
  expect(error.context).toEqual({ operation: 'insert', atomic: true, valuesOrigin: 'system' });
  expect(mapDatabaseFailure(error.failure, { method: 'POST', registry: new ConstraintRegistry(), context: error.context }))
    .toMatchObject({ status: 503, code: expected });
  expect((translateAuthPersistenceError(error) as DatabaseOperationError).failure).toEqual(error.failure);
});
