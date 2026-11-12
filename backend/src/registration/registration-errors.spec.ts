import { ConflictError } from '../common/errors/domain-error';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { mapDatabaseFailure } from '../database/errors/database-http';
import { translateRegistrationError } from './registration-errors';

describe('errores locales de registro', () => {
  it.each([
    ['UQ_users_email', 'email', 'El email ya está registrado.'],
    ['UQ_organizations_name_key', 'organizationName', 'El nombre de organización ya está registrado.'],
  ])('traduce constraint exacta %s', (constraint, field, message) => {
    expect(translateRegistrationError({ severity: 'ERROR', code: '23505', constraint, table: 'users' })).toEqual(new ConflictError(message, field));
  });
  it.each(['uq_users_email', 'uq_organizations_name_key', 'UQ_other', 'UQ_users_email_extra'])('no traduce %s específicamente', constraint => {
    const error = translateRegistrationError({ severity: 'ERROR', code: '23505', constraint, table: 'users' });
    expect(error).toBeInstanceOf(DatabaseOperationError);
    const wrapped = error as DatabaseOperationError;
    expect(mapDatabaseFailure(wrapped.failure, { method: 'POST', registry: new ConstraintRegistry(), context: wrapped.context })).toMatchObject({ status: 409 });
    expect(error).not.toHaveProperty('field');
  });
  it.each([
    ['23514', 400, 'invalid_input'], ['55P03', 503, 'service_unavailable'],
    ['57014', 503, 'service_unavailable'], ['40001', 503, 'service_unavailable'],
    ['08001', 503, 'service_unavailable'], ['08006', 503, 'outcome_unknown'],
    ['ECONNREFUSED', 503, 'service_unavailable'], ['ECONNRESET', 503, 'outcome_unknown'],
  ])('usa mapeo existente para %s', (code, status, mappedCode) => {
    const error = translateRegistrationError({ severity: 'ERROR', code, table: 'users', constraint: 'UQ_users_email', detail: 'secreto', message: 'secreto' }) as DatabaseOperationError;
    expect(error).toBeInstanceOf(DatabaseOperationError);
    expect(error.context).toEqual({ operation: 'insert', atomic: true, valuesOrigin: 'request' });
    expect(mapDatabaseFailure(error.failure, { method: 'POST', registry: new ConstraintRegistry(), context: error.context })).toMatchObject({ status, code: mappedCode });
    expect(JSON.stringify(error)).not.toContain('secreto');
    expect(error).not.toHaveProperty('cause');
  });
  it('relanza errores no clasificados sin inventar un mapeo', () => {
    const error = new Error('fallo interno');
    expect(translateRegistrationError(error)).toBe(error);
  });
});
