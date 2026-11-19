import { ConflictError, ForbiddenError } from '../common/errors/domain-error';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { mapDatabaseFailure } from '../database/errors/database-http';
import { translateCompanyWriteError } from './company-errors';

describe('errores de escritura de empresas', () => {
  it('conserva DomainError y errores no clasificables intactos', () => {
    for (const error of [new ForbiddenError(), new Error('interno'), null]) expect(translateCompanyWriteError(error)).toBe(error);
  });
  it('traduce solo la unicidad exacta', () => {
    expect(translateCompanyWriteError({ severity: 'ERROR', code: '23505', constraint: 'UQ_companies_org_name_key' }))
      .toEqual(new ConflictError('El nombre de empresa ya está registrado.', 'name'));
  });
  it.each(['UQ_other', 'uq_companies_org_name_key', 'UQ_companies_org_name_key_extra'])('no confunde %s', constraint => {
    expect(translateCompanyWriteError({ severity: 'ERROR', code: '23505', constraint })).toBeInstanceOf(DatabaseOperationError);
  });
  it.each([['23514', 400, 'invalid_input'], ['55P03', 503, 'service_unavailable'], ['57014', 503, 'service_unavailable'],
    ['08006', 503, 'outcome_unknown'], ['ECONNRESET', 503, 'outcome_unknown']])('conserva el mapeo de %s', (code, status, mappedCode) => {
    const error = translateCompanyWriteError({ severity: 'ERROR', code, message: 'secreto' }) as DatabaseOperationError;
    expect(error.context).toEqual({ operation: 'insert', atomic: true, valuesOrigin: 'request' });
    expect(mapDatabaseFailure(error.failure, { method: 'POST', registry: new ConstraintRegistry(), context: error.context }))
      .toMatchObject({ status, code: mappedCode });
    const wrapped = translateCompanyWriteError(error) as DatabaseOperationError;
    expect(wrapped.failure).toEqual(error.failure); expect(wrapped.context).toEqual(error.context);
    expect(JSON.stringify(wrapped)).not.toContain('secreto');
  });
});

describe('contexto de edición de empresas', () => {
  it.each(['23514', '55P03', '57014', '08006', 'ECONNRESET'])('conserva el fallo %s y contexto update', code => {
    const failure = translateCompanyWriteError({ severity: 'ERROR', code }, 'update') as DatabaseOperationError;
    expect(failure.context).toEqual({ operation: 'update', atomic: true, valuesOrigin: 'request' });
    const wrapped = translateCompanyWriteError(failure, 'update') as DatabaseOperationError;
    expect(wrapped.failure).toEqual(failure.failure); expect(wrapped.context).toEqual(failure.context);
    expect(mapDatabaseFailure(failure.failure, { method: 'PATCH', registry: new ConstraintRegistry(), context: failure.context }))
      .toMatchObject({ status: code === '23514' ? 400 : 503,
        code: code === '23514' ? 'invalid_input' : ['08006', 'ECONNRESET'].includes(code) ? 'outcome_unknown' : 'service_unavailable' });
  });
  it('preserva errores de dominio y traduce la unicidad exacta al editar', () => {
    for (const error of [new ForbiddenError(), new ConflictError('Desactualizado')]) {
      expect(translateCompanyWriteError(error, 'update')).toBe(error);
    }
    expect(translateCompanyWriteError({ severity: 'ERROR', code: '23505', constraint: 'UQ_companies_org_name_key' }, 'update'))
      .toEqual(new ConflictError('El nombre de empresa ya está registrado.', 'name'));
  });
});
