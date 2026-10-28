import { ConstraintRegistry } from './constraint-registry';
import { createOperationContext, DatabaseFailure, FailureCategory, OperationContext, Outcome, ValuesOrigin } from './database-failure';
import { mapDatabaseFailure, NEUTRAL_CONFLICT, OUTCOME_UNKNOWN, UNAVAILABLE } from './database-http';
const registry = new ConstraintRegistry();
const failure = (category: FailureCategory, patch: Partial<DatabaseFailure> = {}): DatabaseFailure => ({ category, outcome: 'not_applied', retryable: false, ...patch });
const origins = [undefined, 'request', 'derived', 'system'] as const;
const contexts = [undefined, createOperationContext({ operation: 'insert', atomic: true }), createOperationContext({ operation: 'insert', atomic: false }), JSON.parse('{"operation":"insert","table":"t","valuesOrigin":"request","atomic":true}') as unknown];
const transientCases = (['transaction_conflict', 'lock_timeout', 'statement_timeout', 'connection', 'resource'] as const).flatMap(category => ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].flatMap(method => (['not_started', 'not_applied', 'unknown'] as Outcome[]).flatMap(outcome => contexts.map((context, index) => ({ category, method, outcome, context, index })))));
it.each(transientCases)('transitorio $category $method $outcome contexto $index', ({ category, method, outcome, context, index }) => {
  const mapped = mapDatabaseFailure(failure(category, { outcome }), { method, context, registry });
  const repeatable = ['GET', 'HEAD', 'OPTIONS'].includes(method) || (index === 1 && outcome !== 'unknown');
  expect(mapped).toEqual({ status: 503, code: repeatable ? 'service_unavailable' : 'outcome_unknown', message: repeatable ? UNAVAILABLE : OUTCOME_UNKNOWN, event: 'database_transient', level: 'warn',
    ...(repeatable ? { retryAfterSeconds: category === 'transaction_conflict' || category === 'lock_timeout' ? 1 : category === 'statement_timeout' ? 2 : 5 } : { noStore: true }) });
});
it('contexto JSON ignorado; contexto creado sí aplica', () => {
  const f = failure('not_null'); const input = { method: 'POST', registry };
  expect(mapDatabaseFailure(f, { ...input, context: contexts[3] })).toEqual(mapDatabaseFailure(f, input));
  expect(mapDatabaseFailure(f, { ...input, context: createOperationContext({ operation: 'insert', valuesOrigin: 'request' }) }).status).toBe(400);
});
it('unique registrado y genérico', () => {
  const r = new ConstraintRegistry(); r.register({ kind: 'unique', name: 'uq_email', code: 'email_conflict', field: 'email', message: 'Dato duplicado.' });
  expect(mapDatabaseFailure(failure('unique_violation', { constraint: 'uq_email' }), { method: 'POST', registry: r })).toMatchObject({ status: 409, code: 'email_conflict', field: 'email', message: 'Dato duplicado.' });
  expect(mapDatabaseFailure(failure('unique_violation'), { method: 'POST', registry: r })).toMatchObject({ status: 409, code: 'conflict' });
});
it.each((['not_null', 'check_violation'] as const).flatMap(category => origins.flatMap(origin => [undefined, 'input', 'internal'].map(registered => ({ category, origin, registered })))))('$category origen $origin registro $registered', ({ category, origin, registered }) => {
  const r = new ConstraintRegistry();
  if (registered) r.register(category === 'not_null' ? { kind: 'not_null', table: 't', column: 'c', origin: registered as 'input' | 'internal', code: 'invalid_value', field: 'title', message: 'Dato inválido.' } : { kind: 'check', name: 'ck_valid', origin: registered as 'input' | 'internal', code: 'invalid_value', field: 'title', message: 'Dato inválido.' });
  const mapped = mapDatabaseFailure(failure(category, { table: 't', column: 'c', constraint: 'ck_valid' }), { method: 'POST', registry: r, context: origin ? createOperationContext({ operation: 'insert', valuesOrigin: origin }) : undefined });
  const input = registered ? registered === 'input' : origin === 'request';
  expect(mapped.status).toBe(input ? 400 : 500); expect(mapped.level).toBe(input ? 'warn' : 'error'); expect(mapped.event).toBe('data_validation_gap');
  expect(mapped.field).toBe(input && registered ? 'title' : undefined);
});
it.each(origins)('data_exception origen %s', (origin?: ValuesOrigin) => {
  const mapped = mapDatabaseFailure(failure('data_exception'), { method: 'POST', registry, context: origin ? createOperationContext({ operation: 'insert', valuesOrigin: origin }) : undefined });
  expect(mapped.status).toBe(origin === 'derived' || origin === 'system' ? 500 : 400); expect(mapped.field).toBeUndefined();
});
const operations: OperationContext[] = [{ operation: 'insert' }, { operation: 'update', table: 'child' }, { operation: 'update', table: 'parent' }, { operation: 'update', table: 'other' }, { operation: 'update' }, { operation: 'delete' }, { operation: 'select' }];
const fkCases = operations.flatMap(context => ['coherent', 'contradictory', 'absent'].flatMap(mode => [true, false].flatMap(registered => (['body', 'path'] as const).flatMap(referenceIn => [true, false].map(tenantBoundary => ({ context, mode, registered, referenceIn, tenantBoundary }))))));
it.each(fkCases)('FK %#', ({ context, mode, registered, referenceIn, tenantBoundary }) => {
  const r = new ConstraintRegistry(); if (registered) r.register({ kind: 'foreign_key', name: 'fk_parent', childTable: 'child', parentTable: 'parent', referenceIn, tenantBoundary, field: 'parentId' });
  const verb = (mode === 'absent' ? undefined : mode === 'contradictory' ? context.operation === 'insert' ? 'DELETE' : 'INSERT' : context.operation.toUpperCase()) as DatabaseFailure['verb'];
  const mapped = mapDatabaseFailure(failure('foreign_key', { constraint: 'fk_parent', table: 'child', verb }), { method: 'POST', registry: r, context: createOperationContext(context) });
  const side = mode === 'contradictory' ? 'mismatch' : context.operation === 'insert' ? 'child' : context.operation === 'delete' ? 'parent' : registered && context.operation === 'update' && context.table === 'child' ? 'child' : registered && context.operation === 'update' && context.table === 'parent' ? 'parent' : 'ambiguous';
  expect(mapped.status).toBe(side === 'child' ? registered && referenceIn === 'path' ? 404 : 400 : 409);
  expect(mapped.event).toBe(({ child: 'reference_violation', parent: 'in_use', mismatch: 'fk_context_mismatch', ambiguous: 'fk_ambiguous' })[side]);
  if (side === 'mismatch' || side === 'ambiguous') { expect(mapped.message).toBe(NEUTRAL_CONFLICT); expect(mapped.field).toBeUndefined(); }
  if (side === 'child') expect(mapped.tenantBoundary).toBe(registered && tenantBoundary);
  expect(mapped.message).not.toMatch(/child|parent|other|fk_parent|CANARIO_|SELECT|INSERT|UPDATE|DELETE/);
});
it.each(['INSERT', 'DELETE', 'UPDATE', 'WITH', undefined] as const)('FK sin contexto %s', verb => {
  expect(mapDatabaseFailure(failure('foreign_key', { verb }), { method: 'POST', registry }).event).toBe(verb === 'INSERT' ? 'reference_violation' : verb === 'DELETE' ? 'in_use' : 'fk_ambiguous');
});
it.each([['not_found', 404, 'not_found'], ['optimistic_lock', 409, 'conflict'], ['programming', 500, 'internal_error'], ['permission_misconfig', 500, 'internal_error'], ['internal', 500, 'internal_error'], ['unknown', 500, 'internal_error'], ['exclusion_violation', 409, 'conflict'], ['integrity_other', 409, 'conflict']] as const)('%s', (category, status, code) => {
  const mapped = mapDatabaseFailure(failure(category, { constraint: 'CANARIO_CONSTRAINT', table: 'CANARIO_TABLE', column: 'CANARIO_COLUMN' }), { method: 'POST', registry });
  expect(mapped).toMatchObject({ status, code }); expect(mapped.message).not.toContain('CANARIO_');
});
